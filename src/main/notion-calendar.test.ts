import { describe, expect, it, vi } from "vitest";
import { CalendarProviderError, calendarKey, type CalendarDefinition } from "../shared/calendar";
import { NotionCalendarClient } from "./notion-calendar";

const cal: CalendarDefinition = { provider: "notion", id: "source-1", name: "Events", timeZone: "America/Chicago", canRead: true, canWrite: true, mapping: { title: "title-id", date: "date-id" } };
const schema = { object: "data_source", properties: { Name: { id: "title-id", type: "title" }, When: { id: "date-id", type: "date" }, Extra: { id: "extra-id", type: "rich_text" } } };
function page(id: string, start: string | null, end?: string | null, other: any = {}) {
  return { object: "page", id, url: `https://notion.so/${id}`, parent: { type: "data_source_id", data_source_id: "source-1" }, last_edited_time: "2026-10-30T12:00:00Z", properties: { Name: { id: "title-id", type: "title", title: [{ plain_text: id }] }, When: { id: "date-id", type: "date", date: start ? { start, ...(end ? { end } : {}) } : null }, Extra: { id: "extra-id", type: "rich_text", rich_text: [{ plain_text: "keep me" }] }, ...other } };
}
function mockFetch(routes: (url: URL, init: RequestInit) => any) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const data = routes(new URL(String(input)), init);
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}
function client(fetchImpl: typeof fetch) { return new NotionCalendarClient({ getToken: () => "secret", fetch: fetchImpl }); }
const ownership = { installationId: "install", blockId: "block", operationId: "op" };
function markerChildren() { return { results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: `NOTION_TASKS_CALENDAR_EVENT_V1:${JSON.stringify(ownership)}` }] } }], has_more: false }; }

describe("NotionCalendarClient", () => {
  it("reads all pages and filters actual overlap, retaining long-running and overnight/all-day events", async () => {
    let query = 0;
    const fetchImpl = mockFetch((url) => {
      if (url.pathname === "/v1/data_sources/source-1") return schema;
      if (url.pathname.endsWith("/query")) {
        query++;
        return query === 1
          ? { results: [page("long", "2026-10-29T22:00:00-05:00", "2026-10-30T02:00:00-05:00"), page("empty", null)], has_more: true, next_cursor: "next" }
          : { results: [page("day", "2026-10-30"), page("outside", "2026-10-31T06:00:00Z", "2026-10-31T07:00:00Z")], has_more: false };
      }
      if (url.pathname.endsWith("/children")) return { results: [], has_more: false };
      throw new Error(url.href);
    });
    const events = await client(fetchImpl).readEvents(cal, { start: "2026-10-30T00:00:00-05:00", end: "2026-10-31T00:00:00-05:00" });
    expect(events.map((e) => e.ref.id)).toEqual(["long", "day"]);
    expect(query).toBe(2);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("api.notion.com/v1/data_sources/source-1"), expect.objectContaining({ headers: expect.objectContaining({ "Notion-Version": "2025-09-03", Authorization: "Bearer secret" }) }));
    expect(events[0].ref.calendarKey).toBe(calendarKey(cal));
  });

  it("compares timed intervals across the Chicago fall-back DST hour", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.pathname.endsWith("/data_sources/source-1")) return schema;
      if (url.pathname.endsWith("/query")) return { results: [page("fold", "2026-11-01T01:30:00-05:00", "2026-11-01T01:30:00-06:00")], has_more: false };
      if (url.pathname.endsWith("/children")) return { results: [], has_more: false };
      throw new Error(url.href);
    });
    const events = await client(fetchImpl).readEvents(cal, { start: "2026-11-01T00:00:00-05:00", end: "2026-11-02T00:00:00-06:00" });
    expect(events.map((event) => event.ref.id)).toEqual(["fold"]);
    expect(Date.parse(events[0].end) - Date.parse(events[0].start)).toBe(60 * 60 * 1000);
  });

  it("uses the Notion event time_zone and includes the selected date-only end day", async () => {
    const eventPage = page("all-day-range", "2026-10-30", "2026-10-31");
    eventPage.properties.When.date.time_zone = "Asia/Tokyo";
    const fetchImpl = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname.endsWith("/query") ? { results: [eventPage], has_more: false } : url.pathname.endsWith("/children") ? { results: [], has_more: false } : {});
    const events = await client(fetchImpl).readEvents(cal, { start: "2026-10-31T00:00:00-05:00", end: "2026-11-01T00:00:00-06:00" });
    expect(events).toHaveLength(1);
    expect(events[0].allDay).toBe(true);
    expect(events[0].start).toBe("2026-10-29T15:00:00Z");
    // Conservatively count Notion's selected end date as busy.
    expect(events[0].end).toBe("2026-10-31T15:00:00Z");
  });

  it("fails visibly for a timed point without a known end duration", async () => {
    const fetchImpl = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname.endsWith("/query") ? { results: [page("point", "2026-10-30T09:00:00")], has_more: false } : {});
    await expect(client(fetchImpl).readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" })).rejects.toMatchObject({ code: "invalid" });
    const zero = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname.endsWith("/query") ? { results: [page("zero", "2026-10-30T09:00:00Z", "2026-10-30T09:00:00Z")], has_more: false } : {});
    await expect(client(zero).readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("returns null for deleted pages and makes repeated delete idempotent without reading the body", async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch((url) => {
      calls.push(url.pathname);
      if (url.pathname.endsWith("/data_sources/source-1")) return schema;
      if (url.pathname.endsWith("/query")) return { results: [{ ...page("gone", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z"), archived: true }, { ...page("trashed", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z"), in_trash: true }], has_more: false };
      if (url.pathname === "/v1/pages/gone") return { ...page("gone", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z"), archived: true };
      if (url.pathname === "/v1/pages/trashed") return { ...page("trashed", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z"), in_trash: true };
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const instance = client(fetchImpl);
    expect(await instance.getEvent(cal, "gone")).toBeNull();
    await instance.deleteEvent(cal, "trashed", "old-version");
    const events = await instance.readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" });
    expect(events).toEqual([]);
    expect(calls.filter((path) => path.endsWith("/children"))).toEqual([]);
    expect(calls.filter((path) => path.includes("/pages/")).length).toBe(2);
  });

  it("rejects malformed pagination responses and events missing ID/version", async () => {
    const missingResults = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname.endsWith("/query") ? { has_more: false } : {});
    await expect(client(missingResults).readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" })).rejects.toMatchObject({ code: "unavailable" });
    const missingHasMore = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname.endsWith("/query") ? { results: [] } : {});
    await expect(client(missingHasMore).readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" })).rejects.toMatchObject({ code: "unavailable" });
    const missingVersion = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname.endsWith("/query") ? { results: [{ ...page("no-version", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z"), last_edited_time: "" }], has_more: false } : {});
    await expect(client(missingVersion).readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" })).rejects.toMatchObject({ code: "unavailable" });
    const missingId = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname.endsWith("/query") ? { results: [{ ...page("with-id", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z"), id: "" }], has_more: false } : {});
    await expect(client(missingId).readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("returns operation ownership from overlapping events for explicit reconciliation", async () => {
    const fetchImpl = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema
      : url.pathname.endsWith("/query") ? { results: [page("candidate", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z")], has_more: false }
        : url.pathname.endsWith("/children") ? markerChildren() : {});
    const events = await client(fetchImpl).readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" });
    expect(events[0].ownership).toEqual(ownership);
  });

  it("creates a page in the mapped data source with exact IDs, dates and ownership marker", async () => {
    const requests: Array<{ path: string; body?: any }> = [];
    const fetchImpl = mockFetch((url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/v1/data_sources/source-1") return schema;
      if (url.pathname === "/v1/pages" && init.method === "POST") return { ...page("created", body.properties["date-id"].date.start, body.properties["date-id"].date.end), parent: { data_source_id: body.parent.data_source_id } };
      if (url.pathname === "/v1/pages/created") return page("created", "2026-10-30T09:00:00-05:00", "2026-10-30T10:00:00-05:00");
      if (url.pathname === "/v1/blocks/created/children") return markerChildren();
      throw new Error(url.href);
    });
    const result = await client(fetchImpl).createEvent(cal, { ...ownership, title: "Meet", start: "2026-10-30T09:00:00-05:00", end: "2026-10-30T10:00:00-05:00", taskUrl: "https://notion.so/task" });
    expect(result.ref.id).toBe("created");
    expect(result.ownership).toEqual(ownership);
    const body = requests.find((r) => r.path === "/v1/pages")!.body;
    expect(body.parent).toEqual({ type: "data_source_id", data_source_id: "source-1" });
    expect(body.properties).toEqual({ "title-id": { title: [{ type: "text", text: { content: "Meet" } }] }, "date-id": { date: { start: "2026-10-30T14:00:00Z", end: "2026-10-30T15:00:00Z" } } });
    expect(body.children[0].paragraph.rich_text[0].text.content).toBe(`NOTION_TASKS_CALENDAR_EVENT_V1:${JSON.stringify(ownership)}`);
    expect(body.children[1].paragraph.rich_text[0].text.link.url).toBe("https://notion.so/task");
  });

  it("rejects changed mappings, wrong parents, and unowned writes", async () => {
    const wrongSchema = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? { ...schema, properties: { Name: { id: "title-id", type: "rich_text" }, When: { id: "date-id", type: "date" } } } : {});
    await expect(client(wrongSchema).readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" })).rejects.toMatchObject({ code: "invalid" });
    const fetchImpl = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname === "/v1/pages/e1" ? { ...page("e1", "2026-10-30T09:00:00Z"), parent: { data_source_id: "other" } } : {});
    await expect(client(fetchImpl).getEvent(cal, "e1")).rejects.toMatchObject({ code: "invalid" });
    const unowned = mockFetch((url) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname === "/v1/pages/e1" ? page("e1", "2026-10-30T09:00:00Z") : { results: [], has_more: false });
    await expect(client(unowned).deleteEvent(cal, "e1", "2026-10-30T12:00:00Z")).rejects.toMatchObject({ code: "invalid" });
  });

  it("preserves unrelated properties during update and rejects stale versions", async () => {
    let mutation: any;
    const fetchImpl = mockFetch((url, init) => {
      if (url.pathname.endsWith("/data_sources/source-1")) return schema;
      if (url.pathname === "/v1/pages/e1" && init.method === "PATCH") { mutation = JSON.parse(String(init.body)); return {}; }
      if (url.pathname === "/v1/pages/e1") return page("e1", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z");
      if (url.pathname.endsWith("/children")) return markerChildren();
      throw new Error(url.href);
    });
    const result = await client(fetchImpl).updateEvent(cal, "e1", { ...ownership, title: "Changed", start: "2026-10-30T11:00:00Z", end: "2026-10-30T12:00:00Z" }, "2026-10-30T12:00:00Z");
    expect(result.ref.id).toBe("e1");
    expect(mutation.properties).toEqual({ "title-id": expect.any(Object), "date-id": expect.any(Object) });
    expect(mutation.properties["extra-id"]).toBeUndefined();
    const staleFetch = mockFetch((url, init) => url.pathname.endsWith("/data_sources/source-1") ? schema : url.pathname === "/v1/pages/e1" ? { ...page("e1", "2026-10-30T09:00:00Z"), last_edited_time: "later" } : markerChildren());
    await expect(client(staleFetch).deleteEvent(cal, "e1", "before")).rejects.toMatchObject({ code: "conflict" });
    const changedOwner = { installationId: "elsewhere", blockId: "other-block", operationId: "op" };
    const wrongOwnerFetch = mockFetch((url, init) => {
      if (url.pathname.endsWith("/data_sources/source-1")) return schema;
      if (url.pathname === "/v1/pages/e1" && init.method === "PATCH") return {};
      if (url.pathname === "/v1/pages/e1") return page("e1", "2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z");
      if (url.pathname.endsWith("/children")) return { results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: `NOTION_TASKS_CALENDAR_EVENT_V1:${JSON.stringify(changedOwner)}` }] } }], has_more: false };
      throw new Error(url.href);
    });
    await expect(client(wrongOwnerFetch).updateEvent(cal, "e1", { ...ownership, title: "Changed", start: "2026-10-30T11:00:00Z", end: "2026-10-30T12:00:00Z" }, "2026-10-30T12:00:00Z")).rejects.toMatchObject({ code: "conflict" });
  });

  it("classifies uncertain creates and never retries POST", async () => {
    let attempts = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/data_sources/source-1")) return new Response(JSON.stringify(schema));
      attempts++;
      throw new TypeError("network interrupted");
    }) as typeof fetch;
    const err = await client(fetchImpl).createEvent(cal, { ...ownership, title: "Meet", start: "2026-10-30T09:00:00Z", end: "2026-10-30T10:00:00Z" }).catch((e) => e as CalendarProviderError);
    expect(err).toMatchObject({ code: "unknown-write" });
    expect(attempts).toBe(1);
  });

  it("keeps successful creates unknown when readback fails and treats HTTP 408 as ambiguous", async () => {
    for (const failure of ["unauthorized", "network"] as const) {
      let creates = 0;
      const fetchImpl = mockFetch((url, init) => {
        if (url.pathname.endsWith("/data_sources/source-1")) return schema;
        if (url.pathname === "/v1/pages" && init.method === "POST") { creates++; return page("created", "2026-10-30T14:00:00Z", "2026-10-30T15:00:00Z"); }
        if (url.pathname === "/v1/pages/created") {
          if (failure === "network") throw new TypeError("connection dropped");
          return new Response("{}", { status: 401 });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      await expect(client(fetchImpl).createEvent(cal, { ...ownership, title: "Meet", start: "2026-10-30T09:00:00Z", end: "2026-10-30T10:00:00Z" })).rejects.toMatchObject({ code: "unknown-write" });
      expect(creates).toBe(1);
    }

    let creates = 0;
    const timeoutFetch = mockFetch((url, init) => {
      if (url.pathname.endsWith("/data_sources/source-1")) return schema;
      if (url.pathname === "/v1/pages" && init.method === "POST") { creates++; return new Response("{}", { status: 408 }); }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    await expect(client(timeoutFetch).createEvent(cal, { ...ownership, title: "Meet", start: "2026-10-30T09:00:00Z", end: "2026-10-30T10:00:00Z" })).rejects.toMatchObject({ code: "unknown-write" });
    expect(creates).toBe(1);
  });

  it("retries 429 responses for safe reads with bounded Retry-After, but never retries page creation", async () => {
    let queryCalls = 0;
    const delays: number[] = [];
    const readFetch = mockFetch((url) => {
      if (url.pathname.endsWith("/data_sources/source-1")) return schema;
      if (url.pathname.endsWith("/query")) {
        queryCalls++;
        if (queryCalls === 1) return new Response("{}", { status: 429, headers: { "Retry-After": "2" } });
        return { results: [], has_more: false };
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const reader = new NotionCalendarClient({ getToken: () => "secret", fetch: readFetch, sleep: async (ms) => { delays.push(ms); } });
    await expect(reader.readEvents(cal, { start: "2026-10-30T00:00:00Z", end: "2026-10-31T00:00:00Z" })).resolves.toEqual([]);
    expect(queryCalls).toBe(2);
    expect(delays).toEqual([2_000]);

    let createCalls = 0;
    const createDelays: number[] = [];
    const createFetch = mockFetch((url, init) => {
      if (url.pathname.endsWith("/data_sources/source-1")) return schema;
      if (url.pathname === "/v1/pages" && init.method === "POST") { createCalls++; return new Response("{}", { status: 429, headers: { "Retry-After": "1" } }); }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const writer = new NotionCalendarClient({ getToken: () => "secret", fetch: createFetch, sleep: async (ms) => { createDelays.push(ms); } });
    await expect(writer.createEvent(cal, { ...ownership, title: "Meet", start: "2026-10-30T09:00:00Z", end: "2026-10-30T10:00:00Z" })).rejects.toMatchObject({ code: "not-created" });
    expect(createCalls).toBe(1);
    expect(createDelays).toEqual([]);
  });
});
