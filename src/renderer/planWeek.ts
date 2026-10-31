import { DateTime } from 'luxon';

export const SNAP_MINUTES = 15;

export interface WeekEntry { id: string; start: string; end: string }
export interface PlacedEntry<T extends WeekEntry> { entry: T; top: number; height: number; lane: number; lanes: number }

export function weekDays(anchor: string, timezone: string): DateTime[] {
  const first = DateTime.fromISO(anchor).setZone(timezone).startOf('day');
  return Array.from({ length: 7 }, (_, index) => first.plus({ days: index }));
}

function minuteOfDay(value: DateTime, day: DateTime): number {
  if (value < day) return 0;
  if (value >= day.plus({ days: 1 })) return 1440;
  return value.hour * 60 + value.minute;
}

/** The working window, widened to whole hours so that fixed events outside it stay visible. */
export function gridHours(days: DateTime[], entries: WeekEntry[], startHour: number, endHour: number): { from: number; to: number } {
  let from = startHour * 60, to = endHour * 60;
  for (const day of days) for (const entry of entries) {
    const start = DateTime.fromISO(entry.start).setZone(day.zoneName!), end = DateTime.fromISO(entry.end).setZone(day.zoneName!);
    if (end <= day || start >= day.plus({ days: 1 })) continue;
    from = Math.min(from, minuteOfDay(start, day));
    to = Math.max(to, minuteOfDay(end, day));
  }
  return { from: Math.floor(from / 60), to: Math.ceil(to / 60) };
}

/** Positions one day's entries in minutes from the top of the grid, with overlapping entries side by side. */
export function layoutDay<T extends WeekEntry>(day: DateTime, entries: T[], fromHour: number, toHour: number): PlacedEntry<T>[] {
  const bounds = entries.flatMap((entry) => {
    const start = DateTime.fromISO(entry.start).setZone(day.zoneName!), end = DateTime.fromISO(entry.end).setZone(day.zoneName!);
    if (end <= day || start >= day.plus({ days: 1 })) return [];
    const top = Math.max(minuteOfDay(start, day), fromHour * 60), bottom = Math.min(minuteOfDay(end, day), toHour * 60);
    return bottom > top ? [{ entry, top, bottom }] : [];
  }).sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  const placed: PlacedEntry<T>[] = [];
  let cluster: { item: PlacedEntry<T>; bottom: number }[] = [];
  const finish = () => { const lanes = Math.max(0, ...cluster.map(({ item }) => item.lane + 1)); for (const { item } of cluster) item.lanes = lanes; cluster = []; };
  for (const { entry, top, bottom } of bounds) {
    if (cluster.length && cluster.every((other) => other.bottom <= top)) finish();
    const taken = new Set(cluster.filter((other) => other.bottom > top).map(({ item }) => item.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    const item = { entry, top: top - fromHour * 60, height: bottom - top, lane, lanes: 1 };
    placed.push(item);
    cluster.push({ item, bottom });
  }
  finish();
  return placed;
}

/** Converts a pointer offset into a start time on the snap grid, in the planning timezone. */
export function snappedStart(day: DateTime, offsetMinutes: number, fromHour: number): DateTime {
  const minutes = fromHour * 60 + Math.round(offsetMinutes / SNAP_MINUTES) * SNAP_MINUTES;
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}
