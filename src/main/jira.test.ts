import { describe, expect, it, vi } from "vitest";
import type { SourceConfig, Task } from "../shared/types";
import { JiraHttpError, jiraSourceId, JiraService, mapJiraSource, normalizeJiraSite } from "./jira";
import { TaskCreateFailure } from "./task-create-failure";

const site = "https://team.atlassian.net";
const statuses = [{ name: "Task", statuses: [{ id: "1", name: "To Do", statusCategory: { key: "new" } }, { id: "2", name: "In Progress", statusCategory: { key: "indeterminate" } }, { id: "3", name: "Done", statusCategory: { key: "done" } }] }, { name: "Bug", statuses: [{ id: "1", name: "To Do", statusCategory: { key: "new" } }] }];
const issue = (id: string, summary: string, status = { id: "1", name: "To Do", statusCategory: { key: "new" } }, extra: Record<string, unknown> = {}) => ({ id, key: `OPS-${id}`, fields: { summary, status, duedate: "2026-11-06", assignee: { accountId: "me", displayName: "Avery" }, updated: "2026-11-01T10:00:00.000+0000", ...extra } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

type Route = (url: URL, init: RequestInit) => Response | undefined;
function server(route: Route = () => undefined) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const custom = route(url, init);
    if (custom) return custom;
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname === "/rest/api/3/project/OPS") return json({ id: "10", key: "OPS", name: "Operations", issueTypes: [{ id: "5", name: "Sub-task", subtask: true }, { id: "6", name: "Story", subtask: false }, { id: "7", name: "Task", subtask: false }] });
    if (url.pathname === "/rest/api/3/project/OPS/statuses") return json(statuses);
    throw new Error(`Unexpected route ${init.method ?? "GET"} ${url.pathname}`);
  });
}
const service = (fetchImpl: ReturnType<typeof server>) => new JiraService("me@example.com", "token", fetchImpl as unknown as typeof fetch, { siteUrl: site, sleep: async () => undefined });
const source = async (fetchImpl: ReturnType<typeof server>): Promise<SourceConfig> => mapJiraSource(await service(fetchImpl).inspectSource("OPS"));
const task = (config: SourceConfig, overrides: Partial<Task> = {}): Task => ({ id: `${config.id}::1`, sourceId: config.id, name: "Fix it", url: "", due: { start: "2026-11-06", end: null }, status: "To Do", completed: false, lastEdited: "", ...overrides });
const calls = (fetchImpl: ReturnType<typeof server>, method: string) => fetchImpl.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);

describe("Jira site validation", () => {
  it("accepts Atlassian Cloud sites in common forms", () => {
    expect(normalizeJiraSite("team.atlassian.net")).toBe(site);
    expect(normalizeJiraSite("https://TEAM.atlassian.net/jira/software/projects/OPS/boards/1")).toBe(site);
  });
  it.each(["http://team.atlassian.net", "https://atlassian.net.evil.example", "https://evilatlassian.net", "https://jira.example.com"])("refuses to send credentials to %s", (value) => {
    expect(() => normalizeJiraSite(value)).toThrow(/atlassian\.net/);
  });
});

describe("JiraService", () => {
  it("authenticates with email and token and reports bad credentials without echoing them", async () => {
    const accepted = server();
    await service(accepted).validate();
    expect((accepted.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("me@example.com:token").toString("base64")}`);
    const rejected = server((url) => url.pathname.endsWith("/myself") ? json({ errorMessages: ["Unauthorized"] }, 401) : undefined);
    const failure = await service(rejected).validate().catch((error) => error);
    expect(failure).toBeInstanceOf(JiraHttpError);
    expect(failure.message).toContain("account email and API token");
    expect(failure.message).not.toContain("token\"");
  });

  it("describes a project with merged statuses and maps done statuses as complete", async () => {
    const config = await source(server());
    expect(config).toMatchObject({ id: jiraSourceId(site, "OPS"), databaseId: "OPS", provider: "jira", baseUrl: site, name: "Operations", mapping: { title: "summary", due: "duedate", status: "status", complete: "3", reopen: "1", owner: "assignee" } });
    expect(config.properties.find((property) => property.id === "status")?.options).toHaveLength(3);
  });

  it("lists assigned issues across pages and maps them to tasks", async () => {
    const queries: Record<string, unknown>[] = [];
    const fetchImpl = server((url, init) => {
      if (url.pathname !== "/rest/api/3/search/jql") return undefined;
      const body = JSON.parse(String(init.body));
      queries.push(body);
      return body.nextPageToken ? json({ issues: [issue("2", "Second", { id: "3", name: "Done", statusCategory: { key: "done" } }, { assignee: null, duedate: null })], isLast: true }) : json({ issues: [issue("1", "First")], nextPageToken: "page-2", isLast: false });
    });
    const config = await source(fetchImpl);
    const tasks = await service(fetchImpl).listTasks(config);
    expect(String(queries[0].jql)).toContain('project = "OPS" AND assignee = currentUser()');
    expect(queries[1].nextPageToken).toBe("page-2");
    expect(tasks[0]).toMatchObject({ id: `${config.id}::1`, name: "First", url: `${site}/browse/OPS-1`, due: { start: "2026-11-06", end: null }, status: "To Do", completed: false, owners: [{ id: "me", name: "Avery" }] });
    expect(tasks[1]).toMatchObject({ name: "Second", due: null, completed: true, owners: [] });
  });

  it("stops when Jira repeats a page token", async () => {
    const fetchImpl = server((url) => url.pathname.endsWith("/search/jql") ? json({ issues: [], nextPageToken: "same", isLast: false }) : undefined);
    await expect(service(fetchImpl).listTasks(await source(fetchImpl))).resolves.toEqual([]);
  });

  it("resolves browse and board URLs, and refuses another site's URL", async () => {
    const fetchImpl = server();
    expect((await service(fetchImpl).resolveSource(`${site}/browse/OPS-12`))[0].databaseId).toBe("OPS");
    expect((await service(fetchImpl).resolveSource(`${site}/jira/software/projects/OPS/boards/1`))[0].databaseId).toBe("OPS");
    await expect(service(fetchImpl).resolveSource("https://other.atlassian.net/browse/OPS-1")).rejects.toThrow(/different Jira site/);
  });

  it("refuses a source from a different site", async () => {
    await expect(service(server()).inspectSource(jiraSourceId("https://other.atlassian.net", "OPS"))).rejects.toThrow(/different site/);
  });

  it("creates an assigned Task issue so it appears in the list", async () => {
    let posted: any;
    const fetchImpl = server((url, init) => {
      if (url.pathname === "/rest/api/3/issue" && init.method === "POST") { posted = JSON.parse(String(init.body)); return json({ id: "9", key: "OPS-9" }, 201); }
      if (url.pathname === "/rest/api/3/issue/9") return json(issue("9", "New work"));
      return undefined;
    });
    const created = await service(fetchImpl).createTask(await source(fetchImpl), "  New work ", { start: "2026-11-06T09:00:00", end: null });
    expect(posted.fields).toEqual({ project: { key: "OPS" }, issuetype: { id: "7" }, summary: "New work", assignee: { id: "me" }, duedate: "2026-11-06" });
    expect(created.name).toBe("New work");
  });

  it("separates rejected creates from uncertain ones", async () => {
    const rejected = server((url, init) => url.pathname === "/rest/api/3/issue" && init.method === "POST" ? json({ errors: { components: "Component is required." } }, 400) : undefined);
    const refused = await service(rejected).createTask(await source(rejected), "Work").catch((error) => error);
    expect(refused).toBeInstanceOf(TaskCreateFailure);
    expect(refused).toMatchObject({ outcome: "not-created", message: expect.stringContaining("Component is required") });
    const crashed = server((url, init) => url.pathname === "/rest/api/3/issue" && init.method === "POST" ? json({}, 500) : undefined);
    await expect(service(crashed).createTask(await source(crashed), "Work")).rejects.toMatchObject({ outcome: "unknown" });
    expect(calls(crashed, "POST")).toHaveLength(1);
  });

  it("changes status through the matching workflow transition", async () => {
    let current = issue("1", "Fix it");
    const fetchImpl = server((url, init) => {
      if (url.pathname === "/rest/api/3/issue/1") return json(current);
      if (url.pathname.endsWith("/transitions") && init.method === "POST") { expect(JSON.parse(String(init.body))).toEqual({ transition: { id: "41" } }); current = issue("1", "Fix it", { id: "3", name: "Done", statusCategory: { key: "done" } }); return json(null, 204); }
      if (url.pathname.endsWith("/transitions")) return json({ transitions: [{ id: "31", to: { id: "2" } }, { id: "41", to: { id: "3" } }] });
      return undefined;
    });
    const config = await source(fetchImpl);
    const result = await service(fetchImpl).updateTask(config, `${config.id}::1`, { status: "3" }, task(config));
    expect(result.task).toMatchObject({ status: "Done", completed: true });
  });

  it("changes nothing when the workflow has no direct transition", async () => {
    const fetchImpl = server((url, init) => {
      if (url.pathname === "/rest/api/3/issue/1") return json(issue("1", "Fix it"));
      if (url.pathname.endsWith("/transitions") && !init.method) return json({ transitions: [{ id: "31", to: { id: "2" } }] });
      return undefined;
    });
    const config = await source(fetchImpl);
    await expect(service(fetchImpl).updateTask(config, `${config.id}::1`, { name: "Renamed", status: "3" }, task(config))).rejects.toThrow(/no direct move from To Do to Done/);
    expect(calls(fetchImpl, "PUT")).toHaveLength(0);
  });

  it("saves name and due date, and can clear the date", async () => {
    let body: any;
    const fetchImpl = server((url, init) => {
      if (url.pathname === "/rest/api/3/issue/1" && init.method === "PUT") { body = JSON.parse(String(init.body)); return json(null, 204); }
      if (url.pathname === "/rest/api/3/issue/1") return json(issue("1", "Fix it"));
      return undefined;
    });
    const config = await source(fetchImpl);
    await service(fetchImpl).updateTask(config, `${config.id}::1`, { name: "Renamed", due: null }, task(config));
    expect(body).toEqual({ fields: { summary: "Renamed", duedate: null } });
  });

  it("reports a conflict instead of overwriting a newer edit", async () => {
    const fetchImpl = server((url) => url.pathname === "/rest/api/3/issue/1" ? json(issue("1", "Changed elsewhere")) : undefined);
    const config = await source(fetchImpl);
    const result = await service(fetchImpl).updateTask(config, `${config.id}::1`, { name: "Mine" }, task(config));
    expect(result).toMatchObject({ conflict: true, task: { name: "Changed elsewhere" } });
    expect(calls(fetchImpl, "PUT")).toHaveLength(0);
  });

  it("asks for a remap when mapped statuses disappear", async () => {
    const fetchImpl = server();
    const config = await source(fetchImpl);
    await expect(service(fetchImpl).listTasks({ ...config, mapping: { ...config.mapping, complete: "99" } })).rejects.toThrow(/remap/);
  });

  it("retries rate limits and read failures, but never a failed write", async () => {
    let attempts = 0;
    const limited = server((url) => { if (url.pathname.endsWith("/myself") && attempts++ === 0) return json({}, 429, { "Retry-After": "1" }); return undefined; });
    await service(limited).validate();
    expect(attempts).toBe(2);
    let writes = 0;
    const failing = server((url, init) => { if (url.pathname === "/rest/api/3/issue/1" && init.method === "PUT") { writes += 1; return json({}, 503); } if (url.pathname === "/rest/api/3/issue/1") return json(issue("1", "Fix it")); return undefined; });
    const config = await source(failing);
    await expect(service(failing).updateTask(config, `${config.id}::1`, { name: "New" }, task(config))).rejects.toBeInstanceOf(JiraHttpError);
    expect(writes).toBe(1);
  });
});
