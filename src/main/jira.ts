import type {
  PropertyInfo,
  SourceCandidate,
  SourceConfig,
  Task,
  TaskChanges,
  TaskDate,
  UpdateResult,
} from "../shared/types";
import { TaskCreateFailure } from "./task-create-failure";

type JsonRecord = Record<string, any>;
type FetchImpl = typeof fetch;
type Options = NonNullable<PropertyInfo["options"]>;

const API = "/rest/api/3";
const ISSUE_FIELDS = ["summary", "status", "duedate", "assignee", "updated"];
const MAX_PROJECTS = 100;
const INSPECT_CONCURRENCY = 5;

export interface JiraServiceOptions {
  siteUrl: string;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class JiraHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body?: unknown) {
    const record = isRecord(body) ? body : {};
    const details = [...(Array.isArray(record.errorMessages) ? record.errorMessages : []), ...(isRecord(record.errors) ? Object.values(record.errors) : [])].filter((item) => typeof item === "string");
    const hint = status === 401 ? "Check the account email and API token." : details.join(" ");
    super(`Jira API request failed (${status})${hint ? `: ${hint}` : ""}`);
    this.name = "JiraHttpError";
    this.status = status;
    this.body = body;
  }
}

export class JiraSchemaChangedError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string, message: string) {
    super(message);
    this.name = "JiraSchemaChangedError";
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

/** Credentials only ever go to an Atlassian Cloud site, so a pasted lookalike URL cannot receive them. */
export function normalizeJiraSite(value: string): string {
  const raw = value.trim();
  let parsed: URL;
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new Error("Enter your Jira site, such as https://your-team.atlassian.net."); }
  if (parsed.protocol !== "https:" || !parsed.hostname.toLowerCase().endsWith(".atlassian.net")) throw new Error("Only Jira Cloud sites on atlassian.net are supported.");
  return `https://${parsed.hostname.toLowerCase()}`;
}

export function jiraSourceId(site: string, projectKey: string): string {
  return ["jira", site, projectKey].map((item) => encodeURIComponent(item)).join("|");
}

function decodeSourceId(value: string): { site?: string; projectKey?: string } {
  const parts = value.split("|");
  if (parts.length !== 3 || parts[0] !== "jira") return {};
  try { return { site: decodeURIComponent(parts[1]), projectKey: decodeURIComponent(parts[2]) }; }
  catch { return {}; }
}

function dateValue(value: unknown): TaskDate {
  if (typeof value !== "string" || !value) return null;
  return { start: value, end: null };
}

function dateEqual(a: TaskDate, b: TaskDate): boolean {
  return (a?.start ?? null) === (b?.start ?? null) && (a?.end ?? null) === (b?.end ?? null);
}

function statusOptions(issueTypes: unknown): Options {
  const options = new Map<string, Options[number]>();
  for (const type of Array.isArray(issueTypes) ? issueTypes : []) {
    for (const status of Array.isArray(type?.statuses) ? type.statuses : []) {
      const id = text(status?.id), name = text(status?.name);
      if (id && name && !options.has(id)) options.set(id, { id, name, group: status?.statusCategory?.key === "done" ? "completed" : text(status?.statusCategory?.key) });
    }
  }
  return [...options.values()];
}

function statusProperty(source: SourceCandidate | SourceConfig): Options {
  return source.properties.find((property) => property.id === "status")?.options || [];
}

export function mapJiraSource(candidate: SourceCandidate): SourceConfig {
  const options = statusProperty(candidate);
  return {
    ...candidate,
    provider: "jira",
    mapping: {
      title: "summary",
      due: "duedate",
      status: "status",
      complete: options.find((option) => option.group === "completed")?.id || options[0]?.id || "",
      reopen: options.find((option) => option.group !== "completed")?.id || options[0]?.id || "",
      owner: "assignee",
    },
  };
}

export class JiraService {
  private readonly email: string;
  private readonly token: string;
  private readonly site: string;
  private readonly fetchImpl: FetchImpl;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private accountId = "";

  constructor(email: string, token: string, fetchImpl: FetchImpl = globalThis.fetch, options: JiraServiceOptions) {
    this.email = email.trim();
    this.token = token.trim();
    this.site = normalizeJiraSite(options.siteUrl);
    this.fetchImpl = fetchImpl;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 10_000);
    this.sleep = options.sleep ?? sleepDefault;
  }

  get siteUrl(): string { return this.site; }

  async validate(): Promise<void> {
    if (!this.email) throw new Error("A Jira account email is required.");
    if (!this.token) throw new Error("A Jira API token is required.");
    await this.currentAccount(true);
  }

  async listProjects(): Promise<SourceCandidate[]> {
    const projects: JsonRecord[] = [];
    let startAt = 0;
    while (projects.length < MAX_PROJECTS) {
      const page = await this.request<JsonRecord>(`/project/search?${new URLSearchParams({ startAt: String(startAt), maxResults: "50", orderBy: "name" })}`);
      const values = Array.isArray(page?.values) ? page.values.filter(isRecord) : [];
      projects.push(...values);
      startAt += values.length;
      if (page?.isLast !== false || !values.length) break;
    }
    const candidates: SourceCandidate[] = [];
    const keys = projects.slice(0, MAX_PROJECTS).map((project) => text(project.key)).filter(Boolean);
    for (let index = 0; index < keys.length; index += INSPECT_CONCURRENCY) {
      candidates.push(...await Promise.all(keys.slice(index, index + INSPECT_CONCURRENCY).map((key) => this.inspectProject(key))));
    }
    return candidates;
  }

  async resolveSource(url: string): Promise<SourceCandidate[]> {
    if (normalizeJiraSite(url) !== this.site) throw new Error(`This URL belongs to a different Jira site. Connect ${new URL(url).hostname} first.`);
    const key = this.projectKeyFromUrl(url);
    return key ? [await this.inspectProject(key)] : this.listProjects();
  }

  async inspectSource(id: string): Promise<SourceCandidate> {
    const decoded = decodeSourceId(id);
    if (decoded.site && decoded.site !== this.site) throw new Error("This Jira source belongs to a different site; reconnect to that site before using it.");
    return this.inspectProject(decoded.projectKey || id);
  }

  async listTasks(source: SourceCandidate | SourceConfig): Promise<Task[]> {
    const config = await this.schema(source);
    const tasks: Task[] = [];
    const seen = new Set<string>();
    let nextPageToken: string | undefined;
    do {
      const response = await this.request<JsonRecord>("/search/jql", { method: "POST", body: JSON.stringify({ jql: this.taskQuery(config.candidate.databaseId), fields: ISSUE_FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }) });
      for (const issue of Array.isArray(response?.issues) ? response.issues.filter(isRecord) : []) tasks.push(this.taskFromResponse(issue, source, config.mapping));
      nextPageToken = typeof response?.nextPageToken === "string" && response.nextPageToken && response.isLast !== true ? response.nextPageToken : undefined;
      if (nextPageToken && seen.has(nextPageToken)) break;
      if (nextPageToken) seen.add(nextPageToken);
    } while (nextPageToken);
    return tasks;
  }

  async createTask(source: SourceCandidate | SourceConfig, name: string, due?: TaskDate): Promise<Task> {
    if (!name.trim()) throw new TypeError("Task name must be a non-empty string.");
    const config = await this.schema(source);
    const project = await this.request<JsonRecord>(`/project/${encodeURIComponent(config.candidate.databaseId)}`);
    const types = (Array.isArray(project?.issueTypes) ? project.issueTypes.filter(isRecord) : []).filter((type) => !type.subtask);
    const issueType = types.find((type) => /^task$/i.test(text(type.name))) || types[0];
    if (!issueType) throw new TaskCreateFailure("This Jira project has no issue type for new tasks.", "not-created");
    // The task list shows issues assigned to you, so a new issue must be assigned to appear in it.
    const fields: JsonRecord = { project: { key: config.candidate.databaseId }, issuetype: { id: text(issueType.id) }, summary: name.trim(), assignee: { id: await this.currentAccount() } };
    if (config.mapping.due !== null && due?.start) fields.duedate = due.start.slice(0, 10);
    let created: JsonRecord;
    try { created = await this.request<JsonRecord>("/issue", { method: "POST", body: JSON.stringify({ fields }) }); }
    catch (error) {
      const rejected = error instanceof JiraHttpError && error.status >= 400 && error.status < 500;
      throw new TaskCreateFailure(error instanceof Error ? error.message : String(error), rejected ? "not-created" : "unknown", { cause: error });
    }
    const remoteId = text(created?.id);
    if (!remoteId) throw new TaskCreateFailure("Jira did not return the created issue ID.", "unknown");
    try { return this.taskFromResponse(await this.readIssue(remoteId), source, config.mapping); }
    catch (error) { throw new TaskCreateFailure("Jira accepted the create request, but the new issue could not be read back.", "unknown", { cause: error }); }
  }

  async updateTask(source: SourceCandidate | SourceConfig, id: string, changes: TaskChanges, expected: Task): Promise<UpdateResult> {
    const config = await this.schema(source);
    const remoteId = id.startsWith(`${source.id}::`) ? id.slice(source.id.length + 2) : id;
    const current = this.taskFromResponse(await this.readIssue(remoteId), source, config.mapping);
    if (this.hasConflict(current, changes, expected)) return { task: current, conflict: true };
    const fields: JsonRecord = {};
    if (changes.name !== undefined) fields.summary = changes.name;
    if (changes.due !== undefined && config.mapping.due !== null) fields.duedate = changes.due?.start ? changes.due.start.slice(0, 10) : null;
    // Find the transition first so a missing one cannot leave the edit half applied.
    const transition = changes.status !== undefined ? await this.transitionFor(config.candidate, remoteId, changes.status, current) : null;
    if (Object.keys(fields).length) await this.request(`/issue/${encodeURIComponent(remoteId)}`, { method: "PUT", body: JSON.stringify({ fields }) });
    if (transition) await this.request(`/issue/${encodeURIComponent(remoteId)}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: transition } }) });
    if (!Object.keys(fields).length && !transition) return { task: current };
    return { task: this.taskFromResponse(await this.readIssue(remoteId), source, config.mapping) };
  }

  private async transitionFor(candidate: SourceCandidate, remoteId: string, value: string, current: Task): Promise<string | null> {
    const option = statusProperty(candidate).find((item) => item.id === value || item.name === value);
    if (!option) throw new JiraSchemaChangedError(candidate.id, `Jira status ${value} is unavailable.`);
    if (option.name === current.status) return null;
    const response = await this.request<JsonRecord>(`/issue/${encodeURIComponent(remoteId)}/transitions`);
    const transition = (Array.isArray(response?.transitions) ? response.transitions : []).find((item: JsonRecord) => text(item?.to?.id) === option.id);
    if (!transition) throw new Error(`Jira's workflow has no direct move from ${current.status} to ${option.name}. Change it in Jira, or remap this source's statuses.`);
    return text(transition.id);
  }

  private taskQuery(projectKey: string): string {
    return `project = "${projectKey.replace(/["\\]/g, "\\$&")}" AND assignee = currentUser() AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC`;
  }

  private async currentAccount(refresh = false): Promise<string> {
    if (this.accountId && !refresh) return this.accountId;
    const account = await this.request<JsonRecord>("/myself");
    this.accountId = text(account?.accountId);
    if (!this.accountId) throw new Error("Jira did not return the connected account.");
    return this.accountId;
  }

  private async readIssue(remoteId: string): Promise<JsonRecord> {
    return this.request<JsonRecord>(`/issue/${encodeURIComponent(remoteId)}?${new URLSearchParams({ fields: ISSUE_FIELDS.join(",") })}`);
  }

  private async inspectProject(projectKey: string): Promise<SourceCandidate> {
    const path = `/project/${encodeURIComponent(projectKey)}`;
    const project = await this.request<JsonRecord>(path);
    const key = text(project?.key) || projectKey;
    const statuses = await this.request<unknown>(`${path}/statuses`);
    const properties: PropertyInfo[] = [
      { id: "summary", name: "Summary", type: "title" },
      { id: "duedate", name: "Due date", type: "date" },
      { id: "assignee", name: "Assignee", type: "people" },
      { id: "status", name: "Status", type: "status", options: statusOptions(statuses) },
    ];
    return { id: jiraSourceId(this.site, key), databaseId: key, projectId: key, provider: "jira", baseUrl: this.site, name: text(project?.name) || key, properties };
  }

  private async schema(source: SourceCandidate | SourceConfig): Promise<{ candidate: SourceCandidate; mapping: SourceConfig["mapping"] }> {
    const candidate = await this.inspectSource(source.id);
    const mapping = "mapping" in source && source.mapping ? source.mapping : mapJiraSource(candidate).mapping;
    if (mapping.title !== "summary" || mapping.status !== "status" || (mapping.due !== null && mapping.due !== "duedate")) throw new JiraSchemaChangedError(candidate.id, "The Jira project mapping is invalid; remap its summary, due date, or status fields.");
    if (mapping.owner && mapping.owner !== "assignee") throw new JiraSchemaChangedError(candidate.id, "Choose Assignee as the Jira owner field.");
    const options = statusProperty(candidate);
    if (![mapping.complete, mapping.reopen].every((value) => options.some((option) => option.id === value || option.name === value))) throw new JiraSchemaChangedError(candidate.id, "The Jira project statuses changed; remap its complete and reopen statuses.");
    return { candidate, mapping };
  }

  private hasConflict(current: Task, changes: TaskChanges, expected: Task): boolean {
    if (changes.name !== undefined && current.name !== expected.name) return true;
    if (changes.due !== undefined && !dateEqual(current.due, expected.due)) return true;
    if (changes.status !== undefined && (current.status !== expected.status || current.completed !== expected.completed)) return true;
    return false;
  }

  private taskFromResponse(issue: JsonRecord, source: SourceCandidate | SourceConfig, mapping: SourceConfig["mapping"]): Task {
    const remoteId = text(issue.id);
    if (!remoteId) throw new Error("Jira returned an invalid issue.");
    const fields = isRecord(issue.fields) ? issue.fields : {};
    const assignee = isRecord(fields.assignee) ? fields.assignee : null;
    const statusId = text(fields.status?.id), statusName = text(fields.status?.name) || statusId;
    return {
      id: `${source.id}::${remoteId}`,
      sourceId: source.id,
      name: text(fields.summary),
      url: `${this.site}/browse/${encodeURIComponent(text(issue.key) || remoteId)}`,
      due: mapping.due === null ? null : dateValue(fields.duedate),
      status: statusName,
      completed: fields.status?.statusCategory?.key === "done" || statusId === mapping.complete || statusName === mapping.complete,
      lastEdited: text(fields.updated) || new Date().toISOString(),
      ...(mapping.owner ? { owners: assignee && text(assignee.accountId) ? [{ id: text(assignee.accountId), name: text(assignee.displayName) || text(assignee.accountId) }] : [] } : {}),
    };
  }

  private projectKeyFromUrl(url: string): string | undefined {
    const segments = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).pathname.split("/").filter(Boolean);
    const browse = segments.findIndex((item) => item.toLowerCase() === "browse");
    if (browse >= 0 && segments[browse + 1]) return decodeURIComponent(segments[browse + 1]).replace(/-\d+$/, "");
    const projects = segments.findIndex((item) => item.toLowerCase() === "projects");
    return projects >= 0 && segments[projects + 1] ? decodeURIComponent(segments[projects + 1]) : undefined;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) throw new Error("A Jira API token is required.");
    const authorization = `Basic ${Buffer.from(`${this.email}:${this.token}`).toString("base64")}`;
    let attempt = 0;
    while (true) {
      const response = await this.fetchImpl(`${this.site}${API}${path}`, {
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
        ...init,
        headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) },
      });
      if (response.status >= 200 && response.status < 300) {
        if (response.status === 204) return undefined as T;
        try { return await response.json() as T; }
        catch { return undefined as T; }
      }
      const body = await this.readErrorBody(response);
      const readOnly = !init.method || init.method === "GET" || path === "/search/jql";
      const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599 && readOnly);
      if (retryable && attempt < this.maxRetries) {
        const header = response.headers?.get?.("Retry-After");
        const seconds = header ? Number.parseFloat(header) : Number.NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1_000 : Math.min(this.maxRetryDelayMs, 500 * 2 ** attempt);
        if (delay > this.maxRetryDelayMs) throw new JiraHttpError(response.status, body);
        attempt += 1;
        if (delay) await this.sleep(delay);
        continue;
      }
      throw new JiraHttpError(response.status, body);
    }
  }

  private async readErrorBody(response: Response): Promise<unknown> {
    try { return await response.json(); }
    catch { try { return await response.text(); } catch { return undefined; } }
  }
}
