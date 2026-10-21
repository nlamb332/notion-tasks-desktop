import { describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../shared/types";
import { NotionService } from "../main/notion";

function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const sourceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const databaseId = "11111111-2222-3333-4444-555555555555";
const firstTaskId = "77777777-6666-5555-4444-333333333333";
const secondTaskId = "88888888-7777-6666-5555-444444444444";

const sourceResponse = () => ({
  id: sourceId,
  parent: { database_id: databaseId },
  title: [{ plain_text: "Tasks" }],
  properties: {
    "title-id": { id: "title-id", name: "Task", type: "title", title: {} },
    "due-id": { id: "due-id", name: "Due", type: "date", date: {} },
    "status-id": {
      id: "status-id",
      name: "Progress",
      type: "status",
      status: {
        options: [
          { id: "finished-id", name: "Finished" },
          { id: "queued-id", name: "Queued" },
        ],
      },
    },
  },
});

function page(id: string, name: string, status: { id: string; name: string }) {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: "2026-10-21T12:00:00.000Z",
    properties: {
      "title-id": { id: "title-id", type: "title", title: [{ plain_text: name }] },
      "due-id": { id: "due-id", type: "date", date: { start: "2026-10-21", end: null } },
      "status-id": { id: "status-id", type: "status", status },
    },
  };
}

function serviceFor(routes: Record<string, Response | (() => Response)>) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${request.pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`Unexpected request: ${key}`);
    return typeof route === "function" ? route() : route;
  });
  return { service: new NotionService("secret", fetchImpl as typeof fetch), fetchImpl };
}

describe("Notion boundary contracts", () => {
  it("keeps page IDs and custom native status completion across read and update", async () => {
    const source: SourceConfig = {
      id: sourceId,
      databaseId,
      name: "Tasks",
      properties: [
        { id: "title-id", name: "Task", type: "title" },
        { id: "due-id", name: "Due", type: "date" },
        {
          id: "status-id",
          name: "Progress",
          type: "status",
          options: [
            { id: "finished-id", name: "Finished" },
            { id: "queued-id", name: "Queued" },
          ],
        },
      ],
      mapping: {
        title: "title-id",
        due: "due-id",
        status: "status-id",
        complete: "finished-id",
        reopen: "queued-id",
      },
    };
    const expected = {
      id: firstTaskId,
      sourceId,
      name: "Same name",
      url: `https://www.notion.so/${firstTaskId}`,
      due: { start: "2026-10-21", end: null },
      status: "Finished",
      completed: true,
      lastEdited: "2026-10-21T12:00:00.000Z",
    };
    const { service, fetchImpl } = serviceFor({
      [`GET /v1/data_sources/${sourceId}`]: reply(sourceResponse()),
      [`POST /v1/data_sources/${sourceId}/query`]: reply({
        results: [
          page(firstTaskId, "Same name", { id: "finished-id", name: "Finished" }),
          page(secondTaskId, "Same name", { id: "queued-id", name: "Queued" }),
        ],
        has_more: false,
      }),
      [`GET /v1/pages/${firstTaskId}`]: vi
        .fn()
        .mockReturnValueOnce(reply(page(firstTaskId, "Same name", { id: "finished-id", name: "Finished" })))
        .mockReturnValueOnce(reply(page(firstTaskId, "Renamed", { id: "finished-id", name: "Finished" }))),
      [`PATCH /v1/pages/${firstTaskId}`]: reply({ id: firstTaskId }),
    });

    const tasks = await service.listTasks(source);
    expect(tasks.map((task) => task.id)).toEqual([firstTaskId, secondTaskId]);
    expect(tasks[0]).toMatchObject({ sourceId, status: "Finished", completed: true });
    expect(tasks[1]).toMatchObject({ sourceId, status: "Queued", completed: false });

    const result = await service.updateTask(source, firstTaskId, { name: "Renamed", status: "Finished" }, expected);
    expect(result.task.id).toBe(firstTaskId);
    const patch = fetchImpl.mock.calls.find((call) => String(call[1]?.method) === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch?.[1]?.body)).properties["status-id"]).toEqual({ status: { id: "finished-id" } });
  });
});
