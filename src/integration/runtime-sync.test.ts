import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, SourceConfig, Task } from "../shared/types";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => "C:/fixture-user-data"),
    getAppPath: vi.fn(() => "C:/fixture-app"),
    setPath: vi.fn(),
    setLoginItemSettings: vi.fn(),
  },
  BrowserWindow: class BrowserWindow {},
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() },
  screen: { getDisplayMatching: vi.fn() },
  shell: { openExternal: vi.fn() },
  Tray: class Tray {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

const source = (id: string, name: string): SourceConfig => ({
  id,
  databaseId: `db-${id}`,
  name,
  properties: [
    { id: "title", name: "Task", type: "title" },
    { id: "status", name: "Status", type: "select", options: [{ id: "done", name: "Done" }, { id: "open", name: "Not started" }] },
  ],
  mapping: { title: "title", due: null, status: "status", complete: "done", reopen: "open" },
});

const task = (id: string, sourceId: string, name: string): Task => ({
  id,
  sourceId,
  name,
  url: `https://www.notion.so/${id}`,
  due: null,
  status: "Not started",
  completed: false,
  lastEdited: "2026-10-21T12:00:00.000Z",
});

function appState(sources: SourceConfig[], tasks: Task[]): AppState {
  return {
    connected: true,
    sources,
    tasks,
    stars: [],
    settings: { compact: false, alwaysOnTop: false, launchAtLogin: false, selectedList: "today", lastSourceId: "" },
    sync: { syncing: false, lastSync: "2026-10-20T12:00:00.000Z", errors: {}, onlineSources: sources.map((item) => item.id) },
  };
}

describe("DesktopRuntime sync boundary", () => {
  let DesktopRuntime: typeof import("../main/index").DesktopRuntime;
  const originalProcessType = process.type;

  beforeAll(async () => {
    // index.ts is also the Electron entrypoint; keep this test in the Node runtime.
    (process as any).type = "renderer";
    ({ DesktopRuntime } = await import("../main/index"));
  });

  afterAll(() => {
    (process as any).type = originalProcessType;
  });

  it("replaces successful source tasks while retaining a failed source cache", async () => {
    const first = source("source-a", "A");
    const second = source("source-b", "B");
    const runtime = new DesktopRuntime() as any;
    const persisted = vi.fn();
    const service = {
      inspectSource: vi.fn(async (id: string) => id === first.id ? first : second),
      listTasks: vi.fn(async (item: SourceConfig) => {
        if (item.id === second.id) throw new Error("B unavailable");
        return [task("a-new", first.id, "Fresh A")];
      }),
    };
    runtime.state = appState([first, second], [task("a-old", first.id, "Stale A"), task("b-old", second.id, "Cached B")]);
    runtime.service = service;
    runtime.token = "fixture-token";
    runtime.persistence = { save: persisted };
    runtime.mainWindow = null;

    await runtime.performSync();

    expect(runtime.state.tasks).toEqual([task("b-old", second.id, "Cached B"), task("a-new", first.id, "Fresh A")]);
    expect(runtime.state.sync.onlineSources).toEqual([first.id]);
    expect(runtime.state.sync.errors).toEqual({ [second.id]: "B unavailable" });
    expect(runtime.state.sync.lastSync).not.toBe("2026-10-20T12:00:00.000Z");
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it("abandons an in-flight generation after the connection is invalidated", async () => {
    const first = source("source-a", "A");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new DesktopRuntime() as any;
    const persisted = vi.fn();
    runtime.state = appState([first], [task("cached", first.id, "Cached")]);
    runtime.service = {
      inspectSource: vi.fn(async () => first),
      listTasks: vi.fn(async () => {
        await blocked;
        return [task("remote", first.id, "Remote")];
      }),
    };
    runtime.token = "fixture-token";
    runtime.persistence = { save: persisted };
    runtime.mainWindow = null;
    const syncing = runtime.performSync();
    await Promise.resolve();
    runtime.sourceGeneration += 1;
    runtime.state.connected = false;
    release();
    await syncing;

    expect(runtime.state.tasks).toEqual([task("cached", first.id, "Cached")]);
    expect(persisted).not.toHaveBeenCalled();
  });

  it("does not identify a malformed create response by a duplicate task name", async () => {
    const first = source("source-a", "A");
    const existing = task("original", first.id, "Same name");
    const runtime = new DesktopRuntime() as any;
    runtime.state = appState([first], [existing]);
    runtime.service = {
      inspectSource: vi.fn(async () => first),
      createTask: vi.fn(async () => ({ name: "Same name" })),
      listTasks: vi.fn(async () => [existing]),
    };
    runtime.persistence = { save: vi.fn() };
    await expect(runtime.createTask({ sourceId: first.id, name: "Same name" })).rejects.toThrow("invalid task");
    expect(runtime.state.tasks).toEqual([existing]);
    expect(runtime.service.listTasks).not.toHaveBeenCalled();
  });

  it("persists a favorite when creating a task", async () => {
    const first = source("source-a", "A");
    const created = task("created", first.id, "Favorite task");
    const runtime = new DesktopRuntime() as any;
    const persisted = vi.fn();
    runtime.state = appState([first], []);
    runtime.service = {
      inspectSource: vi.fn(async () => first),
      createTask: vi.fn(async () => created),
    };
    runtime.persistence = { save: persisted };
    runtime.mainWindow = null;

    const next = await runtime.createTask({ sourceId: first.id, name: created.name, favorite: true });

    expect(next.stars).toContain(created.id);
    expect(runtime.state.stars).toContain(created.id);
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it("does not restore a removed source after a delayed create completes", async () => {
    const first = source("source-a", "A");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runtime = new DesktopRuntime() as any;
    runtime.state = appState([first], []);
    runtime.service = {
      inspectSource: vi.fn(async () => first),
      createTask: vi.fn(async () => { await pending; return task("created", first.id, "New"); }),
    };
    runtime.persistence = { save: vi.fn() };
    const creating = runtime.createTask({ sourceId: first.id, name: "New" });
    await vi.waitFor(() => expect(runtime.service.createTask).toHaveBeenCalled());
    await runtime.removeSource(first.id);
    release();
    await expect(creating).rejects.toThrow("created in Notion");
    expect(runtime.state.tasks).toEqual([]);
    expect(runtime.state.sources).toEqual([]);
  });

  it("recovers cached startup connections on a later refresh", async () => {
    const first = source("source-a", "A");
    const runtime = new DesktopRuntime() as any;
    runtime.state = appState([first], [task("cached", first.id, "Cached")]);
    runtime.state.connected = false;
    runtime.token = "fixture-token";
    runtime.persistence = { save: vi.fn() };
    runtime.service = {
      validate: vi.fn(async () => undefined),
      inspectSource: vi.fn(async () => first),
      listTasks: vi.fn(async () => [task("new", first.id, "Updated")]),
    };
    const next = await runtime.refresh();
    expect(next.connected).toBe(true);
    expect(next.tasks[0].id).toBe("new");
    expect(next.sync.onlineSources).toEqual([first.id]);
  });

  it("persists a local source tag color without changing Notion", async () => {
    const first = source("source-a", "A");
    const persisted = vi.fn();
    const runtime = new DesktopRuntime() as any;
    runtime.state = appState([first], []);
    runtime.persistence = { save: persisted };
    runtime.mainWindow = null;

    const next = await runtime.setSourceColor(first.id, "rose");

    expect(next.sources[0].color).toBe("rose");
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it("persists an explicit appearance preference", async () => {
    const runtime = new DesktopRuntime() as any;
    const persisted = vi.fn();
    runtime.state = appState([], []);
    runtime.persistence = { save: persisted };
    runtime.mainWindow = null;

    const next = await runtime.setSettings({ theme: "light" });

    expect(next.settings.theme).toBe("light");
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it("blocks same-source remapping for the entire lifetime of a task save", async () => {
    const first = source("source-a", "A");
    const existing = task("task-a", first.id, "Existing");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runtime = new DesktopRuntime() as any;
    runtime.state = appState([first], [existing]);
    runtime.service = {
      inspectSource: vi.fn(async () => first),
      updateTask: vi.fn(async () => { await pending; return { task: { ...existing, name: "Updated" } }; }),
    };
    runtime.persistence = { save: vi.fn() };
    const saving = runtime.updateTask({ id: existing.id, changes: { name: "Updated" }, expected: existing });
    await vi.waitFor(() => expect(runtime.service.updateTask).toHaveBeenCalled());
    await expect(runtime.saveSource(first)).rejects.toThrow("finish before remapping");
    release();
    await saving;
    expect(runtime.sourceWrites.size).toBe(0);
    expect(runtime.state.tasks[0].name).toBe("Updated");
  });
});
