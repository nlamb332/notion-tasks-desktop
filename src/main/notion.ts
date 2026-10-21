import type {
  PropertyInfo,
  SourceCandidate,
  SourceConfig,
  Task,
  TaskChanges,
  TaskDate,
  UpdateResult,
} from "../shared/types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;

type JsonRecord = Record<string, any>;
type FetchImpl = typeof fetch;

export interface NotionServiceOptions {
  apiBase?: string;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class NotionHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    super(`Notion API request failed (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "NotionHttpError";
    this.status = status;
    this.body = body;
  }
}

export class NotionSchemaChangedError extends Error {
  readonly sourceId: string;
  readonly mapping: SourceConfig["mapping"];

  constructor(sourceId: string, mapping: SourceConfig["mapping"], message: string) {
    super(message);
    this.name = "NotionSchemaChangedError";
    this.sourceId = sourceId;
    this.mapping = mapping;
  }
}

export class NotionConflictError extends Error {
  readonly task: Task;

  constructor(task: Task) {
    super("The task changed in Notion before the edit was applied.");
    this.name = "NotionConflictError";
    this.task = task;
  }
}

interface NormalizedProperty extends PropertyInfo {
  rawType?: string;
}

interface SourceWithMapping extends SourceCandidate {
  mapping?: SourceConfig["mapping"];
}

interface SchemaSnapshot {
  candidate: SourceCandidate;
  mapping: SourceConfig["mapping"];
}

function canonicalId(value: string): string {
  const compact = value.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(compact)) return value;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function compactId(value: string): string {
  return value.toLowerCase().replace(/-/g, "");
}

function idsEqual(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && compactId(a) === compactId(b);
}

function textFromRichText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item: JsonRecord) => item?.plain_text ?? item?.text?.content ?? "")
    .join("");
}

function titleFromObject(value: unknown): string {
  return textFromRichText(value);
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optionName(option: JsonRecord): string {
  return String(option?.name ?? "");
}

function optionId(option: JsonRecord): string {
  return String(option?.id ?? option?.name ?? "");
}

function propertyOptions(value: JsonRecord): { id: string; name: string; group?: string }[] {
  const options = value?.type === "status" ? value?.status?.options : value?.select?.options;
  if (!Array.isArray(options)) return [];
  return options.map((option: JsonRecord) => ({
    id: optionId(option),
    name: optionName(option),
    ...(option?.group ? { group: String(option.group) } : {}),
  }));
}

function normalizeProperty(key: string, value: JsonRecord): NormalizedProperty {
  const type = String(value?.type ?? "");
  return {
    id: String(value?.id ?? key),
    name: String(value?.name ?? key),
    type,
    ...(propertyOptions(value).length ? { options: propertyOptions(value) } : {}),
    rawType: type,
  };
}

function normalizeProperties(properties: JsonRecord | undefined): NormalizedProperty[] {
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties).map(([key, value]) => normalizeProperty(key, value as JsonRecord));
}

function findProperty(properties: NormalizedProperty[], id: string | undefined): NormalizedProperty | undefined {
  if (!id) return undefined;
  return properties.find((property) => idsEqual(property.id, id) || property.id === id);
}

function findByName(properties: NormalizedProperty[], names: RegExp): NormalizedProperty | undefined {
  return properties.find((property) => names.test(property.name));
}

function optionByName(property: NormalizedProperty | undefined, name: RegExp): string | undefined {
  return property?.options?.find((option) => name.test(option.name))?.id;
}

function optionByValue(property: NormalizedProperty | undefined, value: string): string | undefined {
  return property?.options?.find(
    (option) => option.id === value || option.name.toLowerCase() === value.toLowerCase(),
  )?.id;
}

function inferMapping(candidate: SourceCandidate): SourceConfig["mapping"] {
  const properties = candidate.properties as NormalizedProperty[];
  const title =
    properties.find((property) => property.type === "title") ??
    findByName(properties, /^(task|name|title)$/i);
  const due =
    properties.find((property) => property.type === "date") ??
    findByName(properties, /^(due|due date|date)$/i);

  const namedStatus = properties.find(
    (property) => ["status", "select", "checkbox"].includes(property.type) && /^status$/i.test(property.name),
  );
  const nativeStatus =
    namedStatus ??
    properties.find(
      (property) =>
        property.type === "status" &&
        !!optionByName(property, /^(done|completed?|complete)$/i) &&
        !!optionByName(property, /^(not started|todo|to do|open|incomplete)$/i),
    ) ??
    properties.find((property) => property.type === "status");
  const configuredSelect = properties.find(
    (property) =>
      property.type === "select" &&
      !!optionByName(property, /^(done|completed?|complete)$/i) &&
      !!optionByName(property, /^(not started|todo|to do|open|incomplete)$/i),
  );
  const checkbox = properties.find(
    (property) => property.type === "checkbox" || /^(done|complete|completed)$/i.test(property.name),
  );
  const status = nativeStatus ?? configuredSelect ?? checkbox ?? findByName(properties, /^status$/i);

  if (!title) throw new Error(`Could not map a title property for source ${candidate.id}.`);
  if (!status) throw new Error(`Could not map a status property for source ${candidate.id}.`);

  const complete =
    status.type === "checkbox"
      ? "true"
      : optionByName(status, /^(done|completed?|complete)$/i) ?? "Done";
  const reopen =
    status.type === "checkbox"
      ? "false"
      : optionByName(status, /^(not started|todo|to do|open|incomplete)$/i) ?? "Not started";

  return {
    title: title.id,
    due: due?.id ?? null,
    status: status.id,
    complete,
    reopen,
  };
}

export function mapSource(candidate: SourceCandidate): SourceConfig {
  return { ...candidate, mapping: inferMapping(candidate) };
}

function sourceName(value: JsonRecord, fallback: string): string {
  const name = typeof value?.name === "string" ? value.name : titleFromObject(value?.name);
  return titleFromObject(value?.title) || name || fallback;
}

function normalizeCandidate(value: JsonRecord, fallbackId: string, fallbackDatabaseId?: string): SourceCandidate {
  const id = canonicalId(String(value?.id ?? fallbackId));
  const databaseId = canonicalId(
    String(value?.parent?.database_id ?? value?.database_id ?? value?.database?.id ?? fallbackDatabaseId ?? id),
  );
  const properties = normalizeProperties(value?.properties);
  return {
    id,
    databaseId,
    name: sourceName(value, id),
    properties,
  };
}

function isTaskDate(value: unknown): value is TaskDate {
  return value === null || (typeof value === "object" && value !== null && typeof (value as JsonRecord).start === "string");
}

function normalizeDate(value: unknown): TaskDate {
  if (!value || typeof value !== "object") return null;
  const date = value as JsonRecord;
  if (typeof date.start !== "string") return null;
  return {
    start: date.start,
    end: typeof date.end === "string" ? date.end : null,
    ...(date.time_zone !== undefined ? { time_zone: date.time_zone ?? null } : {}),
  };
}

function datesEqual(a: TaskDate, b: TaskDate): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function isCompleteValue(value: string | undefined, mapping: SourceConfig["mapping"]): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === mapping.complete || /^(done|completed?|complete|true)$/i.test(value)) return true;
  if (value === mapping.reopen || /^(not started|todo|to do|open|incomplete|false|reopen|reopened)$/i.test(value)) return false;
  return undefined;
}

function propertyFromPage(page: JsonRecord, mappedId: string): JsonRecord | undefined {
  const properties = page?.properties;
  if (!properties || typeof properties !== "object") return undefined;
  if (properties[mappedId]) return properties[mappedId];
  return Object.values(properties).find((property: any) => property?.id === mappedId || idsEqual(String(property?.id ?? ""), mappedId)) as JsonRecord | undefined;
}

function pageTask(page: JsonRecord, source: SourceCandidate, mapping: SourceConfig["mapping"]): Task {
  const titleProperty = propertyFromPage(page, mapping.title);
  const dueProperty = mapping.due ? propertyFromPage(page, mapping.due) : undefined;
  const statusProperty = propertyFromPage(page, mapping.status);
  const titleValue = titleProperty?.title ?? titleProperty?.rich_text;
  const name = textFromRichText(titleValue);
  const dateValue = dueProperty?.date;
  const due = normalizeDate(dateValue);
  const type = String(statusProperty?.type ?? "");
  const rawStatus = type === "checkbox" ? statusProperty?.checkbox : statusProperty?.[type];
  const status =
    type === "checkbox"
      ? rawStatus
        ? "Done"
        : "Not started"
      : String(rawStatus?.name ?? rawStatus?.id ?? "");
  const statusSchema = findProperty(source.properties as NormalizedProperty[], mapping.status);
  const completed = type === "checkbox"
    ? String(!!rawStatus) === mapping.complete
    : !!rawStatus && optionByValue(statusSchema, String(rawStatus.id ?? rawStatus.name)) === optionByValue(statusSchema, mapping.complete);
  return {
    id: String(page?.id ?? ""),
    sourceId: source.id,
    name,
    url: String(page?.url ?? ""),
    due,
    status,
    completed,
    lastEdited: String(page?.last_edited_time ?? ""),
  };
}

function dataSourceDescriptors(database: JsonRecord): JsonRecord[] {
  if (!Array.isArray(database?.data_sources)) return [];
  return database.data_sources.filter((descriptor: JsonRecord) => descriptor?.id);
}

function collectionPath(candidate: SourceCandidate, suffix = ""): string {
  const collection = idsEqual(candidate.id, candidate.databaseId) ? "databases" : "data_sources";
  return `/${collection}/${encodeURIComponent(candidate.id)}${suffix}`;
}

function extractIds(value: string): string[] {
  const matches = value.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32}/gi) ?? [];
  return [...new Set(matches.map(canonicalId))];
}

function pathHint(value: string): "page" | "database" | "source" | "unknown" {
  try {
    const path = new URL(value).pathname.toLowerCase();
    if (/\/p\//.test(path) || /\/pages?\//.test(path)) return "page";
    if (/data[-_]?sources?/.test(path)) return "source";
    if (/databases?/.test(path)) return "database";
  } catch {
    // A bare UUID has no route hint.
  }
  return "unknown";
}

export class NotionService {
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;
  private readonly apiBase: string;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(token: string, fetchImpl: FetchImpl = globalThis.fetch, options: NotionServiceOptions = {}) {
    this.token = token.trim();
    this.fetchImpl = fetchImpl;
    this.apiBase = (options.apiBase ?? NOTION_API).replace(/\/$/, "");
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? MAX_RETRIES));
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS);
    this.sleep = options.sleep ?? sleepDefault;
  }

  async validate(): Promise<void> {
    await this.request<JsonRecord>("/users/me");
  }

  async resolveSource(url: string): Promise<SourceCandidate[]> {
    let identity = url;
    try { identity = new URL(url).pathname; } catch { /* Bare IDs also supported internally. */ }
    const ids = extractIds(identity);
    if (!ids.length) throw new Error("No Notion page, database, or data source ID was found in the URL.");
    const id = ids[0];
    const hint = pathHint(url);
    if (hint === "source") return [await this.inspectSource(id)];
    if (hint === "database") return this.inspectDatabaseSources(id);
    if (hint === "page") {
      try { return await this.resolvePage(id); }
      catch (error) {
        if (!(error instanceof NotionHttpError) || ![400, 404].includes(error.status)) throw error;
        return this.inspectDatabaseSources(id);
      }
    }

    try {
      return await this.inspectDatabaseSources(id);
    } catch (error) {
      if (!(error instanceof NotionHttpError) || ![400, 404].includes(error.status)) throw error;
    }
    try {
      return await this.resolvePage(id);
    } catch (error) {
      if (!(error instanceof NotionHttpError) || ![400, 404].includes(error.status)) throw error;
    }
    return [await this.inspectSource(id)];
  }

  async inspectSource(id: string): Promise<SourceCandidate> {
    const sourceId = canonicalId(id);
    let response: JsonRecord;
    try {
      response = await this.request<JsonRecord>(`/data_sources/${encodeURIComponent(sourceId)}`);
    } catch (error) {
      if (!(error instanceof NotionHttpError) || ![400, 404].includes(error.status)) throw error;
      response = await this.request<JsonRecord>(`/databases/${encodeURIComponent(sourceId)}`);
      // The desktop integration historically passes a database ID when refreshing
      // a saved source. Resolve its first data source so the returned schema stays
      // current even with the split database/data-source API.
      const descriptors = dataSourceDescriptors(response);
      if (descriptors.length) {
        const descriptor = descriptors[0];
        try {
          return await this.inspectSource(String(descriptor.id));
        } catch (descriptorError) {
          if (!(descriptorError instanceof NotionHttpError) || ![400, 404].includes(descriptorError.status)) throw descriptorError;
          return normalizeCandidate({ ...descriptor, parent: { database_id: sourceId } }, String(descriptor.id), sourceId);
        }
      }
    }
    return normalizeCandidate(response, sourceId, response?.parent?.database_id);
  }

  async listTasks(source: SourceCandidate | SourceConfig): Promise<Task[]> {
    const schema = await this.schemaSnapshot(source);
    const results: Task[] = [];
    let cursor: string | undefined;
    do {
      const body: JsonRecord = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = await this.request<JsonRecord>(
        collectionPath(schema.candidate, "/query"),
        { method: "POST", body: JSON.stringify(body) },
      );
      for (const page of Array.isArray(response?.results) ? response.results : []) {
        results.push(pageTask(page, schema.candidate, schema.mapping));
      }
      cursor = response?.has_more && response?.next_cursor ? String(response.next_cursor) : undefined;
    } while (cursor);
    return results;
  }

  async createTask(source: SourceCandidate | SourceConfig, name: string, due?: TaskDate): Promise<Task> {
    if (typeof name !== "string" || name.trim().length === 0) throw new TypeError("Task name must be a non-empty string.");
    const schema = await this.schemaSnapshot(source);
    const properties = this.writeProperties(schema.candidate, schema.mapping, { name, ...(due !== undefined ? { due } : {}) });
    const parent = idsEqual(schema.candidate.id, schema.candidate.databaseId)
      ? { database_id: schema.candidate.databaseId }
      : { data_source_id: schema.candidate.id };
    const created = await this.request<JsonRecord>("/pages", {
      method: "POST",
      body: JSON.stringify({ parent, properties }),
    });
    if (!created?.id) throw new Error("Notion did not return the created task page ID.");
    const page = await this.request<JsonRecord>(`/pages/${encodeURIComponent(String(created.id))}`);
    return pageTask(page, schema.candidate, schema.mapping);
  }

  async updateTask(
    source: SourceCandidate | SourceConfig,
    id: string,
    changes: TaskChanges,
    expected: Task,
  ): Promise<UpdateResult> {
    const schema = await this.schemaSnapshot(source);
    const currentPage = await this.request<JsonRecord>(`/pages/${encodeURIComponent(id)}`);
    const current = pageTask(currentPage, schema.candidate, schema.mapping);
    if (this.hasConflict(current, changes, expected)) return { task: current, conflict: true };

    const properties = this.writeProperties(schema.candidate, schema.mapping, changes, true);
    if (Object.keys(properties).length === 0) return { task: current };
    await this.request<JsonRecord>(`/pages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    const page = await this.request<JsonRecord>(`/pages/${encodeURIComponent(id)}`);
    return { task: pageTask(page, schema.candidate, schema.mapping) };
  }

  private async resolvePage(pageId: string): Promise<SourceCandidate[]> {
    const page = await this.request<JsonRecord>(`/pages/${encodeURIComponent(canonicalId(pageId))}`);
    const parent = page?.parent ?? {};
    if (parent?.data_source_id) return [await this.inspectSource(String(parent.data_source_id))];
    if (parent?.database_id) return this.inspectDatabaseSources(String(parent.database_id));
    return this.enumerateChildDatabases(String(page?.id ?? pageId));
  }

  private async enumerateChildDatabases(pageId: string): Promise<SourceCandidate[]> {
    const candidates: SourceCandidate[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : "?page_size=100";
      const response = await this.request<JsonRecord>(`/blocks/${encodeURIComponent(pageId)}/children${query}`);
      for (const block of Array.isArray(response?.results) ? response.results : []) {
        if (block?.type === "child_database" || block?.child_database) {
          const child = await this.inspectDatabaseSources(String(block?.id));
          candidates.push(...child);
        }
      }
      cursor = response?.has_more && response?.next_cursor ? String(response.next_cursor) : undefined;
    } while (cursor);
    return candidates;
  }

  private async inspectDatabaseSources(databaseId: string): Promise<SourceCandidate[]> {
    const dbId = canonicalId(databaseId);
    const database = await this.request<JsonRecord>(`/databases/${encodeURIComponent(dbId)}`);
    const descriptors = dataSourceDescriptors(database);
    if (!descriptors.length) return [normalizeCandidate(database, dbId, dbId)];
    const sources: SourceCandidate[] = [];
    for (const descriptor of descriptors) {
      const sourceId = canonicalId(String(descriptor.id));
      try {
        sources.push(await this.inspectSource(sourceId));
      } catch (error) {
        if (!(error instanceof NotionHttpError) || ![400, 404].includes(error.status)) throw error;
        sources.push(normalizeCandidate({ ...descriptor, parent: { database_id: dbId } }, sourceId, dbId));
      }
    }
    return sources;
  }

  private async schemaSnapshot(source: SourceCandidate | SourceConfig): Promise<SchemaSnapshot> {
    const candidate = await this.inspectSource(source.id);
    const mapping = "mapping" in source && source.mapping ? source.mapping : inferMapping(candidate);
    this.assertMapping(candidate, mapping);
    return { candidate, mapping };
  }

  private assertMapping(candidate: SourceCandidate, mapping: SourceConfig["mapping"]): void {
    const properties = candidate.properties as NormalizedProperty[];
    const title = findProperty(properties, mapping.title);
    const status = findProperty(properties, mapping.status);
    const due = mapping.due ? findProperty(properties, mapping.due) : undefined;
    const invalid =
      !title || title.type !== "title" ||
      !status || !["status", "select", "checkbox"].includes(status.type) ||
      (mapping.due !== null && (!due || due.type !== "date"));
    if (invalid) {
      throw new NotionSchemaChangedError(
        candidate.id,
        mapping,
        `The Notion schema for ${candidate.name} changed; remap title, due date, or status properties before editing.`,
      );
    }
    if (status.type === "checkbox") {
      if (!/^(true|false)$/i.test(mapping.complete) || !/^(true|false)$/i.test(mapping.reopen)) {
        throw new NotionSchemaChangedError(candidate.id, mapping, `The configured checkbox values for ${candidate.name} are invalid.`);
      }
    } else {
      const complete = optionByValue(status, mapping.complete);
      const reopen = optionByValue(status, mapping.reopen);
      if (!complete || !reopen) {
        throw new NotionSchemaChangedError(candidate.id, mapping, `The configured status options for ${candidate.name} changed.`);
      }
    }
  }

  private hasConflict(current: Task, changes: TaskChanges, expected: Task): boolean {
    if (changes.name !== undefined && current.name !== expected.name) return true;
    if (changes.due !== undefined && !datesEqual(current.due, expected.due)) return true;
    if (changes.status !== undefined && (current.status !== expected.status || current.completed !== expected.completed)) return true;
    return false;
  }

  private writeProperties(
    candidate: SourceCandidate,
    mapping: SourceConfig["mapping"],
    changes: TaskChanges & { name?: string },
    partial = false,
  ): JsonRecord {
    const properties: JsonRecord = {};
    const schemaProperties = candidate.properties as NormalizedProperty[];
    const title = findProperty(schemaProperties, mapping.title);
    const status = findProperty(schemaProperties, mapping.status);
    const due = mapping.due ? findProperty(schemaProperties, mapping.due) : undefined;

    if (changes.name !== undefined || !partial) {
      if (changes.name === undefined) throw new Error("A task name is required.");
      properties[mapping.title] = { title: [{ type: "text", text: { content: changes.name } }] };
    }
    if (changes.due !== undefined) {
      if (!due) throw new NotionSchemaChangedError(candidate.id, mapping, "The configured due-date property is unavailable.");
      properties[mapping.due as string] = { date: changes.due };
    }
    if (!partial) {
      properties[mapping.status] = this.statusPayload(status, mapping.reopen);
    } else if (changes.status !== undefined) {
      properties[mapping.status] = this.statusPayload(status, changes.status);
    }
    return properties;
  }

  private statusPayload(property: NormalizedProperty | undefined, target: string): JsonRecord {
    if (!property) throw new Error("The configured status property is unavailable.");
    if (property.type === "checkbox") {
      if (!["true", "false", "Done", "Not started"].includes(target)) throw new Error("Invalid checkbox status value.");
      return { checkbox: target === "true" || target === "Done" };
    }
    const option = optionByValue(property, target);
    if (!option) throw new NotionSchemaChangedError(property.id, { title: "", due: null, status: property.id, complete: target, reopen: target }, `Status option ${target} is unavailable.`);
    return { [property.type]: { id: option } };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) throw new Error("A Notion integration token is required.");
    let attempt = 0;
    while (true) {
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        signal: AbortSignal.timeout(20_000),
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (response.ok || (response.status >= 200 && response.status < 300)) {
        if (response.status === 204) return undefined as T;
        try {
          return (await response.json()) as T;
        } catch {
          const text = await response.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
      }
      const body = await this.readErrorBody(response);
      // Creating a page is not idempotent: a 5xx can occur after it was committed.
      const retryable = response.status === 429 || (path !== "/pages" && response.status >= 500 && response.status <= 599);
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = response.headers?.get?.("Retry-After");
        const parsedSeconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
        const seconds = Number.isFinite(parsedSeconds)
          ? parsedSeconds
          : retryAfter
            ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1_000)
            : 0;
        const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : Math.min(this.maxRetryDelayMs, 500 * 2 ** attempt);
        // Defer long rate limits to the next refresh; never retry before Retry-After.
        if (delay > this.maxRetryDelayMs) throw new NotionHttpError(response.status, body);
        attempt += 1;
        if (delay) await this.sleep(delay);
        continue;
      }
      throw new NotionHttpError(response.status, body);
    }
  }

  private async readErrorBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      try {
        return await response.text();
      } catch {
        return undefined;
      }
    }
  }
}

