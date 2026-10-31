import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarKey, CalendarProviderError, type CalendarClient, type CalendarDefinition, type RemoteCalendarEvent } from "../shared/calendar";
import type { AppState, PlanningData, SourceConfig, Task, TaskRef } from "../shared/types";
import { cleanPlanning, DEFAULT_PLANNING, refKey } from "../main/planning";

vi.mock("electron", () => ({
  app: { isPackaged: false, requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn(), on: vi.fn(), whenReady: vi.fn(() => Promise.resolve()), getPath: vi.fn(() => "C:/fixture-user-data"), getAppPath: vi.fn(() => "C:/fixture-app"), setPath: vi.fn(), setLoginItemSettings: vi.fn() },
  BrowserWindow: class BrowserWindow {}, Menu: { buildFromTemplate: vi.fn() }, nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() }, screen: { getDisplayMatching: vi.fn() }, shell: { openExternal: vi.fn() }, Tray: class Tray {}, ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}));

const source: SourceConfig = {
  id: "source", databaseId: "db-source", name: "Tasks", provider: "notion",
  properties: [{ id: "title", name: "Title", type: "title" }, { id: "status", name: "Status", type: "select", options: [{ id: "open", name: "Not started" }, { id: "done", name: "Done" }] }],
  mapping: { title: "title", due: null, status: "status", complete: "done", reopen: "open" },
};
const google: CalendarDefinition = { provider: "google", id: "g-cal", accountId: "g-account", name: "Google work", timeZone: "UTC", canRead: true, canWrite: true };
const notion: CalendarDefinition = { provider: "notion", id: "n-source", accountId: "n-account", name: "Notion events", timeZone: "UTC", canRead: true, canWrite: true, mapping: { title: "title-id", date: "date-id" } };
const ref = (taskId: string): TaskRef => ({ provider: "notion", sourceId: source.id, taskId });
const task = (taskId: string, name = taskId): Task => ({ id: taskId, sourceId: source.id, name, url: `https://notion.so/${taskId}`, due: null, status: "Not started", completed: false, lastEdited: "2026-10-29T12:00:00Z" });
const remoteEvent = (calendar: CalendarDefinition, id: string, title: string, start: string, end: string, ownership?: RemoteCalendarEvent["ownership"]): RemoteCalendarEvent => ({ ref: { calendarKey: calendarKey(calendar), id }, title, start, end, version: `version-${id}`, ...(ownership ? { ownership } : {}) });
let DesktopRuntimeForTests: typeof import("../main/index").DesktopRuntime;

function makeState(tasks: Task[], planningOverrides: Partial<PlanningData> = {}): AppState {
  const planning: PlanningData = {
    ...structuredClone(DEFAULT_PLANNING),
    tasks: tasks.map((item, index) => ({ ref: ref(item.id), estimateMinutes: 60, parent: null, stepOrder: index, selected: true })),
    calendarSync: { ...structuredClone(DEFAULT_PLANNING.calendarSync!), calendars: [google, notion], selectedKeys: [calendarKey(google), calendarKey(notion)], defaultDestinationKey: calendarKey(notion), mode: "live", googleConnected: true, googleConfigured: true, installationId: "installation-1", lastSyncedAt: null, error: null, journal: [] },
    settings: { timezone: "UTC", workdays: [1, 2, 3, 4, 5, 6, 7], startHour: 9, endHour: 17, allowEmptyCalendar: false },
    ...planningOverrides,
  };
  return {
    connected: true, sources: [source], tasks, stars: [],
    settings: { compact: false, alwaysOnTop: false, launchAtLogin: false, selectedList: "today", lastSourceId: "" },
    sync: { syncing: false, lastSync: "2026-10-29T12:00:00Z", errors: {}, onlineSources: [source.id] },
    connections: { notion: { connected: true } }, planning,
  };
}

function runtimeWith(state: AppState, clients: { google?: Partial<CalendarClient>; notion?: Partial<CalendarClient> } = {}, save = vi.fn()) {
  const runtime = new DesktopRuntimeForTests() as any;
  runtime.state = state;
  runtime.persistence = { save };
  runtime.mainWindow = null;
  runtime.googleCalendar = clients.google ?? null;
  runtime.notionCalendar = clients.notion ?? null;
  return runtime;
}

function emptyClient(overrides: Partial<CalendarClient> = {}): any {
  return { readEvents: vi.fn(async () => []), getEvent: vi.fn(async () => null), createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn(), ...overrides };
}

describe("DesktopRuntime live calendar transaction boundary", () => {
  const originalProcessType = process.type;

  beforeAll(async () => {
    (process as any).type = "renderer";
    ({ DesktopRuntime: DesktopRuntimeForTests } = await import("../main/index"));
  });
  afterAll(() => { (process as any).type = originalProcessType; });
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T08:00:00.000Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("unions busy events from both providers, creates only in the default destination, and does not write during generation", async () => {
    const gBusy = remoteEvent(google, "g-busy", "Focus", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z");
    const nBusy = remoteEvent(notion, "n-busy", "Review", "2026-10-30T10:00:00Z", "2026-10-30T11:00:00Z");
    const g = emptyClient({ readEvents: vi.fn(async () => [gBusy]) });
    const n = emptyClient({ readEvents: vi.fn(async () => [nBusy]), createEvent: vi.fn(async (_cal, input) => remoteEvent(notion, "created-n", input.title, input.start, input.end, { installationId: input.installationId, blockId: input.blockId, operationId: input.operationId })) });
    const runtime = runtimeWith(makeState([task("task-1", "Write report")]), { google: g, notion: n });
    runtime.updateCalendarSelection([calendarKey(google), calendarKey(notion)], calendarKey(notion));

    const proposal = await runtime.generatePlanning();
    expect(runtime.state.planning.events.map((event: any) => event.remote.eventId)).toEqual(["g-busy", "n-busy"]);
    expect(proposal.items[0].start).toBe("2026-10-30T11:00:00.000Z");
    expect(g.createEvent).not.toHaveBeenCalled();
    expect(n.createEvent).not.toHaveBeenCalled();

    await runtime.approvePlanning(proposal, [refKey(ref("task-1"))]);
    expect(g.createEvent).not.toHaveBeenCalled();
    expect(n.createEvent).toHaveBeenCalledTimes(1);
    expect(n.createEvent.mock.calls[0][0]).toEqual(notion);
  });

  it("uses main-process proposal authority and rejects forged renderer selections", async () => {
    const n = emptyClient({ createEvent: vi.fn(async (_cal, input) => remoteEvent(notion, "actual", input.title, input.start, input.end)) });
    const runtime = runtimeWith(makeState([task("task-safe")]), { google: emptyClient(), notion: n });
    const proposal = await runtime.generatePlanning();
    const forged = { ...proposal, items: [{ ...proposal.items[0], ref: ref("renderer-forged"), start: "2026-10-30T09:00:00Z", calendarId: "attacker-calendar", eventId: "attacker-event" }] };
    await expect(runtime.approvePlanning(forged, ["attacker-event"])).rejects.toThrow();
    expect(n.createEvent).not.toHaveBeenCalled();

    await runtime.approvePlanning(forged, [refKey(ref("task-safe"))]);
    expect(n.createEvent).toHaveBeenCalledTimes(1);
    expect(n.createEvent.mock.calls[0][0]).toEqual(notion);
    expect(n.createEvent.mock.calls[0][1].blockId).not.toBe("attacker-event");
  });

  it("rejects approval after the default destination changes following generation", async () => {
    const g = emptyClient(); const n = emptyClient();
    const runtime = runtimeWith(makeState([task("stale-destination")]), { google: g, notion: n });
    const proposal = await runtime.generatePlanning();
    runtime.updateCalendarSelection([calendarKey(google), calendarKey(notion)], calendarKey(google));
    await expect(runtime.approvePlanning(proposal, [refKey(ref("stale-destination"))])).rejects.toThrow(/stale|changed|fresh/i);
    expect(g.createEvent).not.toHaveBeenCalled();
    expect(n.createEvent).not.toHaveBeenCalled();
  });

  it("persists two confirmed creates and reconciles the third uncertain create after restart without duplicating", async () => {
    const tasks = [task("first"), task("second"), task("third")];
    let saved: AppState | undefined;
    const save = vi.fn((state: AppState) => { saved = structuredClone(state); });
    const createdInputs: any[] = [];
    let exposeCandidate = false;
    let candidate: RemoteCalendarEvent | undefined;
    const notionClient = emptyClient({
      readEvents: vi.fn(async () => exposeCandidate && candidate ? [candidate] : []),
      getEvent: vi.fn(async (_calendar, eventId) => candidate?.ref.id === eventId ? candidate! : null),
      createEvent: vi.fn(async (_calendar, input) => {
        createdInputs.push(input);
        if (createdInputs.length === 3) {
          candidate = remoteEvent(notion, "remote-third", input.title, input.start, input.end, { installationId: input.installationId, blockId: input.blockId, operationId: input.operationId });
          throw new CalendarProviderError("The write may have reached Notion.", "unknown-write");
        }
        return remoteEvent(notion, `remote-${createdInputs.length}`, input.title, input.start, input.end, { installationId: input.installationId, blockId: input.blockId, operationId: input.operationId });
      }),
    });
    const initial = makeState(tasks);
    initial.planning!.tasks.forEach(row => { row.estimateMinutes = 30; });
    const runtime = runtimeWith(initial, { google: emptyClient(), notion: notionClient }, save);
    const proposal = await runtime.generatePlanning();
    const selectedTasks = tasks.map(item => refKey(ref(item.id)));
    await expect(runtime.approvePlanning(proposal, selectedTasks)).rejects.toThrow(/Confirmed changes were saved/);
    const pending = saved!.planning!.calendarSync!.journal.at(-1)!;
    expect(pending.status).toBe("recovery-needed");
    expect(pending.steps.slice(0, 2).every(step => step.status === "complete" && step.remote?.eventId)).toBe(true);
    expect(pending.steps[2].status).toBe("recovery-needed");
    expect(saved!.planning!.blocks).toHaveLength(2);
    const beforeRetry = createdInputs.length;
    await expect(runtime.generatePlanning()).rejects.toThrow(/uncertain|recovery/i);
    await expect(runtime.approvePlanning(proposal, selectedTasks)).rejects.toThrow();
    expect(createdInputs).toHaveLength(beforeRetry);
    const restart = runtimeWith(structuredClone(saved!), { google: emptyClient(), notion: notionClient }, vi.fn());
    exposeCandidate = true;
    const candidates = await restart.getCalendarRecoveryCandidates(pending.id, 2);
    expect(candidates.map((item: any) => item.id)).toEqual(["remote-third"]);
    await restart.reconcileCalendarOperation(pending.id, 2, { kind: "existing-event", eventId: "remote-third" });
    expect(restart.state.planning.blocks).toHaveLength(3);
    expect(restart.state.planning.blocks.find((block: any) => block.id === pending.steps[2].blockId).remote.eventId).toBe("remote-third");
    expect(notionClient.createEvent).toHaveBeenCalledTimes(3);
    expect(restart.state.planning.calendarSync.journal.at(-1).status).toBe("complete");
  });

  it("normalizes an interrupted create after restart and reconciles its marker without retrying", async () => {
    const pendingOperation = {
      id: "interrupted-op", proposalId: "old-proposal", status: "in-progress" as const, updatedAt: "2026-10-30T07:00:00Z",
      steps: [
        { kind: "create" as const, blockId: "interrupted-block", status: "in-progress" as const, calendarKey: calendarKey(notion), taskRef: ref("interrupted"), title: "Interrupted task", start: "2026-10-30T09:00:00Z", end: "2026-10-30T10:00:00Z" },
        { kind: "create" as const, blockId: "not-started-block", status: "pending" as const, calendarKey: calendarKey(notion), taskRef: ref("interrupted"), title: "Not started", start: "2026-10-30T10:00:00Z", end: "2026-10-30T11:00:00Z" },
      ],
    };
    const original = makeState([task("interrupted")]);
    const restartedState = makeState([task("interrupted")]);
    restartedState.planning = cleanPlanning({ ...original.planning, calendarSync: { ...original.planning!.calendarSync!, journal: [pendingOperation] } });
    const normalized = restartedState.planning!.calendarSync!.journal[0];
    expect(normalized.status).toBe("recovery-needed");
    expect(normalized.steps[0]).toMatchObject({ status: "recovery-needed" });
    expect(normalized.steps[1]).toMatchObject({ status: "absent-confirmed" });

    const candidate = remoteEvent(notion, "recovered-event", "Interrupted task", pendingOperation.steps[0].start, pendingOperation.steps[0].end, { installationId: "installation-1", blockId: "interrupted-block", operationId: pendingOperation.id });
    const n = emptyClient({ readEvents: vi.fn(async () => [candidate]), getEvent: vi.fn(async () => candidate) });
    const restarted = runtimeWith(restartedState, { google: emptyClient(), notion: n });
    const candidates = await restarted.getCalendarRecoveryCandidates(pendingOperation.id, 0);
    expect(candidates.map((item: any) => item.id)).toEqual(["recovered-event"]);
    await restarted.reconcileCalendarOperation(pendingOperation.id, 0, { kind: "existing-event", eventId: "recovered-event" });
    expect(restarted.state.planning.blocks).toHaveLength(1);
    expect(restarted.state.planning.blocks[0].remote.eventId).toBe("recovered-event");
    expect(restarted.state.planning.calendarSync.journal[0].status).toBe("complete");
    expect(n.createEvent).not.toHaveBeenCalled();
  });

  it("closes a definitely rejected create and permits a fresh review", async () => {
    const n = emptyClient({ createEvent: vi.fn(async () => { throw new CalendarProviderError("Notion rejected the create.", "not-created"); }) });
    const runtime = runtimeWith(makeState([task("rejected")]), { google: emptyClient(), notion: n });
    const proposal = await runtime.generatePlanning();
    await expect(runtime.approvePlanning(proposal, [refKey(ref("rejected"))])).rejects.toThrow(/confirmed not created/i);
    const closed = runtime.state.planning.calendarSync.journal.at(-1);
    expect(closed.status).toBe("complete");
    expect(closed.steps[0]).toMatchObject({ status: "absent-confirmed", message: expect.stringMatching(/Confirmed not created/) });
    expect(runtime.state.planning.blocks).toEqual([]);
    const freshProposal = await runtime.generatePlanning();
    expect(freshProposal.items).toHaveLength(1);
    expect(n.createEvent).toHaveBeenCalledTimes(1);
  });

  it("preserves a deferred create, journal, and concurrent estimate edit while skipping background refresh", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
    const g = emptyClient();
    const n = emptyClient({ createEvent: vi.fn(async (_calendar, input) => {
      await createGate;
      return remoteEvent(notion, "deferred-created", input.title, input.start, input.end, { installationId: input.installationId, blockId: input.blockId, operationId: input.operationId });
    }) });
    const runtime = runtimeWith(makeState([task("deferred", "Deferred task")]), { google: g, notion: n });
    const proposal = await runtime.generatePlanning();
    const approving = runtime.approvePlanning(proposal, [refKey(ref("deferred"))]);
    await vi.waitFor(() => expect(n.createEvent).toHaveBeenCalledTimes(1));
    const readsBeforeBackgroundRefresh = g.readEvents.mock.calls.length + n.readEvents.mock.calls.length;

    await runtime.refreshLiveCalendars();
    expect(g.readEvents.mock.calls.length + n.readEvents.mock.calls.length).toBe(readsBeforeBackgroundRefresh);
    runtime.setPlanningEstimate(ref("deferred"), 90);
    expect(runtime.state.planning.calendarSync.journal.at(-1).steps[0].status).toBe("in-progress");

    releaseCreate();
    await approving;
    expect(runtime.state.planning.tasks.find((row: any) => row.ref.taskId === "deferred").estimateMinutes).toBe(90);
    expect(runtime.state.planning.blocks).toHaveLength(1);
    expect(runtime.state.planning.blocks[0].remote.eventId).toBe("deferred-created");
    const operation = runtime.state.planning.calendarSync.journal.at(-1);
    expect(operation.status).toBe("complete");
    expect(operation.steps[0]).toMatchObject({ status: "complete", remote: { eventId: "deferred-created" } });
  });

  it("stops approval on a fresh-read failure and retains the prior calendar snapshot", async () => {
    const busy = remoteEvent(google, "before-failure", "Busy", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z");
    const g = emptyClient({ readEvents: vi.fn(async () => [busy]) });
    const n = emptyClient();
    const runtime = runtimeWith(makeState([task("read-failure")]), { google: g, notion: n });
    const proposal = await runtime.generatePlanning();
    const priorEvents = structuredClone(runtime.state.planning.events);
    g.readEvents.mockRejectedValue(new Error("Google read unavailable"));
    await expect(runtime.approvePlanning(proposal, [refKey(ref("read-failure"))])).rejects.toThrow("Google read unavailable");
    expect(runtime.state.planning.events).toEqual(priorEvents);
    expect(runtime.state.planning.calendarSync.error).toContain("Google read unavailable");
    expect(n.createEvent).not.toHaveBeenCalled();
  });

  it("reconciles externally moved and deleted mapped events by durable ID outside the visible window", async () => {
    const current = makeState([task("moved"), task("deleted")]);
    current.planning!.calendarSync!.selectedKeys = [calendarKey(google)];
    current.planning!.calendarSync!.defaultDestinationKey = calendarKey(google);
    current.planning!.blocks = [
      { id: "block-moved", ref: ref("moved"), start: "2026-11-02T09:00:00Z", end: "2026-11-02T10:00:00Z", approvedAt: "2026-10-29T12:00:00Z", remote: { provider: "google", accountId: "g-account", calendarId: google.id, eventId: "event-moved", version: "old" } },
      { id: "block-deleted", ref: ref("deleted"), start: "2026-11-02T10:00:00Z", end: "2026-11-02T11:00:00Z", approvedAt: "2026-10-29T12:00:00Z", remote: { provider: "google", accountId: "g-account", calendarId: google.id, eventId: "event-deleted", version: "old" } },
    ];
    const moved = remoteEvent(google, "event-moved", "Moved later", "2026-11-12T14:00:00Z", "2026-11-12T15:00:00Z", { installationId: "installation-1", blockId: "block-moved", operationId: "op" });
    const g = emptyClient({ getEvent: vi.fn(async (_calendar, id) => id === "event-moved" ? moved : null) });
    const runtime = runtimeWith(current, { google: g, notion: emptyClient() });
    await runtime.refreshLiveCalendars();
    expect(g.getEvent).toHaveBeenCalledWith(google, "event-moved");
    expect(g.getEvent).toHaveBeenCalledWith(google, "event-deleted");
    expect(runtime.state.planning.blocks).toEqual([{ ...current.planning!.blocks[0], start: moved.start, end: moved.end, remote: { ...current.planning!.blocks[0].remote, version: moved.version } }]);
  });

  it("does not overwrite concurrent selection or estimate edits when a refresh resolves late", async () => {
    let release!: () => void;
    const pendingRead = new Promise<RemoteCalendarEvent[]>(resolve => { release = () => resolve([]); });
    const g = emptyClient({ readEvents: vi.fn(() => pendingRead) });
    const n = emptyClient();
    const runtime = runtimeWith(makeState([task("concurrent")]), { google: g, notion: n });
    const refreshing = runtime.refreshLiveCalendars();
    await vi.waitFor(() => expect(g.readEvents).toHaveBeenCalledTimes(1));
    runtime.updateCalendarSelection([calendarKey(notion)], calendarKey(notion));
    runtime.setPlanningEstimate(ref("concurrent"), 90);
    release();
    await expect(refreshing).rejects.toThrow(/Planning settings changed/);
    expect(runtime.state.planning.tasks[0].estimateMinutes).toBe(90);
    expect(runtime.state.planning.calendarSync.selectedKeys).toEqual([calendarKey(notion)]);
    expect(runtime.state.planning.calendarSync.defaultDestinationKey).toBe(calendarKey(notion));
    expect(runtime.state.planning.events).toEqual([]);
  });
});
