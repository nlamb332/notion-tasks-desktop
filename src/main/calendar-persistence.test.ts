import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppPersistence, defaultPersistedData } from "./persistence";

const mockSafeStorage = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => mockSafeStorage.available,
  encryptString: (value: string) => Buffer.from(`encrypted-test:${Buffer.from(value).toString("base64")}`),
  decryptString: (value: Buffer) => Buffer.from(value.toString().replace(/^encrypted-test:/, ""), "base64").toString(),
} }));

const cacheRoot = path.resolve(".cache");
const directories: string[] = [];

function assertInsideCache(directory: string): void {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${cacheRoot}${path.sep}`)) throw new Error(`Refusing to access test directory outside workspace .cache: ${resolved}`);
}

function storage() {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cacheRoot, "calendar-persistence-test-"));
  assertInsideCache(directory);
  directories.push(directory);
  return { directory, persistence: new AppPersistence(directory) };
}

afterEach(() => {
  mockSafeStorage.available = true;
  for (const directory of directories.splice(0)) {
    assertInsideCache(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Google Calendar and live planner persistence", () => {
  it("encrypts Google client and token credentials in their own file, never in state.json", () => {
    const { directory, persistence } = storage();
    const credentials = {
      clientId: "desktop-client.apps.googleusercontent.com",
      clientSecret: "fake-client-secret-7b21",
      refreshToken: "fake-refresh-token-e83a",
      accessToken: "fake-access-token-4c19",
      expiresAt: 1_900_000_000_000,
    };
    const state = defaultPersistedData();
    persistence.saveGoogleCalendarCredentials(credentials);
    persistence.save(state);

    const credentialsPath = path.join(directory, "google-calendar-credentials.enc");
    const rawCredentials = fs.readFileSync(credentialsPath, "utf8");
    const rawState = fs.readFileSync(path.join(directory, "state.json"), "utf8");
    expect(rawCredentials).toContain("encrypted-test:");
    expect(rawCredentials).not.toContain(credentials.clientSecret);
    expect(rawCredentials).not.toContain(credentials.refreshToken);
    expect(rawCredentials).not.toContain(credentials.accessToken);
    for (const secret of [credentials.clientSecret, credentials.refreshToken, credentials.accessToken]) expect(rawState).not.toContain(secret);
    expect(rawState).not.toContain(credentials.clientId);
    expect(new AppPersistence(directory).loadGoogleCalendarCredentials()).toEqual(credentials);
  });

  it("fails closed when secure storage is unavailable and writes no plaintext credential file", () => {
    const { directory, persistence } = storage();
    const credentials = {
      clientId: "desktop-client.apps.googleusercontent.com",
      clientSecret: "never-write-this-secret",
      refreshToken: "never-write-this-refresh-token",
      accessToken: "never-write-this-access-token",
    };
    mockSafeStorage.available = false;

    expect(() => persistence.saveGoogleCalendarCredentials(credentials)).toThrow(/Secure credential storage is unavailable/);
    expect(persistence.loadGoogleCalendarCredentials()).toBeNull();
    expect(fs.existsSync(path.join(directory, "google-calendar-credentials.enc"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "state.json"))).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("round-trips live calendar selections, default destination, owned mappings, and unresolved journal", () => {
    const { directory, persistence } = storage();
    const data = defaultPersistedData();
    const google = { provider: "google" as const, id: "work@example.test", accountId: "google-primary-hash", name: "Work", timeZone: "America/Chicago", canRead: true, canWrite: true };
    const notion = { provider: "notion" as const, id: "notion-data-source", accountId: "notion-account", name: "Schedule", timeZone: "America/Chicago", canRead: true, canWrite: true, mapping: { title: "title-property", date: "date-property" } };
    data.planning.calendarSync = {
      calendars: [google, notion],
      selectedKeys: [JSON.stringify(["google", google.id]), JSON.stringify(["notion", notion.id])],
      defaultDestinationKey: JSON.stringify(["google", google.id]),
      lastSyncedAt: "2026-10-30T14:00:00.000Z",
      error: null,
      mode: "live",
      googleConnected: true,
      googleConfigured: true,
      installationId: "installation-1",
      journal: [{
        id: "operation-1",
        proposalId: "proposal-1",
        status: "recovery-needed",
        updatedAt: "2026-10-30T14:01:00.000Z",
        steps: [{ kind: "create", blockId: "block-1", status: "recovery-needed", calendarKey: JSON.stringify(["google", google.id]), title: "Review", start: "2026-11-02T15:00:00.000Z", end: "2026-11-02T16:00:00.000Z" }],
      }],
    };
    data.planning.blocks = [{
      id: "block-1",
      ref: { provider: "notion", sourceId: "tasks", taskId: "task-1" },
      start: "2026-11-02T15:00:00.000Z",
      end: "2026-11-02T16:00:00.000Z",
      approvedAt: "2026-10-30T14:01:00.000Z",
      remote: { provider: "google", accountId: "google-primary-hash", calendarId: google.id, eventId: "owned-event-1", version: "etag-1" },
    }];
    persistence.save(data);

    const loaded = new AppPersistence(directory).load();
    expect(loaded.planning.calendarSync).toMatchObject({
      calendars: [google, notion],
      selectedKeys: data.planning.calendarSync.selectedKeys,
      defaultDestinationKey: data.planning.calendarSync.defaultDestinationKey,
      mode: "live",
      installationId: "installation-1",
      journal: data.planning.calendarSync.journal,
    });
    expect(loaded.planning.blocks[0].remote).toEqual(data.planning.blocks[0].remote);
  });

  it("migrates an older state without calendar data to empty local calendar defaults", () => {
    const { directory } = storage();
    fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ sources: [], tasks: [], stars: [], settings: {}, lastSync: null }));

    const loaded = new AppPersistence(directory).load();
    expect(loaded.planning.calendarSync).toMatchObject({
      calendars: [], selectedKeys: [], defaultDestinationKey: null, mode: "local", googleConnected: false, googleConfigured: false, journal: [],
    });
    expect(loaded.planning.blocks).toEqual([]);
  });
});
