import { useCallback, useEffect, useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import {
  Archive,
  ArrowDownToLine,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CloudOff,
  Database,
  ExternalLink,
  Filter,
  Flag,
  FolderOpen,
  Inbox,
  ListTodo,
  LoaderCircle,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import { UpdateSettings } from './UpdateSettings';
import { SOURCE_COLORS, type AppState, type SourceCandidate, type SourceColor, type SourceConfig, type Task, type TaskChanges, type TaskDate, type ThemePreference } from '../shared/types';
import {
  autoMapping,
  dateInputValue,
  displayDateTime,
  filterTasks,
  formatTaskDue,
  listCounts,
  type ListId,
  sourceForTask,
  sourceStatusOptions,
  taskStatusTone,
  taskDateFromInputs,
  timeInputValue,
} from './utils';
import { useTaskCompletion } from './completion';
import './styles.css';

type ViewId = ListId | 'settings';

type DraftTask = {
  sourceId: string;
  name: string;
  dueDate: string;
};

const listDefinitions: { id: ListId; label: string; icon: typeof Sun }[] = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'upcoming', label: 'Upcoming', icon: Calendar },
  { id: 'all', label: 'All Tasks', icon: Inbox },
  { id: 'important', label: 'Important', icon: Star },
  { id: 'completed', label: 'Completed', icon: CheckCircle2 },
];

const emptyFilters = { sourceId: '', status: '', from: '', to: '', important: false };

function apiAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.desktop);
}

function sourceName(sourceId: string, sources: SourceConfig[]): string {
  return sources.find((source) => source.id === sourceId)?.name ?? 'Unknown source';
}

function sourceColor(sourceId: string, configured?: SourceColor): SourceColor {
  if (configured) return configured;
  let hash = 0;
  for (const character of sourceId) hash = (hash * 31 + character.charCodeAt(0)) % SOURCE_COLORS.length;
  return SOURCE_COLORS[hash];
}

function applyTheme(preference: ThemePreference): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  };
  apply();
  if (preference !== 'system') return () => undefined;
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}

function taskVersionChanged(left: Task, right: Task): boolean {
  return left.id !== right.id || left.name !== right.name || left.status !== right.status || left.completed !== right.completed || left.lastEdited !== right.lastEdited || JSON.stringify(left.due) !== JSON.stringify(right.due);
}

function App() {
  const [serverState, setState] = useState<AppState | null>(null);
  const [activeView, setActiveView] = useState<ViewId>('today');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(emptyFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { state, completionNotice, toggleComplete, undoCompletion, dismissCompletion } = useTaskCompletion(serverState, setState, setNotice);
  const [settingsSection, setSettingsSection] = useState<'connection' | 'sources' | 'preferences'>('connection');
  const [draft, setDraft] = useState<DraftTask | null>(null);

  const loadState = useCallback(async (method: 'getState' | 'refresh' = 'getState') => {
    if (!apiAvailable()) {
      setLoadError('The desktop bridge is unavailable. Restart the app to reconnect.');
      setLoading(false);
      return;
    }
    try {
      setLoadError(null);
      const next = await (method === 'refresh' ? window.desktop.refresh() : window.desktop.getState());
      setState(next);
      if (!next.connected) {
        setActiveView('settings');
        setSettingsSection('connection');
      } else if (next.settings.selectedList && next.settings.selectedList !== 'settings') {
        setActiveView(next.settings.selectedList as ListId);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load your tasks.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
    if (!apiAvailable()) return undefined;
    return window.desktop.onState((next) => {
      setState(next);
      if (!next.connected) {
        setActiveView('settings');
        setSettingsSection('connection');
      }
    });
  }, [loadState]);

  useEffect(() => applyTheme(state?.settings.theme ?? 'system'), [state?.settings.theme]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 4400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const counts = useMemo(() => state ? listCounts(state, state.settings.showOverdue) : undefined, [state]);
  const selectedTask = state?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const filteredTasks = useMemo(() => {
    if (!state || activeView === 'settings') return [];
    return filterTasks(state.tasks, activeView, state.stars, filters, query, state.sources, new Date(), state.settings.showOverdue);
  }, [activeView, filters, query, state]);
  const statusOptions = useMemo(() => {
    if (!state) return [];
    return [...new Set(state.tasks.map((task) => task.status).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [state]);

  async function setAppSettings(patch: Partial<AppState['settings']>) {
    if (!apiAvailable() || !state) return;
    const previousShowOverdue = state.settings.showOverdue;
    if (patch.showOverdue !== undefined) {
      setState(current => current ? { ...current, settings: { ...current.settings, showOverdue: patch.showOverdue } } : current);
    }
    try {
      const next = await window.desktop.setSettings(patch);
      setState(next);
    } catch (error) {
      if (patch.showOverdue !== undefined) {
        setState(current => current ? { ...current, settings: { ...current.settings, showOverdue: previousShowOverdue } } : current);
      }
      setNotice(error instanceof Error ? error.message : 'Unable to save settings.');
    }
  }

  function chooseView(view: ViewId, preserveSourceFilter = false) {
    setActiveView(view);
    setSelectedTaskId(null);
    if (view !== 'settings' && !preserveSourceFilter) setFilters((current) => current.sourceId ? { ...current, sourceId: '' } : current);
    if (view !== 'settings') void setAppSettings({ selectedList: view });
  }

  async function toggleStar(task: Task) {
    if (!apiAvailable()) return;
    try {
      setState(await window.desktop.toggleStar(task.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to update the local star.');
    }
  }

  async function createTask(sourceId: string, name: string, due?: TaskDate, favorite = false): Promise<Task | null> {
    if (!apiAvailable() || !name.trim()) return null;
    if (state && !state.sync.onlineSources.includes(sourceId)) {
      setNotice('This source is offline. Reconnect it before adding tasks.');
      return null;
    }
    try {
      const beforeIds = new Set(state?.tasks.map((task) => task.id) ?? []);
      const next = await window.desktop.createTask(sourceId, name.trim(), due, favorite);
      const created = next.tasks.find((task) => !beforeIds.has(task.id) && task.sourceId === sourceId) ?? null;
      try {
        setState(await window.desktop.setSettings({ lastSourceId: sourceId }));
      } catch {
        setState({ ...next, settings: { ...next.settings, lastSourceId: sourceId } });
      }
      setNotice('Task added.');
      return created;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to add task.');
      return null;
    }
  }

  function openDraft(sourceId: string, name = '') {
    const preferredSource = sourceId || filters.sourceId || state?.settings.lastSourceId || state?.sources[0]?.id || '';
    if (state?.settings.compact) void setAppSettings({ compact: false });
    setSelectedTaskId(null);
    const dueDate = activeView === 'today' ? dateInputValue({ start: new Date().toISOString(), end: null }) : '';
    setDraft(current => current && current.sourceId === preferredSource && !name.trim() ? current : { sourceId: preferredSource, name, dueDate });
  }

  function selectTask(task: Task) {
    setDraft(null);
    if (state?.settings.compact) void setAppSettings({ compact: false });
    setSelectedTaskId(task.id);
  }

  if (loading) return <div className="app-loading"><LoaderCircle className="spin" size={20} /><span>Loading your workspace…</span></div>;
  if (loadError && !state) return <div className="app-loading app-error"><Archive size={26} /><strong>Notion Tasks could not start</strong><span>{loadError}</span><button className="button button-primary" onClick={() => void loadState()}>Try again</button></div>;
  if (!state) return <div className="app-loading app-error"><Archive size={26} /><strong>Notion Tasks could not start</strong><span>No workspace state was returned by the desktop bridge.</span><button className="button button-primary" onClick={() => void loadState()}>Try again</button></div>;

  return (
    <div className={`app-shell ${state?.settings.compact ? 'compact-mode' : ''}`}>
      {state?.settings.compact && state.connected ? (
        <CompactView
          state={state}
          activeView={activeView === 'settings' ? 'today' : activeView}
          onView={(view) => chooseView(view)}
          sourceId={filters.sourceId}
          onSource={(sourceId) => setFilters((current) => ({ ...current, sourceId }))}
          tasks={filteredTasks}
          query={query}
          onQuery={setQuery}
          onToggleStar={toggleStar}
          onToggleComplete={toggleComplete}
          onSelect={selectTask}
          onDraft={openDraft}
          onExpand={() => void setAppSettings({ compact: false })}
          onRefresh={() => void loadState('refresh')}
          onShowOverdue={(showOverdue) => void setAppSettings({ showOverdue })}
        />
      ) : (
        <>
          <Sidebar state={state} activeView={activeView} counts={counts} onView={chooseView} onSource={(sourceId) => { setFilters((current) => ({ ...current, sourceId })); chooseView('all', true); }} onSettings={(section) => { setSettingsSection(section); chooseView('settings'); }} />
          <main className="main-column">
            <TopBar
              activeView={activeView}
              state={state}
              sourceId={filters.sourceId}
              onSource={(sourceId) => setFilters((current) => ({ ...current, sourceId }))}
              query={query}
              onQuery={setQuery}
              showFilters={showFilters}
              onToggleFilters={() => setShowFilters((value) => !value)}
              onRefresh={() => void loadState('refresh')}
              onCompact={() => void setAppSettings({ compact: true })}
            />
            {activeView === 'settings' ? (
              <SettingsView
                state={state}
                section={settingsSection}
                onSection={setSettingsSection}
                onState={setState}
                onNotice={setNotice}
              />
            ) : (
              <>
                {showFilters ? <FilterBar state={state} filters={filters} statusOptions={statusOptions} onFilters={setFilters} /> : null}
                <QuickAdd state={state} initialSourceId={filters.sourceId || state.settings.lastSourceId || state.sources[0]?.id || ''} onDraft={openDraft} />
                <TaskListHeader activeView={activeView} count={filteredTasks.length} showOverdue={Boolean(state.settings.showOverdue)} onShowOverdue={(showOverdue) => void setAppSettings({ showOverdue })} />
                <TaskList
                  state={state}
                  tasks={filteredTasks}
                  activeView={activeView}
                  selectedTaskId={selectedTaskId}
                  onSelect={selectTask}
                  onToggleStar={toggleStar}
                  onToggleComplete={toggleComplete}
                />
              </>
            )}
          </main>
          {activeView !== 'settings' && draft ? <DraftPanel state={state} draft={draft} onCreate={createTask} onCreated={(task) => { setDraft(null); setSelectedTaskId(task.id); }} onClose={() => setDraft(null)} onNotice={setNotice} /> : activeView !== 'settings' && selectedTask ? <DetailPanel state={state} task={selectedTask} onState={setState} onClose={() => setSelectedTaskId(null)} onNotice={setNotice} /> : null}
        </>
      )}
      {notice ? <div className="toast" role="status"><Sparkles size={15} />{notice}<button aria-label="Dismiss" onClick={() => setNotice(null)}><X size={14} /></button></div> : null}
      {completionNotice ? <div className={`toast completion-toast ${notice ? 'stacked' : ''}`} role="status"><CheckCircle2 size={16} /><span>{completionNotice.message}</span><button className="undo-button" onClick={undoCompletion}>Undo</button><button aria-label="Dismiss completion notification" onClick={dismissCompletion}><X size={14} /></button></div> : null}
    </div>
  );
}

function Sidebar({ state, activeView, counts, onView, onSource, onSettings }: { state: AppState; activeView: ViewId; counts?: Record<ListId, number>; onView: (view: ViewId) => void; onSource: (sourceId: string) => void; onSettings: (section: 'connection' | 'sources' | 'preferences') => void }) {
  return <aside className="sidebar">
    <div className="brand"><div className="brand-mark"><Check size={18} strokeWidth={3} /></div><div><strong>Notion Tasks</strong><span>Personal workspace</span></div></div>
    <div className="sidebar-scroll">
      <p className="nav-label">Lists</p>
      <nav className="primary-nav" aria-label="Task lists">
        {listDefinitions.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${activeView === id ? 'active' : ''}`} aria-label={label} title={label} onClick={() => onView(id)}><Icon size={17} /><span>{label}</span>{counts?.[id] ? <em>{counts[id]}</em> : null}</button>)}
      </nav>
      <div className="sidebar-divider" />
      <div className="source-heading"><p className="nav-label">Sources</p><button aria-label="Add source" title="Add source" onClick={() => onSettings('sources')}><Plus size={15} /></button></div>
      <div className="source-list">
        {state.sources.map((source) => <button className="source-item" key={source.id} onClick={() => onSource(source.id)}><span className={`source-dot ${sourceColor(source.id, source.color)}`} /><span title={source.name}>{source.name}</span>{state.sync.errors[source.id] ? <span className="source-error-dot" title={state.sync.errors[source.id]} /> : null}</button>)}
        {!state.sources.length ? <p className="muted sidebar-empty">Connect a database in Settings.</p> : null}
      </div>
    </div>
    <div className="sidebar-footer">
      <button className={`nav-item ${activeView === 'settings' ? 'active' : ''}`} aria-label="Settings" title="Settings" onClick={() => onSettings('connection')}><Settings size={17} /><span>Settings</span></button>
      <div className="connection-pill"><span className={`status-dot ${state.connected ? 'online' : 'offline'}`} /><span>{state.connected ? `${state.sources.length} source${state.sources.length === 1 ? '' : 's'}` : 'Not connected'}</span></div>
    </div>
  </aside>;
}

function TopBar({ activeView, state, sourceId, onSource, query, onQuery, showFilters, onToggleFilters, onRefresh, onCompact }: { activeView: ViewId; state: AppState; sourceId: string; onSource: (sourceId: string) => void; query: string; onQuery: (value: string) => void; showFilters: boolean; onToggleFilters: () => void; onRefresh: () => void; onCompact: () => void }) {
  const currentLabel = activeView === 'settings' ? 'Settings' : listDefinitions.find((item) => item.id === activeView)?.label ?? 'Tasks';
  return <header className="topbar">
    <div className="topbar-title"><div><h1>{currentLabel}</h1>{activeView !== 'settings' ? <span>{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</span> : <span>Make Notion Tasks work for you</span>}</div>{activeView !== 'settings' ? <SyncStatus state={state} onRefresh={onRefresh} /> : null}</div>
    <div className="topbar-actions">
      {activeView !== 'settings' ? <select className="topbar-source-select" aria-label="Filter by source" value={sourceId} onChange={(event) => onSource(event.target.value)}><option value="">All sources</option>{state.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select> : null}
      {activeView !== 'settings' ? <label className="search-field"><Search size={16} /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={(event) => onQuery(event.target.value)} /></label> : null}
      {activeView !== 'settings' ? <button className={`icon-button ${showFilters ? 'active' : ''}`} aria-label="Filter tasks" title="Filter tasks" onClick={onToggleFilters}><Filter size={17} /></button> : null}
      <button className="icon-button" aria-label="Refresh tasks" title="Refresh tasks" onClick={onRefresh}><RefreshCw size={17} className={state.sync.syncing ? 'spin' : ''} /></button>
      <button className="icon-button" aria-label="Use compact view" title="Use compact view" onClick={onCompact}><PanelLeft size={17} /></button>
    </div>
  </header>;
}

function SyncStatus({ state, onRefresh }: { state: AppState; onRefresh: () => void }) {
  const errors = Object.entries(state.sync.errors);
  const healthy = !errors.length;
  const statusLabel = state.sync.syncing ? 'Syncing…' : errors.length ? `${errors.length} source${errors.length === 1 ? '' : 's'} offline` : state.sync.lastSync ? `Synced ${new Date(state.sync.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Ready to sync';
  return <div className={`sync-status ${healthy ? 'healthy' : 'has-errors'}`} title={errors.length ? 'Some sources need attention. Cached tasks remain available.' : statusLabel}>
    {state.sync.syncing ? <LoaderCircle size={14} className="spin" /> : healthy ? <CheckCircle2 size={14} /> : <CloudOff size={14} />}
    <span className="sync-status-label">{statusLabel}</span>
    {errors.length ? <details className="sync-error-details"><summary>View errors</summary><div className="sync-error-popover">{errors.map(([sourceId, message]) => <div className="sync-error-item" key={sourceId}><span><strong>{sourceName(sourceId, state.sources)}</strong><small>{message}</small></span><button type="button" onClick={onRefresh}>Retry</button></div>)}</div></details> : null}
  </div>;
}

function FilterBar({ state, filters, statusOptions, onFilters }: { state: AppState; filters: typeof emptyFilters; statusOptions: string[]; onFilters: (filters: typeof emptyFilters) => void }) {
  return <div className="filter-bar" aria-label="Task filters">
    <label><span>Source</span><select value={filters.sourceId} onChange={(event) => onFilters({ ...filters, sourceId: event.target.value })}><option value="">All sources</option>{state.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
    <label><span>Status</span><select value={filters.status} onChange={(event) => onFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option>{statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
    <label><span>From</span><input type="date" value={filters.from} onChange={(event) => onFilters({ ...filters, from: event.target.value })} /></label>
    <label><span>To</span><input type="date" value={filters.to} onChange={(event) => onFilters({ ...filters, to: event.target.value })} /></label>
    <label className="filter-importance"><span>Importance</span><button type="button" aria-pressed={filters.important} className={filters.important ? 'selected' : ''} onClick={() => onFilters({ ...filters, important: !filters.important })}><Star size={13} fill={filters.important ? 'currentColor' : 'none'} /> Important</button></label>
    <button className="filter-clear" onClick={() => onFilters(emptyFilters)}>Clear</button>
  </div>;
}

function OverdueToggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="overdue-toggle"><input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>Show overdue</span></label>;
}

function TaskListHeader({ activeView, count, showOverdue, onShowOverdue }: { activeView: ListId; count: number; showOverdue: boolean; onShowOverdue: (checked: boolean) => void }) {
  const list = listDefinitions.find((item) => item.id === activeView);
  return <div className="list-heading"><div><h2>{list?.label}</h2><span>{count} {count === 1 ? 'task' : 'tasks'}</span></div><div className="list-heading-controls">{activeView === 'today' ? <OverdueToggle checked={showOverdue} onChange={onShowOverdue} /> : null}<span className="sort-note"><ArrowDownToLine size={14} /> Due date</span></div></div>;
}

function TaskList({ state, tasks, activeView, selectedTaskId, onSelect, onToggleStar, onToggleComplete }: { state: AppState; tasks: Task[]; activeView: ListId; selectedTaskId: string | null; onSelect: (task: Task) => void; onToggleStar: (task: Task) => void; onToggleComplete: (task: Task) => void }) {
  if (!tasks.length) return <EmptyTaskState activeView={activeView} hasSources={state.sources.length > 0} />;
  const sections = [{ label: '', tasks }];
  return <div className="task-list">{sections.map((section) => <section key={section.label || 'tasks'} className="task-section">{section.label ? <h3>{section.label}</h3> : null}{section.tasks.map((task) => <TaskRow key={task.id} state={state} task={task} selected={selectedTaskId === task.id} onSelect={onSelect} onToggleStar={onToggleStar} onToggleComplete={onToggleComplete} />)}</section>)}</div>;
}

function EmptyTaskState({ activeView, hasSources }: { activeView: ListId; hasSources: boolean }) {
  const copy = activeView === 'today' ? 'Nothing due today.' : activeView === 'upcoming' ? 'Your upcoming tasks will appear here.' : activeView === 'completed' ? 'Completed tasks will collect here.' : activeView === 'important' ? 'Star a task to keep it close.' : hasSources ? 'No tasks match these filters.' : 'Connect a Notion database to bring in your tasks.';
  return <div className="empty-state"><div className="empty-icon"><ListTodo size={22} /></div><strong>{copy}</strong><span>{hasSources ? 'Try another list or clear your filters.' : 'Your data stays in Notion and is cached locally for offline reading.'}</span></div>;
}

function TaskRow({ state, task, selected, onSelect, onToggleStar, onToggleComplete }: { state: AppState; task: Task; selected: boolean; onSelect: (task: Task) => void; onToggleStar: (task: Task) => void; onToggleComplete: (task: Task) => void }) {
  const due = formatTaskDue(task);
  const source = sourceForTask(task, state.sources);
  const editable = state.sync.onlineSources.includes(task.sourceId);
  const statusLabel = task.status.trim() || (task.completed ? 'Completed' : 'No status');
  return <div className={`task-row ${selected ? 'selected' : ''} ${task.completed ? 'completed' : ''}`}>
    <button className={`check-button ${task.completed ? 'checked' : ''}`} aria-label={task.completed ? `Reopen ${task.name}` : `Complete ${task.name}`} disabled={!editable} onClick={() => onToggleComplete(task)}>{task.completed ? <Check size={14} strokeWidth={3} /> : null}</button>
    <button className="task-main" onClick={() => onSelect(task)} aria-label={`Open ${task.name}`}><span className="task-name">{task.name || 'Untitled task'}</span><span className={`task-meta ${due.tone}`}><Clock3 size={13} />{due.label}<span className={`task-status ${taskStatusTone(task.status, task.completed)}`} title={`Status: ${statusLabel}`}><span className="task-status-dot" aria-hidden="true" />{statusLabel}</span><span className={`source-badge ${sourceColor(task.sourceId, source?.color)}`}>{source?.name ?? 'Source unavailable'}</span></span></button>
    <button className={`star-button ${state.stars.includes(task.id) ? 'starred' : ''}`} aria-label={state.stars.includes(task.id) ? `Remove ${task.name} from important` : `Mark ${task.name} important`} onClick={() => onToggleStar(task)}>{state.stars.includes(task.id) ? <Star size={16} fill="currentColor" /> : <Star size={16} />}</button>
  </div>;
}

function QuickAdd({ state, initialSourceId, onDraft, compact = false }: { state: AppState; initialSourceId: string; onDraft: (sourceId: string, name: string) => void; compact?: boolean }) {
  const [newTask, setNewTask] = useState('');
  const [sourceId, setSourceId] = useState(initialSourceId);
  useEffect(() => {
    setSourceId(initialSourceId || state.sources[0]?.id || '');
  }, [initialSourceId]);
  useEffect(() => {
    if (!sourceId || !state.sources.some((source) => source.id === sourceId)) setSourceId(initialSourceId || state.sources[0]?.id || '');
  }, [initialSourceId, sourceId, state.sources]);
  const online = Boolean(sourceId && state.sync.onlineSources.includes(sourceId));
  function openDraft() {
    if (!sourceId || !state.sources.length) return;
    onDraft(sourceId, newTask);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!sourceId) return;
    openDraft();
  }
  return <form className={`quick-add ${compact ? 'compact-quick-add' : 'full-quick-add'}`} onSubmit={submit}><Plus size={16} /><input aria-label="Quick add task" placeholder={online ? 'Add a task' : state.sources.length ? 'Source offline' : 'Connect a source to add tasks'} value={newTask} onChange={(event) => { const value = event.target.value; setNewTask(value); if (sourceId) onDraft(sourceId, value); }} onFocus={openDraft} disabled={!state.sources.length} /><select aria-label="Task source" value={sourceId} onChange={(event) => { setSourceId(event.target.value); onDraft(event.target.value, newTask); }} disabled={!state.sources.length}>{state.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select><button className="button button-primary" type="submit" disabled={!sourceId}>{<Plus size={14} />}Add</button></form>;
}

function CompactView({ state, activeView, onView, sourceId, onSource, tasks, query, onQuery, onToggleStar, onToggleComplete, onSelect, onDraft, onExpand, onRefresh, onShowOverdue }: { state: AppState; activeView: ListId; onView: (view: ListId) => void; sourceId: string; onSource: (sourceId: string) => void; tasks: Task[]; query: string; onQuery: (value: string) => void; onToggleStar: (task: Task) => void; onToggleComplete: (task: Task) => void; onSelect: (task: Task) => void; onDraft: (sourceId: string, name: string) => void; onExpand: () => void; onRefresh: () => void; onShowOverdue: (checked: boolean) => void }) {
  return <div className="compact-shell">
    <header className="compact-toolbar"><div className="brand compact-brand"><div className="brand-mark"><Check size={16} strokeWidth={3} /></div><strong>Notion Tasks</strong></div><SyncStatus state={state} onRefresh={onRefresh} /><select aria-label="Current list" value={activeView} onChange={(event) => onView(event.target.value as ListId)}>{listDefinitions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><select aria-label="Current source" value={sourceId} onChange={(event) => onSource(event.target.value)}><option value="">All sources</option>{state.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select><button className="icon-button" aria-label="Refresh" onClick={onRefresh}><RefreshCw size={15} /></button><button className="icon-button" aria-label="Expand Notion Tasks" onClick={onExpand}><PanelLeft size={15} /></button></header>
    <div className="compact-search"><Search size={15} /><input aria-label="Search compact tasks" placeholder="Search" value={query} onChange={(event) => onQuery(event.target.value)} /></div>
    {activeView === 'today' ? <div className="compact-list-options"><OverdueToggle checked={Boolean(state.settings.showOverdue)} onChange={onShowOverdue} /></div> : null}
    <QuickAdd state={state} initialSourceId={sourceId || state.settings.lastSourceId || state.sources[0]?.id || ''} onDraft={onDraft} compact />
    <div className="compact-list">{tasks.map((task) => <TaskRow key={task.id} state={state} task={task} selected={false} onSelect={onSelect} onToggleStar={onToggleStar} onToggleComplete={onToggleComplete} />)}{!tasks.length ? <EmptyTaskState activeView={activeView} hasSources={state.sources.length > 0} /> : null}</div>
  </div>;
}

function DraftPanel({ state, draft, onCreate, onCreated, onClose, onNotice }: { state: AppState; draft: DraftTask; onCreate: (sourceId: string, name: string, due?: TaskDate, favorite?: boolean) => Promise<Task | null>; onCreated: (task: Task) => void; onClose: () => void; onNotice: (message: string) => void }) {
  const [title, setTitle] = useState(draft.name);
  const [sourceId, setSourceId] = useState(draft.sourceId || state.settings.lastSourceId || state.sources[0]?.id || '');
  const [date, setDate] = useState(draft.dueDate);
  const [time, setTime] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = Boolean(sourceId && state.sync.onlineSources.includes(sourceId));

  useEffect(() => {
    setTitle(draft.name);
    setSourceId(draft.sourceId || state.settings.lastSourceId || state.sources[0]?.id || '');
    setDate(draft.dueDate);
    setTime('');
    setFavorite(false);
    setError(null);
  }, [draft]);

  async function save() {
    if (!title.trim()) {
      setError('Add a task name before saving.');
      return;
    }
    if (!sourceId) {
      setError('Choose a source before saving.');
      return;
    }
    if (!online) {
      setError('This source is offline. Reconnect it before adding tasks.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const due = date ? taskDateFromInputs(date, time, null) : undefined;
      const created = await onCreate(sourceId, title, due, favorite);
      if (created) onCreated(created);
      else setError('The task could not be created. Try again.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to add task.');
      onNotice(reason instanceof Error ? reason.message : 'Unable to add task.');
    } finally {
      setSaving(false);
    }
  }

  return <aside className="detail-panel draft-panel"><div className="detail-header"><span>New task</span><button className="icon-button" aria-label="Close new task" onClick={onClose}><X size={17} /></button></div><div className="detail-scroll">
    <label className="detail-title"><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Task title" placeholder="Task name" /></label>
    <div className="detail-property"><div className="property-icon"><Calendar size={16} /></div><div className="property-content"><span className="property-label">Due date</span><div className="date-edit-row"><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /><input type="time" value={time} disabled={!date} onChange={(event) => setTime(event.target.value)} /><button className="clear-date" disabled={!date} onClick={() => { setDate(''); setTime(''); }}>Clear</button></div><span className="property-hint">Optional · saved as your local time</span></div></div>
    <div className="detail-property"><div className={`property-icon ${favorite ? 'favorite-icon' : ''}`}><Star size={16} fill={favorite ? 'currentColor' : 'none'} /></div><label className="property-content favorite-option"><span className="favorite-option-main"><span className="property-label">Favorite</span><input aria-label="Favorite this task" type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} disabled={saving} /></span><span className="property-hint">Keep this task in your Important list.</span></label></div>
    <div className="detail-property"><div className="property-icon"><Database size={16} /></div><div className="property-content"><span className="property-label">Source</span><select aria-label="New task source" value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={saving || !state.sources.length}>{state.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select><span className="property-hint">{online ? 'Online · ready to save' : 'Offline · reconnect before saving'}</span></div></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="detail-footer"><button className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving || !title.trim() || !online} onClick={() => void save()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{saving ? 'Saving…' : 'Create task'}</button></div>
  </div></aside>;
}

function DetailPanel({ state, task, onState, onClose, onNotice }: { state: AppState; task: Task; onState: Dispatch<SetStateAction<AppState | null>>; onClose: () => void; onNotice: (message: string) => void }) {
  const source = sourceForTask(task, state.sources);
  const [baseline, setBaseline] = useState<Task>(task);
  const [title, setTitle] = useState(task.name);
  const [date, setDate] = useState(dateInputValue(task.due));
  const [time, setTime] = useState(timeInputValue(task.due));
  const [status, setStatus] = useState(task.status);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Task | null>(null);
  const editable = state.sync.onlineSources.includes(task.sourceId);
  const options = sourceStatusOptions(source);
  const baselineDate = dateInputValue(baseline.due);
  const baselineTime = timeInputValue(baseline.due);
  const dirty = title !== baseline.name || status !== baseline.status || date !== baselineDate || time !== baselineTime;

  useEffect(() => {
    if (task.id !== baseline.id) {
      setBaseline(task);
      setTitle(task.name);
      setDate(dateInputValue(task.due));
      setTime(timeInputValue(task.due));
      setStatus(task.status);
      setConflict(null);
      return;
    }
    if (!taskVersionChanged(task, baseline)) return;
    if (!dirty) {
      setBaseline(task);
      setTitle(task.name);
      setDate(dateInputValue(task.due));
      setTime(timeInputValue(task.due));
      setStatus(task.status);
      setConflict(null);
    } else {
      setConflict(task);
    }
  }, [task.id, task.name, task.status, task.completed, task.lastEdited, task.due?.start, task.due?.end, task.due?.time_zone, baseline, dirty]);

  function reloadCurrent() {
    if (!conflict) return;
    setBaseline(conflict);
    setTitle(conflict.name);
    setDate(dateInputValue(conflict.due));
    setTime(timeInputValue(conflict.due));
    setStatus(conflict.status);
    setConflict(null);
    onNotice('Current Notion values loaded.');
  }

  function reviewAndKeepDraft() {
    if (!conflict) return;
    setBaseline(conflict);
    setConflict(null);
    onNotice('Current values reviewed. Save again explicitly to keep your draft.');
  }

  async function save() {
    if (!apiAvailable() || !editable || !dirty || !title.trim() || conflict) return;
    const changes: TaskChanges = {};
    if (title !== baseline.name) changes.name = title.trim();
    if (status !== baseline.status) changes.status = status;
    if (date !== baselineDate || time !== baselineTime) changes.due = taskDateFromInputs(date, time, baseline.due);
    setSaving(true);
    try {
      const result = await window.desktop.updateTask(task.id, changes, baseline);
      if (result.conflict) {
        onState((current) => current ? { ...current, tasks: current.tasks.map((item) => item.id === result.task.id ? result.task : item) } : current);
        setConflict(result.task);
        onNotice('This task changed in Notion. Review the current values before saving again.');
      } else {
        onState((current) => current ? { ...current, tasks: current.tasks.map((item) => item.id === result.task.id ? result.task : item) } : current);
        setBaseline(result.task);
        setTitle(result.task.name);
        setDate(dateInputValue(result.task.due));
        setTime(timeInputValue(result.task.due));
        setStatus(result.task.status);
        setConflict(null);
        onNotice('Task saved.');
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Unable to save task.');
    } finally {
      setSaving(false);
    }
  }

  return <aside className="detail-panel"><div className="detail-header"><span>Task details</span><button className="icon-button" aria-label="Close task details" onClick={onClose}><X size={17} /></button></div><div className="detail-scroll">
    {conflict ? <div className="conflict-card"><div><strong>Changed in Notion</strong><span>Current: “{conflict.name}” · {conflict.status || 'No status'}</span></div><div className="conflict-actions"><button className="button button-secondary" onClick={reloadCurrent}>Reload current</button><button className="button button-secondary" onClick={reviewAndKeepDraft}>Keep my draft</button></div><span className="muted">Save is paused until you review the current values.</span></div> : null}
    <label className="detail-title"><input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!editable} aria-label="Task title" /></label>
    <div className="detail-property"><div className="property-icon"><Calendar size={16} /></div><div className="property-content"><span className="property-label">Due date</span><div className="date-edit-row"><input type="date" value={date} disabled={!editable} onChange={(event) => setDate(event.target.value)} /><input type="time" value={time} disabled={!editable || !date} onChange={(event) => setTime(event.target.value)} /><button className="clear-date" disabled={!editable || !date} onClick={() => { setDate(''); setTime(''); }}>Clear</button></div><span className="property-hint">{baseline.due?.end ? `Range ends ${displayDateTime({ start: baseline.due.end, end: null })}` : baseline.due?.time_zone ? `Timezone: ${baseline.due.time_zone}` : 'Local time'}</span></div></div>
    <div className="detail-property"><div className="property-icon"><Flag size={16} /></div><div className="property-content"><span className="property-label">Status</span>{options.length ? <select value={status} disabled={!editable} onChange={(event) => setStatus(event.target.value)}>{!options.some((option) => option.name === status) ? <option value={status}>{status || 'Current status'}</option> : null}{options.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select> : <input value={status} disabled={!editable} onChange={(event) => setStatus(event.target.value)} placeholder="No status" />}</div></div>
    <div className="detail-property"><div className="property-icon"><Database size={16} /></div><div className="property-content"><span className="property-label">Source</span><span className="property-value">{source?.name ?? 'Source unavailable'}</span><span className="property-hint">{editable ? 'Online · changes sync to Notion' : 'Offline · read-only until the source reconnects'}</span></div></div>
    <div className="detail-footer"><button className="button button-secondary open-notion" onClick={() => apiAvailable() && void window.desktop.openNotion(task.id)}><ExternalLink size={15} /> Open in Notion</button>{editable ? <button className="button button-primary" disabled={!dirty || saving || Boolean(conflict)} onClick={() => void save()}>{saving ? <LoaderCircle size={15} className="spin" /> : null}{saving ? 'Saving…' : 'Save changes'}</button> : <span className="offline-note"><CloudOff size={14} /> Reconnect to edit</span>}</div>
  </div></aside>;
}

function SettingsView({ state, section, onSection, onState, onNotice }: { state: AppState; section: 'connection' | 'sources' | 'preferences'; onSection: (section: 'connection' | 'sources' | 'preferences') => void; onState: (state: AppState) => void; onNotice: (message: string) => void }) {
  return <div className="settings-layout"><div className="settings-nav"><p className="nav-label">Workspace</p><button className={section === 'connection' ? 'active' : ''} onClick={() => onSection('connection')}><ShieldCheck size={17} />Connection</button><button className={section === 'sources' ? 'active' : ''} onClick={() => onSection('sources')}><Database size={17} />Sources</button><button className={section === 'preferences' ? 'active' : ''} onClick={() => onSection('preferences')}><Settings size={17} />Preferences</button></div><div className="settings-content">{section === 'connection' ? <ConnectionSettings state={state} onState={onState} onNotice={onNotice} /> : null}{section === 'sources' ? <SourcesSettings state={state} onState={onState} onNotice={onNotice} /> : null}{section === 'preferences' ? <PreferenceSettings state={state} onState={onState} onNotice={onNotice} /> : null}</div></div>;
}

function ConnectionSettings({ state, onState, onNotice }: { state: AppState; onState: (state: AppState) => void; onNotice: (message: string) => void }) {
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  async function connect() {
    if (!apiAvailable() || !token.trim()) return;
    setConnecting(true);
    try { onState(await window.desktop.connect(token.trim())); setToken(''); onNotice('Connected to Notion.'); } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to connect to Notion.'); } finally { setConnecting(false); }
  }
  async function disconnect() {
    if (!apiAvailable()) return;
    try { onState(await window.desktop.disconnect()); onNotice('Notion disconnected.'); } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to disconnect.'); }
  }
  return <section className="settings-section"><div className="settings-intro"><span className="eyebrow">Connection</span><h2>{state.connected ? 'Your Notion workspace is connected' : 'Connect Notion to get started'}</h2><p>Notion Tasks reads the databases you explicitly share with your internal integration. Tokens are held by the desktop connection and are never persisted in the renderer.</p></div>{state.connected ? <div className="connected-card"><div className="connected-icon"><CheckCircle2 size={21} /></div><div><strong>Connected</strong><span>{state.sources.length} shared database{state.sources.length === 1 ? '' : 's'} available</span></div><button className="button button-secondary" onClick={() => void disconnect()}><Unplug size={15} /> Disconnect</button></div> : <div className="connect-card"><div className="step"><span>1</span><div><strong>Create an internal integration</strong><p>In Notion, open Settings → Connections → Develop or manage integrations, then create an internal integration.</p></div></div><div className="step"><span>2</span><div><strong>Copy the integration token</strong><p>Paste it here. Notion Tasks keeps it in the desktop connection and clears the form after connecting.</p><div className="token-input"><ShieldCheck size={16} /><input aria-label="Notion integration token" type="password" autoComplete="off" placeholder="secret_…" value={token} onChange={(event) => setToken(event.target.value)} /><button className="button button-primary" disabled={connecting || !token.trim()} onClick={() => void connect()}>{connecting ? 'Connecting…' : 'Connect'}</button></div></div></div><div className="step"><span>3</span><div><strong>Share each database with the integration</strong><p>Open the database menu in Notion, choose Connections, connect your integration, then add the database link as a source.</p></div></div></div>}</section>;
}

function SourcesSettings({ state, onState, onNotice }: { state: AppState; onState: (state: AppState) => void; onNotice: (message: string) => void }) {
  const [url, setUrl] = useState('');
  const [candidates, setCandidates] = useState<SourceCandidate[]>([]);
  const [candidate, setCandidate] = useState<SourceCandidate | null>(null);
  const [mapping, setMapping] = useState<SourceConfig['mapping']>({ title: '', due: null, status: '', complete: '', reopen: '' });
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingColor, setSavingColor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function resolve() {
    if (!apiAvailable() || !url.trim()) return;
    setResolving(true); setError(null);
    try { const next = await window.desktop.resolveSource(url.trim()); setCandidates(next); if (next.length === 1) choose(next[0]); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to resolve that Notion URL.'); } finally { setResolving(false); }
  }
  function choose(next: SourceCandidate) { setCandidate(next); setCandidates([]); setEditingId(state.sources.find((source) => source.databaseId === next.databaseId)?.id ?? null); setMapping(autoMapping(next)); }
  function remap(source: SourceConfig) { setCandidate(source); setEditingId(source.id); setMapping(source.mapping); setCandidates([]); setError(null); }
  async function save() {
    if (!apiAvailable() || !candidate || !mapping.title || !mapping.status) { setError('Choose a title and status property before saving.'); return; }
    setSaving(true); setError(null);
    try {
      const existing = state.sources.find((source) => source.id === candidate.id || source.databaseId === candidate.databaseId);
      const next = await window.desktop.saveSource({ ...candidate, ...(existing?.color ? { color: existing.color } : {}), mapping });
      onState(next); setCandidate(null); setUrl(''); setEditingId(null); onNotice('Source saved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save this source.'); } finally { setSaving(false); }
  }
  async function changeColor(source: SourceConfig, color: SourceColor) {
    if (!apiAvailable() || sourceColor(source.id, source.color) === color) return;
    setSavingColor(source.id);
    try { onState(await window.desktop.setSourceColor(source.id, color)); onNotice(`${source.name} tag color updated.`); }
    catch (reason) { onNotice(reason instanceof Error ? reason.message : 'Unable to update the tag color.'); }
    finally { setSavingColor(null); }
  }
  async function remove(source: SourceConfig) {
    if (!apiAvailable() || !window.confirm(`Remove “${source.name}” from Notion Tasks?`)) return;
    try { onState(await window.desktop.removeSource(source.id)); onNotice('Source removed.'); } catch (reason) { onNotice(reason instanceof Error ? reason.message : 'Unable to remove this source.'); }
  }
  const statusProperty = candidate?.properties.find((property) => property.id === mapping.status);
  return <section className="settings-section"><div className="settings-intro"><span className="eyebrow">Sources</span><h2>Choose the databases you work from</h2><p>Paste a Notion database URL to discover available properties. Mapping uses property IDs so renamed columns stay connected.</p></div><div className="add-source-card"><div className="source-url-row"><div className="url-input"><FolderOpen size={16} /><input aria-label="Notion database URL" placeholder="https://www.notion.so/…" value={url} onChange={(event) => setUrl(event.target.value)} /><button className="button button-primary" disabled={resolving || !state.connected || !url.trim()} onClick={() => void resolve()}>{resolving ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{resolving ? 'Resolving…' : 'Add source'}</button></div></div>{!state.connected ? <p className="muted form-note">Connect Notion before adding a database.</p> : null}{error ? <p className="form-error">{error}</p> : null}{candidates.length > 1 ? <div className="candidate-list"><strong>Choose a database</strong>{candidates.map((item) => <button key={item.id} className="candidate" onClick={() => choose(item)}><Database size={16} /><span><b>{item.name}</b><small>{item.properties.length} properties · {item.databaseId}</small></span><ChevronDown size={15} /></button>)}</div> : null}{candidate ? <MappingEditor candidate={candidate} mapping={mapping} setMapping={setMapping} statusProperty={statusProperty} editing={Boolean(editingId)} saving={saving} onSave={() => void save()} onCancel={() => { setCandidate(null); setEditingId(null); }} /> : null}</div><div className="source-cards">{state.sources.map((source) => { const tagColor = sourceColor(source.id, source.color); return <div className="source-card" key={source.id}><div className="source-card-main"><span className={`source-dot ${tagColor}`} /><div><strong>{source.name}</strong><span>{source.databaseId}</span>{state.sync.errors[source.id] ? <em>{state.sync.errors[source.id]}</em> : null}</div></div><div className="source-card-actions"><div className="source-color-picker" role="group" aria-label={`Tag color for ${source.name}`}>{SOURCE_COLORS.map((color) => <button type="button" key={color} className={`source-color-option ${color} ${tagColor === color ? 'selected' : ''}`} aria-label={`Use ${color} tag color`} aria-pressed={tagColor === color} title={`${color[0].toUpperCase()}${color.slice(1)} tag`} disabled={savingColor === source.id} onClick={() => void changeColor(source, color)}><span className={`source-dot ${color}`} /></button>)}</div><button className="button button-secondary" onClick={() => remap(source)}>Remap</button><button className="icon-button danger" aria-label={`Remove ${source.name}`} onClick={() => void remove(source)}><Trash2 size={16} /></button></div></div>; })}{!state.sources.length ? <div className="empty-settings"><Database size={20} /><span>No sources yet. Add a shared Notion database above.</span></div> : null}</div></section>;
}

function MappingEditor({ candidate, mapping, setMapping, statusProperty, editing, saving, onSave, onCancel }: { candidate: SourceCandidate; mapping: SourceConfig['mapping']; setMapping: (mapping: SourceConfig['mapping']) => void; statusProperty?: SourceCandidate['properties'][number]; editing: boolean; saving: boolean; onSave: () => void; onCancel: () => void }) {
  const set = (key: keyof SourceConfig['mapping']) => (value: string) => setMapping({ ...mapping, [key]: value });
  return <div className="mapping-editor"><div className="mapping-heading"><div><span className="eyebrow">{editing ? 'Remap source' : 'Confirm mapping'}</span><strong>{candidate.name}</strong></div><button className="icon-button" aria-label="Cancel mapping" onClick={onCancel}><X size={16} /></button></div><p className="muted">Notion Tasks detected these fields. Confirm the exact properties before syncing.</p><div className="mapping-grid"><label>Title property<select value={mapping.title} onChange={(event) => set('title')(event.target.value)}><option value="">Choose property</option>{candidate.properties.filter((property) => property.type === 'title' || property.type === 'rich_text').map((property) => <option key={property.id} value={property.id}>{property.name} · {property.type}</option>)}</select></label><label>Due date<select value={mapping.due ?? ''} onChange={(event) => setMapping({ ...mapping, due: event.target.value || null })}><option value="">No due date</option>{candidate.properties.filter((property) => property.type === 'date').map((property) => <option key={property.id} value={property.id}>{property.name} · {property.type}</option>)}</select></label><label>Status property<select value={mapping.status} onChange={(event) => set('status')(event.target.value)}><option value="">Choose property</option>{candidate.properties.filter((property) => property.type === 'status' || property.type === 'select').map((property) => <option key={property.id} value={property.id}>{property.name} · {property.type}</option>)}</select></label><label>Complete option<select value={mapping.complete} onChange={(event) => set('complete')(event.target.value)}><option value="">Choose option</option>{statusProperty?.options?.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}<option value="true">true</option><option value="false">false</option></select></label><label>Reopen option<select value={mapping.reopen} onChange={(event) => set('reopen')(event.target.value)}><option value="">Choose option</option>{statusProperty?.options?.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}<option value="true">true</option><option value="false">false</option></select></label></div><div className="mapping-preview"><span>Property preview</span>{candidate.properties.map((property) => <div key={property.id}><code>{property.id}</code><strong>{property.name}</strong><small>{property.type}{property.options?.length ? ` · ${property.options.length} options` : ''}</small></div>)}</div><div className="mapping-actions"><button className="button button-secondary" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : editing ? 'Save remapping' : 'Save source'}</button></div></div>;
}

function PreferenceSettings({ state, onState, onNotice }: { state: AppState; onState: (state: AppState) => void; onNotice: (message: string) => void }) {
  async function update(patch: Partial<AppState['settings']>) { if (!apiAvailable()) return; try { onState(await window.desktop.setSettings(patch)); } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to save preferences.'); } }
  const theme = state.settings.theme ?? 'system';
  const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
    { value: 'system', label: 'System', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ];
  return <section className="settings-section"><div className="settings-intro"><span className="eyebrow">Preferences</span><h2>Shape your workspace</h2><p>These choices are stored by the desktop shell and apply to future launches.</p></div><div className="preference-list"><label className="toggle-row"><span><strong>Always on top</strong><small>Keep the task window above other apps.</small></span><input type="checkbox" checked={state.settings.alwaysOnTop} onChange={(event) => void update({ alwaysOnTop: event.target.checked })} /></label><label className="toggle-row"><span><strong>Launch at login</strong><small>Open Notion Tasks when Windows starts.</small></span><input type="checkbox" checked={state.settings.launchAtLogin} onChange={(event) => void update({ launchAtLogin: event.target.checked })} /></label><div className="theme-row"><span><strong>Appearance</strong><small>Choose light, dark, or follow Windows.</small></span><div className="theme-controls" role="group" aria-label="Appearance">{themeOptions.map(({ value, label, icon: Icon }) => <button type="button" key={value} className={`theme-choice ${theme === value ? 'selected' : ''}`} aria-label={`${label} appearance`} aria-pressed={theme === value} onClick={() => void update({ theme: value })}><Icon size={14} />{label}</button>)}</div></div></div><UpdateSettings /></section>;
}

export default App;
