export type TaskDate = { start: string; end: string | null; time_zone?: string | null } | null;
export const SOURCE_COLORS = ["blue", "violet", "teal", "amber", "rose"] as const;
export type SourceColor = typeof SOURCE_COLORS[number];
export type ThemePreference = "system" | "light" | "dark";
export type SourceProvider = "notion" | "plane";
export interface ConnectionConfig { provider: SourceProvider; token: string; baseUrl?: string; workspaceSlug?: string }
export interface PlaneConnectionInput { apiKey: string; workspaceSlug: string; baseUrl?: string }
export interface ProviderConnectionState { connected: boolean; baseUrl?: string; workspaceSlug?: string }
export interface Task { id: string; sourceId: string; name: string; url: string; due: TaskDate; status: string; completed: boolean; lastEdited: string }
export interface PropertyInfo { id: string; name: string; type: string; options?: { id: string; name: string; group?: string }[] }
export interface SourceCandidate { id: string; databaseId: string; name: string; properties: PropertyInfo[]; provider?: SourceProvider; workspaceSlug?: string; projectId?: string; baseUrl?: string }
export interface SourceConfig extends SourceCandidate { color?: SourceColor; mapping: { title: string; due: string | null; status: string; complete: string; reopen: string } }
export interface DesktopSettings { compact: boolean; showOverdue?: boolean; alwaysOnTop: boolean; launchAtLogin: boolean; selectedList: string; lastSourceId: string; theme?: ThemePreference; bounds?: { x: number; y: number; width: number; height: number }; fullBounds?: { x: number; y: number; width: number; height: number }; compactBounds?: { x: number; y: number; width: number; height: number } }
export interface SyncState { syncing: boolean; lastSync: string | null; errors: Record<string, string>; onlineSources: string[] }
export interface AppState { connected: boolean; sources: SourceConfig[]; tasks: Task[]; stars: string[]; settings: DesktopSettings; sync: SyncState; connections?: Partial<Record<SourceProvider, ProviderConnectionState>> }
export interface TaskChanges { name?: string; due?: TaskDate; status?: string }
export interface UpdateResult { task: Task; conflict?: boolean }
export interface AppUpdateState {
 currentVersion: string;
 status: 'idle' | 'unsupported' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
 latestVersion?: string;
 progress?: number;
 message?: string;
}
export interface DesktopAPI {
 getUpdateState(): Promise<AppUpdateState>;
 checkForUpdates(): Promise<AppUpdateState>;
 downloadUpdate(): Promise<AppUpdateState>;
 installUpdate(): Promise<AppUpdateState>;
 onUpdateState(callback: (state: AppUpdateState) => void): () => void;
 getState(): Promise<AppState>;
 connect(input: string | ConnectionConfig): Promise<AppState>;
 connectPlane(input: PlaneConnectionInput): Promise<AppState>;
 listPlaneProjects(workspaceSlug?: string, baseUrl?: string): Promise<SourceCandidate[]>;
 disconnect(provider?: SourceProvider): Promise<AppState>;
 resolveSource(url: string): Promise<SourceCandidate[]>;
 saveSource(source: SourceConfig): Promise<AppState>;
 setSourceColor(sourceId: string, color: SourceColor): Promise<AppState>;
 removeSource(id: string): Promise<AppState>;
 refresh(): Promise<AppState>;
 createTask(sourceId: string, name: string, due?: TaskDate, favorite?: boolean): Promise<AppState>;
 updateTask(id: string, changes: TaskChanges, expected: Task): Promise<UpdateResult>;
 toggleStar(id: string): Promise<AppState>;
 setSettings(settings: Partial<DesktopSettings>): Promise<AppState>;
 openNotion(id: string): Promise<void>;
 onState(callback: (state: AppState) => void): () => void;
}
declare global { interface Window { desktop: DesktopAPI } }
