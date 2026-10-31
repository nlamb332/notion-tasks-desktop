import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DateTime } from "luxon";
import {
  CalendarProviderError,
  calendarKey,
  type CalendarClient,
  type CalendarDefinition,
  type CalendarRange,
  type CalendarWriteInput,
  type RemoteCalendarEvent,
} from "../shared/calendar";

const API = "https://www.googleapis.com/calendar/v3";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
].join(" ");
const MAX_RANGE_DAYS = 7;
const PAGE_LIMIT = 2500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type Json = Record<string, any>;
type Fetcher = typeof fetch;

async function requestWithTimeout<T>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const work = (async () => consume(await fetcher(url, { ...init, signal: controller.signal })))();
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("request timeout"));
    }, timeoutMs);
  });
  try { return await Promise.race([work, expired]); }
  finally { clearTimeout(timeout!); }
}

function providerError(code: ConstructorParameters<typeof CalendarProviderError>[1]): CalendarProviderError {
  const messages = {
    invalid: "Google Calendar returned invalid or incomplete calendar data.",
    unauthorized: "Google Calendar authorization is unavailable. Reconnect your Google account.",
    unavailable: "Google Calendar could not be reached. Try again.",
    "not-found": "The Google Calendar event no longer exists.",
    conflict: "The Google Calendar event changed or is not owned by this app.",
    "not-created": "Google Calendar did not create the event.",
    "unknown-write": "Google Calendar may have applied the change; refresh before trying again.",
  } as const;
  return new CalendarProviderError(messages[code], code);
}

function validCalendar(calendar: CalendarDefinition): void {
  if (calendar.provider !== "google" || !calendar.id || !calendar.timeZone) throw providerError("invalid");
}

function validRange(range: CalendarRange, timeZone: string): { start: string; end: string } {
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  const localStart = DateTime.fromISO(range.start, { setZone: true }).setZone(timeZone);
  const localEnd = DateTime.fromISO(range.end, { setZone: true }).setZone(timeZone);
  const startDay = localStart.toISODate();
  const endDay = localEnd.toISODate();
  const calendarDays = startDay && endDay
    ? DateTime.fromISO(endDay, { zone: "utc" }).diff(DateTime.fromISO(startDay, { zone: "utc" }), "days").days
    : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !localStart.isValid || !localEnd.isValid || calendarDays > MAX_RANGE_DAYS || calendarDays < 0) {
    throw providerError("invalid");
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function encodedId(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let buffer = 0;
  let bits = 0;
  let result = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function googleEventId(input: CalendarWriteInput): string {
  return `nt${encodedId(`${input.installationId}\0${input.blockId}`)}`;
}

function ownedMarker(event: Json): RemoteCalendarEvent["ownership"] {
  const props = event?.extendedProperties?.private;
  if (props?.notionTasksOwner !== "notion-tasks-desktop") return undefined;
  if (typeof props.installationId !== "string" || typeof props.blockId !== "string" || typeof props.operationId !== "string") return undefined;
  return { installationId: props.installationId, blockId: props.blockId, operationId: props.operationId };
}

function normalizeEvent(event: Json, key: string, timeZone: string): RemoteCalendarEvent {
  if (!event || typeof event.id !== "string" || typeof event.etag !== "string") throw providerError("invalid");
  const startDate = event.start?.date;
  const endDate = event.end?.date;
  const allDay = typeof startDate === "string" && typeof endDate === "string";
  const start = allDay ? DateTime.fromISO(startDate, { zone: timeZone }).toUTC().toISO() : event.start?.dateTime;
  const end = allDay ? DateTime.fromISO(endDate, { zone: timeZone }).toUTC().toISO() : event.end?.dateTime;
  if (typeof start !== "string" || typeof end !== "string" || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) {
    throw providerError("invalid");
  }
  const title = typeof event.summary === "string" ? event.summary : "(No title)";
  return {
    ref: { calendarKey: key, id: event.id },
    title,
    start,
    end,
    ...(allDay ? { allDay: true } : {}),
    version: event.etag,
    ...(typeof event.htmlLink === "string" ? { url: event.htmlLink } : {}),
    ...(ownedMarker(event) ? { ownership: ownedMarker(event) } : {}),
  };
}

function attendeeDeclined(event: Json): boolean {
  if (!Array.isArray(event.attendees)) return false;
  return event.attendees.some((attendee: Json) => attendee?.self === true && attendee?.responseStatus === "declined");
}

function overlaps(event: RemoteCalendarEvent, start: string, end: string): boolean {
  return Date.parse(event.start) < Date.parse(end) && Date.parse(event.end) > Date.parse(start);
}

function messageCode(status: number): ConstructorParameters<typeof CalendarProviderError>[1] {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 409 || status === 412) return "conflict";
  if (status >= 500) return "unavailable";
  return "invalid";
}

export interface GoogleCalendarClientOptions {
  getAccessToken: () => Promise<string>;
  fetch?: Fetcher;
  timeoutMs?: number;
}

/** Google Calendar API adapter. It never logs or includes response bodies in errors. */
export class GoogleCalendarClient implements CalendarClient {
  private readonly fetcher: Fetcher;

  constructor(private readonly options: GoogleCalendarClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Json | null> {
    let token: string;
    try { token = await this.options.getAccessToken(); }
    catch { throw providerError("unauthorized"); }
    if (!token) throw providerError("unauthorized");
    let response: Response;
    try {
      return await requestWithTimeout(this.fetcher, `${API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
      }, this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, async (result) => {
        if (result.status === 404) return null;
        if (!result.ok) throw providerError(messageCode(result.status));
        if (result.status === 204) return null;
        try { return await result.json() as Json; }
        catch { throw providerError("invalid"); }
      });
    } catch (error) {
      if (error instanceof CalendarProviderError) throw error;
      throw providerError("unavailable");
    }
  }

  async listCalendars(): Promise<CalendarDefinition[]> {
    const results: CalendarDefinition[] = [];
    let pageToken: string | undefined;
    let accountIdentity: string | undefined;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ maxResults: "250", ...(pageToken ? { pageToken } : {}) });
      const page = await this.request(`/users/me/calendarList?${params}`);
      if (!page || !Array.isArray(page.items)) throw providerError("invalid");
      for (const item of page.items) {
        if (!item || typeof item.id !== "string" || typeof item.summary !== "string") throw providerError("invalid");
        const role = item.accessRole;
        if (item.primary === true) accountIdentity = item.id;
        // Free/busy-only calendars are intentionally unavailable: this client needs event details.
        const canRead = role === "owner" || role === "writer" || role === "reader";
        const canWrite = role === "owner";
        results.push({ provider: "google", id: item.id, name: item.summary, timeZone: typeof item.timeZone === "string" ? item.timeZone : "UTC", canRead, canWrite });
      }
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
      if (pageToken && seen.has(pageToken)) throw providerError("invalid");
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    if (!accountIdentity) throw providerError("invalid");
    const accountId = `google-${createHash("sha256").update(accountIdentity).digest("hex").slice(0, 24)}`;
    return results.map((item) => ({ ...item, accountId }));
  }

  async readEvents(calendar: CalendarDefinition, range: CalendarRange): Promise<RemoteCalendarEvent[]> {
    validCalendar(calendar);
    const bounded = validRange(range, calendar.timeZone);
    const items: Json[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({
        timeMin: bounded.start,
        timeMax: bounded.end,
        singleEvents: "true",
        showDeleted: "true",
        orderBy: "startTime",
        maxResults: String(PAGE_LIMIT),
        timeZone: calendar.timeZone,
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await this.request(`/calendars/${encodeURIComponent(calendar.id)}/events?${params}`);
      if (!page || !Array.isArray(page.items)) throw providerError("invalid");
      items.push(...page.items);
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
      if (pageToken && seen.has(pageToken)) throw providerError("invalid");
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    const key = calendarKey(calendar);
    const events: RemoteCalendarEvent[] = [];
    for (const item of items) {
      if (!item || typeof item.status !== "string") throw providerError("invalid");
      if (item.status === "cancelled" || item.transparency === "transparent" || attendeeDeclined(item)) continue;
      const event = normalizeEvent(item, key, calendar.timeZone);
      if (overlaps(event, bounded.start, bounded.end)) events.push(event);
    }
    return events;
  }

  async getEvent(calendar: CalendarDefinition, eventId: string): Promise<RemoteCalendarEvent | null> {
    validCalendar(calendar);
    if (!eventId) throw providerError("invalid");
    const event = await this.request(`/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(eventId)}`);
    if (!event || event.status === "cancelled") return null;
    return normalizeEvent(event, calendarKey(calendar), calendar.timeZone);
  }

  private body(input: CalendarWriteInput): Json {
    return {
      summary: input.title,
      start: { dateTime: input.start },
      end: { dateTime: input.end },
      ...(input.taskUrl ? { source: { title: input.title, url: input.taskUrl } } : {}),
      extendedProperties: { private: {
        notionTasksOwner: "notion-tasks-desktop",
        installationId: input.installationId,
        blockId: input.blockId,
        operationId: input.operationId,
      } },
    };
  }

  private isExact(event: RemoteCalendarEvent, input: CalendarWriteInput): boolean {
    return event.ownership?.installationId === input.installationId && event.ownership.blockId === input.blockId &&
      event.ownership.operationId === input.operationId && event.title === input.title &&
      Date.parse(event.start) === Date.parse(input.start) && Date.parse(event.end) === Date.parse(input.end);
  }

  async createEvent(calendar: CalendarDefinition, input: CalendarWriteInput): Promise<RemoteCalendarEvent> {
    validCalendar(calendar);
    if (!calendar.canWrite || !input.installationId || !input.blockId || !input.operationId || !input.title || !Number.isFinite(Date.parse(input.start)) || !Number.isFinite(Date.parse(input.end)) || Date.parse(input.end) <= Date.parse(input.start)) throw providerError("invalid");
    const id = googleEventId(input);
    const existing = await this.getEvent(calendar, id);
    if (existing) {
      if (this.isExact(existing, input)) return existing;
      throw providerError("conflict");
    }
    let response: Json | null;
    try {
      response = await this.request(`/calendars/${encodeURIComponent(calendar.id)}/events?sendUpdates=none`, { method: "POST", body: JSON.stringify({ id, ...this.body(input) }) });
    } catch (error) {
      if (error instanceof CalendarProviderError && error.code === "conflict") {
        const recovered = await this.getEvent(calendar, id).catch(() => null);
        if (recovered && this.isExact(recovered, input)) return recovered;
        throw providerError("conflict");
      }
      if (error instanceof CalendarProviderError && !["unavailable", "unknown-write"].includes(error.code)) throw error;
      const recovered = await this.getEvent(calendar, id).catch(() => null);
      if (recovered && this.isExact(recovered, input)) return recovered;
      if (recovered) throw providerError("conflict");
      throw providerError("unknown-write");
    }
    if (!response) {
      const recovered = await this.getEvent(calendar, id);
      if (recovered && this.isExact(recovered, input)) return recovered;
      throw providerError("unknown-write");
    }
    const created = normalizeEvent(response, calendarKey(calendar), calendar.timeZone);
    if (!this.isExact(created, input)) throw providerError("conflict");
    return created;
  }

  async updateEvent(calendar: CalendarDefinition, eventId: string, input: CalendarWriteInput, expectedVersion: string): Promise<RemoteCalendarEvent> {
    validCalendar(calendar);
    if (!calendar.canWrite || !eventId || !expectedVersion) throw providerError("invalid");
    const current = await this.getEvent(calendar, eventId);
    if (!current) throw providerError("not-found");
    if (!current.ownership || current.ownership.installationId !== input.installationId || current.ownership.blockId !== input.blockId || current.version !== expectedVersion) throw providerError("conflict");
    const response = await this.request(`/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "PATCH", headers: { "If-Match": expectedVersion }, body: JSON.stringify(this.body(input)),
    });
    if (!response) throw providerError("not-found");
    const updated = normalizeEvent(response, calendarKey(calendar), calendar.timeZone);
    if (!this.isExact(updated, input)) throw providerError("conflict");
    return updated;
  }

  async deleteEvent(calendar: CalendarDefinition, eventId: string, expectedVersion: string): Promise<void> {
    validCalendar(calendar);
    if (!calendar.canWrite || !eventId || !expectedVersion) throw providerError("invalid");
    const current = await this.getEvent(calendar, eventId);
    if (!current) return;
    if (!current.ownership || current.version !== expectedVersion) throw providerError("conflict");
    // Runtime must additionally validate its durable block->event ownership map before calling this method.
    await this.request(`/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "DELETE", headers: { "If-Match": expectedVersion },
    });
  }
}

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
}

/** Callbacks must persist the complete record using OS-backed encrypted storage. */
export interface GoogleOAuthCredentialStore {
  loadCredentials: () => Promise<GoogleOAuthCredentials | null>;
  saveCredentials: (credentials: GoogleOAuthCredentials) => Promise<void>;
  clearCredentials: () => Promise<void>;
}

export interface GoogleOAuthClientOptions extends GoogleOAuthCredentialStore {
  openExternal: (url: string) => Promise<unknown> | unknown;
  fetch?: Fetcher;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  /** Test seam for a simulated loopback callback; production should omit it. */
  receiveCallback?: (redirectUri: string, state: string) => Promise<{ code?: string; state: string; error?: string }>;
}

interface OAuthClientConfig { clientId: string; clientSecret?: string }

function parseClientConfig(value: unknown): OAuthClientConfig {
  const root = value as Json;
  const config = root?.installed ?? root?.desktop ?? root;
  if (!config || typeof config.client_id !== "string" || !config.client_id.endsWith(".apps.googleusercontent.com")) throw providerError("invalid");
  // Endpoints and redirects supplied by JSON are deliberately ignored. Only the
  // client identity and optional secret are accepted; service origins are constants.
  return { clientId: config.client_id, ...(typeof config.client_secret === "string" && config.client_secret ? { clientSecret: config.client_secret } : {}) };
}

function errorFromOAuthResult(result: Json, status: number): CalendarProviderError {
  const error = typeof result.error === "string" ? result.error : "";
  if (error === "access_denied") return new CalendarProviderError("Google access was declined.", "unauthorized");
  if (status === 400 && (error === "invalid_grant" || error === "invalid_client")) return providerError("unauthorized");
  return status >= 500 ? providerError("unavailable") : providerError("unauthorized");
}

/** Desktop OAuth Authorization Code + PKCE with an ephemeral IPv4 loopback listener. */
export class GoogleOAuthClient {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private config: OAuthClientConfig | null = null;
  private pending: { server: Server; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; state: string } | null = null;
  private credentials: GoogleOAuthCredentials | null = null;
  private generation = 0;
  private credentialWrites: Promise<void> = Promise.resolve();

  constructor(private readonly options: GoogleOAuthClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async configureClient(json: unknown): Promise<void> {
    this.invalidate(new CalendarProviderError("Google sign-in was superseded by new client configuration.", "unavailable"));
    const generation = this.generation;
    this.config = parseClientConfig(json);
    const previous = await this.load();
    this.assertGeneration(generation);
    const credentials: GoogleOAuthCredentials = {
      clientId: this.config.clientId,
      ...(this.config.clientSecret ? { clientSecret: this.config.clientSecret } : {}),
      ...(previous?.clientId === this.config.clientId ? {
        ...(previous.refreshToken ? { refreshToken: previous.refreshToken } : {}),
        ...(previous.accessToken ? { accessToken: previous.accessToken } : {}),
        ...(previous.expiresAt ? { expiresAt: previous.expiresAt } : {}),
      } : {}),
    };
    try { await this.saveForGeneration(credentials, generation); }
    catch { throw new CalendarProviderError("Secure Google credentials could not be saved.", "unavailable"); }
    this.assertGeneration(generation);
    this.credentials = credentials;
  }

  isConfigured(): boolean { return this.config !== null; }

  async isConnected(): Promise<boolean> {
    const credentials = await this.load();
    return !!credentials?.refreshToken;
  }

  private async load(): Promise<GoogleOAuthCredentials | null> {
    if (this.credentials) return this.credentials;
    try { this.credentials = await this.options.loadCredentials(); }
    catch { throw new CalendarProviderError("Secure Google credentials are unavailable.", "unavailable"); }
    if (this.credentials && this.config && this.credentials.clientId !== this.config.clientId) return null;
    return this.credentials;
  }

  private ensureConfigured(): OAuthClientConfig {
    if (!this.config) throw new CalendarProviderError("Import Google desktop client JSON before connecting.", "invalid");
    return this.config;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new CalendarProviderError("Google authorization changed during the request. Reconnect and try again.", "unauthorized");
  }

  private invalidate(reason: Error): void {
    this.generation += 1;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(reason);
    pending.server.close();
  }

  private async queueCredentialWrite(action: () => Promise<void>): Promise<void> {
    const write = this.credentialWrites.then(action, action);
    this.credentialWrites = write.catch(() => undefined);
    await write;
  }

  private async saveForGeneration(credentials: GoogleOAuthCredentials, generation: number): Promise<void> {
    await this.queueCredentialWrite(async () => {
      this.assertGeneration(generation);
      await this.options.saveCredentials(credentials);
    });
    this.assertGeneration(generation);
  }

  private async clearQueued(): Promise<void> {
    await this.queueCredentialWrite(() => this.options.clearCredentials());
  }

  private async postToken(params: URLSearchParams): Promise<Json> {
    try {
      return await requestWithTimeout(this.fetcher, TOKEN, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(),
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, async (response) => {
        let body: Json;
        try { body = await response.json() as Json; }
        catch { throw providerError("invalid"); }
        if (!response.ok) throw errorFromOAuthResult(body, response.status);
        return body;
      });
    } catch (error) {
      if (error instanceof CalendarProviderError) throw error;
      throw providerError("unavailable");
    }
  }

  private async exchange(code: string, verifier: string, redirectUri: string, generation: number): Promise<void> {
    const config = this.ensureConfigured();
    const params = new URLSearchParams({ client_id: config.clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
    if (config.clientSecret) params.set("client_secret", config.clientSecret);
    const result = await this.postToken(params);
    this.assertGeneration(generation);
    if (typeof result.refresh_token !== "string" || typeof result.access_token !== "string" || typeof result.expires_in !== "number") throw providerError("invalid");
    const credentials: GoogleOAuthCredentials = {
      clientId: config.clientId,
      ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
      refreshToken: result.refresh_token,
      accessToken: result.access_token,
      expiresAt: this.now() + result.expires_in * 1000,
    };
    try { await this.saveForGeneration(credentials, generation); }
    catch { throw new CalendarProviderError("Secure Google credentials could not be saved.", "unavailable"); }
    this.credentials = credentials;
  }

  async connect(): Promise<void> {
    const config = this.ensureConfigured();
    if (this.pending) throw new CalendarProviderError("A Google sign-in is already running.", "conflict");
    const generation = this.generation;
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let server: Server;
    try {
      server = createServer();
      server.listen(0, "127.0.0.1");
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    } catch { throw providerError("unavailable"); }
    if (generation !== this.generation) {
      server.close();
      this.assertGeneration(generation);
    }
    const address = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const callback = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // Attach both outcomes immediately; callers often await a UI action before this settles.
    const callbackOutcome = callback.then(
      (code) => ({ code }),
      (error: unknown) => ({ error }),
    );
    const timeout = this.options.timeoutMs ?? 180_000;
    const timer = setTimeout(() => rejectCode(new CalendarProviderError("Google sign-in timed out.", "unavailable")), timeout);
    this.pending = { server, reject: rejectCode, timer, state };
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/oauth2callback") { response.writeHead(404).end(); return; }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/plain" }).end("Sign-in could not be verified. You can close this window.");
        rejectCode(new CalendarProviderError("Google sign-in could not be verified.", "unauthorized"));
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        response.writeHead(200, { "Content-Type": "text/plain" }).end("Google sign-in was not completed. You can close this window.");
        rejectCode(oauthError === "access_denied" ? new CalendarProviderError("Google access was declined.", "unauthorized") : providerError("unauthorized"));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) { response.writeHead(400).end(); rejectCode(providerError("invalid")); return; }
      response.writeHead(200, { "Content-Type": "text/plain" }).end("Google Calendar is connected. You can close this window.");
      resolveCode(code);
    });
    const authUrl = new URL(AUTH);
    authUrl.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    try {
      await this.options.openExternal(authUrl.toString());
      this.assertGeneration(generation);
      if (this.options.receiveCallback) {
        void this.options.receiveCallback(redirectUri, state).then((received) => {
          if (received.state !== state) { rejectCode(new CalendarProviderError("Google sign-in could not be verified.", "unauthorized")); return; }
          if (received.error === "access_denied") { rejectCode(new CalendarProviderError("Google access was declined.", "unauthorized")); return; }
          if (received.error) { rejectCode(providerError("unauthorized")); return; }
          if (!received.code) { rejectCode(providerError("invalid")); return; }
          resolveCode(received.code);
        }, () => rejectCode(providerError("unavailable")));
      }
      const outcome = await callbackOutcome;
      if ("error" in outcome) throw outcome.error;
      const code = outcome.code;
      this.assertGeneration(generation);
      await this.exchange(code, verifier, redirectUri, generation);
    } catch (error) {
      if (error instanceof CalendarProviderError) throw error;
      throw providerError("unavailable");
    } finally {
      if (this.pending?.server === server) this.pending = null;
      clearTimeout(timer);
      server.close();
    }
  }

  cancelConnection(): void {
    this.invalidate(new CalendarProviderError("Google sign-in was cancelled.", "unavailable"));
  }

  async getAccessToken(): Promise<string> {
    const generation = this.generation;
    const config = this.ensureConfigured();
    const credentials = await this.load();
    this.assertGeneration(generation);
    if (!credentials?.refreshToken) throw providerError("unauthorized");
    if (credentials.accessToken && credentials.expiresAt && credentials.expiresAt > this.now() + 60_000) return credentials.accessToken;
    const params = new URLSearchParams({ client_id: config.clientId, refresh_token: credentials.refreshToken, grant_type: "refresh_token" });
    if (config.clientSecret) params.set("client_secret", config.clientSecret);
    try {
      const result = await this.postToken(params);
      this.assertGeneration(generation);
      if (typeof result.access_token !== "string" || typeof result.expires_in !== "number") throw providerError("invalid");
      const updated: GoogleOAuthCredentials = { ...credentials, accessToken: result.access_token, expiresAt: this.now() + result.expires_in * 1000 };
      await this.saveForGeneration(updated, generation);
      this.credentials = updated;
      return updated.accessToken!;
    } catch (error) {
      if (generation !== this.generation) throw new CalendarProviderError("Google authorization changed during the request. Reconnect and try again.", "unauthorized");
      if (error instanceof CalendarProviderError && error.code === "unauthorized") {
        this.credentials = null;
        try {
          await this.saveForGeneration({ clientId: config.clientId, ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}) }, generation);
          this.credentials = { clientId: config.clientId, ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}) };
        } catch { /* Keep the sanitized reconnect error. */ }
      }
      throw error instanceof CalendarProviderError ? error : providerError("unavailable");
    }
  }

  async disconnect(): Promise<void> {
    this.invalidate(new CalendarProviderError("Google sign-in was cancelled.", "unavailable"));
    const credentials = await this.load();
    this.credentials = null;
    try { await this.clearQueued(); }
    catch { throw new CalendarProviderError("Secure Google credentials could not be cleared.", "unavailable"); }
    if (credentials?.refreshToken) {
      try {
        await requestWithTimeout(this.fetcher, REVOKE, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: credentials.refreshToken }).toString(),
        }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, () => undefined);
      }
      catch { /* Local disconnect succeeds even when remote revocation is unavailable. */ }
    }
  }
}

export { SCOPES as GOOGLE_CALENDAR_SCOPES };
