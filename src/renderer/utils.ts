import type { AppState, SourceConfig, Task, TaskDate } from '../shared/types';
import { DateTime } from 'luxon';

export type ListId = 'today' | 'upcoming' | 'all' | 'important' | 'completed';

export interface TaskFilters {
  sourceId: string;
  status: string;
  from: string;
  to: string;
  important: boolean;
}

const dayStart = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());
const dayEnd = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1);

export function taskStart(task: Task): Date | null {
  if (!task.due?.start) return null;
  const parsed = parseTaskDate(task.due.start, task.due.time_zone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function dateInputValue(date: TaskDate): string {
  if (!date?.start) return '';
  const value = taskDateForInput(date.start, date.time_zone);
  return value.slice(0, 10);
}

export function timeInputValue(date: TaskDate): string {
  if (!date?.start) return '';
  const value = taskDateForInput(date.start, date.time_zone);
  return value.length > 10 ? value.slice(11, 16) : '';
}

function taskDateForInput(value: string, timeZone?: string | null): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = parseTaskDate(value, timeZone);
  if (Number.isNaN(date.getTime())) return value.replace(/Z$/, '').slice(0, 16);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function taskDateFromInputs(date: string, time: string, previous: TaskDate): TaskDate {
  if (!date) return null;
  if (!time) {
    let end: string | null = null;
    if (previous?.end) {
      const firstDay = DateTime.fromISO(dateInputValue(previous), { zone: 'UTC' });
      const lastDay = DateTime.fromISO(taskDateForInput(previous.end, previous.time_zone).slice(0, 10), { zone: 'UTC' });
      end = DateTime.fromISO(date, { zone: 'UTC' }).plus({ days: Math.max(0, lastDay.diff(firstDay, 'days').days) }).toISODate();
    }
    return {
      start: date,
      end,
    };
  }
  const local = `${date}T${time}`;
  const parsed = new Date(local);
  const start = Number.isNaN(parsed.getTime()) ? local : parsed.toISOString();
  return {
    start,
    end: previous?.end ? new Date(parsed.getTime() + Math.max(0, parseTaskDate(previous.end, previous.time_zone).getTime() - parseTaskDate(previous.start, previous.time_zone).getTime())).toISOString() : null,
  };
}

function parseTaskDate(value: string, timeZone?: string | null): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const parsed = DateTime.fromISO(value, hasOffset ? { setZone: true } : timeZone ? { zone: timeZone } : undefined);
  return parsed.toJSDate();
}

export function isSameLocalDay(value: Date | null, reference = new Date()): boolean {
  if (!value) return false;
  return value >= dayStart(reference) && value < dayEnd(reference);
}

export function isOverdue(task: Task, reference = new Date()): boolean {
  const due = taskStart(task);
  return !task.completed && !!due && due < dayStart(reference);
}

export function isUpcoming(task: Task, reference = new Date()): boolean {
  const due = taskStart(task);
  return !task.completed && !!due && due >= dayEnd(reference);
}

export function belongsToList(task: Task, list: ListId, stars: string[], reference = new Date(), showOverdue = false): boolean {
  if (list === 'all') return !task.completed;
  if (list === 'completed') return task.completed;
  if (list === 'important') return !task.completed && stars.includes(task.id);
  if (list === 'upcoming') return isUpcoming(task, reference);
  return !task.completed && (isSameLocalDay(taskStart(task), reference) || (showOverdue && isOverdue(task, reference)));
}

export function formatTaskDue(task: Task, now = new Date()): { label: string; tone: 'overdue' | 'today' | 'normal' | 'empty' } {
  const due = taskStart(task);
  if (!due) return { label: 'No due date', tone: 'empty' };
  const datePart = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(due);
  const hasTime = Boolean(task.due?.start && /T\d{2}:\d{2}/.test(task.due.start));
  const timePart = hasTime ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(due) : '';
  if (isOverdue(task, now)) return { label: `Overdue · ${datePart}${timePart ? `, ${timePart}` : ''}`, tone: 'overdue' };
  if (isSameLocalDay(due, now)) return { label: `Today${timePart ? ` · ${timePart}` : ''}`, tone: 'today' };
  return { label: `${datePart}${timePart ? ` · ${timePart}` : ''}`, tone: 'normal' };
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const leftDue = taskStart(left)?.getTime() ?? Number.POSITIVE_INFINITY;
    const rightDue = taskStart(right)?.getTime() ?? Number.POSITIVE_INFINITY;
    if (leftDue !== rightDue) return leftDue - rightDue;
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

export function filterTasks(
  tasks: Task[],
  list: ListId,
  stars: string[],
  filters: TaskFilters,
  query: string,
  sources: SourceConfig[],
  reference = new Date(),
  showOverdue = false,
): Task[] {
  const normalizedQuery = query.trim().toLowerCase();
  return sortTasks(tasks.filter((task) => {
    if (!belongsToList(task, list, stars, reference, showOverdue)) return false;
    const source = sources.find((item) => item.id === task.sourceId);
    if (filters.sourceId && task.sourceId !== filters.sourceId) return false;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.important && !stars.includes(task.id)) return false;
    if (normalizedQuery && !`${task.name} ${source?.name ?? ''} ${task.status}`.toLowerCase().includes(normalizedQuery)) return false;
    const due = taskStart(task);
    if (filters.from && (!due || due < new Date(`${filters.from}T00:00:00`))) return false;
    if (filters.to && (!due || due >= new Date(`${filters.to}T23:59:59.999`))) return false;
    return true;
  }));
}

export function sourceForTask(task: Task, sources: SourceConfig[]): SourceConfig | undefined {
  return sources.find((source) => source.id === task.sourceId);
}

export function autoMapping(source: Pick<SourceConfig, 'properties'>): SourceConfig['mapping'] {
  const properties = source.properties;
  const exact = (names: string[]) => properties.find((property) => names.includes(property.name.trim().toLowerCase()));
  const title = exact(['task', 'name', 'title']) ?? properties.find((property) => property.type === 'title');
  const due = exact(['due date', 'due', 'date']) ?? properties.find((property) => property.type === 'date');
  const status = properties.find((property) => property.name.trim().toLowerCase() === 'status' && ['status', 'select', 'checkbox'].includes(property.type))
    ?? properties.find((property) => property.type === 'status' && property.options?.length)
    ?? properties.find((property) => property.type === 'select' && property.options?.length)
    ?? properties.find((property) => property.type === 'checkbox' || /^(done|complete|completed)$/i.test(property.name));
  const options = status?.options ?? [];
  const complete = status?.type === 'checkbox'
    ? { id: 'true' }
    : options.find((option) => /^(done|complete|completed|closed)$/i.test(option.name))
      ?? options.find((option) => /done|complete|completed|closed/i.test(option.name));
  const reopen = status?.type === 'checkbox'
    ? { id: 'false' }
    : options.find((option) => /^not started$/i.test(option.name))
      ?? options.find((option) => /to ?do|open|active|backlog/i.test(option.name))
      ?? options.find((option) => /in progress/i.test(option.name));
  return {
    title: title?.id ?? '',
    due: due?.id ?? null,
    status: status?.id ?? '',
    complete: complete?.id ?? '',
    reopen: reopen?.id ?? '',
  };
}

export function sourceStatusOptions(source: SourceConfig | undefined) {
  if (!source) return [];
  return source.properties.find((property) => property.id === source.mapping.status)?.options ?? [];
}

export type TaskStatusTone = 'complete' | 'progress' | 'blocked' | 'planned' | 'neutral';

/** Maps arbitrary Notion status labels to a small, consistent set of visual tones. */
export function taskStatusTone(status: string, completed = false): TaskStatusTone {
  const normalized = status.trim().toLowerCase();
  if (completed || /\b(done|complete|completed|closed|resolved|finished|true)\b/.test(normalized)) return 'complete';
  if (/\b(blocked|blocking|stuck|on hold|paused|waiting|at risk)\b/.test(normalized)) return 'blocked';
  if (!normalized || /\b(not started|to do|todo|backlog|open|planned|queued|pending|false)\b/.test(normalized)) return 'planned';
  if (/\b(in progress|progress|doing|active|started|working|review|reviewing)\b/.test(normalized)) return 'progress';
  return 'neutral';
}

export function toggleStatusForTask(task: Task, source: SourceConfig | undefined): string | null {
  const options = sourceStatusOptions(source);
  const targetId = task.completed ? source?.mapping.reopen : source?.mapping.complete;
  const target = options.find((option) => option.id === targetId || option.name === targetId);
  if (target) return target.name;
  const exactFallback = options.find((option) => task.completed ? /^not started$/i.test(option.name) : /^(done|complete|completed|closed)$/i.test(option.name));
  const fallback = exactFallback ?? options.find((option) => task.completed ? /open|to ?do|active|in progress/i.test(option.name) : /done|complete|closed/i.test(option.name));
  return fallback?.name ?? (options.length ? (task.completed ? 'false' : 'true') : (task.completed ? 'false' : 'true'));
}

export function displayDateTime(date: TaskDate): string {
  if (!date?.start) return 'No date set';
  const parsed = parseTaskDate(date.start, date.time_zone);
  if (Number.isNaN(parsed.getTime())) return date.start;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: /T\d{2}:\d{2}/.test(date.start) ? 'short' : undefined }).format(parsed);
}

export function listCounts(state: Pick<AppState, 'tasks' | 'stars'>, showOverdue = false, reference = new Date()): Record<ListId, number> {
  return {
    today: state.tasks.filter((task) => belongsToList(task, 'today', state.stars, reference, showOverdue)).length,
    upcoming: state.tasks.filter((task) => belongsToList(task, 'upcoming', state.stars, reference)).length,
    all: state.tasks.filter((task) => belongsToList(task, 'all', state.stars, reference)).length,
    important: state.tasks.filter((task) => belongsToList(task, 'important', state.stars, reference)).length,
    completed: state.tasks.filter((task) => belongsToList(task, 'completed', state.stars, reference)).length,
  };
}
