import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppState, DesktopAPI, SourceConfig, Task } from '../shared/types';
import { toggleStatusForTask } from './utils';

export interface CompletionNotice { token: number; message: string }
export function mergeConfirmedTask(current: Task, confirmed: Task): Task {
  return Date.parse(current.lastEdited) > Date.parse(confirmed.lastEdited) ? current : confirmed;
}
interface Operation { token: number; before: Task; optimistic: Task; confirmed?: Task; undoRequested: boolean; busy: boolean }
interface Callbacks {
  overlay(tasks: Record<string, Task>): void;
  task(task: Task): void;
  notice(notice: CompletionNotice | null): void;
  error(message: string): void;
}

/** Keeps the immediate visual state separate from Notion's acknowledged state. */
export class CompletionController {
  private operations = new Map<number, Operation>();
  private overlays: Record<string, Task> = {};
  private noticeToken: number | null = null;
  private serial = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private api: Pick<DesktopAPI, 'updateTask'>, private callbacks: Callbacks, private undoMs = 8000) {}

  toggle(task: Task, source: SourceConfig | undefined): void {
    if (this.disposed || [...this.operations.values()].some(op => op.before.id === task.id && op.busy)) return;
    const status = toggleStatusForTask(task, source);
    if (!status) { this.callbacks.error('Map complete and reopen options before editing this task.'); return; }
    const token = ++this.serial;
    const op: Operation = { token, before: task, optimistic: { ...task, status, completed: !task.completed }, undoRequested: false, busy: true };
    this.operations.set(token, op);
    this.overlay(task.id, op.optimistic);
    if (this.timer) clearTimeout(this.timer);
    if (this.noticeToken !== null) {
      const old = this.operations.get(this.noticeToken);
      if (old && !old.busy) this.operations.delete(old.token);
    }
    this.noticeToken = token;
    this.callbacks.notice({ token, message: task.completed ? 'Task reopened' : 'Task completed' });
    this.timer = setTimeout(() => this.dismiss(token), this.undoMs);
    void this.save(op);
  }

  undo(token: number): void {
    const op = this.operations.get(token);
    if (!op || op.undoRequested || this.disposed) return;
    op.undoRequested = true;
    this.dismiss(token);
    this.overlay(op.before.id, op.before);
    // The original response supplies the baseline for a serialized reversal.
    if (!op.busy && op.confirmed) { op.busy = true; void this.restore(op); }
  }

  private async save(op: Operation): Promise<void> {
    try {
      const result = await this.api.updateTask(op.before.id, { status: op.optimistic.status }, op.before);
      if (this.disposed) return;
      this.callbacks.task(result.task);
      op.confirmed = result.task;
      if (result.conflict) {
        this.callbacks.error('This task changed in Notion. Its current status has been restored.');
        this.dismiss(op.token);
      } else if (op.undoRequested) {
        await this.restore(op);
        return;
      }
    } catch (error) {
      if (this.disposed) return;
      this.callbacks.error(error instanceof Error ? error.message : 'Could not save the task status.');
      this.dismiss(op.token);
    }
    this.finish(op);
  }

  private async restore(op: Operation): Promise<void> {
    try {
      const result = await this.api.updateTask(op.before.id, { status: op.before.status }, op.confirmed!);
      if (this.disposed) return;
      this.callbacks.task(result.task);
      if (result.conflict) this.callbacks.error('Undo could not be applied because the task changed in Notion.');
    } catch (error) {
      if (!this.disposed) this.callbacks.error(`Could not undo the status change. ${error instanceof Error ? error.message : 'Try again after refreshing.'}`);
    } finally { if (!this.disposed) this.finish(op); }
  }

  private overlay(id: string, task?: Task): void {
    if (task) this.overlays = { ...this.overlays, [id]: task };
    else { this.overlays = { ...this.overlays }; delete this.overlays[id]; }
    this.callbacks.overlay(this.overlays);
  }

  private finish(op: Operation): void {
    op.busy = false;
    this.overlay(op.before.id);
    if (this.noticeToken !== op.token || op.undoRequested) this.operations.delete(op.token);
  }

  dismiss(token: number): void {
    if (this.noticeToken === token) {
      this.noticeToken = null;
      if (this.timer) clearTimeout(this.timer);
      this.callbacks.notice(null);
    }
    const op = this.operations.get(token);
    if (op && !op.busy && !op.undoRequested) this.operations.delete(token);
  }

  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.operations.clear(); }
}

export function useTaskCompletion(server: AppState | null, setServer: Dispatch<SetStateAction<AppState | null>>, onError: (message: string) => void) {
  const [overlays, setOverlays] = useState<Record<string, Task>>({});
  const [notice, setNotice] = useState<CompletionNotice | null>(null);
  const controller = useRef<CompletionController | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    const current = new CompletionController(window.desktop, {
      overlay: setOverlays, notice: setNotice, error: message => errorRef.current(message),
      task: task => setServer(state => state ? { ...state, tasks: state.tasks.map(item => item.id === task.id && item.sourceId === task.sourceId ? mergeConfirmedTask(item, task) : item) } : state),
    });
    controller.current = current;
    return () => { current.dispose(); controller.current = null; };
  }, [setServer]);
  const state = useMemo(() => server ? { ...server, tasks: server.tasks.map(task => overlays[task.id] ?? task) } : null, [server, overlays]);
  return {
    state, completionNotice: notice,
    toggleComplete(task: Task) {
      if (!server?.sync.onlineSources.includes(task.sourceId)) { onError('This source is offline. Reconnect before editing tasks.'); return; }
      controller.current?.toggle(task, server.sources.find(source => source.id === task.sourceId));
    },
    undoCompletion: () => { if (notice) controller.current?.undo(notice.token); },
    dismissCompletion: () => { if (notice) controller.current?.dismiss(notice.token); },
  };
}
