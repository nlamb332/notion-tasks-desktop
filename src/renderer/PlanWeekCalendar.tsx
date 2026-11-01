import { useMemo, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { DateTime } from 'luxon';
import { LoaderCircle } from 'lucide-react';
import { gridHours, layoutDay, SNAP_MINUTES, snappedStart, weekDays, type WeekEntry } from './planWeek';

const MINUTE_HEIGHT = 0.8;

export interface WeekProposed extends WeekEntry { title: string; conflict: string | null; adjusted: boolean }
export interface WeekFixed extends WeekEntry { title: string; allDay?: boolean }

interface Props {
  anchor: string;
  timezone: string;
  workdays: number[];
  startHour: number;
  endHour: number;
  events: WeekFixed[];
  approved: WeekFixed[];
  proposed: WeekProposed[];
  loading: boolean;
  /** Reports why a start would conflict, without changing the draft. */
  onProbe(id: string, start: string): string | null;
  onMove(id: string, start: string): void;
}

export function PlanWeekCalendar({ anchor, timezone, workdays, startHour, endHour, events, approved, proposed, loading, onProbe, onMove }: Props) {
  const [dragging, setDragging] = useState<{ id: string; minutes: number; grabOffset: number } | null>(null);
  const [hover, setHover] = useState<{ day: number; offset: number; conflict: string | null } | null>(null);
  const days = useMemo(() => weekDays(anchor, timezone), [anchor, timezone]);
  const timed = events.filter(event => !event.allDay);
  const { from, to } = gridHours(days, [...timed, ...approved, ...proposed], startHour, endHour);
  const hours = Array.from({ length: to - from }, (_, index) => from + index);
  const columnHeight = (to - from) * 60 * MINUTE_HEIGHT;
  const clock = (value: string) => DateTime.fromISO(value).setZone(timezone).toFormat('t');
  const position = (top: number, height: number, lane: number, lanes: number): CSSProperties => ({ top: top * MINUTE_HEIGHT, height: Math.max(height * MINUTE_HEIGHT, 16), left: `${lane / lanes * 100}%`, width: `${100 / lanes}%` });

  function pointerStart(event: DragEvent<HTMLDivElement>, day: number) {
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = (event.clientY - rect.top - (dragging?.grabOffset ?? 0)) / MINUTE_HEIGHT;
    const offset = Math.max(0, Math.min(raw, (to - from) * 60 - SNAP_MINUTES));
    return { offset: Math.round(offset / SNAP_MINUTES) * SNAP_MINUTES, start: snappedStart(days[day], offset, from).toUTC().toISO()! };
  }
  function dragOver(event: DragEvent<HTMLDivElement>, day: number) {
    if (!dragging) return;
    event.preventDefault();
    const { offset, start } = pointerStart(event, day);
    if (hover?.day !== day || hover.offset !== offset) setHover({ day, offset, conflict: onProbe(dragging.id, start) });
  }
  function drop(event: DragEvent<HTMLDivElement>, day: number) {
    if (!dragging) return;
    event.preventDefault();
    onMove(dragging.id, pointerStart(event, day).start);
    setDragging(null); setHover(null);
  }
  function nudge(event: KeyboardEvent<HTMLButtonElement>, entry: WeekProposed) {
    const change = { ArrowUp: { minutes: -SNAP_MINUTES }, ArrowDown: { minutes: SNAP_MINUTES }, ArrowLeft: { days: -1 }, ArrowRight: { days: 1 } }[event.key];
    if (!change) return;
    event.preventDefault();
    onMove(entry.id, DateTime.fromISO(entry.start).setZone(timezone).plus(change).toUTC().toISO()!);
  }

  return <div className="plan-week" aria-busy={loading}>
    <div className="plan-week-legend" aria-label="Calendar legend"><span className="plan-swatch event">Calendar event</span><span className="plan-swatch approved">Approved block</span><span className="plan-swatch proposed">Proposed block</span><small>Times shown in {timezone}. Drag proposed blocks, or focus one and use the arrow keys.</small></div>
    {loading ? <div className="plan-week-loading" role="status"><LoaderCircle size={14} className="spin" />Reading calendars and building a draft…</div> : null}
    <div className="plan-week-scroll"><div className="plan-week-grid">
      <div className="plan-week-gutter"><div className="plan-week-head" />{hours.map(hour => <div className="plan-week-hour" style={{ height: 60 * MINUTE_HEIGHT }} key={hour}>{DateTime.fromObject({ hour: hour % 24 }).toFormat('h a')}</div>)}</div>
      {days.map((day, index) => {
        const allDay = events.filter(event => event.allDay && DateTime.fromISO(event.start).setZone(timezone) < day.plus({ days: 1 }) && DateTime.fromISO(event.end).setZone(timezone) > day);
        const working = workdays.includes(day.weekday);
        return <div className={`plan-week-day ${working ? '' : 'off'}`} key={day.toISODate()}>
          <div className="plan-week-head"><strong>{day.toFormat('ccc')}</strong><span>{day.toFormat('LLL d')}</span>{!working ? <small>Off</small> : null}{allDay.map(event => <small className="plan-all-day" key={event.id} title={event.title}>{event.title}</small>)}</div>
          <div className="plan-week-body" data-day={day.toISODate()} style={{ height: columnHeight, '--hour-height': `${60 * MINUTE_HEIGHT}px` } as CSSProperties} onDragOver={event => dragOver(event, index)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setHover(null); }} onDrop={event => drop(event, index)}>
            {working ? <div className="plan-week-working" style={{ top: (startHour - from) * 60 * MINUTE_HEIGHT, height: (endHour - startHour) * 60 * MINUTE_HEIGHT }} /> : null}
            {layoutDay(day, timed, from, to).map(({ entry, top, height, lane, lanes }) => <div className="plan-block event" key={entry.id} style={position(top, height, lane, lanes)} title={`${entry.title}, ${clock(entry.start)}–${clock(entry.end)}`}><strong>{entry.title}</strong></div>)}
            {layoutDay(day, approved, from, to).map(({ entry, top, height, lane, lanes }) => <div className="plan-block approved" key={entry.id} style={position(top, height, lane, lanes)} title={`Approved: ${entry.title}, ${clock(entry.start)}–${clock(entry.end)}`}><strong>{entry.title}</strong></div>)}
            {layoutDay(day, proposed, from, to).map(({ entry, top, height, lane, lanes }) => <button type="button" draggable className={`plan-block proposed ${entry.conflict ? 'conflict' : ''} ${dragging?.id === entry.id ? 'dragging' : ''}`} key={entry.id} style={position(top, height, lane, lanes)} aria-label={`Proposed: ${entry.title}, ${day.toFormat('cccc')} ${clock(entry.start)} to ${clock(entry.end)}${entry.conflict ? `. Conflict: ${entry.conflict}` : ''}. Use arrow keys to move.`} title={entry.conflict ?? `${clock(entry.start)}–${clock(entry.end)}`} onKeyDown={event => nudge(event, entry)} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', entry.title); setDragging({ id: entry.id, minutes: DateTime.fromISO(entry.end).diff(DateTime.fromISO(entry.start), 'minutes').minutes, grabOffset: event.clientY - event.currentTarget.getBoundingClientRect().top }); }} onDragEnd={() => { setDragging(null); setHover(null); }}><strong>{entry.title}</strong>{height * MINUTE_HEIGHT >= 30 ? <span>{clock(entry.start)}</span> : null}</button>)}
            {hover?.day === index && dragging ? <div className={`plan-drop-preview ${hover.conflict ? 'conflict' : ''}`} style={{ top: hover.offset * MINUTE_HEIGHT, height: dragging.minutes * MINUTE_HEIGHT }}>{hover.conflict ?? ''}</div> : null}
          </div>
        </div>;
      })}
    </div></div>
  </div>;
}

/** The form alternative to dragging, for choosing an exact date and time. */
export function PlacementForm({ label, start, timezone, adjusted, onMove, onReset }: { label: string; start: string; timezone: string; adjusted: boolean; onMove(start: string): void; onReset(): void }) {
  const current = DateTime.fromISO(start).setZone(timezone).toFormat("yyyy-LL-dd'T'HH:mm");
  const [draft, setDraft] = useState(current);
  const [syncedFrom, setSyncedFrom] = useState(current);
  if (current !== syncedFrom) { setSyncedFrom(current); setDraft(current); }
  const next = DateTime.fromISO(draft, { zone: timezone });
  return <div className="placement-form"><input type="datetime-local" step={SNAP_MINUTES * 60} aria-label={`New time for ${label}`} value={draft} onChange={event => setDraft(event.target.value)} /><button type="button" className="button button-secondary" disabled={!next.isValid || draft === current} onClick={() => onMove(next.toUTC().toISO()!)}>Move</button>{adjusted ? <button type="button" className="text-button" onClick={onReset}>Reset</button> : null}</div>;
}
