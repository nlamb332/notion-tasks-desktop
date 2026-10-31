import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarProviderError, calendarKey, type CalendarDefinition } from "../shared/calendar";
import { GoogleCalendarClient, GoogleOAuthClient, type GoogleOAuthCredentials } from "./google-calendar";

const calendar: CalendarDefinition = { provider: "google", id: "owner@example.com", name: "Work", timeZone: "America/Chicago", canRead: true, canWrite: true };
const event = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ id, etag: `"${id}-v1"`, status: "confirmed", summary: id, start: start.includes("T") ? { dateTime: start } : { date: start }, end: end.includes("T") ? { dateTime: end } : { date: end }, ...extra });
const response = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const input = { installationId: "install-A", blockId: "block-1", operationId: "op-1", title: "Focus", start: "2026-11-01T08:00:00-06:00", end: "2026-11-01T09:00:00-06:00" };

describe("GoogleCalendarClient", () => {
  it("paginates complete bounded instance reads and excludes cancelled, transparent, and self-declined events", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ items: [event("busy", "2026-11-01", "2026-11-02"), event("clear", "2026-11-01T09:00:00-06:00", "2026-11-01T10:00:00-06:00", { transparency: "transparent" })], nextPageToken: "next" }))
      .mockResolvedValueOnce(response({ items: [event("cancel", "2026-11-01T11:00:00Z", "2026-11-01T12:00:00Z", { status: "cancelled" }), event("declined", "2026-11-01T13:00:00Z", "2026-11-01T14:00:00Z", { attendees: [{ self: true, responseStatus: "declined" }] }), event("later", "2026-11-09", "2026-11-10")] }));
    const client = new GoogleCalendarClient({ getAccessToken: async () => "token", fetch: fetcher as typeof fetch });
    const result = await client.readEvents(calendar, { start: "2026-11-01T00:00:00-05:00", end: "2026-11-08T00:00:00-06:00" });
    expect(result.map((item) => item.ref.id)).toEqual(["busy"]);
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("singleEvents=true");
    expect(urls[0]).toContain("timeZone=America%2FChicago");
    expect(urls[1]).toContain("pageToken=next");
    expect(result[0]).toMatchObject({ allDay: true, start: "2026-11-01T05:00:00.000Z", end: "2026-11-02T06:00:00.000Z", ref: { calendarKey: calendarKey(calendar) } });
  });

  it("lists calendars while disabling free/busy-only access and paginates", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ items: [{ id: "primary-a", summary: "Primary", accessRole: "owner", primary: true }, { id: "a", summary: "A", accessRole: "owner", timeZone: "America/Chicago" }], nextPageToken: "p" })).mockResolvedValueOnce(response({ items: [{ id: "b", summary: "Busy only", accessRole: "freeBusyReader" }] }));
    const client = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: fetcher as typeof fetch });
    const calendars = await client.listCalendars();
    expect(calendars).toMatchObject([
      { provider: "google", id: "primary-a", name: "Primary", timeZone: "UTC", canRead: true, canWrite: true, accountId: expect.stringMatching(/^google-[0-9a-f]{24}$/) },
      { provider: "google", id: "a", name: "A", timeZone: "America/Chicago", canRead: true, canWrite: true, accountId: calendars[0].accountId },
      { provider: "google", id: "b", name: "Busy only", timeZone: "UTC", canRead: false, canWrite: false, accountId: calendars[0].accountId },
    ]);
    const otherAccount = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: vi.fn().mockResolvedValue(response({ items: [{ id: "primary-b", summary: "Primary", accessRole: "owner", primary: true }, { id: "a", summary: "A", accessRole: "writer" }] })) as typeof fetch });
    const alternate = await otherAccount.listCalendars();
    expect(alternate[1].id).toBe(calendars[1].id);
    expect(alternate[1].accountId).not.toBe(calendars[1].accountId);
  });

  it("creates deterministic owned events and reconciles an ambiguous network outcome by exact GET", async () => {
    let postId = "";
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === "POST") { postId = JSON.parse(String(init.body)).id; throw new Error("connection dropped"); }
      if (postId && target.includes(`/events/${postId}`)) return response(event(postId, "2026-11-01T14:00:00Z", "2026-11-01T15:00:00Z", { summary: input.title, extendedProperties: { private: { notionTasksOwner: "notion-tasks-desktop", installationId: input.installationId, blockId: input.blockId, operationId: input.operationId } } }));
      return response(null, 404);
    });
    const client = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: fetcher as typeof fetch });
    const created = await client.createEvent(calendar, input);
    expect(created.ownership).toEqual({ installationId: input.installationId, blockId: input.blockId, operationId: input.operationId });
    expect(postId).toMatch(/^nt[0-9a-v]{52}$/);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("reconciles a 409 only when the existing deterministic ID has the exact operation marker and effect", async () => {
    let id = "";
    const owned = { notionTasksOwner: "notion-tasks-desktop", installationId: input.installationId, blockId: input.blockId, operationId: input.operationId };
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === "POST") { id = JSON.parse(String(init.body)).id; return response({ error: { message: "duplicate" } }, 409); }
      if (id && target.includes(`/events/${id}`)) return response(event(id, "2026-11-01T14:00:00Z", "2026-11-01T15:00:00Z", { summary: input.title, extendedProperties: { private: owned } }));
      return response(null, 404);
    });
    const client = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: fetcher as typeof fetch });
    await expect(client.createEvent(calendar, input)).resolves.toMatchObject({ title: input.title, ownership: { operationId: input.operationId } });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("never updates an unowned event and maps If-Match failures to conflict", async () => {
    const unowned = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: vi.fn().mockResolvedValue(response(event("e", "2026-11-01T14:00:00Z", "2026-11-01T15:00:00Z"))) as typeof fetch });
    await expect(unowned.updateEvent(calendar, "e", input, '"e-v1"')).rejects.toMatchObject({ code: "conflict" });
    const owned = { notionTasksOwner: "notion-tasks-desktop", installationId: input.installationId, blockId: input.blockId, operationId: input.operationId };
    const foreignOwned = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: vi.fn().mockResolvedValue(response(event("e", input.start, input.end, { extendedProperties: { private: { ...owned, blockId: "different-block" } } }))) as typeof fetch });
    await expect(foreignOwned.updateEvent(calendar, "e", input, '"e-v1"')).rejects.toMatchObject({ code: "conflict" });
    const fetcher = vi.fn().mockResolvedValueOnce(response(event("e", input.start, input.end, { extendedProperties: { private: owned } }))).mockResolvedValueOnce(response({ error: { message: "opaque details" } }, 412));
    const client = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: fetcher as typeof fetch });
    let failure: unknown;
    try { await client.updateEvent(calendar, "e", input, '"e-v1"'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CalendarProviderError);
    expect(failure).toMatchObject({ code: "conflict" });
    expect(String(fetcher.mock.calls[1][0])).toContain("sendUpdates=none");
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ "If-Match": '"e-v1"' });
  });

  it("deletes only a marked event with the expected ETag", async () => {
    const owned = { notionTasksOwner: "notion-tasks-desktop", installationId: input.installationId, blockId: input.blockId, operationId: input.operationId };
    const fetcher = vi.fn().mockResolvedValueOnce(response(event("e", input.start, input.end, { extendedProperties: { private: owned } }))).mockResolvedValueOnce(response(null, 204));
    const client = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: fetcher as typeof fetch });
    await expect(client.deleteEvent(calendar, "e", '"e-v1"')).resolves.toBeUndefined();
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "DELETE", headers: { "If-Match": '"e-v1"' } });
  });

  it("rejects malformed coverage and ranges longer than seven days", async () => {
    const client = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: vi.fn() as typeof fetch });
    await expect(client.readEvents(calendar, { start: "2026-01-01T00:00:00Z", end: "2026-01-09T00:00:00Z" })).rejects.toMatchObject({ code: "invalid" });
    const dst = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: vi.fn().mockResolvedValue(response({ items: [event("day", "2026-11-01", "2026-11-02")] })) as typeof fetch });
    await expect(dst.readEvents(calendar, { start: "2026-11-01T00:00:00-05:00", end: "2026-11-08T00:00:00-06:00" })).resolves.toHaveLength(1);
  });

  it("bounds stalled Google Calendar API requests", async () => {
    const client = new GoogleCalendarClient({ getAccessToken: async () => "t", fetch: vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch, timeoutMs: 5 });
    await expect(client.listCalendars()).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("GoogleOAuthClient", () => {
  const config = { installed: { client_id: "client.apps.googleusercontent.com", client_secret: "secret", auth_uri: "https://attacker.invalid/auth", token_uri: "https://attacker.invalid/token", redirect_uris: ["https://attacker.invalid/callback"] } };
  const store = (initial: GoogleOAuthCredentials | null = null) => {
    let value = initial;
    return {
      loadCredentials: vi.fn(async () => value),
      saveCredentials: vi.fn(async (next: GoogleOAuthCredentials) => { value = next; }),
      clearCredentials: vi.fn(async () => { value = null; }),
      value: () => value,
    };
  };

  it("uses loopback PKCE with random state and fixed official origins, then saves credentials", async () => {
    const saved = store();
    let callbackUrl = "";
    let verifier = "";
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      const params = new URLSearchParams(String(init?.body));
      verifier = params.get("code_verifier") ?? "";
      return response({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    });
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: (url) => { callbackUrl = url; }, fetch: fetcher as typeof fetch, now: () => 10_000, receiveCallback: async (_redirect, state) => ({ state, code: "auth-code" }) });
    await oauth.configureClient(config);
    const connecting = oauth.connect();
    await vi.waitFor(() => expect(callbackUrl).not.toBe("") );
    const auth = new URL(callbackUrl);
    expect(auth.origin).toBe("https://accounts.google.com");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toBeTruthy();
    expect(auth.searchParams.get("state")).toHaveLength(43);
    expect(auth.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(auth.searchParams.get("redirect_uri")).not.toContain("attacker");
    await connecting;
    expect(verifier.length).toBeGreaterThan(40);
    expect(saved.value()).toMatchObject({ clientId: "client.apps.googleusercontent.com", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", expiresAt: 3_610_000 });
    expect(await oauth.isConnected()).toBe(true);
  });

  it("rejects mismatched callback state without revealing values", async () => {
    const saved = store();
    let callbackUrl = "";
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: (url) => { callbackUrl = url; }, receiveCallback: async () => ({ state: "wrong", code: "sensitive" }) });
    await oauth.configureClient(config);
    const connecting = oauth.connect().then(() => null, (error) => error);
    await vi.waitFor(() => expect(callbackUrl).not.toBe("") );
    await expect(connecting).resolves.toMatchObject({ code: "unauthorized" });
    expect(saved.value()).not.toMatchObject({ refreshToken: expect.anything() });
  });

  it("refreshes expired access tokens and clears revoked credentials", async () => {
    const saved = store({ clientId: "client.apps.googleusercontent.com", refreshToken: "r", accessToken: "old", expiresAt: 1 });
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: () => undefined, now: () => 100_000, fetch: vi.fn().mockResolvedValue(response({ access_token: "fresh", expires_in: 3600 })) as typeof fetch });
    await oauth.configureClient({ installed: { client_id: "client.apps.googleusercontent.com" } });
    expect(await oauth.getAccessToken()).toBe("fresh");
    expect(saved.value()?.refreshToken).toBe("r");
    const revokedStore = store({ clientId: "client.apps.googleusercontent.com", refreshToken: "r" });
    const revoked = new GoogleOAuthClient({ ...revokedStore, openExternal: () => undefined, fetch: vi.fn().mockResolvedValue(response({ error: "invalid_grant" }, 400)) as typeof fetch });
    await revoked.configureClient({ installed: { client_id: "client.apps.googleusercontent.com" } });
    await expect(revoked.getAccessToken()).rejects.toMatchObject({ code: "unauthorized" });
    expect(revokedStore.clearCredentials).not.toHaveBeenCalled();
    expect(revokedStore.value()).toEqual({ clientId: "client.apps.googleusercontent.com" });
  });

  it("does not save or return authorization-code tokens when connection is cancelled during exchange", async () => {
    const saved = store();
    let resolveToken!: (value: Response) => void;
    let tokenRequestStarted!: () => void;
    const started = new Promise<void>((resolve) => { tokenRequestStarted = resolve; });
    const fetcher = vi.fn(() => {
      tokenRequestStarted();
      return new Promise<Response>((resolve) => { resolveToken = resolve; });
    });
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: () => undefined, receiveCallback: async (_redirect, state) => ({ state, code: "code" }), fetch: fetcher as typeof fetch });
    await oauth.configureClient({ installed: { client_id: "client.apps.googleusercontent.com" } });
    const connecting = oauth.connect().then(() => null, (error) => error);
    await started;
    oauth.cancelConnection();
    resolveToken(response({ access_token: "late-access", refresh_token: "late-refresh", expires_in: 3600 }));
    await expect(connecting).resolves.toMatchObject({ code: "unauthorized" });
    expect(saved.value()).toEqual({ clientId: "client.apps.googleusercontent.com" });
  });

  it("does not save or return refresh tokens after disconnect and posts revocation tokens in the body", async () => {
    const saved = store({ clientId: "client.apps.googleusercontent.com", refreshToken: "old-refresh", accessToken: "expired", expiresAt: 1 });
    let resolveRefresh!: (value: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const revokeRequests: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "https://oauth2.googleapis.com/revoke") {
        revokeRequests.push({ url: String(url), init });
        return Promise.resolve(response({}));
      }
      refreshStarted();
      return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    });
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: () => undefined, fetch: fetcher as typeof fetch, now: () => 100_000 });
    await oauth.configureClient({ installed: { client_id: "client.apps.googleusercontent.com" } });
    const refreshing = oauth.getAccessToken().then(() => null, (error) => error);
    await started;
    await oauth.disconnect();
    resolveRefresh(response({ access_token: "late-access", expires_in: 3600 }));
    await expect(refreshing).resolves.toMatchObject({ code: "unauthorized" });
    expect(saved.value()).toBeNull();
    expect(revokeRequests[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(revokeRequests[0].url).not.toContain("old-refresh");
    expect(new URLSearchParams(String(revokeRequests[0].init?.body)).get("token")).toBe("old-refresh");
  });

  it("invalidates an in-flight refresh when the client configuration changes", async () => {
    const saved = store({ clientId: "client.apps.googleusercontent.com", refreshToken: "refresh", accessToken: "expired", expiresAt: 1 });
    let resolveRefresh!: (value: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const fetcher = vi.fn(() => {
      refreshStarted();
      return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    });
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: () => undefined, fetch: fetcher as typeof fetch });
    await oauth.configureClient({ installed: { client_id: "client.apps.googleusercontent.com" } });
    const refreshing = oauth.getAccessToken().then(() => null, (error) => error);
    await started;
    await oauth.configureClient({ installed: { client_id: "new-client.apps.googleusercontent.com" } });
    resolveRefresh(response({ access_token: "late-access", expires_in: 3600 }));
    await expect(refreshing).resolves.toMatchObject({ code: "unauthorized" });
    expect(saved.value()).toEqual({ clientId: "new-client.apps.googleusercontent.com" });
  });

  it("bounds stalled OAuth token requests", async () => {
    const saved = store({ clientId: "client.apps.googleusercontent.com", refreshToken: "refresh", expiresAt: 1 });
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: () => undefined, fetch: vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch, now: () => 100_000, requestTimeoutMs: 5 });
    await oauth.configureClient({ installed: { client_id: "client.apps.googleusercontent.com" } });
    await expect(oauth.getAccessToken()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("supports cancellation and disconnect clears encrypted state", async () => {
    const saved = store({ clientId: "client.apps.googleusercontent.com", refreshToken: "r" });
    let callbackUrl = "";
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: (url) => { callbackUrl = url; }, receiveCallback: () => new Promise(() => undefined) });
    await oauth.configureClient({ installed: { client_id: "client.apps.googleusercontent.com" } });
    const connecting = oauth.connect().then(() => null, (error) => error);
    await vi.waitFor(() => expect(callbackUrl).not.toBe("") );
    oauth.cancelConnection();
    await expect(connecting).resolves.toMatchObject({ message: "Google sign-in was cancelled." });
    await oauth.disconnect();
    expect(saved.clearCredentials).toHaveBeenCalledOnce();
  });

  it("closes a timed-out sign-in and returns a sanitized timeout error", async () => {
    const saved = store();
    const oauth = new GoogleOAuthClient({ ...saved, openExternal: () => undefined, receiveCallback: () => new Promise(() => undefined), timeoutMs: 5 });
    await oauth.configureClient({ installed: { client_id: "client.apps.googleusercontent.com" } });
    const connecting = oauth.connect().then(() => null, (error) => error);
    await expect(connecting).resolves.toMatchObject({ message: "Google sign-in timed out.", code: "unavailable" });
    expect(saved.value()?.refreshToken).toBeUndefined();
  });
});

afterEach(() => vi.restoreAllMocks());
