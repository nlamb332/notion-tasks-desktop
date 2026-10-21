import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { ipcMain } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcMainInvokeEvent } from "electron";
import { NotionService } from "./notion";
import { AppPersistence, DEFAULT_SETTINGS, type PersistedData } from "./persistence";
import type {
  AppState,
  DesktopSettings,
  PropertyInfo,
  SourceCandidate,
  SourceConfig,
  SyncState,
  Task,
  TaskChanges,
  TaskDate,
  UpdateResult,
} from "../shared/types";

type Service = {
  validate(): Promise<unknown>;
  resolveSource(url: string): Promise<unknown>;
  inspectSource(id: string): Promise<unknown>;
  listTasks(source: SourceConfig): Promise<unknown>;
  createTask(source: SourceConfig, name: string, due?: TaskDate): Promise<unknown>;
  updateTask(source: SourceConfig, id: string, changes: TaskChanges, expected: Task): Promise<unknown>;
};

type Bounds = NonNullable<DesktopSettings["bounds"]>;

const CHANNELS = {
  getState: "desktop:get-state",
  connect: "desktop:connect",
  disconnect: "desktop:disconnect",
  resolveSource: "desktop:resolve-source",
  saveSource: "desktop:save-source",
  removeSource: "desktop:remove-source",
  refresh: "desktop:refresh",
  createTask: "desktop:create-task",
  updateTask: "desktop:update-task",
  toggleStar: "desktop:toggle-star",
  setSettings: "desktop:set-settings",
  openNotion: "desktop:open-notion",
  state: "desktop:state",
} as const;

const MIN_WIDTH = 300;
const MIN_HEIGHT = 220;
const COMPACT_WIDTH = 360;
const COMPACT_HEIGHT = 440;
const FULL_WIDTH = 1100;
const FULL_HEIGHT = 720;

function developmentUrl(): string | undefined {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return undefined;
  try {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    if (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) return url.origin;
  } catch { /* Invalid development URLs never replace the bundled renderer. */ }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function taskDate(value: unknown, name = "due"): TaskDate | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value) || typeof value.start !== "string" || value.start.length === 0) throw new TypeError(`${name} is invalid`);
  if (value.end !== undefined && value.end !== null && typeof value.end !== "string") throw new TypeError(`${name}.end is invalid`);
  if (value.time_zone !== undefined && value.time_zone !== null && typeof value.time_zone !== "string") throw new TypeError(`${name}.time_zone is invalid`);
  return {
    start: value.start,
    end: value.end === undefined ? null : value.end as string | null,
    ...(value.time_zone === undefined ? {} : { time_zone: value.time_zone as string | null }),
  };
}

function isPropertyType(property: PropertyInfo | undefined, ...types: string[]): boolean {
  return !!property && types.includes(property.type);
}

function propertyById(source: SourceConfig): Map<string, PropertyInfo> {
  return new Map(source.properties.map((property) => [property.id, property]));
}

/** Validate the saved mapping against the latest schema before reading or writing. */
export function validateSourceConfig(source: SourceConfig): void {
  if (!source || typeof source.id !== "string" || source.id.length === 0 || typeof source.databaseId !== "string" || source.databaseId.length === 0) {
    throw new Error("Source identity is invalid");
  }
  if (!Array.isArray(source.properties)) throw new Error(`Source ${source.name || source.id} has no schema`);
  const properties = propertyById(source);
  const mapping = source.mapping;
  if (!mapping || typeof mapping.title !== "string" || !mapping.title) throw new Error(`Source ${source.name} has no title mapping`);
  if (!isPropertyType(properties.get(mapping.title), "title")) throw new Error(`Source ${source.name} title mapping is no longer a title property`);
  if (mapping.due !== null && !isPropertyType(properties.get(mapping.due), "date")) throw new Error(`Source ${source.name} due mapping is no longer a date property`);
  if (!mapping.status || !isPropertyType(properties.get(mapping.status), "status", "select", "checkbox")) throw new Error(`Source ${source.name} status mapping is invalid`);
  const status = properties.get(mapping.status);
  if (status?.type === "checkbox") {
    if (!/^(true|false)$/i.test(mapping.complete) || !/^(true|false)$/i.test(mapping.reopen)) throw new Error(`Source ${source.name} checkbox mapping is invalid`);
    return;
  }
  const isStatusOption = (value: string) => status?.options?.some((option) => option.id === value || option.name === value);
  if (!mapping.complete || !isStatusOption(mapping.complete) || !mapping.reopen || !isStatusOption(mapping.reopen)) throw new Error(`Source ${source.name} status options are invalid`);
}

function sourceCandidate(value: unknown, fallback?: SourceCandidate): SourceCandidate {
  if (isRecord(value) && typeof value.id === "string" && typeof value.databaseId === "string" && typeof value.name === "string" && Array.isArray(value.properties)) {
    return {
      id: value.id,
      databaseId: value.databaseId,
      name: value.name,
      properties: cleanProperties(value.properties),
    };
  }
  if (Array.isArray(value) && fallback) return { ...fallback, properties: cleanProperties(value) };
  if (fallback) return { ...fallback, properties: cleanProperties(fallback.properties) };
  throw new Error("Notion returned an invalid source schema");
}

function cleanProperties(value: unknown[]): PropertyInfo[] {
  const result: PropertyInfo[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.type !== "string" || seen.has(item.id)) continue;
    const options = Array.isArray(item.options)
      ? item.options.filter((option): option is { id: string; name: string; group?: string } => isRecord(option) && typeof option.id === "string" && typeof option.name === "string")
        .map((option) => ({ id: option.id, name: option.name, ...(typeof option.group === "string" ? { group: option.group } : {}) }))
      : undefined;
    result.push({ id: item.id, name: item.name, type: item.type, ...(options && options.length > 0 ? { options } : {}) });
    seen.add(item.id);
  }
  return result;
}

function cleanTask(value: unknown, sourceId: string): Task {
  const item = isRecord(value) && isRecord(value.task) ? value.task : value;
  if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string") throw new Error("Notion returned an invalid task");
  const due = taskDate(item.due, "task.due");
  return {
    id: item.id,
    sourceId,
    name: item.name,
    url: typeof item.url === "string" ? item.url : `https://www.notion.so/${item.id.replaceAll("-", "")}`,
    due: due === undefined ? null : due,
    status: typeof item.status === "string" ? item.status : "",
    completed: typeof item.completed === "boolean" ? item.completed : false,
    lastEdited: typeof item.lastEdited === "string" ? item.lastEdited : new Date().toISOString(),
  };
}

function cleanTaskList(value: unknown, sourceId: string): Task[] {
  const list = isRecord(value) && Array.isArray(value.tasks) ? value.tasks : value;
  if (!Array.isArray(list)) throw new Error("Notion returned an invalid task list");
  const result: Task[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const task = cleanTask(item, sourceId);
    if (!seen.has(task.id)) {
      result.push(task);
      seen.add(task.id);
    }
  }
  return result;
}

function sourceKey(source: SourceConfig): string {
  return source.id || source.databaseId;
}

function boundsFromSettings(settings: DesktopSettings): Bounds {
  const selected = settings.compact ? settings.compactBounds : settings.fullBounds;
  return selected || settings.bounds || {
    width: settings.compact ? COMPACT_WIDTH : FULL_WIDTH,
    height: settings.compact ? COMPACT_HEIGHT : FULL_HEIGHT,
    x: 0,
    y: 0,
  };
}

export function clampBounds(value: Bounds, workArea?: Bounds): Bounds {
  const area = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const width = Math.max(MIN_WIDTH, Math.min(Math.round(value.width), area.width));
  const height = Math.max(MIN_HEIGHT, Math.min(Math.round(value.height), area.height));
  const x = Math.min(Math.max(Math.round(value.x), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(Math.round(value.y), area.y), area.y + area.height - height);
  return { x, y, width, height };
}

function isNotionUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "notion.so" || host.endsWith(".notion.so") || host === "notion.com" || host.endsWith(".notion.com"));
  } catch {
    return false;
  }
}

function isConflict(error: unknown): boolean {
  return isRecord(error) && (error.conflict === true || error.code === "CONFLICT" || error.status === 409 || error.statusCode === 409);
}

function conflictTask(error: unknown): Task | undefined {
  if (!isRecord(error)) return undefined;
  const current = error.currentTask || error.current;
  return current && isRecord(current) && typeof current.id === "string" ? current as unknown as Task : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(typeof error === "string" ? error : "Notion request failed");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class DesktopRuntime {
  private state: AppState;
  private persistence!: AppPersistence;
  private service: Service | null = null;
  private token: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private focusTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private syncInFlight: Promise<void> | null = null;
  private syncInFlightGeneration: number | null = null;
  private sourceGeneration = 0;
  private quitting = false;
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly sourceWrites = new Map<string, number>();

  private async withSourceWrite<T>(sourceId: string, action: () => Promise<T>): Promise<T> {
    this.sourceWrites.set(sourceId, (this.sourceWrites.get(sourceId) ?? 0) + 1);
    try { return await action(); }
    finally {
      const remaining = (this.sourceWrites.get(sourceId) ?? 1) - 1;
      if (remaining) this.sourceWrites.set(sourceId, remaining);
      else this.sourceWrites.delete(sourceId);
    }
  }

  constructor() {
    this.state = {
      connected: false,
      sources: [],
      tasks: [],
      stars: [],
      settings: { ...DEFAULT_SETTINGS },
      sync: { syncing: false, lastSync: null, errors: {}, onlineSources: [] },
    };
  }

  async start(): Promise<void> {
    this.persistence = new AppPersistence(app.getPath("userData"));
    const saved: PersistedData = this.persistence.load();
    this.state.sources = saved.sources;
    this.state.tasks = saved.tasks;
    this.state.stars = saved.stars;
    this.state.settings = saved.settings;
    this.state.sync.lastSync = saved.lastSync;
    this.token = this.persistence.loadToken();
    if (this.token) this.service = new NotionService(this.token) as unknown as Service;
    this.registerIpc();
    this.createWindow();
    this.createTray();
    this.refreshTimer = setInterval(() => void this.refresh(), 60_000);
    if (this.service) void this.startupConnection();
  }

  private async startupConnection(): Promise<void> {
    const service = this.service;
    const generation = this.sourceGeneration;
    try {
      await service?.validate();
      if (service !== this.service || generation !== this.sourceGeneration || !this.token) return;
      this.state.connected = true;
      this.broadcast();
      await this.sync();
    } catch (error) {
      this.state.connected = false;
      this.state.sync.errors.account = toError(error).message;
      this.state.sync.onlineSources = [];
      this.broadcast();
    }
  }

  private registerIpc(): void {
    const guarded = <T>(handler: (...args: unknown[]) => T) => (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      this.assertMainFrame(event);
      return handler(...args);
    };
    ipcMain.handle(CHANNELS.getState, guarded(() => this.snapshot()));
    ipcMain.handle(CHANNELS.connect, guarded((token) => this.connect(token)));
    ipcMain.handle(CHANNELS.disconnect, guarded(() => this.disconnect()));
    ipcMain.handle(CHANNELS.resolveSource, guarded((url) => this.resolveSource(url)));
    ipcMain.handle(CHANNELS.saveSource, guarded((source) => this.saveSource(source)));
    ipcMain.handle(CHANNELS.removeSource, guarded((id) => this.removeSource(id)));
    ipcMain.handle(CHANNELS.refresh, guarded(() => this.refresh()));
    ipcMain.handle(CHANNELS.createTask, guarded((input) => this.createTask(input)));
    ipcMain.handle(CHANNELS.updateTask, guarded((input) => this.updateTask(input)));
    ipcMain.handle(CHANNELS.toggleStar, guarded((id) => this.toggleStar(id)));
    ipcMain.handle(CHANNELS.setSettings, guarded((settings) => this.setSettings(settings)));
    ipcMain.handle(CHANNELS.openNotion, guarded((id) => this.openNotion(id)));
  }

  private assertMainFrame(event: IpcMainInvokeEvent): void {
    const contents = this.mainWindow?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error("Renderer frame is not authorized");
  }

  private snapshot(): AppState {
    return clone(this.state);
  }

  private persist(): void {
    this.persistence.save(this.state);
  }

  private broadcast(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(CHANNELS.state, this.snapshot());
  }

  private setSync(partial: Partial<SyncState>): void {
    this.state.sync = { ...this.state.sync, ...partial };
    this.broadcast();
  }

  private createWindow(): void {
    const initial = this.clampToDisplay(boundsFromSettings(this.state.settings));
    this.mainWindow = new BrowserWindow({
      ...initial,
      icon: path.join(app.getAppPath(), "assets", "icon.png"),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.mainWindow.setAlwaysOnTop(this.state.settings.alwaysOnTop);
    this.mainWindow.on("close", (event) => {
      this.saveCurrentBounds();
      this.persist();
      if (!this.quitting) {
        event.preventDefault();
        this.mainWindow?.hide();
      }
    });
    this.mainWindow.on("focus", () => {
      if (this.focusTimer) clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(() => void this.refresh(), 150);
    });
    const rememberBounds = () => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.saveCurrentBounds();
        this.persist();
      }, 200);
    };
    this.mainWindow.on("resize", rememberBounds);
    this.mainWindow.on("move", rememberBounds);
    this.mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!this.isAllowedAppUrl(url)) event.preventDefault();
    });
    this.installCsp(this.mainWindow);
    const devUrl = developmentUrl();
    if (devUrl) void this.mainWindow.loadURL(devUrl);
    else void this.mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
    this.mainWindow.once("ready-to-show", () => this.mainWindow?.show());
  }

  private installCsp(window: BrowserWindow): void {
    const devServerUrl = developmentUrl();
    const dev = !!devServerUrl;
    let devConnect = "";
    if (devServerUrl) {
      try {
        const devUrl = new URL(devServerUrl);
        const websocketProtocol = devUrl.protocol === "https:" ? "wss:" : "ws:";
        devConnect = ` ${devUrl.origin} ${websocketProtocol}//${devUrl.host}`;
      } catch {
        devConnect = "";
      }
    }
    const policy = [
      "default-src 'self'",
      `script-src 'self'${dev ? " 'unsafe-eval' 'unsafe-inline'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src 'self'${dev ? devConnect : ""}`,
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join("; ");
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...details.responseHeaders, "Content-Security-Policy": [policy] };
      callback({ responseHeaders });
    });
  }

  private isAllowedAppUrl(url: string): boolean {
    if (url.startsWith("file://")) {
      try {
        return path.resolve(fileURLToPath(url)) === path.resolve(app.getAppPath(), "dist", "index.html");
      } catch {
        return false;
      }
    }
    const devUrl = developmentUrl();
    if (!devUrl) return false;
    try {
      const expected = new URL(devUrl);
      const actual = new URL(url);
      return actual.protocol === expected.protocol && actual.hostname === expected.hostname && actual.port === expected.port;
    } catch {
      return false;
    }
  }

  private createTray(): void {
    const size = 16;
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const offset = (y * size + x) * 4;
        const onCheck = (y === 10 && x >= 3 && x <= 6) || (y === 9 && x >= 5 && x <= 8) || (y === 8 && x >= 7 && x <= 10) || (y === 7 && x >= 9 && x <= 12) || (y === 6 && x >= 11 && x <= 13);
        pixels[offset] = onCheck ? 255 : 192;
        pixels[offset + 1] = onCheck ? 255 : 112;
        pixels[offset + 2] = onCheck ? 255 : 45;
        pixels[offset + 3] = 255;
      }
    }
    const fallbackIcon = nativeImage.createFromBuffer(pixels, { width: size, height: size });
    const packagedIcon = nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "icon.png"));
    const trayIcon = packagedIcon.isEmpty() ? fallbackIcon : packagedIcon.resize({ width: size, height: size });
    this.tray = new Tray(trayIcon);
    this.tray.setToolTip("Notion Tasks");
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show Notion Tasks", click: () => this.showWindow() },
      { label: "Quit", click: () => { this.quitting = true; app.quit(); } },
    ]));
    this.tray.on("click", () => {
      if (this.mainWindow?.isVisible()) this.mainWindow.hide();
      else this.showWindow();
    });
  }

  showWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.show();
    this.mainWindow.focus();
  }

  markQuitting(): void {
    this.quitting = true;
  }

  private clampToDisplay(value: Bounds): Bounds {
    try {
      const display = screen.getDisplayMatching(value);
      return clampBounds(value, display.workArea);
    } catch {
      return clampBounds(value);
    }
  }

  private saveCurrentBounds(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const current = this.clampToDisplay(this.mainWindow.getBounds());
    this.state.settings.bounds = current;
    if (this.state.settings.compact) this.state.settings.compactBounds = current;
    else this.state.settings.fullBounds = current;
  }

  private async connect(value: unknown): Promise<AppState> {
    const token = stringValue(value, "token");
    const service = new NotionService(token) as unknown as Service;
    await service.validate();
    this.persistence.saveToken(token);
    this.token = token;
    this.service = service;
    this.sourceGeneration += 1;
    this.state.connected = true;
    this.state.sync.errors = {};
    this.broadcast();
    await this.sync();
    return this.snapshot();
  }

  private async disconnect(): Promise<AppState> {
    this.sourceGeneration += 1;
    this.persistence.clearToken();
    this.token = null;
    this.service = null;
    this.state.connected = false;
    this.state.sync.onlineSources = [];
    this.state.sync.syncing = false;
    this.broadcast();
    return this.snapshot();
  }

  private async resolveSource(value: unknown): Promise<SourceCandidate[]> {
    const url = stringValue(value, "url");
    if (!isNotionUrl(url)) throw new Error("Only HTTPS Notion URLs can be resolved");
    if (!this.service || !this.state.connected) throw new Error("Connect Notion before resolving a source");
    const response = await this.service.resolveSource(url);
    const candidates = Array.isArray(response) ? response : isRecord(response) && Array.isArray(response.sources) ? response.sources : [];
    const seen = new Set<string>();
    return candidates.map((item) => sourceCandidate(item)).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  private async inspect(source: SourceConfig): Promise<SourceConfig> {
    if (!this.service) throw new Error("Connect Notion before using a source");
    const inspected = await this.service.inspectSource(source.id || source.databaseId);
    const candidate = sourceCandidate(inspected, source);
    const refreshed: SourceConfig = { ...source, name: candidate.name || source.name, properties: candidate.properties };
    validateSourceConfig(refreshed);
    return refreshed;
  }

  private async saveSource(value: unknown): Promise<AppState> {
    if (!this.service || !this.state.connected) throw new Error("Connect Notion before saving a source");
    if (!isRecord(value)) throw new TypeError("source is invalid");
    const source = value as unknown as SourceConfig;
    if (this.sourceWrites.has(source.id)) throw new Error("Wait for this source's task saves to finish before remapping");
    validateSourceConfig(source);
    const refreshed = await this.inspect(source);
    if (this.sourceWrites.has(source.id)) throw new Error("Wait for this source's task saves to finish before remapping");
    this.sourceGeneration += 1;
    const index = this.state.sources.findIndex((item) => item.id === refreshed.id);
    if (index === -1) this.state.sources.push(refreshed);
    else this.state.sources[index] = refreshed;
    this.state.sources = this.dedupeSources(this.state.sources);
    this.state.settings.lastSourceId = refreshed.id;
    this.persist();
    this.broadcast();
    await this.sync();
    if (!this.state.sync.onlineSources.includes(refreshed.id)) await this.sync();
    return this.snapshot();
  }

  private dedupeSources(sources: SourceConfig[]): SourceConfig[] {
    const seen = new Set<string>();
    return sources.filter((source) => {
      if (seen.has(source.id)) return false;
      seen.add(source.id);
      return true;
    });
  }

  private async removeSource(value: unknown): Promise<AppState> {
    const id = stringValue(value, "id");
    this.sourceGeneration += 1;
    this.state.sources = this.state.sources.filter((source) => source.id !== id);
    this.state.tasks = this.state.tasks.filter((task) => task.sourceId !== id);
    this.state.stars = this.state.stars.filter((taskId) => this.state.tasks.some((task) => task.id === taskId));
    this.state.sync.onlineSources = this.state.sync.onlineSources.filter((sourceId) => sourceId !== id);
    this.state.sync.syncing = false;
    delete this.state.sync.errors[id];
    if (this.state.settings.lastSourceId === id) this.state.settings.lastSourceId = this.state.sources[0]?.id || "";
    this.persist();
    this.broadcast();
    return this.snapshot();
  }

  async refresh(): Promise<AppState> {
    if (!this.service || !this.token) return this.snapshot();
    if (!this.state.connected) {
      const service = this.service;
      const generation = this.sourceGeneration;
      try {
        await service.validate();
        if (service !== this.service || generation !== this.sourceGeneration || !this.token) return this.snapshot();
        this.state.connected = true;
        delete this.state.sync.errors.account;
        this.broadcast();
      } catch (error) {
        this.state.sync.errors.account = toError(error).message;
        this.state.sync.syncing = false;
        this.broadcast();
        return this.snapshot();
      }
    }
    await this.sync();
    return this.snapshot();
  }

  private async sync(): Promise<void> {
    if (this.syncInFlight) {
      const generationAtWait = this.syncInFlightGeneration;
      await this.syncInFlight;
      if (generationAtWait !== this.sourceGeneration && this.service && this.state.connected) return this.sync();
      return;
    }
    if (!this.service || !this.state.connected) return;
    this.syncInFlightGeneration = this.sourceGeneration;
    this.syncInFlight = this.performSync().finally(() => { this.syncInFlight = null; this.syncInFlightGeneration = null; });
    return this.syncInFlight;
  }

  private async performSync(): Promise<void> {
    const generation = this.sourceGeneration;
    const service = this.service;
    const configuredSources = [...this.state.sources];
    const initialErrors = { ...this.state.sync.errors };
    delete initialErrors.account;
    this.setSync({ syncing: true, errors: initialErrors });
    const errors: Record<string, string> = {};
    const onlineSources: string[] = [];
    for (const configured of configuredSources) {
      try {
        if (!this.isSyncCurrent(generation, service)) return;
        const source = await this.inspect(configured);
        const tasks = await service!.listTasks(source);
        if (!this.isSyncCurrent(generation, service)) return;
        const sourceTasks = cleanTaskList(tasks, source.id);
        this.state.sources = this.state.sources.map((item) => item.id === source.id ? source : item);
        this.state.tasks = this.state.tasks.filter((task) => task.sourceId !== source.id).concat(sourceTasks);
        onlineSources.push(source.id);
      } catch (error) {
        if (!this.isSyncCurrent(generation, service)) return;
        errors[configured.id] = toError(error).message;
        // Leave the last successful task snapshot in place for offline read-only use.
      }
    }
    this.state.sync = {
      syncing: false,
      lastSync: onlineSources.length > 0 || configuredSources.length === 0 ? new Date().toISOString() : this.state.sync.lastSync,
      errors,
      onlineSources,
    };
    this.persist();
    this.broadcast();
  }

  private isSyncCurrent(generation: number, service: Service | null): boolean {
    return generation === this.sourceGeneration && service === this.service && this.state.connected;
  }

  private async createTask(value: unknown): Promise<AppState> {
    if (!isRecord(value)) throw new TypeError("createTask input is invalid");
    const sourceId = stringValue(value.sourceId, "sourceId");
    const name = stringValue(value.name, "name");
    const due = taskDate(value.due);
    const source = this.state.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("Source not found");
    this.requireOnline(source);
    return this.withSourceWrite(sourceId, async () => {
    const service = this.service!;
    const refreshed = await this.inspect(source);
    if (service !== this.service || !this.state.sources.some(item => item.id === sourceId)) throw new Error("The connection or source changed; refresh before creating a task");
    const created = await service.createTask(refreshed, name, due);
    if (service !== this.service || !this.state.sources.some(item => item.id === sourceId)) throw new Error("The task was created in Notion, but its source was disconnected. Reconnect to view it");
    this.sourceGeneration += 1;
    this.state.sync.syncing = false;
    // The created page's ID is authoritative; task names are never identities.
    const task = cleanTask(created, sourceId);
    if (!this.state.tasks.some((item) => item.sourceId === sourceId && item.id === task.id)) this.state.tasks.push(task);
    this.state.sources = this.state.sources.map((item) => item.id === sourceId ? refreshed : item);
    this.persist();
    this.broadcast();
    return this.snapshot();
    });
  }

  private requireOnline(source: SourceConfig): void {
    if (!this.service || !this.state.connected || !this.state.sync.onlineSources.includes(source.id)) {
      throw new Error(`Source ${source.name} is offline; refresh before editing`);
    }
  }

  private async updateTask(value: unknown): Promise<UpdateResult> {
    if (!isRecord(value)) throw new TypeError("updateTask input is invalid");
    const id = stringValue(value.id, "id");
    const expected = value.expected as Task;
    if (!isRecord(expected) || expected.id !== id || typeof expected.sourceId !== "string") throw new TypeError("expected task is invalid");
    const changes = this.cleanChanges(value.changes);
    const task = this.state.tasks.find((item) => item.id === id && item.sourceId === expected.sourceId);
    if (!task) throw new Error("Task not found");
    const source = this.state.sources.find((item) => item.id === task.sourceId);
    if (!source) throw new Error("Source not found");
    this.requireOnline(source);
    return this.withSourceWrite(source.id, async () => {
    const service = this.service!;
    const refreshed = await this.inspect(source);
    return this.queueWrite(id, async () => {
      if (service !== this.service || !this.state.sources.some(item => item.id === source.id)) throw new Error("The connection or source changed; refresh before editing");
      this.requireOnline(refreshed);
      return this.performUpdate(refreshed, id, changes, expected, service);
    });
    });
  }

  private cleanChanges(value: unknown): TaskChanges {
    if (!isRecord(value)) throw new TypeError("changes is invalid");
    const changes: TaskChanges = {};
    if (value.name !== undefined) changes.name = stringValue(value.name, "name");
    if (value.status !== undefined) changes.status = stringValue(value.status, "status");
    if (value.due !== undefined) changes.due = taskDate(value.due) as TaskDate;
    if (Object.keys(changes).length === 0) throw new Error("At least one task change is required");
    return changes;
  }

  private queueWrite<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.writeQueues.set(id, next);
    const cleanup = () => {
      if (this.writeQueues.get(id) === next) this.writeQueues.delete(id);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  private async performUpdate(source: SourceConfig, id: string, changes: TaskChanges, expected: Task, service: Service): Promise<UpdateResult> {
    try {
      const response = await service.updateTask(source, id, changes, expected);
      if (service !== this.service || !this.state.sources.some(item => item.id === source.id)) throw new Error("The source was disconnected. Reconnect to see the task's latest state");
      this.sourceGeneration += 1;
      this.state.sync.syncing = false;
      const conflict = isRecord(response) && response.conflict === true;
      const task = cleanTask(response, source.id);
      this.replaceTask(task);
      this.persist();
      this.broadcast();
      return { task, ...(conflict ? { conflict: true } : {}) };
    } catch (error) {
      if (!isConflict(error)) throw error;
      let current = conflictTask(error);
      if (!current) {
        try {
          const listed = await this.service!.listTasks(source);
          current = cleanTaskList(listed, source.id).find((item) => item.id === id);
        } catch {
          // Preserve the original conflict response when the refresh itself is unavailable.
        }
      }
      if (!current) throw error;
      const normalized = cleanTask(current, source.id);
      this.replaceTask(normalized);
      this.persist();
      this.broadcast();
      return { task: normalized, conflict: true };
    }
  }

  private replaceTask(task: Task): void {
    const index = this.state.tasks.findIndex((item) => item.id === task.id && item.sourceId === task.sourceId);
    if (index === -1) this.state.tasks.push(task);
    else this.state.tasks[index] = task;
  }

  private async toggleStar(value: unknown): Promise<AppState> {
    const id = stringValue(value, "id");
    if (this.state.stars.includes(id)) this.state.stars = this.state.stars.filter((item) => item !== id);
    else this.state.stars.push(id);
    this.persist();
    this.broadcast();
    return this.snapshot();
  }

  private async setSettings(value: unknown): Promise<AppState> {
    if (!isRecord(value)) throw new TypeError("settings is invalid");
    const previousMode = this.state.settings.compact;
    const previousLaunchAtLogin = this.state.settings.launchAtLogin;
    this.saveCurrentBounds();
    const next = { ...this.state.settings };
    if (value.compact !== undefined) {
      if (typeof value.compact !== "boolean") throw new TypeError("compact must be boolean");
      next.compact = value.compact;
    }
    if (value.alwaysOnTop !== undefined) {
      if (typeof value.alwaysOnTop !== "boolean") throw new TypeError("alwaysOnTop must be boolean");
      next.alwaysOnTop = value.alwaysOnTop;
    }
    if (value.launchAtLogin !== undefined) {
      if (typeof value.launchAtLogin !== "boolean") throw new TypeError("launchAtLogin must be boolean");
      next.launchAtLogin = value.launchAtLogin;
    }
    if (value.selectedList !== undefined) next.selectedList = stringValue(value.selectedList, "selectedList");
    if (value.lastSourceId !== undefined) next.lastSourceId = stringValue(value.lastSourceId, "lastSourceId");
    for (const key of ["bounds", "fullBounds", "compactBounds"] as const) {
      if (value[key] !== undefined) next[key] = this.validateBounds(value[key], key);
    }
    this.state.settings = next;
    if (this.mainWindow) {
      this.mainWindow.setAlwaysOnTop(next.alwaysOnTop);
      if (next.compact !== previousMode) {
        const current = this.mainWindow.getBounds();
        const target = next.compact ? next.compactBounds : next.fullBounds;
        const fallback = { ...current, width: next.compact ? COMPACT_WIDTH : FULL_WIDTH, height: next.compact ? COMPACT_HEIGHT : FULL_HEIGHT };
        const clamped = this.clampToDisplay(target || fallback);
        if (next.compact) next.compactBounds = clamped;
        else next.fullBounds = clamped;
        this.mainWindow.setBounds(clamped);
      }
    }
    if (next.launchAtLogin !== previousLaunchAtLogin) {
      try {
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
      } catch {
        // Login item settings are unavailable in some development environments.
      }
    }
    this.saveCurrentBounds();
    this.persist();
    this.broadcast();
    return this.snapshot();
  }

  private validateBounds(value: unknown, name: string): Bounds {
    if (!isRecord(value) || !["x", "y", "width", "height"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))) throw new TypeError(`${name} is invalid`);
    return { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number };
  }

  private async openNotion(value: unknown): Promise<void> {
    const id = stringValue(value, "id");
    const knownTask = this.state.tasks.find((task) => task.id === id);
    const target = knownTask && isNotionUrl(knownTask.url) ? knownTask.url : null;
    if (!target) throw new Error("Only a known Notion task ID can be opened");
    await shell.openExternal(target);
  }
}

let runtime: DesktopRuntime | null = null;
let singleInstance = false;

function boot(): void {
  const fixtureUserData = process.env.NOTION_TASKS_USER_DATA;
  if (!app.isPackaged && fixtureUserData) app.setPath("userData", fixtureUserData);
  singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
    return;
  }
  app.on("second-instance", () => runtime?.showWindow());
  app.on("before-quit", () => {
    runtime?.markQuitting();
  });
  app.on("window-all-closed", () => {
    // Keep the tray application alive after its window is hidden or closed.
  });
  app.on("activate", () => runtime?.showWindow());
  void app.whenReady().then(async () => {
    runtime = new DesktopRuntime();
    await runtime.start();
  });
}

if (process.versions.electron && process.type !== "renderer") boot();

export { CHANNELS };

