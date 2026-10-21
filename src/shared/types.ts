export type TaskDate = { start: string; end: string | null; time_zone?: string | null } | null;
export interface Task { id: string; sourceId: string; name: string; url: string; due: TaskDate; status: string; completed: boolean; lastEdited: string }
export interface PropertyInfo { id: string; name: string; type: string; options?: { id: string; name: string; group?: string }[] }
export interface SourceCandidate { id: string; databaseId: string; name: string; properties: PropertyInfo[] }
export interface SourceConfig extends SourceCandidate { mapping: { title: string; due: string | null; status: string; complete: string; reopen: string } }
export interface DesktopSettings { compact: boolean; alwaysOnTop: boolean; launchAtLogin: boolean; selectedList: string; lastSourceId: string; bounds?: { x: number; y: number; width: number; height: number }; fullBounds?: { x: number; y: number; width: number; height: number }; compactBounds?: { x: number; y: number; width: number; height: number } }
export interface SyncState { syncing: boolean; lastSync: string | null; errors: Record<string, string>; onlineSources: string[] }
export interface AppState { connected: boolean; sources: SourceConfig[]; tasks: Task[]; stars: string[]; settings: DesktopSettings; sync: SyncState }
export interface TaskChanges { name?: string; due?: TaskDate; status?: string }
export interface UpdateResult { task: Task; conflict?: boolean }
export interface DesktopAPI {
 getState(): Promise<AppState>;
 connect(token: string): Promise<AppState>;
 disconnect(): Promise<AppState>;
 resolveSource(url: string): Promise<SourceCandidate[]>;
 saveSource(source: SourceConfig): Promise<AppState>;
 removeSource(id: string): Promise<AppState>;
 refresh(): Promise<AppState>;
 createTask(sourceId: string, name: string, due?: TaskDate): Promise<AppState>;
 updateTask(id: string, changes: TaskChanges, expected: Task): Promise<UpdateResult>;
 toggleStar(id: string): Promise<AppState>;
 setSettings(settings: Partial<DesktopSettings>): Promise<AppState>;
 openNotion(id: string): Promise<void>;
 onState(callback: (state: AppState) => void): () => void;
}
declare global { interface Window { desktop: DesktopAPI } }
