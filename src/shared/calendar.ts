/** Calendar providers are independent of task providers: Plane tasks can use either calendar. */
export type CalendarProvider = 'google' | 'notion';
export interface CalendarDefinition {
  provider: CalendarProvider;
  id: string;
  name: string;
  timeZone: string;
  /** Stable provider account identity. Required for durable remote ownership bindings. */
  accountId?: string;
  canRead: boolean;
  canWrite: boolean;
  /** Explicit existing Notion properties; calendar setup never changes a database schema. */
  mapping?: { title: string; date: string };
}
export function calendarKey(calendar: Pick<CalendarDefinition, 'provider' | 'id'>): string {
  return JSON.stringify([calendar.provider, calendar.id]);
}
export interface CalendarRange { start: string; end: string }
export interface CalendarEventRef { calendarKey: string; id: string }
export interface CalendarOwnership { installationId: string; blockId: string; operationId: string }
export interface RemoteCalendarEvent {
  ref: CalendarEventRef;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  version: string;
  url?: string;
  ownership?: CalendarOwnership;
}
export interface CalendarWriteInput extends CalendarOwnership {
  title: string;
  start: string;
  end: string;
  taskUrl?: string;
}
/** All mutations are called only for specific, explicitly approved planner changes. */
export interface CalendarClient {
  readEvents(calendar: CalendarDefinition, range: CalendarRange): Promise<RemoteCalendarEvent[]>;
  getEvent(calendar: CalendarDefinition, eventId: string): Promise<RemoteCalendarEvent | null>;
  createEvent(calendar: CalendarDefinition, input: CalendarWriteInput): Promise<RemoteCalendarEvent>;
  updateEvent(calendar: CalendarDefinition, eventId: string, input: CalendarWriteInput, expectedVersion: string): Promise<RemoteCalendarEvent>;
  deleteEvent(calendar: CalendarDefinition, eventId: string, expectedVersion: string): Promise<void>;
}
export type CalendarErrorCode = 'invalid' | 'unauthorized' | 'unavailable' | 'not-found' | 'conflict' | 'not-created' | 'unknown-write';
export class CalendarProviderError extends Error {
  constructor(message: string, public readonly code: CalendarErrorCode) { super(message); this.name = 'CalendarProviderError'; }
}
