import { describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../shared/types";
import { planeSourceId, PlaneService } from "./plane";

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

const api = "https://api.plane.so/api/v1";
const sourceId = planeSourceId(api, "fixture", "project-1");
const states = {
  results: [
    { id: "state-open", name: "Open", group: "backlog" },
    { id: "state-done", name: "Done", group: "completed" },
  ],
  next_page_results: false,
};
const source: SourceConfig = {
  id: sourceId,
  databaseId: "project-1",
  projectId: "project-1",
  provider: "plane",
  workspaceSlug: "fixture",
  baseUrl: api,
  name: "Fixture project",
  properties: [
    { id: "name", name: "Name", type: "title" },
    { id: "target_date", name: "Target date", type: "date" },
    { id: "state", name: "State", type: "status", options: states.results },
  ],
  mapping: { title: "name", due: "target_date", status: "state", complete: "state-done", reopen: "state-open" },
};

function serviceFor(routes: Record<string, Response | (() => Response)>) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    const value = routes[key];
    if (!value) throw new Error(`Unexpected request: ${key}`);
    return typeof value === "function" ? value() : value;
  });
  return { service: new PlaneService("fixture-key", fetchImpl as typeof fetch, { apiBase: api, workspaceSlug: "fixture", webBase: "https://app.plane.so" }), fetchImpl };
}

describe("PlaneService", () => {
  it("resolves a project URL and preserves project state mappings", async () => {
    const { service, fetchImpl } = serviceFor({
      "GET /api/v1/workspaces/fixture/projects/project-1/": reply({ id: "project-1", name: "Fixture project" }),
      "GET /api/v1/workspaces/fixture/projects/project-1/states/?per_page=100": reply(states),
    });
    const [candidate] = await service.resolveSource("https://app.plane.so/fixture/projects/project-1/issues/123");
    expect(candidate).toMatchObject({ provider: "plane", workspaceSlug: "fixture", projectId: "project-1", name: "Fixture project" });
    expect(candidate.properties.find((property) => property.id === "state")?.options).toEqual(states.results);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ "X-API-Key": "fixture-key" });
  });

  it("lists paginated work items with collision-safe IDs, resolved state names, and a cloud web link", async () => {
    const item = { id: "work-item-1", name: "Write tests", state: "state-done", target_date: "2026-10-29", updated_at: "2026-10-28T12:00:00Z" };
    const { fetchImpl } = serviceFor({
      "GET /api/v1/workspaces/fixture/projects/project-1/": reply({ id: "project-1", name: "Fixture project" }),
      "GET /api/v1/workspaces/fixture/projects/project-1/states/?per_page=100": reply(states),
      "GET /api/v1/workspaces/fixture/projects/project-1/work-items/?per_page=100&expand=state": reply({ results: [item], next_page_results: false }),
    });
    const cloudService = new PlaneService("fixture-key", fetchImpl as typeof fetch, { apiBase: api, workspaceSlug: "fixture" });
    const tasks = await cloudService.listTasks(source);
    expect(tasks[0]).toMatchObject({ id: `${sourceId}::work-item-1`, sourceId: sourceId, status: "Done", completed: true, due: { start: "2026-10-29", end: null } });
    expect(tasks[0].url).toContain("/issues/work-item-1");
    expect(tasks[0].url).toContain("https://app.plane.so/");
  });

  it("stops pagination when Plane reports the final page even if next_cursor is stale", async () => {
    const first = { id: "work-item-1", name: "First", state: "state-open", target_date: null, updated_at: "2026-10-28T10:00:00Z" };
    const second = { id: "work-item-2", name: "Second", state: "state-done", target_date: null, updated_at: "2026-10-28T11:00:00Z" };
    const { service, fetchImpl } = serviceFor({
      "GET /api/v1/workspaces/fixture/projects/project-1/": reply({ id: "project-1", name: "Fixture project" }),
      "GET /api/v1/workspaces/fixture/projects/project-1/states/?per_page=100": reply(states),
      "GET /api/v1/workspaces/fixture/projects/project-1/work-items/?per_page=100&expand=state": reply({ results: [first], next_page_results: true, next_cursor: "cursor-1" }),
      "GET /api/v1/workspaces/fixture/projects/project-1/work-items/?per_page=100&cursor=cursor-1&expand=state": reply({ results: [second], next_page_results: false, next_cursor: "cursor-1" }),
    });
    const tasks = await service.listTasks(source);
    expect(tasks.map((task) => task.name)).toEqual(["First", "Second"]);
    expect(fetchImpl.mock.calls.filter((call) => String(call[0]).includes("work-items")).length).toBe(2);
  });

  it("rejects a saved source from a different Plane API endpoint before making a request", async () => {
    const { service, fetchImpl } = serviceFor({});
    const otherEndpoint = "https://plane.example.test/api/v1";
    const otherSource = { ...source, id: planeSourceId(otherEndpoint, "fixture", "project-1"), baseUrl: otherEndpoint };
    await expect(service.listTasks(otherSource)).rejects.toThrow(/different API endpoint/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("creates and updates only supported work-item fields", async () => {
    let current = { id: "work-item-2", name: "Old", state: { id: "state-open", name: "Open", group: "backlog" }, target_date: null, updated_at: "2026-10-28T12:00:00Z" };
    const { service, fetchImpl } = serviceFor({
      "GET /api/v1/workspaces/fixture/projects/project-1/": reply({ id: "project-1", name: "Fixture project" }),
      "GET /api/v1/workspaces/fixture/projects/project-1/states/?per_page=100": reply(states),
      "POST /api/v1/workspaces/fixture/projects/project-1/work-items/": () => reply({ id: "work-item-2" }, 201),
      "GET /api/v1/workspaces/fixture/projects/project-1/work-items/work-item-2/": () => reply(current),
      "PATCH /api/v1/workspaces/fixture/projects/project-1/work-items/work-item-2/": ( ) => { current = { ...current, name: "Renamed", state: { id: "state-done", name: "Done", group: "completed" } }; return reply(current); },
    });
    const created = await service.createTask(source, "Old");
    expect(created.id).toBe(`${sourceId}::work-item-2`);
    const createCall = fetchImpl.mock.calls.find((call) => call[1]?.method === "POST");
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ name: "Old", state: "state-open" });
    const updated = await service.updateTask(source, created.id, { name: "Renamed", status: "Done" }, created);
    expect(updated.task.name).toBe("Renamed");
    const patchCall = fetchImpl.mock.calls.find((call) => call[1]?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ name: "Renamed", state: "state-done" });
  });
});
