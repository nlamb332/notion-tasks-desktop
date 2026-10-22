import { describe, expect, it } from 'vitest';
import type { SourceConfig, Task } from '../shared/types';
import {
  autoMapping,
  belongsToList,
  dateInputValue,
  filterTasks,
  listCounts,
  sortTasks,
  taskDateFromInputs,
  taskStart,
  timeInputValue,
  toggleStatusForTask,
} from './utils';

process.env.TZ = 'America/Chicago';

const task = (id: string, due: string | null, completed = false, name = id): Task => ({
  id,
  sourceId: 'source',
  name,
  url: '',
  due: due ? { start: due, end: null } : null,
  status: completed ? 'Done' : 'Not started',
  completed,
  lastEdited: '2026-10-21T12:00:00.000Z',
});

const source = (mapping: SourceConfig['mapping'] = { title: 'title', due: 'due', status: 'status', complete: 'done', reopen: 'open' }): SourceConfig => ({
  id: 'source',
  databaseId: 'database',
  name: 'Tasks',
  properties: [
    { id: 'title', name: 'Task', type: 'title' },
    { id: 'due', name: 'Due Date', type: 'date' },
    { id: 'status', name: 'Status', type: 'select', options: [{ id: 'done', name: 'Done' }, { id: 'open', name: 'Not started' }, { id: 'progress', name: 'In progress' }] },
  ],
  mapping,
});

describe('renderer date and task helpers', () => {
  it('treats date-only Notion values as local calendar dates', () => {
    const due = task('a', '2026-10-21');
    const parsed = taskStart(due);
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(9);
    expect(parsed?.getDate()).toBe(21);
    expect(dateInputValue(due.due)).toBe('2026-10-21');
    expect(timeInputValue(due.due)).toBe('');
  });

  it('resolves IANA wall-clock times before projecting them into local time', () => {
    const due = { ...task('tokyo', '2026-10-22T00:30:00'), due: { start: '2026-10-22T00:30:00', end: null, time_zone: 'Asia/Tokyo' } };
    const parsed = taskStart(due);
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(9);
    expect(parsed?.getDate()).toBe(21);
    expect(dateInputValue(due.due)).toBe('2026-10-21');
    expect(timeInputValue(due.due)).toBe('10:30');
  });

  it('shows only exact local Today tasks and excludes completed tasks from active lists', () => {
    const reference = new Date(2026, 9, 21, 12, 0);
    expect(belongsToList(task('today', '2026-10-21'), 'today', [], reference)).toBe(true);
    expect(belongsToList(task('overdue', '2026-10-20'), 'today', [], reference)).toBe(false);
    expect(belongsToList(task('done', '2026-10-21', true), 'all', [], reference)).toBe(false);
    expect(belongsToList(task('done', '2026-10-21', true), 'important', ['done'], reference)).toBe(false);
    expect(belongsToList(task('done', '2026-10-21', true), 'completed', [], reference)).toBe(true);
  });

  it('optionally includes overdue tasks in Today while retaining filters and other list semantics', () => {
    const reference = new Date(2026, 9, 21, 12);
    const tasks = [task('today', '2026-10-21'), task('overdue', '2026-10-20'), task('future', '2026-10-22'), task('undated', null), task('done', '2026-10-20', true)];
    const filters = { sourceId: '', status: '', from: '', to: '', important: false };
    const ids = (list: 'today' | 'upcoming', enabled: boolean, query = '') => filterTasks(tasks, list, [], filters, query, [], reference, enabled).map(t => t.id);
    expect(ids('today', false)).toEqual(['today']);
    expect(ids('today', true)).toEqual(['overdue', 'today']);
    expect(ids('today', true, 'overdue')).toEqual(['overdue']);
    expect(ids('upcoming', true)).toEqual(ids('upcoming', false));
    expect(filterTasks(tasks, 'today', [], { ...filters, from: '2026-10-21' }, '', [], reference, true).map(t => t.id)).toEqual(['today']);
    expect(listCounts({ tasks, stars: [] }, false, reference).today).toBe(1);
    expect(listCounts({ tasks, stars: [] }, true, reference).today).toBe(2);
  });

  it('preserves duration when a due range is moved past its original end', () => {
    const previous = { start: '2026-10-21T09:30:00-05:00', end: '2026-10-21T10:00:00-05:00', time_zone: 'America/Chicago' };
    expect(taskDateFromInputs('2026-10-22', '10:15', previous)).toEqual({ start: '2026-10-22T15:15:00.000Z', end: '2026-10-22T15:45:00.000Z' });
    expect(taskDateFromInputs('2026-10-22', '', previous)).toEqual({ start: '2026-10-22', end: '2026-10-22' });
  });

  it('edits a foreign offset as local wall time instead of reusing its old offset', () => {
    const previous = { start: '2026-10-21T09:30:00+01:00', end: '2026-10-21T10:00:00+01:00', time_zone: 'Europe/London' };
    expect(taskDateFromInputs('2026-10-22', '10:15', previous)).toEqual({ start: '2026-10-22T15:15:00.000Z', end: '2026-10-22T15:45:00.000Z' });
  });

  it('normalizes an invalid mixed range without creating end-before-start', () => {
    const previous = { start: '2026-10-21T09:30:00', end: '2026-10-21', time_zone: 'Europe/London' };
    expect(taskDateFromInputs('2026-10-22', '10:15', previous)).toEqual({ start: '2026-10-22T15:15:00.000Z', end: '2026-10-22T15:15:00.000Z' });
  });

  it('moves date-only ranges by calendar days across daylight-saving boundaries', () => {
    expect(taskDateFromInputs('2026-11-01', '', { start: '2026-10-20', end: '2026-10-23' })).toEqual({ start: '2026-11-01', end: '2026-11-04' });
  });

  it('auto maps exact Status and prefers Not started when reopening', () => {
    const candidate = source({ title: '', due: null, status: '', complete: '', reopen: '' });
    expect(autoMapping(candidate).status).toBe('status');
    expect(autoMapping(candidate).complete).toBe('done');
    expect(autoMapping(candidate).reopen).toBe('open');
  });

  it('auto maps checkbox status values to true and false', () => {
    const candidate = { ...source(), properties: [{ id: 'title', name: 'Task', type: 'title' }, { id: 'done', name: 'Done', type: 'checkbox' }] };
    expect(autoMapping(candidate).status).toBe('done');
    expect(autoMapping(candidate).complete).toBe('true');
    expect(autoMapping(candidate).reopen).toBe('false');
  });

  it('sorts by due date, keeps undated items last, then sorts names', () => {
    const result = sortTasks([task('undated', null), task('later', '2026-10-23'), task('early', '2026-10-21'), task('also undated', null)]);
    expect(result.map((item) => item.id)).toEqual(['early', 'later', 'also undated', 'undated']);
  });

  it('uses mapped status values and boolean fallback values for checkbox updates', () => {
    expect(toggleStatusForTask(task('open', '2026-10-21'), source())).toBe('Done');
    expect(toggleStatusForTask(task('done', '2026-10-21', true), source())).toBe('Not started');
    expect(toggleStatusForTask(task('open', null), source({ title: 'title', due: null, status: 'missing', complete: '', reopen: '' }))).toBe('true');
  });
});
