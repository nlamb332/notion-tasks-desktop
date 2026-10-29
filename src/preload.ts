import { contextBridge, ipcRenderer } from "electron";
import { SOURCE_COLORS, type AppState, type AppUpdateState, type ConnectionConfig, type DesktopAPI, type PlaneConnectionInput, type SourceColor, type SourceConfig, type Task, type TaskChanges, type TaskDate, type UpdateResult } from "./shared/types";

const channels = {
  getState: "desktop:get-state",
  connect: "desktop:connect",
  connectPlane: "desktop:connect-plane",
  listPlaneProjects: "desktop:list-plane-projects",
  disconnect: "desktop:disconnect",
  resolveSource: "desktop:resolve-source",
  saveSource: "desktop:save-source",
  removeSource: "desktop:remove-source",
  refresh: "desktop:refresh",
  createTask: "desktop:create-task",
  updateTask: "desktop:update-task",
  toggleStar: "desktop:toggle-star",
  setSourceColor: "desktop:set-source-color",
  setSettings: "desktop:set-settings",
  openNotion: "desktop:open-notion",
  state: "desktop:state",
} as const;

function ensureString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function ensureConnection(value: unknown): string | ConnectionConfig {
  if (typeof value === "string") return ensureString(value, "token");
  if (typeof value !== "object" || value === null) throw new TypeError("connection is invalid");
  const input = value as Record<string, unknown>;
  const provider = input.provider;
  if (provider !== "notion" && provider !== "plane") throw new TypeError("connection.provider is invalid");
  const token = ensureString(input.token, "token");
  const result: ConnectionConfig = { provider, token };
  if (input.baseUrl !== undefined) result.baseUrl = ensureString(input.baseUrl, "baseUrl");
  if (input.workspaceSlug !== undefined) result.workspaceSlug = ensureString(input.workspaceSlug, "workspaceSlug");
  return result;
}

function ensurePlaneConnection(value: unknown): PlaneConnectionInput {
  if (typeof value !== "object" || value === null) throw new TypeError("Plane connection is invalid");
  const input = value as Record<string, unknown>;
  const result: PlaneConnectionInput = {
    apiKey: ensureString(input.apiKey, "apiKey"),
    workspaceSlug: ensureString(input.workspaceSlug, "workspaceSlug"),
  };
  if (input.baseUrl !== undefined) result.baseUrl = ensureString(input.baseUrl, "baseUrl");
  return result;
}

function ensureSourceColor(value: unknown): SourceColor {
  if (typeof value !== "string" || !SOURCE_COLORS.includes(value as SourceColor)) throw new TypeError("color must be a supported source color");
  return value as SourceColor;
}

function ensureTaskDate(value: unknown): TaskDate | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || value === null || typeof (value as { start?: unknown }).start !== "string") throw new TypeError("due is invalid");
  const date = value as { start: string; end?: unknown; time_zone?: unknown };
  if (date.end !== undefined && date.end !== null && typeof date.end !== "string") throw new TypeError("due.end is invalid");
  if (date.time_zone !== undefined && date.time_zone !== null && typeof date.time_zone !== "string") throw new TypeError("due.time_zone is invalid");
  return { start: date.start, end: date.end === undefined ? null : date.end as string | null, ...(date.time_zone === undefined ? {} : { time_zone: date.time_zone as string | null }) };
}

function ensureChanges(value: unknown): TaskChanges {
  if (typeof value !== "object" || value === null) throw new TypeError("changes is invalid");
  const input = value as Record<string, unknown>;
  const changes: TaskChanges = {};
  if (input.name !== undefined) changes.name = ensureString(input.name, "name");
  if (input.status !== undefined) changes.status = ensureString(input.status, "status");
  if (input.due !== undefined) changes.due = ensureTaskDate(input.due) as TaskDate;
  return changes;
}

const desktop: DesktopAPI = {
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  onUpdateState: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => callback(state);
    ipcRenderer.on('desktop:update-state', listener);
    return () => ipcRenderer.removeListener('desktop:update-state', listener);
  },
  getState: () => ipcRenderer.invoke(channels.getState),
  connect: (input) => ipcRenderer.invoke(channels.connect, ensureConnection(input)),
  connectPlane: (input) => ipcRenderer.invoke(channels.connectPlane, ensurePlaneConnection(input)),
  listPlaneProjects: (workspaceSlug, baseUrl) => ipcRenderer.invoke(channels.listPlaneProjects, {
    ...(workspaceSlug === undefined ? {} : { workspaceSlug: ensureString(workspaceSlug, "workspaceSlug") }),
    ...(baseUrl === undefined ? {} : { baseUrl: ensureString(baseUrl, "baseUrl") }),
  }),
  disconnect: (provider) => ipcRenderer.invoke(channels.disconnect, provider),
  resolveSource: (url) => ipcRenderer.invoke(channels.resolveSource, ensureString(url, "url")),
  saveSource: (source: SourceConfig) => ipcRenderer.invoke(channels.saveSource, source),
  removeSource: (id) => ipcRenderer.invoke(channels.removeSource, ensureString(id, "id")),
  refresh: () => ipcRenderer.invoke(channels.refresh),
  createTask: (sourceId, name, due, favorite) => {
    if (favorite !== undefined && typeof favorite !== "boolean") throw new TypeError("favorite must be boolean");
    return ipcRenderer.invoke(channels.createTask, { sourceId: ensureString(sourceId, "sourceId"), name: ensureString(name, "name"), due: ensureTaskDate(due), ...(favorite === undefined ? {} : { favorite }) });
  },
  updateTask: (id, changes, expected: Task) => ipcRenderer.invoke(channels.updateTask, { id: ensureString(id, "id"), changes: ensureChanges(changes), expected }),
  toggleStar: (id) => ipcRenderer.invoke(channels.toggleStar, ensureString(id, "id")),
  setSourceColor: (sourceId, color) => ipcRenderer.invoke(channels.setSourceColor, ensureString(sourceId, "sourceId"), ensureSourceColor(color)),
  setSettings: (settings) => ipcRenderer.invoke(channels.setSettings, settings),
  openNotion: (id) => ipcRenderer.invoke(channels.openNotion, ensureString(id, "id")),
  onState: (callback) => {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on(channels.state, listener);
    return () => ipcRenderer.removeListener(channels.state, listener);
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);

