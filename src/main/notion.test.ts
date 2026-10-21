import { describe, expect, it, vi } from "vitest";
import type { SourceConfig, Task } from "../shared/types";
import { mapSource, NotionSchemaChangedError, NotionService } from "./notion";

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

function sourceResponse() {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    parent: { database_id: "11111111-2222-3333-4444-555555555555" },
    title: [{ plain_text: "Tasks" }],
    properties: {
      "title-id": { id: "title-id", name: "Task", type: "title", title: {} },
      "due-id": { id: "due-id", name: "Due Date", type: "date", date: {} },
      "status-id": {
        id: "status-id",
        name: "Status",
        type: "select",
        select: { options: [{ id: "done-id", name: "Done" }, { id: "open-id", name: "Not started" }] },
      },
    },
  };
}

function page(id: string, name: string, due: any = null, status = "Not started") {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: "2026-10-21T12:00:00.000Z",
    properties: {
      "title-id": { id: "title-id", type: "title", title: [{ plain_text: name }] },
      "due-id": { id: "due-id", type: "date", date: due },
      "status-id": { id: "status-id", type: "select", select: status ? { id: status === "Done" ? "done-id" : "open-id", name: status } : null },
    },
  };
}

function serviceFor(routes: Record<string, Response | (() => Response)>, options: any = {}) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}${new URL(String(input)).search}`;
    const value = routes[key];
    if (!value) throw new Error(`Unexpected request: ${key}`);
    return typeof value === "function" ? value() : value;
  });
  return { service: new NotionService("secret", fetchImpl as typeof fetch, options), fetchImpl };
}

describe("NotionService", () => {
  it("resolves a database URL into every data source", async () => {
    const { service } = serviceFor({
      "GET /v1/databases/11111111-2222-3333-4444-555555555555": reply({
        id: "11111111-2222-3333-4444-555555555555",
        title: [{ plain_text: "Workspace" }],
        data_sources: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Tasks" }, { id: "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb", name: "Other" }],
      }),
      "GET /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": reply(sourceResponse()),
      "GET /v1/data_sources/ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb": reply({ id: "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb", parent: { database_id: "11111111-2222-3333-4444-555555555555" }, title: [{ plain_text: "Other" }], properties: {} }),
    });

    const result = await service.resolveSource("https://www.notion.so/workspace/Workspace-11111111222233334444555555555555");
    expect(result.map((candidate) => candidate.id)).toEqual(["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb"]);
    expect(result[0].properties.map((property) => property.name)).toEqual(["Task", "Due Date", "Status"]);
  });

  it("follows a task page parent data source", async () => {
    const { service } = serviceFor({
      "GET /v1/pages/99999999-8888-7777-6666-555555555555": reply({ id: "99999999-8888-7777-6666-555555555555", parent: { data_source_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } }),
      "GET /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": reply(sourceResponse()),
    });
    const result = await service.resolveSource("https://app.notion.com/p/99999999-8888-7777-6666-555555555555");
    expect(result[0].databaseId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("enumerates child databases on an ordinary page", async () => {
    const { service } = serviceFor({
      "GET /v1/pages/99999999-8888-7777-6666-555555555555": reply({ id: "99999999-8888-7777-6666-555555555555", parent: { type: "page_id", page_id: "root" } }),
      "GET /v1/blocks/99999999-8888-7777-6666-555555555555/children?page_size=100": reply({ results: [{ id: "11111111-2222-3333-4444-555555555555", type: "child_database", child_database: { title: "Tasks" } }], has_more: false }),
      "GET /v1/databases/11111111-2222-3333-4444-555555555555": reply({ id: "11111111-2222-3333-4444-555555555555", data_sources: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }] }),
      "GET /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": reply(sourceResponse()),
    });
    const result = await service.resolveSource("https://app.notion.com/p/99999999888877776666555555555555");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("paginates queries and preserves date-only and time-bearing date values", async () => {
    const date = { start: "2026-10-21T09:30:00-05:00", end: "2026-10-21T10:00:00-05:00", time_zone: "America/Chicago" };
    const { service, fetchImpl } = serviceFor({
      "GET /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": reply(sourceResponse()),
      "POST /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/query": vi.fn()
        .mockReturnValueOnce(reply({ results: [page("77777777-6666-5555-4444-333333333333", "First", date)], has_more: true, next_cursor: "next" }))
        .mockReturnValueOnce(reply({ results: [page("88888888-7777-6666-5555-444444444444", "Second", { start: "2026-10-22", end: null })], has_more: false })),
    });
    const tasks = await service.listTasks({ ...sourceResponse(), id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", databaseId: "11111111-2222-3333-4444-555555555555", name: "Tasks", properties: sourceResponse().properties as any });
    expect(tasks[0].due).toEqual(date);
    expect(tasks[1].due).toEqual({ start: "2026-10-22", end: null });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("creates with mapped properties only and re-reads the page", async () => {
    const { service, fetchImpl } = serviceFor({
      "GET /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": reply(sourceResponse()),
      "POST /v1/pages": reply({ id: "77777777-6666-5555-4444-333333333333" }),
      "GET /v1/pages/77777777-6666-5555-4444-333333333333": reply(page("77777777-6666-5555-4444-333333333333", "New task", null, "Not started")),
    });
    const source = { ...sourceResponse(), id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", databaseId: "11111111-2222-3333-4444-555555555555", name: "Tasks", properties: sourceResponse().properties as any };
    const task = await service.createTask(source, "New task");
    expect(task.name).toBe("New task");
    const createCall = fetchImpl.mock.calls.find((call) => String(call[1]?.method) === "POST")!;
    const body = JSON.parse(String(createCall[1]?.body));
    expect(body.parent).toEqual({ data_source_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    expect(Object.keys(body.properties).sort()).toEqual(["status-id", "title-id"]);
    expect(body.properties["status-id"]).toEqual({ select: { id: "open-id" } });
  });

  it("returns the current task when an edited field changed before the write", async () => {
    const source = { ...sourceResponse(), id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", databaseId: "11111111-2222-3333-4444-555555555555", name: "Tasks", properties: sourceResponse().properties as any };
    const expected: Task = {
      id: "77777777-6666-5555-4444-333333333333", sourceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Old", url: "https://www.notion.so/task-1", due: null,
      status: "Not started", completed: false, lastEdited: "2026-10-20T12:00:00.000Z",
    };
    const { service, fetchImpl } = serviceFor({
      "GET /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": reply(sourceResponse()),
      "GET /v1/pages/77777777-6666-5555-4444-333333333333": reply(page("77777777-6666-5555-4444-333333333333", "Changed", null, "Not started")),
    });
    const result = await service.updateTask(source, "77777777-6666-5555-4444-333333333333", { name: "My edit" }, expected);
    expect(result.conflict).toBe(true);
    expect(result.task.name).toBe("Changed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.some((call) => String(call[1]?.method) === "PATCH")).toBe(false);
  });

  it("updates only mapped title, date, and status properties", async () => {
    const source = { ...sourceResponse(), id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", databaseId: "11111111-2222-3333-4444-555555555555", name: "Tasks", properties: sourceResponse().properties as any };
    const due = { start: "2026-10-23", end: null };
    const expected: Task = {
      id: "77777777-6666-5555-4444-333333333333", sourceId: source.id, name: "Old", url: "https://www.notion.so/task-1", due: null,
      status: "Not started", completed: false, lastEdited: "2026-10-20T12:00:00.000Z",
    };
    const { service, fetchImpl } = serviceFor({
      "GET /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": reply(sourceResponse()),
      "GET /v1/pages/77777777-6666-5555-4444-333333333333": vi.fn()
        .mockReturnValueOnce(reply(page("77777777-6666-5555-4444-333333333333", "Old", null, "Not started")))
        .mockReturnValueOnce(reply(page("77777777-6666-5555-4444-333333333333", "Renamed", due, "Done"))),
      "PATCH /v1/pages/77777777-6666-5555-4444-333333333333": reply({ id: "77777777-6666-5555-4444-333333333333" }),
    });
    const result = await service.updateTask(source, expected.id, { name: "Renamed", due, status: "Done" }, expected);
    expect(result.task.name).toBe("Renamed");
    const patchCall = fetchImpl.mock.calls.find((call) => String(call[1]?.method) === "PATCH")!;
    const body = JSON.parse(String(patchCall[1]?.body));
    expect(Object.keys(body.properties).sort()).toEqual(["due-id", "status-id", "title-id"]);
    expect(body.properties["due-id"]).toEqual({ date: due });
    expect(body.properties["status-id"]).toEqual({ select: { id: "done-id" } });
  });

  it("detects a remapped property before querying or editing", async () => {
    const source: SourceConfig = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", databaseId: "11111111-2222-3333-4444-555555555555", name: "Tasks", properties: [],
      mapping: { title: "old-title", due: "due-id", status: "status-id", complete: "done-id", reopen: "open-id" },
    };
    const { service } = serviceFor({ "GET /v1/data_sources/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": reply(sourceResponse()) });
    await expect(service.listTasks(source)).rejects.toBeInstanceOf(NotionSchemaChangedError);
  });

  it("honors Retry-After for retryable rate limits", async () => {
    const sleep = vi.fn(async () => undefined);
    const { service, fetchImpl } = serviceFor({
      "GET /v1/users/me": vi.fn()
        .mockReturnValueOnce(reply({ message: "slow down" }, 429, { "Retry-After": "0.05" }))
        .mockReturnValueOnce(reply({ id: "user-1" })),
    }, { sleep, maxRetryDelayMs: 100 });
    await service.validate();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Notion-Version"]).toBe("2025-09-03");
  });

  it("defers excessive Retry-After rather than retrying too early", async () => {
    const sleep = vi.fn(async () => undefined);
    const { service, fetchImpl } = serviceFor({ "GET /v1/users/me": reply({ message: "slow down" }, 429, { "Retry-After": "60" }) }, { sleep, maxRetryDelayMs: 100 });
    await expect(service.validate()).rejects.toThrow("429");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps the exact Status property and ignores a similarly named Status 1 field", () => {
    const source: any = sourceResponse();
    source.properties = {
      ...source.properties,
      "status-1-id": {
        id: "status-1-id", name: "Status 1", type: "select",
        select: { options: [{ id: "wrong-done", name: "Done" }, { id: "wrong-open", name: "Not started" }] },
      },
    };
    const candidate = {
      id: source.id,
      databaseId: source.parent.database_id,
      name: "Tasks",
      properties: Object.entries(source.properties).map(([id, value]: [string, any]) => ({
        id, name: value.name, type: value.type, options: value.select?.options,
      })),
    };
    const mapped = mapSource(candidate);
    expect(mapped.mapping.status).toBe("status-id");
    expect(mapped.mapping.complete).toBe("done-id");
    expect(mapped.mapping.reopen).toBe("open-id");
  });
});


