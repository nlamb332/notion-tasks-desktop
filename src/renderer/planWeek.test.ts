import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { gridHours, layoutDay, snappedStart, weekDays } from './planWeek';

const zone = 'America/Chicago';
const day = DateTime.fromISO('2026-11-03T00:00:00', { zone });
const entry = (id: string, start: string, end: string) => ({ id, start: `2026-11-03T${start}:00-06:00`, end: `2026-11-03T${end}:00-06:00` });

describe('plan week layout', () => {
  it('lists seven local dates from the anchor, including across a DST change', () => {
    const days = weekDays('2026-10-30T15:00:00Z', zone);
    expect(days.map(item => item.toISODate())).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
  });
  it('widens the working hours to show events outside them', () => {
    expect(gridHours([day], [], 9, 17)).toEqual({ from: 9, to: 17 });
    expect(gridHours([day], [entry('early', '07:30', '08:00'), entry('late', '18:00', '18:15')], 9, 17)).toEqual({ from: 7, to: 19 });
  });
  it('places entries from the top of the grid and shares width only among overlaps', () => {
    const placed = layoutDay(day, [entry('a', '09:00', '10:00'), entry('b', '09:30', '10:30'), entry('c', '11:00', '11:30')], 9, 17);
    expect(placed.map(({ entry: item, top, height, lane, lanes }) => [item.id, top, height, lane, lanes])).toEqual([['a', 0, 60, 0, 2], ['b', 30, 60, 1, 2], ['c', 120, 30, 0, 1]]);
  });
  it('clips an overnight event to the visible part of the day', () => {
    const overnight = { id: 'night', start: '2026-11-02T22:00:00-06:00', end: '2026-11-03T10:00:00-06:00' };
    expect(layoutDay(day, [overnight], 9, 17)).toMatchObject([{ top: 0, height: 60 }]);
  });
  it('snaps a pointer offset to the quarter hour in the planning timezone', () => {
    expect(snappedStart(day, 67, 9).toFormat('HH:mm')).toBe('10:00');
    expect(snappedStart(day, 68, 9).toFormat('HH:mm')).toBe('10:15');
    expect(snappedStart(day, 0, 9).zoneName).toBe(zone);
  });
});
