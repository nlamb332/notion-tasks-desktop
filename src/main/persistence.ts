import * as fs from "node:fs";
import * as path from "node:path";
import { safeStorage } from "electron";
import { SOURCE_COLORS, type AppState, type DesktopSettings, type SourceColor, type SourceConfig, type Task, type ThemePreference } from "../shared/types";

export interface PersistedData {
  sources: SourceConfig[];
  tasks: Task[];
  stars: string[];
  settings: DesktopSettings;
  lastSync: string | null;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  compact: false,
  showOverdue: false,
  alwaysOnTop: false,
  launchAtLogin: false,
  selectedList: "today",
  lastSourceId: "",
  theme: "system",
};

function isSourceColor(value: unknown): value is SourceColor {
  return typeof value === "string" && SOURCE_COLORS.includes(value as SourceColor);
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanBounds(value: unknown): DesktopSettings["bounds"] {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(finiteNumber)) return undefined;
  if ((width as number) < 220 || (height as number) < 120) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function cleanSettings(value: unknown): DesktopSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
  const settings: DesktopSettings = {
    compact: typeof value.compact === "boolean" ? value.compact : DEFAULT_SETTINGS.compact,
    showOverdue: typeof value.showOverdue === "boolean" ? value.showOverdue : false,
    alwaysOnTop: typeof value.alwaysOnTop === "boolean" ? value.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    launchAtLogin: typeof value.launchAtLogin === "boolean" ? value.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    selectedList: typeof value.selectedList === "string" ? value.selectedList : DEFAULT_SETTINGS.selectedList,
    lastSourceId: typeof value.lastSourceId === "string" ? value.lastSourceId : DEFAULT_SETTINGS.lastSourceId,
    theme: isThemePreference(value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
  };
  settings.bounds = cleanBounds(value.bounds);
  settings.fullBounds = cleanBounds(value.fullBounds);
  settings.compactBounds = cleanBounds(value.compactBounds);
  return settings;
}

function cleanSources(value: unknown): SourceConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SourceConfig[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.databaseId !== "string") continue;
    if (seen.has(item.id)) continue;
    if (typeof item.name !== "string" || !Array.isArray(item.properties) || !isRecord(item.mapping)) continue;
    const mapping = item.mapping as Record<string, unknown>;
    if (!["title", "status", "complete", "reopen"].every((key) => typeof mapping[key] === "string")) continue;
    const properties = item.properties.filter((property): property is SourceConfig["properties"][number] =>
      isRecord(property) && typeof property.id === "string" && typeof property.name === "string" && typeof property.type === "string",
    );
    seen.add(item.id);
    result.push({
      id: item.id,
      databaseId: item.databaseId,
      name: item.name,
      properties,
      ...(isSourceColor(item.color) ? { color: item.color } : {}),
      mapping: {
        title: mapping.title as string,
        due: typeof mapping.due === "string" ? mapping.due : null,
        status: mapping.status as string,
        complete: mapping.complete as string,
        reopen: mapping.reopen as string,
      },
    });
  }
  return result;
}

function cleanTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) return [];
  const result: Task[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || typeof item.sourceId !== "string" || !item.sourceId.trim()) continue;
    if (seen.has(`${item.sourceId}:${item.id}`)) continue;
    if (typeof item.name !== "string" || typeof item.url !== "string" || typeof item.status !== "string" || typeof item.completed !== "boolean" || typeof item.lastEdited !== "string") continue;
    const due = item.due === null || item.due === undefined || (isRecord(item.due) && typeof item.due.start === "string" && (item.due.end === null || typeof item.due.end === "string") && (item.due.time_zone === undefined || item.due.time_zone === null || typeof item.due.time_zone === "string"))
      ? item.due === undefined ? null : item.due as Task["due"]
      : null;
    result.push({
      id: item.id,
      sourceId: item.sourceId,
      name: item.name,
      url: item.url,
      due,
      status: item.status,
      completed: item.completed,
      lastEdited: item.lastEdited,
    });
    seen.add(`${item.sourceId}:${item.id}`);
  }
  return result;
}

export function defaultPersistedData(): PersistedData {
  return { sources: [], tasks: [], stars: [], settings: { ...DEFAULT_SETTINGS }, lastSync: null };
}

export class AppPersistence {
  private readonly statePath: string;
  private readonly tokenPath: string;

  constructor(private readonly directory: string) {
    this.statePath = path.join(directory, "state.json");
    this.tokenPath = path.join(directory, "notion-token.enc");
  }

  load(): PersistedData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Record<string, unknown>;
      const clean = defaultPersistedData();
      return {
        sources: cleanSources(raw.sources),
        tasks: cleanTasks(raw.tasks),
        stars: Array.isArray(raw.stars) ? raw.stars.filter((id): id is string => typeof id === "string") : [],
        settings: cleanSettings(raw.settings),
        lastSync: raw.lastSync === null || typeof raw.lastSync === "string" ? raw.lastSync as string | null : null,
      };
    } catch {
      return defaultPersistedData();
    }
  }

  save(data: PersistedData | AppState): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const persisted: PersistedData = {
      sources: cleanSources(data.sources),
      tasks: cleanTasks(data.tasks),
      stars: Array.from(new Set(data.stars.filter((id) => typeof id === "string"))),
      settings: cleanSettings(data.settings),
      lastSync: "sync" in data
        ? isRecord(data.sync) && (data.sync.lastSync === null || typeof data.sync.lastSync === "string") ? data.sync.lastSync as string | null : null
        : data.lastSync,
    };
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(persisted), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.statePath);
  }

  loadToken(): string | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const encrypted = fs.readFileSync(this.tokenPath);
      return safeStorage.decryptString(encrypted) || null;
    } catch {
      return null;
    }
  }

  saveToken(token: string): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.mkdirSync(this.directory, { recursive: true });
    const encrypted = safeStorage.encryptString(token);
    const temporaryPath = `${this.tokenPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.tokenPath);
    return true;
  }

  clearToken(): void {
    try {
      fs.unlinkSync(this.tokenPath);
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
}

