import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppPersistence, defaultPersistedData } from "./persistence";

vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ""),
} }));

const directories: string[] = [];
const cacheRoot = path.resolve(".cache");
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!path.resolve(directory).startsWith(`${cacheRoot}${path.sep}`)) throw new Error("Unexpected test directory");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function storage() {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cacheRoot, "plane-persistence-test-"));
  directories.push(directory);
  return { directory, persistence: new AppPersistence(directory) };
}

describe("provider persistence", () => {
  it("stores, reloads, and removes provider keys independently", () => {
    const { directory, persistence } = storage();
    persistence.saveToken("notion-test-key");
    persistence.saveToken("plane-test-key", "plane");
    const restarted = new AppPersistence(directory);
    expect(restarted.loadToken()).toBe("notion-test-key");
    expect(restarted.loadToken("plane")).toBe("plane-test-key");
    restarted.clearToken("plane");
    expect(restarted.loadToken("plane")).toBeNull();
    expect(restarted.loadToken("notion")).toBe("notion-test-key");
    restarted.clearToken("notion");
    expect(restarted.loadToken()).toBeNull();
  });

  it("retains self-hosted Plane metadata and legacy Notion sources across restart", () => {
    const { directory, persistence } = storage();
    const data = defaultPersistedData();
    const common = { properties: [{ id: "name", name: "Name", type: "title" }], mapping: { title: "name", due: null, status: "state", complete: "done", reopen: "open" } };
    data.sources = [
      { ...common, id: "notion-source", databaseId: "notion-database", name: "Notion" },
      { ...common, id: "plane-source", databaseId: "project", name: "Plane", provider: "plane", workspaceSlug: "workspace", projectId: "project", baseUrl: "https://plane.example/api/v1" },
    ];
    persistence.save(data);
    persistence.savePlaneConfig({ baseUrl: "https://plane.example/api/v1", workspaceSlug: "workspace" });
    const restarted = new AppPersistence(directory);
    expect(restarted.load().sources).toEqual(data.sources);
    expect(restarted.loadPlaneConfig()).toEqual({ baseUrl: "https://plane.example/api/v1", workspaceSlug: "workspace" });
    restarted.clearPlaneConfig();
    expect(restarted.loadPlaneConfig()).toBeNull();
  });
});
