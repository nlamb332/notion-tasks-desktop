import { calendarKey, type CalendarClient, type CalendarDefinition, type RemoteCalendarEvent } from "../shared/calendar";
import type { CalendarEvent, OwnedCalendarEventRef, OwnedBlock, PlanningData } from "../shared/types";

export interface CalendarRefreshResult { planning: PlanningData; syncedAt: string; range: { start: string; end: string } }

function remoteBinding(calendar: CalendarDefinition, event: RemoteCalendarEvent): OwnedCalendarEventRef {
  return { provider: calendar.provider, accountId: calendar.accountId ?? calendar.id, calendarId: calendar.id, eventId: event.ref.id, version: event.version };
}

function eventFromRemote(calendar: CalendarDefinition, event: RemoteCalendarEvent): CalendarEvent {
  return { id: `${calendar.provider}:${calendar.accountId ?? calendar.id}:${calendar.id}:${event.ref.id}`, title: event.title, start: event.start, end: event.end, allDay: event.allDay, remote: remoteBinding(calendar, event), ownership: event.ownership };
}

/** Fetch every selected calendar to completion, then replace only the live portion atomically. */
export async function refreshCalendarSnapshot(
  planning: PlanningData,
  clients: Partial<Record<CalendarDefinition["provider"], CalendarClient>>,
  range: { start: string; end: string },
  now = new Date().toISOString(),
): Promise<CalendarRefreshResult> {
  const sync = planning.calendarSync;
  if (!sync || sync.mode !== "live") throw new Error("Live calendar sync is not selected.");
  const selectedKeys = new Set(sync.selectedKeys);
  const knownKeys = new Set(sync.calendars.map(calendarKey));
  if ([...selectedKeys, ...(sync.defaultDestinationKey ? [sync.defaultDestinationKey] : [])].some(key => !knownKeys.has(key))) throw new Error("A selected calendar is no longer available. Review calendar settings before syncing.");
  const calendars = sync.calendars.filter(calendar => selectedKeys.has(calendarKey(calendar)) || calendarKey(calendar) === sync.defaultDestinationKey);
  if (!calendars.length || calendars.some(calendar => !calendar.canRead)) throw new Error("Select calendars with event read access before syncing.");
  const results = await Promise.all(calendars.map(async calendar => {
    const client = clients[calendar.provider];
    if (!client) throw new Error(`Connect ${calendar.provider === "google" ? "Google Calendar" : "Notion"} before syncing.`);
    const events = await client.readEvents(calendar, range);
    return { calendar, events };
  }));
  const liveEvents = results.flatMap(({ calendar, events }) => events.map(event => eventFromRemote(calendar, event)));
  const manualEvents = planning.events.filter(event => !event.remote && event.id.startsWith("manual-"));

  // Resolve known durable bindings by direct ID, including events moved outside the planning window.
  const blockUpdates = new Map<string, OwnedBlock | null>();
  for (const block of planning.blocks) {
    const binding = block.remote;
    if (!binding) continue;
    const calendar = sync.calendars.find(candidate => candidate.provider === binding.provider && candidate.id === binding.calendarId && (candidate.accountId ?? candidate.id) === binding.accountId);
    const client = calendar && clients[calendar.provider];
    if (!calendar || !client) continue;
    const event = await client.getEvent(calendar, binding.eventId);
    if (!event) { blockUpdates.set(block.id, null); continue; }
    if (!event.ownership || event.ownership.installationId !== sync.installationId || event.ownership.blockId !== block.id) { blockUpdates.set(block.id, null); continue; }
    blockUpdates.set(block.id, { ...block, start: event.start, end: event.end, remote: remoteBinding(calendar, event) });
  }
  const blocks = planning.blocks.flatMap(block => blockUpdates.has(block.id) ? (blockUpdates.get(block.id) ? [blockUpdates.get(block.id)!] : []) : [block]);
  const events = [...manualEvents, ...liveEvents].sort((a,b) => a.id.localeCompare(b.id));
  const priorEvents = [...planning.events].sort((a,b) => a.id.localeCompare(b.id));
  const changed = JSON.stringify(events) !== JSON.stringify(priorEvents) || JSON.stringify(blocks) !== JSON.stringify(planning.blocks);
  const syncedPlanning: PlanningData = { ...planning, events, blocks, calendarImportedAt: now, calendarSource: null, calendarSync: { ...sync, lastSyncedAt: now, error: null }, inputRevision: planning.inputRevision + (changed ? 1 : 0) };
  return { planning: syncedPlanning, syncedAt: now, range };
}

export function validateRemoteOwnership(block: OwnedBlock, event: RemoteCalendarEvent, installationId: string): boolean {
  return Boolean(block.remote && event.ownership && event.ownership.installationId === installationId && event.ownership.blockId === block.id && block.remote.eventId === event.ref.id);
}
