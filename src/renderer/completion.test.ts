import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletionController, mergeConfirmedTask } from './completion';
import type { SourceConfig, Task, UpdateResult } from '../shared/types';

const source: SourceConfig = { id: 's', databaseId: 'db', name: 'Tasks', properties: [
  { id: 'status', name: 'Status', type: 'status', options: [{ id: 'working', name: 'In progress' }, { id: 'done', name: 'Done' }, { id: 'open', name: 'Not started' }] },
], mapping: { title: 'title', due: null, status: 'status', complete: 'done', reopen: 'open' } };
const task: Task = { id: 't', sourceId: 's', name: 'Test task', url: '', due: null, status: 'In progress', completed: false, lastEdited: 'first' };
const completed = { ...task, status: 'Done', completed: true, lastEdited: 'second' };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function setup(updateTask: ReturnType<typeof vi.fn>) {
  const callbacks = { overlay: vi.fn(), task: vi.fn(), notice: vi.fn(), error: vi.fn() };
  return { callbacks, controller: new CompletionController({ updateTask } as any, callbacks) };
}
afterEach(() => vi.useRealTimers());

describe('optimistic task completion', () => {
  it('does not overwrite newer synchronized data with an older completion response', () => {
    const newer = { ...task, name: 'Newer task', lastEdited: '2026-10-21T17:01:00Z' };
    expect(mergeConfirmedTask(newer, { ...completed, lastEdited: '2026-10-21T17:00:00Z' })).toBe(newer);
  });
  it('updates the visual state before Notion acknowledges the write', async () => {
    const pending = deferred<UpdateResult>();
    const update = vi.fn(() => pending.promise);
    const { controller, callbacks } = setup(update);
    controller.toggle(task, source);
    expect(callbacks.overlay).toHaveBeenLastCalledWith({ t: expect.objectContaining({ completed: true, status: 'Done' }) });
    expect(callbacks.notice).toHaveBeenCalledWith({ token: 1, message: 'Task completed' });
    expect(callbacks.task).not.toHaveBeenCalled();
    pending.resolve({ task: completed });
    await vi.waitFor(() => expect(callbacks.task).toHaveBeenCalledWith(completed));
    expect(callbacks.overlay).toHaveBeenLastCalledWith({});
    controller.dispose();
  });

  it('undoes immediately while the initial save is pending, then restores the exact previous status', async () => {
    const pending = deferred<UpdateResult>();
    const update = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce({ task });
    const { controller, callbacks } = setup(update);
    controller.toggle(task, source);
    controller.undo(1);
    expect(callbacks.overlay).toHaveBeenLastCalledWith({ t: task });
    expect(update).toHaveBeenCalledTimes(1);
    pending.resolve({ task: completed });
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]).toEqual([task.id, { status: 'In progress' }, completed]);
    controller.dispose();
  });

  it('allows undo after the initial save has completed', async () => {
    const update = vi.fn().mockResolvedValueOnce({ task: completed }).mockResolvedValueOnce({ task });
    const { controller, callbacks } = setup(update);
    controller.toggle(task, source);
    await vi.waitFor(() => expect(callbacks.task).toHaveBeenCalledWith(completed));
    controller.undo(1);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(callbacks.task).toHaveBeenLastCalledWith(task);
    controller.dispose();
  });

  it('rolls back failed writes and clears Undo', async () => {
    const { controller, callbacks } = setup(vi.fn().mockRejectedValue(new Error('Network unavailable')));
    controller.toggle(task, source);
    await vi.waitFor(() => expect(callbacks.error).toHaveBeenCalledWith('Network unavailable'));
    expect(callbacks.overlay).toHaveBeenLastCalledWith({});
    expect(callbacks.notice).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });

  it('uses the current task on conflict and never blindly reverts it', async () => {
    const changed = { ...task, status: 'Not started' };
    const update = vi.fn().mockResolvedValue({ task: changed, conflict: true });
    const { controller, callbacks } = setup(update);
    controller.toggle(task, source);
    controller.undo(1);
    await vi.waitFor(() => expect(callbacks.task).toHaveBeenCalledWith(changed));
    expect(update).toHaveBeenCalledTimes(1);
    expect(callbacks.error).toHaveBeenCalled();
    controller.dispose();
  });

  it('prevents repeat writes for the same task while a save is pending', () => {
    const update = vi.fn(() => new Promise(() => {}));
    const { controller } = setup(update);
    controller.toggle(task, source);
    controller.toggle(completed, source);
    expect(update).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('expires Undo after eight seconds', async () => {
    vi.useFakeTimers();
    const update = vi.fn().mockResolvedValue({ task: completed });
    const { controller, callbacks } = setup(update);
    controller.toggle(task, source);
    await vi.advanceTimersByTimeAsync(8000);
    expect(callbacks.notice).toHaveBeenLastCalledWith(null);
    controller.undo(1);
    expect(update).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
