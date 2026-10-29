import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, SourceConfig, Task } from "../shared/types";

vi.mock("electron", () => ({
  app: { isPackaged: false, on: vi.fn(), requestSingleInstanceLock: vi.fn(() => true), whenReady: vi.fn(() => Promise.resolve()) },
  BrowserWindow: class {}, Menu: {}, nativeImage: {}, screen: {}, shell: { openExternal: vi.fn() }, Tray: class {},
  ipcMain: { handle: vi.fn() }, safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

function source(provider?: "plane"): SourceConfig {
  return {
    id: provider ? "plane-project" : "notion-source", databaseId: provider ? "project" : "database", name: provider ? "Plane" : "Notion",
    ...(provider ? { provider, workspaceSlug: "workspace", projectId: "project", baseUrl: "https://api.plane.so/api/v1" } : {}),
    properties: [{ id: "title", name: "Name", type: "title" }, { id: "status", name: "Status", type: "status", options: [{ id: "open", name: "Open" }, { id: "done", name: "Done" }] }],
    mapping: { title: "title", due: null, status: "status", complete: "done", reopen: "open" },
  };
}

const notion = source();
const plane = source("plane");
const task = (item: SourceConfig, name = "Cached"): Task => ({ id: `${item.id}-task`, sourceId: item.id, name, status: "Open", completed: false, due: null, url: "https://app.plane.so/workspace/projects/project/issues/task", lastEdited: "2026-10-28T12:00:00Z" });
const service = (item: SourceConfig) => ({ validate: vi.fn(async () => undefined), inspectSource: vi.fn(async () => item), listTasks: vi.fn(async () => [task(item, "Fresh")]) });

describe("mixed provider runtime", () => {
  let Runtime: typeof import("../main/index").DesktopRuntime;
  const originalType = process.type;
  beforeAll(async () => {
    (process as any).type = "renderer";
    Runtime = (await import("../main/index")).DesktopRuntime;
  });
  afterAll(() => { (process as any).type = originalType; });

  function runtime() {
    const runtime = new Runtime() as any;
    runtime.state = {
      connected: true, sources: [notion, plane], tasks: [task(notion), task(plane)], stars: [],
      settings: { compact: false, alwaysOnTop: false, launchAtLogin: false, selectedList: "all", lastSourceId: plane.id },
      sync: { syncing: false, lastSync: null, errors: {}, onlineSources: [notion.id, plane.id] },
      connections: { notion: { connected: true }, plane: { connected: true, workspaceSlug: "workspace" } },
    } satisfies AppState;
    runtime.persistence = { save: vi.fn(), clearToken: vi.fn(), clearPlaneConfig: vi.fn() };
    runtime.service = service(notion);
    runtime.token = "notion-key";
    runtime.services.set("notion", runtime.service);
    runtime.services.set("plane", service(plane));
    runtime.tokens.set("notion", "notion-key");
    runtime.tokens.set("plane", "plane-key");
    return runtime;
  }

  it("disconnects legacy Notion sources while keeping Plane online", async () => {
    const app = runtime();
    const state = await app.disconnect("notion");
    expect(state.connected).toBe(true);
    expect(state.sync.onlineSources).toEqual([plane.id]);
    expect(state.tasks).toHaveLength(2);
    expect(state.connections.notion.connected).toBe(false);
    expect(state.connections.plane.connected).toBe(true);
    expect(app.persistence.clearToken).toHaveBeenCalledWith("notion");
  });

  it("syncs a connected source after a disconnected provider's cached source", async () => {
    const app = runtime();
    await app.disconnect("notion");
    await app.performSync();
    expect(app.state.tasks.find((item: Task) => item.sourceId === plane.id)?.name).toBe("Fresh");
    expect(app.state.tasks.find((item: Task) => item.sourceId === notion.id)?.name).toBe("Cached");
    expect(app.state.sync.syncing).toBe(false);
    expect(app.state.sync.onlineSources).toEqual([plane.id]);
  });

  it("keeps Notion editable after disconnecting Plane and refreshing", async () => {
    const app = runtime();
    await app.disconnect("plane");
    await app.refresh();
    expect(app.state.sync.onlineSources).toEqual([notion.id]);
    expect(app.state.tasks.find((item: Task) => item.sourceId === notion.id)?.name).toBe("Fresh");
    expect(app.state.tasks.find((item: Task) => item.sourceId === plane.id)?.name).toBe("Cached");
    expect(app.state.sync.syncing).toBe(false);
  });

  it("retries failed Plane validation while Notion stays connected", async () => {
    const app = runtime();
    app.state.connections.plane.connected = false;
    app.state.sync.errors["plane:account"] = "Expired key";
    const planeService = app.services.get("plane");
    planeService.validate.mockRejectedValueOnce(new Error("Expired key"));
    await app.refresh();
    expect(app.state.connected).toBe(true);
    expect(app.state.connections.plane.connected).toBe(false);
    expect(app.state.sync.errors["plane:account"]).toBe("Expired key");
    expect(app.state.sync.onlineSources).toEqual([notion.id]);
    await app.refresh();
    expect(app.state.connections.plane.connected).toBe(true);
    expect(app.state.sync.errors["plane:account"]).toBeUndefined();
    expect(app.state.sync.onlineSources).toEqual([notion.id, plane.id]);
  });
});
