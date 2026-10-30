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
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import type { IpcMainInvokeEvent } from "electron";
import { NotionService } from "./notion";
import { PlaneService } from "./plane";
import { TaskCreateFailure } from "./task-create-failure";
import { UpdateController } from "./updates";
import { approvePlan, DEFAULT_PLANNING, exportApprovedICS, generatePlan, linkChildren, parseCalendarICS, providerFor, refKey, setEstimate } from "./planning";
import { AppPersistence, DEFAULT_SETTINGS, type PersistedData } from "./persistence";
import {
  SOURCE_COLORS,
  cleanTaskOwners,
  type AppState,
  type BreakdownOperation,
  type ConnectionConfig,
  type DesktopSettings,
  type PlaneConnectionInput,
  type PropertyInfo,
  type SourceCandidate,
  type SourceConfig,
  type SourceColor,
  type SourceProvider,
  type SyncState,
  type Task,
  type TaskChanges,
  type TaskDate,
  type ThemePreference,
  type UpdateResult,
  type PlanningSettings,
  type TaskRef,
  type PlanProposal,
} from "../shared/types";

type Service = {
  validate(): Promise<unknown>;
  resolveSource(url: string): Promise<unknown>;
  inspectSource(id: string): Promise<unknown>;
  listTasks(source: SourceConfig): Promise<unknown>;
  createTask(source: SourceConfig, name: string, due?: TaskDate): Promise<unknown>;
  updateTask(source: SourceConfig, id: string, changes: TaskChanges, expected: Task): Promise<unknown>;
};

type PlaneConfig = { baseUrl?: string; workspaceSlug?: string };

type Bounds = NonNullable<DesktopSettings["bounds"]>;

const CHANNELS = {
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

function isPrereleaseVersion(version: string): boolean {
  return /-[0-9A-Za-z]/.test(version);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSourceColor(value: unknown): value is SourceColor {
  return typeof value === "string" && SOURCE_COLORS.includes(value as SourceColor);
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
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
  if (mapping?.owner && !isPropertyType(properties.get(mapping.owner), "people")) throw new Error(`Source ${source.name} owner mapping is no longer a people field`);
  if (!mapping || typeof mapping.title !== "string" || !mapping.title) throw new Error(`Source ${source.name} has no title mapping`);
  if (source.provider === "plane") {
    if (!source.workspaceSlug || !(source.projectId || source.databaseId)) throw new Error(`Source ${source.name} has incomplete Plane project metadata`);
    if (!isPropertyType(properties.get(mapping.title), "title", "text")) throw new Error(`Source ${source.name} title mapping is invalid`);
    if (mapping.due !== null && !isPropertyType(properties.get(mapping.due), "date")) throw new Error(`Source ${source.name} due mapping is invalid`);
    const status = properties.get(mapping.status);
    if (!status || !isPropertyType(status, "status", "select")) throw new Error(`Source ${source.name} state mapping is invalid`);
    const isStateOption = (value: string) => status.options?.some((option) => option.id === value || option.name === value);
    if (!mapping.complete || !isStateOption(mapping.complete) || !mapping.reopen || !isStateOption(mapping.reopen)) throw new Error(`Source ${source.name} state options are invalid`);
    return;
  }
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
      ...((value.provider === "plane" || fallback?.provider === "plane") ? {
        provider: "plane",
        ...(typeof value.workspaceSlug === "string" ? { workspaceSlug: value.workspaceSlug } : fallback?.workspaceSlug ? { workspaceSlug: fallback.workspaceSlug } : {}),
        ...(typeof value.projectId === "string" ? { projectId: value.projectId } : fallback?.projectId ? { projectId: fallback.projectId } : {}),
        ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : fallback?.baseUrl ? { baseUrl: fallback.baseUrl } : {}),
      } : {}),
    };
  }
  if (Array.isArray(value) && fallback) return { ...fallback, properties: cleanProperties(value) };
  if (fallback) return { ...fallback, properties: cleanProperties(fallback.properties) };
  throw new Error("Remote service returned an invalid source schema");
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

function cleanTask(value: unknown, sourceId: string, provider: SourceProvider = "notion"): Task {
  const item = isRecord(value) && isRecord(value.task) ? value.task : value;
  if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string") throw new Error(`${provider === "plane" ? "Plane" : "Notion"} returned an invalid task`);
  const due = taskDate(item.due, "task.due");
  return {
    id: item.id,
    sourceId,
    name: item.name,
    url: typeof item.url === "string" ? item.url : provider === "plane" ? "" : `https://www.notion.so/${item.id.replaceAll("-", "")}`,
    due: due === undefined ? null : due,
    status: typeof item.status === "string" ? item.status : "",
    completed: typeof item.completed === "boolean" ? item.completed : false,
    lastEdited: typeof item.lastEdited === "string" ? item.lastEdited : new Date().toISOString(),
    ...(Array.isArray(item.owners) ? { owners: cleanTaskOwners(item.owners) } : {}),
  };
}

function cleanTaskList(value: unknown, sourceId: string, provider: SourceProvider = "notion"): Task[] {
  const list = isRecord(value) && Array.isArray(value.tasks) ? value.tasks : value;
  if (!Array.isArray(list)) throw new Error(`${provider === "plane" ? "Plane" : "Notion"} returned an invalid task list`);
  const result: Task[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const task = cleanTask(item, sourceId, provider);
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

function isPlaneUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && (parsed.hostname === "plane.so" || parsed.hostname.endsWith(".plane.so") || parsed.pathname.toLowerCase().includes("/projects/"));
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
  return error instanceof Error ? error : new Error(typeof error === "string" ? error : "Remote task request failed");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class DesktopRuntime {
  private state: AppState;
  private persistence!: AppPersistence;
  private service: Service | null = null;
  private token: string | null = null;
  private readonly services = new Map<SourceProvider, Service>();
  private readonly tokens = new Map<SourceProvider, string>();
  private planeConfig: PlaneConfig | null = null;
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
  private updateController: UpdateController | null = null;

  private updates(): UpdateController {
    if (!this.updateController) {
      this.updateController = new UpdateController(app.getVersion(), app.isPackaged && process.platform === 'win32',
        async () => {
          const module = await import('electron-updater');
          return (module.default ?? module).autoUpdater;
        },
        state => this.mainWindow?.webContents.send('desktop:update-state', state),
        () => {
          if (this.sourceWrites.size || this.writeQueues.size) throw new Error('Wait for your task changes to finish saving, then try again.');
          this.quitting = true;
        },
        () => { this.quitting = false; });
    }
    return this.updateController;
  }

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
      connections: {},
      planning: structuredClone(DEFAULT_PLANNING),
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
    this.state.planning = saved.planning;
    this.token = this.persistence.loadToken("notion");
    if (this.token) {
      this.services.set("notion", new NotionService(this.token) as unknown as Service);
      this.tokens.set("notion", this.token);
      this.service = this.services.get("notion") || null;
      this.state.connections = { ...this.state.connections, notion: { connected: false } };
    }
    this.planeConfig = this.persistence.loadPlaneConfig();
    const planeToken = this.persistence.loadToken("plane");
    if (planeToken) {
      const firstPlane = this.state.sources.find((source) => source.provider === "plane");
      const config = this.planeConfig || { workspaceSlug: firstPlane?.workspaceSlug, baseUrl: firstPlane?.baseUrl };
      if (config.workspaceSlug) {
        const plane = new PlaneService(planeToken, globalThis.fetch, { workspaceSlug: config.workspaceSlug, ...(config.baseUrl ? { apiBase: config.baseUrl } : {}) }) as unknown as Service;
        this.services.set("plane", plane);
        this.tokens.set("plane", planeToken);
        this.state.connections = { ...this.state.connections, plane: { connected: false, ...config } };
      }
    }
    this.registerIpc();
    this.createWindow();
    this.createTray();
    this.refreshTimer = setInterval(() => void this.refresh(), 60_000);
    for (const provider of this.services.keys()) void this.startupConnection(provider);
  }

  private hasConnectedProvider(): boolean {
    if (this.services.size) return [...this.services.keys()].some((provider) => this.state.connections?.[provider]?.connected === true);
    return Boolean(this.service && this.token && this.state.connected);
  }

  private async startupConnection(provider: SourceProvider = "notion", syncAfter = true): Promise<void> {
    const service = this.services.get(provider) || (provider === "notion" ? this.service : null);
    const generation = this.sourceGeneration;
    try {
      await service?.validate();
      if (!service || service !== (this.services.get(provider) || this.service) || generation !== this.sourceGeneration || !this.tokens.get(provider)) return;
      this.state.connections = { ...this.state.connections, [provider]: { ...(this.state.connections?.[provider] || {}), connected: true } };
      delete this.state.sync.errors[`${provider}:account`];
      if (provider === "notion") delete this.state.sync.errors.account;
      this.state.connected = true;
      this.broadcast();
      if (syncAfter) await this.sync();
    } catch (error) {
      this.state.connections = { ...this.state.connections, [provider]: { ...(this.state.connections?.[provider] || {}), connected: false } };
      this.state.connected = this.hasConnectedProvider();
      this.state.sync.errors[`${provider}:account`] = toError(error).message;
      this.state.sync.onlineSources = this.state.sync.onlineSources.filter((sourceId) => (this.state.sources.find((source) => source.id === sourceId)?.provider || "notion") !== provider);
      this.broadcast();
    }
  }

  private registerIpc(): void {
    const guarded = <T>(handler: (...args: unknown[]) => T) => (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      this.assertMainFrame(event);
      return handler(...args);
    };
    ipcMain.handle(CHANNELS.getState, guarded(() => this.snapshot()));
    ipcMain.handle('desktop:get-update-state', guarded(() => this.updates().snapshot()));
    ipcMain.handle('desktop:check-updates', guarded(() => this.updates().check()));
    ipcMain.handle('desktop:download-update', guarded(() => this.updates().download()));
    ipcMain.handle('desktop:install-update', guarded(() => this.updates().install()));
    ipcMain.handle(CHANNELS.connect, guarded((token) => this.connect(token)));
    ipcMain.handle(CHANNELS.connectPlane, guarded((input) => this.connectPlane(input)));
    ipcMain.handle(CHANNELS.listPlaneProjects, guarded((input) => this.listPlaneProjects(input)));
    ipcMain.handle(CHANNELS.disconnect, guarded((provider) => this.disconnect(provider)));
    ipcMain.handle(CHANNELS.resolveSource, guarded((url) => this.resolveSource(url)));
    ipcMain.handle(CHANNELS.saveSource, guarded((source) => this.saveSource(source)));
    ipcMain.handle(CHANNELS.removeSource, guarded((id) => this.removeSource(id)));
    ipcMain.handle(CHANNELS.refresh, guarded(() => this.refresh()));
    ipcMain.handle(CHANNELS.createTask, guarded((input) => this.createTask(input)));
    ipcMain.handle(CHANNELS.updateTask, guarded((input) => this.updateTask(input)));
    ipcMain.handle(CHANNELS.toggleStar, guarded((id) => this.toggleStar(id)));
    ipcMain.handle(CHANNELS.setSourceColor, guarded((id, color) => this.setSourceColor(id, color)));
    ipcMain.handle(CHANNELS.setSettings, guarded((settings) => this.setSettings(settings)));
    ipcMain.handle("desktop:planning-estimate", guarded((ref, minutes) => this.setPlanningEstimate(ref, minutes)));
    ipcMain.handle("desktop:planning-links", guarded((parent, children) => this.setPlanningLinks(parent, children)));
    ipcMain.handle("desktop:planning-create-breakdown", guarded((id, parent, steps) => this.createPlanningBreakdown(id, parent, steps)));
    ipcMain.handle("desktop:planning-reconcile-breakdown", guarded((id, order, resolution) => this.reconcilePlanningBreakdown(id, order, resolution)));
    ipcMain.handle("desktop:planning-settings", guarded((settings) => this.setPlanningSettings(settings)));
    ipcMain.handle("desktop:calendar-import", guarded((ics) => this.importCalendar(ics)));
    ipcMain.handle("desktop:calendar-add-event", guarded((event) => this.addCalendarEvent(event)));
    ipcMain.handle("desktop:plan-generate", guarded(() => generatePlan(this.planning(), this.state)));
    ipcMain.handle("desktop:plan-approve", guarded((proposal, selected) => this.approvePlanning(proposal, selected)));
    ipcMain.handle("desktop:calendar-export", guarded(() => exportApprovedICS(this.planning().blocks, this.state)));
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

  private planning() { return this.state.planning ?? (this.state.planning = structuredClone(DEFAULT_PLANNING)); }
  private requireTaskRef(value: unknown): TaskRef {
    if (!isRecord(value) || !["notion", "plane"].includes(String(value.provider)) || typeof value.sourceId !== "string" || typeof value.taskId !== "string") throw new TypeError("Task reference is invalid");
    const ref = value as unknown as TaskRef;
    if (!this.state.tasks.some(t => t.id === ref.taskId && t.sourceId === ref.sourceId) || providerFor(ref.sourceId, this.state) !== ref.provider) throw new Error("Task is unavailable in the selected source.");
    return ref;
  }
  private setPlanningEstimate(value: unknown, minutesValue: unknown): AppState {
    const ref=this.requireTaskRef(value); if(minutesValue!==null && typeof minutesValue!=="number")throw new TypeError("Estimate is invalid");
    this.state.planning=setEstimate(this.planning(),ref,minutesValue as number|null); this.persist();this.broadcast();return this.snapshot();
  }
  private setPlanningLinks(parentValue: unknown, childrenValue: unknown): AppState {
    const parent=this.requireTaskRef(parentValue); if(!Array.isArray(childrenValue)||childrenValue.length>50)throw new TypeError("Breakdown is invalid");
    const children=childrenValue.map(item=>{if(!isRecord(item)||!Number.isInteger(item.estimateMinutes)||!Number.isInteger(item.order))throw new TypeError("Child breakdown is invalid");return {ref:this.requireTaskRef(item.ref),estimateMinutes:item.estimateMinutes as number,order:item.order as number};});
    this.state.planning=linkChildren(this.planning(),parent,children);this.persist();this.broadcast();return this.snapshot();
  }
  private async createPlanningBreakdown(idValue: unknown, parentValue: unknown, stepsValue: unknown): Promise<AppState> {
    const id=stringValue(idValue,"operationId"),parent=this.requireTaskRef(parentValue);if(!Array.isArray(stepsValue)||!stepsValue.length||stepsValue.length>50)throw new TypeError("Breakdown steps are invalid.");
    const steps=stepsValue.map((value,index)=>{if(!isRecord(value)||typeof value.name!=="string"||!value.name.trim()||typeof value.estimateMinutes!=="number"||!Number.isInteger(value.estimateMinutes)||value.estimateMinutes<=0||value.estimateMinutes>100_000||typeof value.order!=="number"||!Number.isInteger(value.order)||value.order<0||value.order>=stepsValue.length)throw new TypeError("Breakdown step is invalid.");return {name:value.name.trim(),estimateMinutes:value.estimateMinutes,order:value.order,status:"pending" as const};});
    let data=this.planning();let operation=data.operations.find(x=>x.id===id);
    if(!operation){operation={id,parent,steps,status:"in-progress",updatedAt:new Date().toISOString()};data={...data,operations:[...data.operations,operation]};this.state.planning=data;this.persist();}
    else if(refKey(operation.parent)!==refKey(parent))throw new Error("Operation ID belongs to a different breakdown.");
    if(operation.status==="complete")return this.snapshot();if(operation.status==="recovery-needed"||operation.steps.some(s=>s.status==="recovery-needed"||s.status==="creating"))throw new Error("A child creation result is uncertain. Refresh the source, then choose the existing task or confirm no task was created before resuming.");
    if(operation.steps.length!==steps.length||operation.steps.some((s,i)=>s.name!==steps[i].name||s.estimateMinutes!==steps[i].estimateMinutes||s.order!==steps[i].order))throw new Error("Operation ID was reused with different breakdown steps.");
    const parentSource=this.state.sources.find(s=>s.id===parent.sourceId);if(!parentSource)throw new Error("Breakdown source is no longer available.");this.requireOnline(parentSource);
    for(let i=0;i<operation.steps.length;i++){
      if(operation.steps[i].status==="created")continue;
      const currentSource=this.state.sources.find(s=>s.id===parent.sourceId);if(!currentSource)throw new Error("Breakdown source is no longer available.");this.requireOnline(currentSource);
      operation={...operation,status:"in-progress",updatedAt:new Date().toISOString(),steps:operation.steps.map((s,j)=>j===i?{...s,status:"creating",message:undefined}:s)};this.state.planning={...this.planning(),operations:this.planning().operations.map(o=>o.id===id?operation!:o)};this.persist();
      try { const before=new Set(this.state.tasks.map(t=>`${t.sourceId}\0${t.id}`)); const next=await this.createTask({sourceId:parent.sourceId,name:steps[i].name}); const created=next.tasks.find(t=>t.sourceId===parent.sourceId&&!before.has(`${t.sourceId}\0${t.id}`)); if(!created)throw new Error("The provider response did not include the created task ID."); const ref:TaskRef={provider:parent.provider,sourceId:parent.sourceId,taskId:created.id};operation={...operation,steps:operation.steps.map((s,j)=>j===i?{...s,status:"created",ref,message:undefined}:s),updatedAt:new Date().toISOString()};this.state.planning={...this.planning(),operations:this.planning().operations.map(o=>o.id===id?operation!:o)};this.state.planning=linkChildren(this.planning(),parent,[{ref,estimateMinutes:steps[i].estimateMinutes,order:steps[i].order}]);this.persist();this.broadcast();
      } catch(error) { const message=toError(error).message;const knownRejected=error instanceof TaskCreateFailure&&error.outcome==="not-created";operation={...operation,status:knownRejected?"in-progress":"recovery-needed",steps:operation.steps.map((s,j)=>j===i?{...s,status:knownRejected?"failed":"recovery-needed",message}:s),updatedAt:new Date().toISOString()};this.state.planning={...this.planning(),operations:this.planning().operations.map(o=>o.id===id?operation!:o)};this.persist();this.broadcast();throw new Error(knownRejected?`Could not create “${steps[i].name}”: ${message}. This step is confirmed not created; correct the issue and resume.`:`The result for “${steps[i].name}” is uncertain: ${message}. Refresh the source and reconcile this step before resuming.`); }
    }
    operation={...operation,status:"complete",updatedAt:new Date().toISOString()};this.state.planning={...this.planning(),operations:this.planning().operations.map(o=>o.id===id?operation!:o)};this.persist();this.broadcast();return this.snapshot();
  }
  private reconcilePlanningBreakdown(idValue: unknown, orderValue: unknown, resolutionValue: unknown): AppState {
    const id=stringValue(idValue,"operationId");if(!Number.isInteger(orderValue)||!isRecord(resolutionValue))throw new TypeError("Breakdown recovery choice is invalid.");
    const operation=this.planning().operations.find(o=>o.id===id);if(!operation)throw new Error("Breakdown operation was not found.");const order=orderValue as number;const step=operation.steps.find(s=>s.order===order);if(!step||!(step.status==="recovery-needed"||step.status==="creating"))throw new Error("This step does not need recovery.");
    let nextStep:typeof step;
    if(resolutionValue.kind==="confirm-not-created")nextStep={...step,status:"pending",message:undefined,ref:undefined};
    else if(resolutionValue.kind==="existing-task"){
      const ref=this.requireTaskRef(resolutionValue.ref);if(ref.sourceId!==operation.parent.sourceId||ref.provider!==operation.parent.provider)throw new Error("Choose an existing task from the same source as the breakdown.");
      if(operation.steps.some(s=>s.order!==order&&s.ref&&refKey(s.ref)===refKey(ref)))throw new Error("That task is already assigned to another step in this breakdown.");
      if(this.planning().tasks.some(row=>refKey(row.ref)===refKey(ref)&&row.parent)||this.planning().operations.some(other=>other.steps.some(s=>s.ref&&refKey(s.ref)===refKey(ref))))throw new Error("That task is already linked to another breakdown step.");
      this.state.planning=linkChildren(this.planning(),operation.parent,[{ref,estimateMinutes:step.estimateMinutes,order:step.order}]);nextStep={...step,status:"created",ref,message:undefined};
    } else throw new TypeError("Choose an existing task or confirm that no task was created.");
    const steps=operation.steps.map(s=>s.order===order?nextStep:s);const unresolved=steps.some(s=>s.status==="recovery-needed"||s.status==="creating");const complete=steps.every(s=>s.status==="created");const status:BreakdownOperation["status"]=complete?"complete":unresolved?"recovery-needed":"in-progress";const updated={...operation,steps,status,updatedAt:new Date().toISOString()};this.state.planning={...this.planning(),operations:this.planning().operations.map(o=>o.id===id?updated:o)};this.persist();this.broadcast();return this.snapshot();
  }
  private setPlanningSettings(value: unknown): AppState {
    if(!isRecord(value))throw new TypeError("Planning settings are invalid"); const old=this.planning(); const settings={...old.settings,...value} as PlanningSettings;
    if(typeof settings.timezone!=="string"||!Array.isArray(settings.workdays)||settings.workdays.some(d=>!Number.isInteger(d)||d<1||d>7)||!Number.isInteger(settings.startHour)||!Number.isInteger(settings.endHour)||settings.startHour<0||settings.endHour>24||settings.startHour>=settings.endHour||typeof settings.allowEmptyCalendar!=="boolean")throw new TypeError("Planning settings are invalid");
    if(!DateTime.now().setZone(settings.timezone).isValid)throw new TypeError("Choose a valid IANA timezone.");
    this.state.planning={...old,settings,inputRevision:old.inputRevision+1};this.persist();this.broadcast();return this.snapshot();
  }
  private importCalendar(value: unknown): AppState {
    if(typeof value!=="string"||value.length>5_000_000)throw new TypeError("Calendar file is invalid or too large.");const current=this.planning();const parsed=parseCalendarICS(value,current.settings.timezone);
    this.state.planning={...current,events:parsed.events,calendarImportedAt:parsed.importedAt,calendarSource:"ics",settings:{...current.settings,allowEmptyCalendar:false},inputRevision:current.inputRevision+1};this.persist();this.broadcast();return this.snapshot();
  }
  private addCalendarEvent(value: unknown): AppState {
    if(!isRecord(value)||typeof value.title!=="string"||!value.title.trim()||typeof value.start!=="string"||typeof value.end!=="string")throw new TypeError("Calendar event is invalid.");const start=DateTime.fromISO(value.start),end=DateTime.fromISO(value.end);if(!start.isValid||!end.isValid||end<=start)throw new TypeError("Calendar event needs a valid end after its start.");const current=this.planning();
    this.state.planning={...current,events:[...current.events,{id:`manual-${Date.now()}`,title:value.title.trim(),start:start.toUTC().toISO()!,end:end.toUTC().toISO()!}],calendarImportedAt:current.calendarImportedAt??new Date().toISOString(),calendarSource:current.calendarSource??"manual",inputRevision:current.inputRevision+1};this.persist();this.broadcast();return this.snapshot();
  }
  private approvePlanning(proposalValue: unknown, selectedValue: unknown): AppState {
    if(!isRecord(proposalValue)||typeof proposalValue.id!=="string"||!Array.isArray(proposalValue.items)||!Number.isInteger(proposalValue.inputRevision)||!Array.isArray(selectedValue)||selectedValue.some(x=>typeof x!=="string"))throw new TypeError("Plan approval is invalid.");
    this.state.planning=approvePlan(this.planning(),this.state,proposalValue as unknown as PlanProposal,selectedValue as string[]);this.persist();this.broadcast();return this.snapshot();
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

  private parseConnection(value: unknown): ConnectionConfig {
    if (typeof value === "string") return { provider: "notion", token: stringValue(value, "token") };
    if (!isRecord(value)) throw new TypeError("connection is invalid");
    const provider = value.provider === "plane" ? "plane" : value.provider === "notion" ? "notion" : null;
    if (!provider) throw new TypeError("connection.provider is invalid");
    const token = stringValue(value.token, "token");
    const baseUrl = value.baseUrl === undefined ? undefined : stringValue(value.baseUrl, "baseUrl");
    const workspaceSlug = value.workspaceSlug === undefined ? undefined : stringValue(value.workspaceSlug, "workspaceSlug");
    return { provider, token, ...(baseUrl ? { baseUrl } : {}), ...(workspaceSlug ? { workspaceSlug } : {}) };
  }

  private async connect(value: unknown): Promise<AppState> {
    const config = this.parseConnection(value);
    if (config.provider === "plane") return this.connectPlane({ apiKey: config.token, workspaceSlug: config.workspaceSlug || "", baseUrl: config.baseUrl });
    const token = config.token;
    const service = new NotionService(token) as unknown as Service;
    await service.validate();
    this.persistence.saveToken(token, "notion");
    this.token = token;
    this.service = service;
    this.tokens.set("notion", token);
    this.services.set("notion", service);
    this.sourceGeneration += 1;
    this.state.connected = true;
    this.state.connections = { ...this.state.connections, notion: { connected: true } };
    this.state.sync.errors = {};
    this.broadcast();
    await this.sync();
    return this.snapshot();
  }

  private providerForValue(value: unknown): SourceProvider {
    if (value === undefined || value === null || value === "") return "notion";
    if (value === "plane" || isRecord(value) && value.provider === "plane") return "plane";
    if (value === "notion" || isRecord(value) && value.provider === "notion") return "notion";
    throw new TypeError("provider is invalid");
  }

  private async disconnect(value?: unknown): Promise<AppState> {
    const provider = this.providerForValue(value);
    this.sourceGeneration += 1;
    this.persistence.clearToken(provider);
    this.tokens.delete(provider);
    this.services.delete(provider);
    if (provider === "plane") {
      this.planeConfig = null;
      this.persistence.clearPlaneConfig();
    }
    if (provider === "notion") {
      this.token = null;
      this.service = this.services.get("notion") || null;
    }
    this.state.connected = this.services.size > 0;
    this.state.connections = { ...this.state.connections, [provider]: { ...(this.state.connections?.[provider] || {}), connected: false } };
    this.state.sync.onlineSources = this.state.sync.onlineSources.filter((sourceId) => (this.state.sources.find((source) => source.id === sourceId)?.provider || "notion") !== provider);
    delete this.state.sync.errors[`${provider}:account`];
    this.state.sync.syncing = false;
    this.broadcast();
    return this.snapshot();
  }

  private async connectPlane(value: unknown): Promise<AppState> {
    if (!isRecord(value)) throw new TypeError("Plane connection is invalid");
    const apiKey = stringValue(value.apiKey, "apiKey");
    const workspaceSlug = stringValue(value.workspaceSlug, "workspaceSlug");
    const baseUrl = value.baseUrl === undefined ? undefined : stringValue(value.baseUrl, "baseUrl");
    const service = new PlaneService(apiKey, globalThis.fetch, { workspaceSlug, ...(baseUrl ? { apiBase: baseUrl } : {}) }) as unknown as Service;
    await service.validate();
    this.persistence.saveToken(apiKey, "plane");
    this.persistence.savePlaneConfig({ ...(baseUrl ? { baseUrl } : {}), workspaceSlug });
    this.planeConfig = { ...(baseUrl ? { baseUrl } : {}), workspaceSlug };
    this.services.set("plane", service);
    this.tokens.set("plane", apiKey);
    this.state.connected = true;
    this.state.connections = { ...this.state.connections, plane: { connected: true, ...(baseUrl ? { baseUrl } : {}), workspaceSlug } };
    delete this.state.sync.errors["plane:account"];
    this.sourceGeneration += 1;
    this.broadcast();
    await this.sync();
    return this.snapshot();
  }

  private async listPlaneProjects(value: unknown): Promise<SourceCandidate[]> {
    const input = value === undefined ? {} : value;
    if (!isRecord(input)) throw new TypeError("Plane project options are invalid");
    const service = this.services.get("plane");
    if (!service || !this.state.connections?.plane?.connected) throw new Error("Connect Plane before listing projects");
    const workspaceSlug = input.workspaceSlug === undefined ? undefined : stringValue(input.workspaceSlug, "workspaceSlug");
    const list = (service as unknown as { listProjects?: (workspace?: string) => Promise<unknown> }).listProjects;
    if (typeof list !== "function") throw new Error("Plane project listing is unavailable");
    const response = await list.call(service, workspaceSlug);
    return (Array.isArray(response) ? response : []).map((item) => sourceCandidate(item)).filter((item) => item.provider === "plane");
  }

  private async resolveSource(value: unknown): Promise<SourceCandidate[]> {
    const url = stringValue(value, "url");
    const provider: SourceProvider = isNotionUrl(url) ? "notion" : isPlaneUrl(url) ? "plane" : (() => { throw new Error("Only HTTPS Notion or Plane URLs can be resolved"); })();
    const service = this.services.get(provider) || (provider === "notion" ? this.service : null);
    if (!service || !this.state.connected) throw new Error(`Connect ${provider === "plane" ? "Plane" : "Notion"} before resolving a source`);
    const response = await service.resolveSource(url);
    const candidates = Array.isArray(response) ? response : isRecord(response) && Array.isArray(response.sources) ? response.sources : [];
    const seen = new Set<string>();
    return candidates.map((item) => sourceCandidate(item)).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  private async inspect(source: SourceConfig): Promise<SourceConfig> {
    const provider = source.provider === "plane" ? "plane" : "notion";
    const service = this.services.get(provider) || (provider === "notion" ? this.service : null);
    if (!service) throw new Error(`Connect ${provider === "plane" ? "Plane" : "Notion"} before using a source`);
    const inspected = await service.inspectSource(source.id || source.databaseId);
    const candidate = sourceCandidate(inspected, source);
    const refreshed: SourceConfig = { ...source, ...candidate, provider: source.provider || candidate.provider, name: candidate.name || source.name, properties: candidate.properties, mapping: source.mapping };
    validateSourceConfig(refreshed);
    return refreshed;
  }

  private async saveSource(value: unknown): Promise<AppState> {
    if (!isRecord(value)) throw new TypeError("source is invalid");
    const source = value as unknown as SourceConfig;
    const provider = source.provider === "plane" ? "plane" : "notion";
    if (!(this.services.get(provider) || (provider === "notion" ? this.service : null)) || !this.state.connected) throw new Error(`Connect ${provider === "plane" ? "Plane" : "Notion"} before saving a source`);
    if (this.sourceWrites.has(source.id)) throw new Error("Wait for this source's task saves to finish before remapping");
    validateSourceConfig(source);
    const refreshed = await this.inspect(source);
    if (this.sourceWrites.has(source.id)) throw new Error("Wait for this source's task saves to finish before remapping");
    this.sourceGeneration += 1;
    const index = this.state.sources.findIndex((item) => item.id === refreshed.id && (item.provider || "notion") === (refreshed.provider || "notion"));
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
      const key = `${source.provider || "notion"}:${source.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
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
    if (!this.services.size && (!this.service || !this.token)) return this.snapshot();
    if (this.services.size) {
      for (const provider of this.services.keys()) {
        if (this.state.connections?.[provider]?.connected !== true) await this.startupConnection(provider, false);
      }
      this.state.connected = this.hasConnectedProvider();
    } else if (!this.state.connected) {
      if (this.service && this.token) {
        try {
          await this.service.validate();
          this.state.connected = true;
          delete this.state.sync.errors.account;
          await this.sync();
        } catch (error) {
          this.state.sync.errors.account = toError(error).message;
          this.state.sync.syncing = false;
          this.broadcast();
          return this.snapshot();
        }
      }
    }
    if (!this.state.connected) return this.snapshot();
    await this.sync();
    return this.snapshot();
  }

  private async sync(): Promise<void> {
    if (this.syncInFlight) {
      const generationAtWait = this.syncInFlightGeneration;
      await this.syncInFlight;
      if (generationAtWait !== this.sourceGeneration && this.services.size && this.state.connected) return this.sync();
      return;
    }
    if (!this.services.size && !this.service) return;
    this.syncInFlightGeneration = this.sourceGeneration;
    this.syncInFlight = this.performSync().finally(() => { this.syncInFlight = null; this.syncInFlightGeneration = null; });
    return this.syncInFlight;
  }

  private async performSync(): Promise<void> {
    const generation = this.sourceGeneration;
    const configuredSources = [...this.state.sources];
    const accountErrors = Object.fromEntries(Object.entries(this.state.sync.errors).filter(([key]) => key === "account" || key.endsWith(":account")));
    const initialErrors = { ...this.state.sync.errors };
    delete initialErrors.account;
    this.setSync({ syncing: true, errors: initialErrors });
    const errors: Record<string, string> = {};
    const onlineSources: string[] = [];
    for (const configured of configuredSources) {
      try {
        const service = this.serviceForSource(configured);
        if (!service || !this.isSyncCurrent(generation, service, configured)) throw new Error(`${configured.name} is offline`);
        const source = await this.inspect(configured);
        const tasks = await service.listTasks(source);
        if (!this.isSyncCurrent(generation, service, source)) return;
        const sourceTasks = cleanTaskList(tasks, source.id, source.provider === "plane" ? "plane" : "notion");
        this.state.sources = this.state.sources.map((item) => item.id === source.id && (item.provider || "notion") === (source.provider || "notion") ? source : item);
        this.state.tasks = this.state.tasks.filter((task) => task.sourceId !== source.id).concat(sourceTasks);
        onlineSources.push(source.id);
      } catch (error) {
        if (generation !== this.sourceGeneration) return;
        const currentService = this.serviceForSource(configured);
        if (currentService && !this.isSyncCurrent(generation, currentService, configured)) return;
        errors[configured.id] = toError(error).message;
        // Leave the last successful task snapshot in place for offline read-only use.
      }
    }
    this.state.sync = {
      syncing: false,
      lastSync: onlineSources.length > 0 || configuredSources.length === 0 ? new Date().toISOString() : this.state.sync.lastSync,
      errors: { ...accountErrors, ...errors },
      onlineSources,
    };
    this.persist();
    this.broadcast();
  }

  private serviceForSource(source: SourceConfig): Service | null {
    const provider = source.provider === "plane" ? "plane" : "notion";
    if (this.state.connections?.[provider]?.connected === false) return null;
    return this.services.get(provider) || (provider === "notion" ? this.service : null);
  }

  private isSyncCurrent(generation: number, service: Service | null, source?: SourceConfig): boolean {
    if (generation !== this.sourceGeneration || !this.state.connected || !service) return false;
    return source ? service === this.serviceForSource(source) : service === this.service || [...this.services.values()].includes(service);
  }

  private async createTask(value: unknown): Promise<AppState> {
    if (!isRecord(value)) throw new TypeError("createTask input is invalid");
    const sourceId = stringValue(value.sourceId, "sourceId");
    const name = stringValue(value.name, "name");
    const due = taskDate(value.due);
    if (value.favorite !== undefined && typeof value.favorite !== "boolean") throw new TypeError("favorite must be boolean");
    const favorite = value.favorite === true;
    const source = this.state.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("Source not found");
    this.requireOnline(source);
    return this.withSourceWrite(sourceId, async () => {
    const service = this.serviceForSource(source);
    if (!service) throw new Error("The source is offline; reconnect before creating a task");
    const refreshed = await this.inspect(source);
    if (!this.isSyncCurrent(this.sourceGeneration, service, source) || !this.state.sources.some(item => item.id === sourceId)) throw new Error("The connection or source changed; refresh before creating a task");
    const created = await service.createTask(refreshed, name, due);
    if (!this.isSyncCurrent(this.sourceGeneration, service, source) || !this.state.sources.some(item => item.id === sourceId)) throw new Error(`The task was created in ${source.provider === "plane" ? "Plane" : "Notion"}, but its source was disconnected. Reconnect to view it`);
    this.sourceGeneration += 1;
    this.state.sync.syncing = false;
    // The created page's ID is authoritative; task names are never identities.
    const task = cleanTask(created, sourceId, source.provider === "plane" ? "plane" : "notion");
    if (!this.state.tasks.some((item) => item.sourceId === sourceId && item.id === task.id)) this.state.tasks.push(task);
    if (favorite && !this.state.stars.includes(task.id)) this.state.stars.push(task.id);
    this.state.sources = this.state.sources.map((item) => item.id === sourceId ? refreshed : item);
    this.persist();
    this.broadcast();
    return this.snapshot();
    });
  }

  private requireOnline(source: SourceConfig): void {
    if (!this.serviceForSource(source) || !this.state.connected || !this.state.sync.onlineSources.includes(source.id)) {
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
    const service = this.serviceForSource(source);
    if (!service) throw new Error("The source is offline; reconnect before editing");
    const refreshed = await this.inspect(source);
    return this.queueWrite(id, async () => {
      if (!this.isSyncCurrent(this.sourceGeneration, service, source) || !this.state.sources.some(item => item.id === source.id)) throw new Error("The connection or source changed; refresh before editing");
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
      if (!this.isSyncCurrent(this.sourceGeneration, service, source) || !this.state.sources.some(item => item.id === source.id)) throw new Error("The source was disconnected. Reconnect to see the task's latest state");
      this.sourceGeneration += 1;
      this.state.sync.syncing = false;
      const conflict = isRecord(response) && response.conflict === true;
      const task = cleanTask(response, source.id, source.provider === "plane" ? "plane" : "notion");
      this.replaceTask(task);
      this.persist();
      this.broadcast();
      return { task, ...(conflict ? { conflict: true } : {}) };
    } catch (error) {
      if (!isConflict(error)) throw error;
      let current = conflictTask(error);
      if (!current) {
        try {
          const listed = await service.listTasks(source);
          current = cleanTaskList(listed, source.id, source.provider === "plane" ? "plane" : "notion").find((item) => item.id === id);
        } catch {
          // Preserve the original conflict response when the refresh itself is unavailable.
        }
      }
      if (!current) throw error;
      const normalized = cleanTask(current, source.id, source.provider === "plane" ? "plane" : "notion");
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

  private async setSourceColor(sourceValue: unknown, colorValue: unknown): Promise<AppState> {
    const id = stringValue(sourceValue, "sourceId");
    if (!isSourceColor(colorValue)) throw new TypeError("color must be a supported source color");
    const source = this.state.sources.find((item) => item.id === id);
    if (!source) throw new Error("Source not found");
    source.color = colorValue;
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
    if (value.showOverdue !== undefined) {
      if (typeof value.showOverdue !== "boolean") throw new TypeError("showOverdue must be boolean");
      next.showOverdue = value.showOverdue;
    }
    if (value.lastSourceId !== undefined) next.lastSourceId = stringValue(value.lastSourceId, "lastSourceId");
    if (value.theme !== undefined) {
      if (!isThemePreference(value.theme)) throw new TypeError("theme must be system, light, or dark");
      next.theme = value.theme;
    }
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
    const target = knownTask && (isNotionUrl(knownTask.url) || isPlaneUrl(knownTask.url)) ? knownTask.url : null;
    if (!target) throw new Error("Only a known Notion or Plane task ID can be opened");
    await shell.openExternal(target);
  }
}

let runtime: DesktopRuntime | null = null;
let singleInstance = false;

function boot(): void {
  const previewChannel = process.env.NOTION_TASKS_CHANNEL === "preview" || isPrereleaseVersion(app.getVersion());
  if (previewChannel) {
    // Preview builds must be installable and runnable beside the stable app.
    app.setName("Notion Tasks Preview");
    app.setAppUserModelId("com.notiontasks.desktop.preview");
    const previewUserData = process.env.NOTION_TASKS_USER_DATA || path.join(app.getPath("appData"), "Notion Tasks Preview");
    mkdirSync(previewUserData, { recursive: true });
    app.setPath("userData", previewUserData);
  }
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

