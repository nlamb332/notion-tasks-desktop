import { calendarKey, CalendarProviderError, type CalendarClient, type CalendarDefinition, type CalendarOwnership, type CalendarRange, type CalendarWriteInput, type RemoteCalendarEvent } from "../shared/calendar";
import { DateTime } from "luxon";

const API = "https://api.notion.com/v1";
const VERSION = "2025-09-03";
const MARKER_PREFIX = "NOTION_TASKS_CALENDAR_EVENT_V1:";
const MAX_PAGES = 1_000;
type Obj = Record<string, any>;

export interface NotionCalendarOptions {
  getToken: () => string | Promise<string>;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

function compact(id: string): string { return id.toLowerCase().replace(/-/g, ""); }
function sameId(a: unknown, b: string): boolean { return typeof a === "string" && compact(a) === compact(b); }
function richTextText(items: unknown): string {
  return Array.isArray(items) ? items.map((item: Obj) => String(item?.plain_text ?? item?.text?.content ?? "")).join("") : "";
}
function fail(message: string, code: ConstructorParameters<typeof CalendarProviderError>[1]): never { throw new CalendarProviderError(message, code); }
function safeError(status: number, action: string): CalendarProviderError {
  const code = status === 401 || status === 403 ? "unauthorized"
    : status === 404 ? "not-found"
      : status === 409 || status === 412 ? "conflict"
        : status === 408 || (status === 429 && action !== "event creation") ? "unavailable"
        : status >= 400 && status < 500 ? "invalid" : "unavailable";
  return new CalendarProviderError(`Notion ${action} failed (${status}).`, code);
}
function parseDate(value: unknown, calendarTimeZone: string): { start: string; end: string; allDay: boolean } {
  if (!value || typeof value !== "object" || typeof (value as Obj).start !== "string") fail("Notion event has a malformed date property.", "invalid");
  const date = value as Obj;
  const rawStart = String(date.start);
  const rawEnd = typeof date.end === "string" ? date.end : undefined;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(rawStart);
  const zone = typeof date.time_zone === "string" ? date.time_zone : calendarTimeZone;
  if (allDay) {
    if (rawEnd && !/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) fail("Notion event has mismatched all-day date boundaries.", "invalid");
    const start = DateTime.fromISO(rawStart, { zone }).startOf("day");
    const inclusiveEnd = DateTime.fromISO(rawEnd ?? rawStart, { zone }).startOf("day");
    const end = inclusiveEnd.plus({ days: 1 }).startOf("day");
    if (!start.isValid || !inclusiveEnd.isValid || !end.isValid || inclusiveEnd < start) fail("Notion event has an invalid all-day date range.", "invalid");
    return { start: start.toUTC().toISO({ suppressMilliseconds: true })!, end: end.toUTC().toISO({ suppressMilliseconds: true })!, allDay: true };
  }
  // Offsetless timed dates are local to the event's explicit zone, or its calendar zone.
  const start = DateTime.fromISO(rawStart, { zone });
  const end = rawEnd ? DateTime.fromISO(rawEnd, { zone }) : null;
  if (!start.isValid || !end?.isValid || end.toMillis() <= start.toMillis()) fail("Notion timed event has an invalid, missing, or zero-length end time.", "invalid");
  return { start: start.toUTC().toISO({ suppressMilliseconds: true })!, end: end.toUTC().toISO({ suppressMilliseconds: true })!, allDay: false };
}
function rangeInstants(range: CalendarRange, timeZone: string): [number, number] {
  if (!range || typeof range.start !== "string" || typeof range.end !== "string") fail("Calendar range is invalid.", "invalid");
  const start = DateTime.fromISO(range.start, { zone: timeZone });
  const end = DateTime.fromISO(range.end, { zone: timeZone });
  if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis()) fail("Calendar range is invalid.", "invalid");
  return [start.toMillis(), end.toMillis()];
}
function intersects(event: {start:string; end:string; allDay:boolean}, range: CalendarRange, timeZone: string): boolean {
  const [rs, re] = rangeInstants(range, timeZone);
  return Date.parse(event.start) < re && Date.parse(event.end) > rs;
}
function markerValue(ownership: CalendarOwnership): string {
  return `${MARKER_PREFIX}${JSON.stringify({ installationId: ownership.installationId, blockId: ownership.blockId, operationId: ownership.operationId })}`;
}
function parseOwnership(children: Obj[]): CalendarOwnership | undefined {
  for (const block of children) {
    const text = richTextText(block?.[block?.type]?.rich_text);
    if (!text.startsWith(MARKER_PREFIX)) continue;
    try {
      const parsed = JSON.parse(text.slice(MARKER_PREFIX.length));
      if ([parsed?.installationId, parsed?.blockId, parsed?.operationId].every((v) => typeof v === "string" && v.length > 0)) return parsed as CalendarOwnership;
    } catch { /* malformed markers are not ownership evidence */ }
  }
  return undefined;
}

export class NotionCalendarClient implements CalendarClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  constructor(private readonly options: NotionCalendarOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 3));
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 30_000);
  }

  async readEvents(calendar: CalendarDefinition, range: CalendarRange): Promise<RemoteCalendarEvent[]> {
    rangeInstants(range, calendar.timeZone);
    const schema = await this.schema(calendar);
    const results: Obj[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Obj = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = await this.request<Obj>(`/data_sources/${encodeURIComponent(calendar.id)}/query`, { method: "POST", body: JSON.stringify(body) });
      if (!Array.isArray(response?.results) || typeof response?.has_more !== "boolean") fail("Notion returned a malformed calendar page response.", "unavailable");
      for (const pageObj of response.results) {
        if (!pageObj || typeof pageObj !== "object") fail("Notion returned a malformed calendar event.", "unavailable");
        results.push(pageObj);
      }
      if (!response.has_more) {
        const overlapping = results.flatMap((pageObj) => {
        if (pageObj.archived || pageObj.in_trash) return [];
        const event = this.eventFromPage(pageObj, calendar, schema, undefined);
        return event && intersects(parseDate(this.property(pageObj, schema.date)?.date, calendar.timeZone), range, calendar.timeZone) ? [{ pageObj, event }] : [];
      });
        return Promise.all(overlapping.map(async ({ pageObj, event }) => {
          const ownership = await this.readOwnership(String(pageObj.id));
          return ownership ? { ...event, ownership } : event;
        }));
      }
      cursor = typeof response?.next_cursor === "string" && response.next_cursor ? response.next_cursor : undefined;
      if (!cursor) fail("Notion returned an incomplete calendar page sequence.", "unavailable");
    }
    fail("Notion calendar exceeds the safe pagination limit; no partial result was returned.", "unavailable");
  }

  async getEvent(calendar: CalendarDefinition, eventId: string): Promise<RemoteCalendarEvent | null> {
    const schema = await this.schema(calendar);
    let page: Obj;
    try { page = await this.request<Obj>(`/pages/${encodeURIComponent(eventId)}`); }
    catch (error) { if (error instanceof CalendarProviderError && error.code === "not-found") return null; throw error; }
    if (page?.archived || page?.in_trash) return null;
    this.assertParent(page, calendar);
    const ownership = await this.readOwnership(eventId);
    return this.eventFromPage(page, calendar, schema, ownership);
  }

  async createEvent(calendar: CalendarDefinition, input: CalendarWriteInput): Promise<RemoteCalendarEvent> {
    const schema = await this.schema(calendar, true);
    const properties = this.writeProperties(schema, input, calendar.timeZone);
    const body: Obj[] = [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: markerValue(input) } }] } }];
    if (input.taskUrl) body.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Original task", link: { url: input.taskUrl } } }] } });
    let created: Obj;
    try {
      created = await this.request<Obj>("/pages", { method: "POST", body: JSON.stringify({ parent: { type: "data_source_id", data_source_id: calendar.id }, properties, children: body }) });
    } catch (error) {
      if (error instanceof CalendarProviderError && error.code === "invalid" || error instanceof CalendarProviderError && error.code === "unauthorized" || error instanceof CalendarProviderError && error.code === "not-found") throw new CalendarProviderError("Notion rejected the event create request.", "not-created");
      throw new CalendarProviderError("Notion event creation outcome is unknown; reconcile before retrying.", "unknown-write");
    }
    if (typeof created?.id !== "string" || !created.id) throw new CalendarProviderError("Notion accepted the create request but returned no event ID; reconcile before retrying.", "unknown-write");
    try {
      this.assertParent(created, calendar);
      const readback = await this.getEvent(calendar, created.id);
      if (!readback) throw new Error("The created page is unavailable or no longer visible.");
      return readback;
    } catch {
      throw new CalendarProviderError("Notion accepted the event, but verification failed; reconcile before retrying.", "unknown-write");
    }
  }

  async updateEvent(calendar: CalendarDefinition, eventId: string, input: CalendarWriteInput, expectedVersion: string): Promise<RemoteCalendarEvent> {
    const schema = await this.schema(calendar, true);
    const current = await this.ownedPage(calendar, eventId, expectedVersion);
    if (current.ownership.installationId !== input.installationId || current.ownership.blockId !== input.blockId) fail("Notion event ownership no longer matches this approved block.", "conflict");
    const properties = this.writeProperties(schema, input, calendar.timeZone);
    try { await this.request(`/pages/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify({ properties }) }); }
    catch (error) { if (error instanceof CalendarProviderError && error.code === "conflict") throw error; throw new CalendarProviderError("Notion event update failed; verify the event before retrying.", "unknown-write"); }
    const updated = await this.getEvent(calendar, eventId);
    if (!updated) throw new CalendarProviderError("Updated Notion event could not be read back.", "unknown-write");
    return updated;
  }

  async deleteEvent(calendar: CalendarDefinition, eventId: string, expectedVersion: string): Promise<void> {
    await this.schema(calendar, true);
    let page: Obj;
    try { page = await this.request<Obj>(`/pages/${encodeURIComponent(eventId)}`); }
    catch (error) { if (error instanceof CalendarProviderError && error.code === "not-found") return; throw error; }
    this.assertParent(page, calendar);
    if (page.archived || page.in_trash) return;
    await this.ownedPage(calendar, eventId, expectedVersion);
    try { await this.request(`/pages/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify({ in_trash: true }) }); }
    catch (error) { if (error instanceof CalendarProviderError && error.code === "conflict") throw error; throw new CalendarProviderError("Notion event removal failed; verify the event before retrying.", "unknown-write"); }
  }

  private async schema(calendar: CalendarDefinition, write = false): Promise<{title:string; date:string}> {
    if (calendar.provider !== "notion" || !calendar.mapping?.title || !calendar.mapping.date || !calendar.id) fail("Notion calendar requires a data-source ID and explicit title/date property mapping.", "invalid");
    if (!calendar.canRead || (write && !calendar.canWrite)) fail("Notion calendar does not have the required read/write permission.", "unauthorized");
    const source = await this.request<Obj>(`/data_sources/${encodeURIComponent(calendar.id)}`);
    const properties = source?.properties;
    if (!properties || typeof properties !== "object") fail("Notion data-source schema is unavailable.", "invalid");
    const byId = (id: string) => Object.entries(properties).find(([key, value]: [string, any]) => key === id || value?.id === id || sameId(value?.id, id))?.[1] as Obj | undefined;
    if (byId(calendar.mapping.title)?.type !== "title" || byId(calendar.mapping.date)?.type !== "date") fail("Mapped Notion title/date properties are missing or have changed type.", "invalid");
    return { title: calendar.mapping.title, date: calendar.mapping.date };
  }

  private property(page: Obj, id: string): Obj | undefined { const values = page?.properties; return values?.[id] ?? Object.values(values ?? {}).find((p: any) => p?.id === id || sameId(p?.id, id)) as Obj | undefined; }
  private eventFromPage(page: Obj, calendar: CalendarDefinition, schema: {title:string; date:string}, ownership?: CalendarOwnership): RemoteCalendarEvent | null {
    if (!page || page.object !== "page" && !page.id) fail("Notion returned a malformed event page.", "invalid");
    this.assertParent(page, calendar);
    const title = this.property(page, schema.title);
    const dateProp = this.property(page, schema.date);
    if (!title || title.type !== "title" || !dateProp || dateProp.type !== "date") fail("Notion event no longer matches the mapped calendar schema.", "invalid");
    const name = richTextText(title.title);
    if (!dateProp.date) return null;
    if (!name) fail("Notion event has a date but no title.", "invalid");
    if (typeof page.id !== "string" || !page.id.trim() || typeof page.last_edited_time !== "string" || !page.last_edited_time.trim()) fail("Notion event is missing its ID or version.", "unavailable");
    const date = parseDate(dateProp.date, calendar.timeZone);
    return { ref: { calendarKey: calendarKey(calendar), id: String(page.id) }, title: name, start: date.start, end: date.end, ...(date.allDay ? { allDay: true } : {}), version: String(page.last_edited_time ?? ""), ...(typeof page.url === "string" ? { url: page.url } : {}), ...(ownership ? { ownership } : {}) };
  }
  private assertParent(page: Obj, calendar: CalendarDefinition): void {
    if (!sameId(page?.parent?.data_source_id, calendar.id)) fail("Notion event belongs to a different data source.", "invalid");
  }
  private async readOwnership(pageId: string): Promise<CalendarOwnership | undefined> {
    const children: Obj[] = []; let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const query = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
      const response = await this.request<Obj>(`/blocks/${encodeURIComponent(pageId)}/children?${query}`);
      if (!Array.isArray(response?.results) || typeof response?.has_more !== "boolean") fail("Notion returned a malformed event-body page response.", "unavailable");
      children.push(...response.results);
      if (!response.has_more) return parseOwnership(children);
      cursor = typeof response?.next_cursor === "string" ? response.next_cursor : undefined;
      if (!cursor) fail("Notion returned an incomplete event-body page sequence.", "unavailable");
    }
    fail("Notion event body exceeds the safe pagination limit.", "unavailable");
  }
  private async ownedPage(calendar: CalendarDefinition, eventId: string, expectedVersion: string): Promise<{page:Obj; ownership:CalendarOwnership}> {
    const page = await this.request<Obj>(`/pages/${encodeURIComponent(eventId)}`);
    this.assertParent(page, calendar);
    if (page.archived || page.in_trash) fail("Notion event has already been removed.", "not-found");
    if (String(page.last_edited_time ?? "") !== expectedVersion) fail("Notion event changed since it was read.", "conflict");
    const ownership = await this.readOwnership(eventId);
    if (!ownership) fail("Notion event has no valid app ownership marker.", "invalid");
    return { page, ownership };
  }
  private writeProperties(schema: {title:string; date:string}, input: CalendarWriteInput, timeZone: string): Obj {
    if (!input.title?.trim()) fail("Event title is required.", "invalid");
    const d = parseDate({ start: input.start, end: input.end }, timeZone);
    if (d.allDay) fail("Scheduled Notion events require timed start and end values.", "invalid");
    return { [schema.title]: { title: [{ type: "text", text: { content: input.title } }] }, [schema.date]: { date: { start: d.start, end: d.end === d.start ? null : d.end } } };
  }
  private async request<T = Obj>(path: string, init: RequestInit = {}): Promise<T> {
    let token = "";
    try { token = (await this.options.getToken()).trim(); } catch { fail("Notion credentials are unavailable.", "unauthorized"); }
    if (!token) fail("Notion credentials are unavailable.", "unauthorized");
    const isCreate = init.method === "POST" && path === "/pages";
    const isSafeRead = (init.method === undefined || init.method === "GET") || (init.method === "POST" && /^\/data_sources\/[^/]+\/query$/.test(path));
    let attempt = 0;
    while (true) {
      let response: Response;
      try { response = await this.fetchImpl(`${API}${path}`, { signal: AbortSignal.timeout(20_000), ...init, headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json", ...(init.headers ?? {}) } }); }
      catch { throw new CalendarProviderError("Notion request could not be completed.", "unavailable"); }
      if (response.status === 429 && isSafeRead && attempt < this.maxRetries) {
        const retryAfter = response.headers.get("Retry-After");
        const parsedSeconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
        const seconds = Number.isFinite(parsedSeconds)
          ? parsedSeconds
          : retryAfter
            ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1_000)
            : 0;
        const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : Math.min(this.maxRetryDelayMs, 500 * 2 ** attempt);
        if (delay > this.maxRetryDelayMs) throw safeError(429, "request");
        attempt += 1;
        if (delay) await this.sleep(delay);
        continue;
      }
      if (!response.ok) throw safeError(response.status, isCreate ? "event creation" : "request");
      if (response.status === 204) return undefined as T;
      try { return await response.json() as T; } catch { throw new CalendarProviderError("Notion returned an unreadable response.", "unavailable"); }
    }
  }
}
