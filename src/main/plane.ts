import type {
  ConnectionConfig,
  PropertyInfo,
  SourceCandidate,
  SourceConfig,
  Task,
  TaskChanges,
  TaskDate,
  UpdateResult,
} from "../shared/types";

const DEFAULT_API = "https://api.plane.so/api/v1";
const DEFAULT_WEB = "https://app.plane.so";
type JsonRecord = Record<string, any>;
type FetchImpl = typeof fetch;

export interface PlaneServiceOptions {
  apiBase?: string;
  webBase?: string;
  workspaceSlug?: string;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PlaneHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body?: unknown) {
    const detail = typeof body === "string" ? body : body && typeof body === "object" && "detail" in body ? String((body as JsonRecord).detail) : "";
    super(`Plane API request failed (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "PlaneHttpError";
    this.status = status;
    this.body = body;
  }
}

export class PlaneSchemaChangedError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string, message: string) {
    super(message);
    this.name = "PlaneSchemaChangedError";
    this.sourceId = sourceId;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeBase(value: string | undefined, fallback: string): string {
  const base = (value || fallback).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("Plane API URL must use http or https");
  if (/\/api\/v1$/i.test(base)) return base;
  if (/\/api$/i.test(base)) return `${base}/v1`;
  return `${base}/api/v1`;
}

function webBaseForApi(apiBase: string, configured?: string): string {
  if (configured) return configured.replace(/\/+$/, "");
  try {
    const parsed = new URL(apiBase);
    if (parsed.hostname.toLowerCase() === "api.plane.so" && parsed.pathname.toLowerCase() === "/api/v1") return DEFAULT_WEB;
  } catch {
    // normalizeBase has already validated the URL; keep the conservative fallback below.
  }
  return apiBase.replace(/\/api\/v1$/i, "");
}

function sourceId(baseUrl: string, workspaceSlug: string, projectId: string): string {
  return ["plane", baseUrl, workspaceSlug, projectId].map((item) => encodeURIComponent(item)).join("|");
}

function decodeSourceId(value: string): { baseUrl?: string; workspaceSlug?: string; projectId?: string } {
  const parts = value.split("|");
  if (parts.length !== 4 || parts[0] !== "plane") return {};
  try {
    return { baseUrl: decodeURIComponent(parts[1]), workspaceSlug: decodeURIComponent(parts[2]), projectId: decodeURIComponent(parts[3]) };
  } catch {
    return {};
  }
}

function pageResults(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) && Array.isArray(value.results) ? value.results.filter(isRecord) : [];
}

function pageCursor(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.next_page_results === false || value.has_more === false) return undefined;
  const cursor = value.next_cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

function dateValue(value: unknown): TaskDate {
  if (typeof value !== "string" || !value) return null;
  return { start: value, end: null };
}

function dateEqual(a: TaskDate, b: TaskDate): boolean {
  return (a?.start ?? null) === (b?.start ?? null) && (a?.end ?? null) === (b?.end ?? null) && (a?.time_zone ?? null) === (b?.time_zone ?? null);
}

function stateGroupComplete(group: string): boolean {
  return /^(completed|cancelled|canceled)$/i.test(group);
}

function stateOptions(states: JsonRecord[]): PropertyInfo["options"] {
  return states
    .filter((state) => typeof state.id === "string" && typeof state.name === "string")
    .map((state) => ({ id: state.id, name: state.name, ...(typeof state.group === "string" ? { group: state.group } : {}) }));
}

function chooseState(options: NonNullable<PropertyInfo["options"]>, patterns: RegExp[], fallback: (item: NonNullable<PropertyInfo["options"]>[number]) => boolean): string {
  const match = options.find((option) => patterns.some((pattern) => pattern.test(option.name)));
  if (match) return match.id;
  const fallbackMatch = options.find(fallback);
  return fallbackMatch?.id || options[0]?.id || "";
}

function inferMapping(states: JsonRecord[]): SourceConfig["mapping"] {
  const options = stateOptions(states) || [];
  const complete = chooseState(options, [/^done$/i, /^complete/i, /^closed$/i, /^cancel/i], (option) => option.group === "completed");
  const reopen = chooseState(options, [/^not started$/i, /^todo$/i, /^backlog$/i, /^open$/i], (option) => option.group !== "completed" && option.group !== "cancelled");
  return { title: "name", due: "target_date", status: "state", complete, reopen };
}

function sourceParts(source: SourceCandidate | SourceConfig, defaults: { baseUrl: string; workspaceSlug: string }): { baseUrl: string; workspaceSlug: string; projectId: string } {
  const decoded = decodeSourceId(source.id);
  const baseUrl = normalizeBase(source.baseUrl || decoded.baseUrl, defaults.baseUrl);
  const currentBase = normalizeBase(defaults.baseUrl, defaults.baseUrl);
  if (baseUrl.toLowerCase() !== currentBase.toLowerCase()) throw new Error("This Plane source belongs to a different API endpoint; reconnect to that Plane host before using it.");
  const workspaceSlug = source.workspaceSlug || decoded.workspaceSlug || defaults.workspaceSlug;
  const projectId = source.projectId || decoded.projectId || source.databaseId || source.id;
  if (!workspaceSlug) throw new Error("A Plane workspace slug is required");
  if (!projectId) throw new Error("A Plane project ID is required");
  return { baseUrl, workspaceSlug, projectId };
}

function taskId(source: SourceCandidate | SourceConfig, remoteId: string): string {
  return `${source.id}::${remoteId}`;
}

function remoteTaskId(source: SourceCandidate | SourceConfig, id: string): string {
  const prefix = `${source.id}::`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export function mapPlaneSource(candidate: SourceCandidate): SourceConfig {
  const status = candidate.properties.find((property) => property.id === "state");
  const options = status?.options || [];
  return {
    ...candidate,
    provider: "plane",
    mapping: {
      title: "name",
      due: "target_date",
      status: "state",
      complete: options.find((option) => /^(done|complete|closed|cancel)/i.test(option.name) || option.group === "completed")?.id || options[0]?.id || "",
      reopen: options.find((option) => !/^(done|complete|closed|cancel)/i.test(option.name) && option.group !== "completed")?.id || options[0]?.id || "",
    },
  };
}

export class PlaneService {
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;
  private readonly apiBase: string;
  private readonly webBase: string;
  private readonly workspaceSlug: string;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(token: string, fetchImpl: FetchImpl = globalThis.fetch, options: PlaneServiceOptions = {}) {
    this.token = token.trim();
    this.fetchImpl = fetchImpl;
    this.apiBase = normalizeBase(options.apiBase, DEFAULT_API);
    this.webBase = webBaseForApi(this.apiBase, options.webBase);
    this.workspaceSlug = (options.workspaceSlug || "").trim();
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 10_000);
    this.sleep = options.sleep ?? sleepDefault;
  }

  get config(): ConnectionConfig {
    return { provider: "plane", token: this.token, baseUrl: this.apiBase, ...(this.workspaceSlug ? { workspaceSlug: this.workspaceSlug } : {}) };
  }

  async validate(): Promise<void> {
    if (!this.token) throw new Error("A Plane API key is required.");
    if (!this.workspaceSlug) throw new Error("A Plane workspace slug is required.");
    await this.request(`/workspaces/${encodeURIComponent(this.workspaceSlug)}/projects/?per_page=1`);
  }

  async listProjects(workspaceSlug = this.workspaceSlug): Promise<SourceCandidate[]> {
    if (!workspaceSlug) throw new Error("A Plane workspace slug is required.");
    const projects: JsonRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const query = new URLSearchParams({ per_page: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request<JsonRecord>(`/workspaces/${encodeURIComponent(workspaceSlug)}/projects/?${query}`);
      projects.push(...pageResults(response));
      cursor = pageCursor(response);
      if (cursor && seenCursors.has(cursor)) break;
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    const candidates: SourceCandidate[] = [];
    for (const project of projects) {
      const projectId = text(project.id);
      if (!projectId) continue;
      candidates.push(await this.inspectSourceWithWorkspace(projectId, workspaceSlug));
    }
    return candidates;
  }

  async resolveSource(url: string): Promise<SourceCandidate[]> {
    const parsed = this.parseProjectUrl(url);
    if (!parsed.projectId) return this.listProjects(parsed.workspaceSlug || this.workspaceSlug);
    return [await this.inspectSourceWithWorkspace(parsed.projectId, parsed.workspaceSlug || this.workspaceSlug)];
  }

  async inspectSource(id: string): Promise<SourceCandidate> {
    const decoded = decodeSourceId(id);
    return this.inspectSourceWithWorkspace(decoded.projectId || id, decoded.workspaceSlug || this.workspaceSlug, decoded.baseUrl);
  }

  async listTasks(source: SourceCandidate | SourceConfig): Promise<Task[]> {
    const parts = sourceParts(source, { baseUrl: this.apiBase, workspaceSlug: this.workspaceSlug });
    const config = await this.schema(source, parts);
    const mapping = config.mapping;
    const tasks: Task[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const query = new URLSearchParams({ per_page: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request<JsonRecord>(this.path(parts, `/work-items/?${query}&expand=state`));
      for (const item of pageResults(response)) tasks.push(this.taskFromResponse(item, source, mapping, parts));
      cursor = pageCursor(response);
      if (cursor && seenCursors.has(cursor)) break;
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return tasks;
  }

  async createTask(source: SourceCandidate | SourceConfig, name: string, due?: TaskDate): Promise<Task> {
    if (!name.trim()) throw new TypeError("Task name must be a non-empty string.");
    const parts = sourceParts(source, { baseUrl: this.apiBase, workspaceSlug: this.workspaceSlug });
    const config = await this.schema(source, parts);
    const body: JsonRecord = { name: name.trim(), state: config.mapping.reopen };
    if (config.mapping.due !== null && due?.start) body.target_date = due.start.slice(0, 10);
    const created = await this.request<JsonRecord>(this.path(parts, "/work-items/"), { method: "POST", body: JSON.stringify(body) });
    const remoteId = text(created.id);
    if (!remoteId) throw new Error("Plane did not return the created work item ID.");
    const item = await this.request<JsonRecord>(this.path(parts, `/work-items/${encodeURIComponent(remoteId)}/`));
    return this.taskFromResponse(item, source, config.mapping, parts);
  }

  async updateTask(source: SourceCandidate | SourceConfig, id: string, changes: TaskChanges, expected: Task): Promise<UpdateResult> {
    const parts = sourceParts(source, { baseUrl: this.apiBase, workspaceSlug: this.workspaceSlug });
    const config = await this.schema(source, parts);
    const remoteId = remoteTaskId(source, id);
    const currentItem = await this.request<JsonRecord>(this.path(parts, `/work-items/${encodeURIComponent(remoteId)}/`));
    const current = this.taskFromResponse(currentItem, source, config.mapping, parts);
    if (this.hasConflict(current, changes, expected)) return { task: current, conflict: true };
    const body: JsonRecord = {};
    if (changes.name !== undefined) body.name = changes.name;
    if (changes.due !== undefined && config.mapping.due !== null) body.target_date = changes.due?.start ? changes.due.start.slice(0, 10) : null;
    if (changes.status !== undefined) body.state = this.stateId(config, changes.status);
    if (Object.keys(body).length === 0) return { task: current };
    await this.request<JsonRecord>(this.path(parts, `/work-items/${encodeURIComponent(remoteId)}/`), { method: "PATCH", body: JSON.stringify(body) });
    const updated = await this.request<JsonRecord>(this.path(parts, `/work-items/${encodeURIComponent(remoteId)}/`));
    return { task: this.taskFromResponse(updated, source, config.mapping, parts) };
  }

  private async inspectSourceWithWorkspace(projectId: string, workspaceSlug: string, baseOverride?: string): Promise<SourceCandidate> {
    if (baseOverride && normalizeBase(baseOverride, this.apiBase).toLowerCase() !== this.apiBase.toLowerCase()) {
      throw new Error("This Plane source belongs to a different API endpoint; reconnect to that Plane host before using it.");
    }
    let project: JsonRecord;
    try {
      project = await this.request<JsonRecord>(`/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/`);
    } catch (error) {
      if (!(error instanceof PlaneHttpError) || ![404, 405].includes(error.status)) throw error;
      const projects = await this.request<JsonRecord>(`/workspaces/${encodeURIComponent(workspaceSlug)}/projects/?per_page=100`);
      project = pageResults(projects).find((item) => text(item.id) === projectId) || { id: projectId };
    }
    const states: JsonRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const query = new URLSearchParams({ per_page: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.request<JsonRecord>(`/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/states/?${query}`);
      states.push(...pageResults(response));
      cursor = pageCursor(response);
      if (cursor && seenCursors.has(cursor)) break;
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    const baseUrl = baseOverride || this.apiBase;
    const id = sourceId(baseUrl, workspaceSlug, projectId);
    const properties: PropertyInfo[] = [
      { id: "name", name: "Name", type: "title" },
      { id: "target_date", name: "Target date", type: "date" },
      { id: "state", name: "State", type: "status", options: stateOptions(states) },
    ];
    return { id, databaseId: projectId, projectId, provider: "plane", workspaceSlug, baseUrl, name: text(project.name || project.identifier || projectId), properties };
  }

  private async schema(source: SourceCandidate | SourceConfig, parts: { baseUrl: string; workspaceSlug: string; projectId: string }): Promise<{ candidate: SourceCandidate; mapping: SourceConfig["mapping"] }> {
    const candidate = await this.inspectSource(source.id);
    const mapping = "mapping" in source && source.mapping ? source.mapping : inferMapping((candidate.properties.find((property) => property.id === "state")?.options || []).map((option) => ({ ...option })));
    if (mapping.title !== "name" || mapping.status !== "state" || (mapping.due !== null && mapping.due !== "target_date")) throw new PlaneSchemaChangedError(candidate.id, "The Plane project mapping is invalid; remap its name, target date, or state fields.");
    const options = candidate.properties.find((property) => property.id === "state")?.options || [];
    if (!options.some((option) => option.id === mapping.complete || option.name === mapping.complete) || !options.some((option) => option.id === mapping.reopen || option.name === mapping.reopen)) throw new PlaneSchemaChangedError(candidate.id, "The Plane project states changed; remap its complete and reopen states.");
    return { candidate, mapping };
  }

  private stateId(config: { candidate: SourceCandidate; mapping: SourceConfig["mapping"] }, value: string): string {
    const options = config.candidate.properties.find((property) => property.id === "state")?.options || [];
    const option = options.find((item) => item.id === value || item.name === value);
    if (!option) throw new PlaneSchemaChangedError(config.candidate.id, `Plane state ${value} is unavailable.`);
    return option.id;
  }

  private hasConflict(current: Task, changes: TaskChanges, expected: Task): boolean {
    if (changes.name !== undefined && current.name !== expected.name) return true;
    if (changes.due !== undefined && !dateEqual(current.due, expected.due)) return true;
    if (changes.status !== undefined && (current.status !== expected.status || current.completed !== expected.completed)) return true;
    return false;
  }

  private taskFromResponse(item: JsonRecord, source: SourceCandidate | SourceConfig, mapping: SourceConfig["mapping"], parts: { baseUrl: string; workspaceSlug: string; projectId: string }): Task {
    const remoteId = text(item.id);
    if (!remoteId) throw new Error("Plane returned an invalid work item.");
    const stateOptions = source.properties.find((property) => property.id === "state")?.options || [];
    const rawState = isRecord(item.state) ? item.state : { id: text(item.state), name: text(item.state) };
    const resolvedState = stateOptions.find((option) => option.id === text(rawState.id) || option.name === text(rawState.name));
    const state = resolvedState ? { ...rawState, id: resolvedState.id, name: resolvedState.name, group: resolvedState.group } : rawState;
    const stateId = text(state.id);
    const stateName = text(state.name) || stateId;
    const completed = stateGroupComplete(text(state.group)) || stateId === mapping.complete || stateName === mapping.complete;
    const identifier = remoteId;
    return {
      id: taskId(source, remoteId),
      sourceId: source.id,
      name: text(item.name),
      url: `${this.webBase}/${encodeURIComponent(parts.workspaceSlug)}/projects/${encodeURIComponent(parts.projectId)}/issues/${encodeURIComponent(identifier)}`,
      due: mapping.due === null ? null : dateValue(item.target_date),
      status: stateName,
      completed,
      lastEdited: text(item.updated_at || item.last_activity_at || item.created_at) || new Date().toISOString(),
    };
  }

  private path(parts: { workspaceSlug: string; projectId: string }, suffix: string): string {
    return `/workspaces/${encodeURIComponent(parts.workspaceSlug)}/projects/${encodeURIComponent(parts.projectId)}${suffix}`;
  }

  private parseProjectUrl(value: string): { workspaceSlug?: string; projectId?: string } {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const projectIndex = segments.findIndex((item) => item.toLowerCase() === "projects");
      if (projectIndex >= 1) return { workspaceSlug: segments[projectIndex - 1], projectId: segments[projectIndex + 1] };
      if (segments.length >= 2) return { workspaceSlug: segments[0], projectId: segments[1] };
    } catch {
      const parts = value.split("/").map((item) => item.trim()).filter(Boolean);
      if (parts.length >= 2) return { workspaceSlug: parts[0], projectId: parts[1] };
    }
    return {};
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) throw new Error("A Plane API key is required.");
    let attempt = 0;
    while (true) {
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        signal: AbortSignal.timeout(20_000),
        ...init,
        headers: { "X-API-Key": this.token, "Content-Type": "application/json", ...(init.headers || {}) },
      });
      if (response.ok || (response.status >= 200 && response.status < 300)) {
        if (response.status === 204) return undefined as T;
        try { return await response.json() as T; }
        catch { return undefined as T; }
      }
      const body = await this.readErrorBody(response);
      const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599 && init.method !== "POST");
      if (retryable && attempt < this.maxRetries) {
        const header = response.headers?.get?.("Retry-After");
        const seconds = header ? Number.parseFloat(header) : Number.NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1_000 : Math.min(this.maxRetryDelayMs, 500 * 2 ** attempt);
        if (delay > this.maxRetryDelayMs) throw new PlaneHttpError(response.status, body);
        attempt += 1;
        if (delay) await this.sleep(delay);
        continue;
      }
      throw new PlaneHttpError(response.status, body);
    }
  }

  private async readErrorBody(response: Response): Promise<unknown> {
    try { return await response.json(); }
    catch { try { return await response.text(); } catch { return undefined; } }
  }
}

export { DEFAULT_API as PLANE_API_BASE, DEFAULT_WEB as PLANE_WEB_BASE, sourceId as planeSourceId };
