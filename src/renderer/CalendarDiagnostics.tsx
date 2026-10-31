import { useState } from 'react';
import { DateTime } from 'luxon';
import { Download } from 'lucide-react';
import type { AppState } from '../shared/types';

interface Props {
  state: AppState;
  onState(state: AppState): void;
  onNotice(message: string): void;
}

/** Advanced fallback tools. Nothing here runs unless the user chooses it; live planning never falls back on its own. */
export function CalendarDiagnostics({ state, onState, onNotice }: Props) {
  const planning = state.planning!;
  const sync = planning.calendarSync;
  const live = sync?.mode === 'live';
  const timezone = planning.settings.timezone;
  const [eventTitle, setEventTitle] = useState('');
  const [eventStart, setEventStart] = useState('');
  const [eventEnd, setEventEnd] = useState('');
  const savedSnapshot = planning.localCalendar;
  const pendingRecovery = sync?.journal.filter(operation => operation.status === 'recovery-needed').length ?? 0;

  function when(value: string) { return new Date(value).toLocaleString(undefined, { timeZone: timezone }); }
  function blockCalendar(blockId: string) { const block = planning.blocks.find(item => item.id === blockId); if (!block?.remote) return 'Local'; return sync?.calendars.find(calendar => calendar.provider === block.remote?.provider && calendar.id === block.remote?.calendarId && (calendar.accountId ?? calendar.id) === block.remote?.accountId)?.name || 'Previously connected calendar'; }

  async function useLocal() {
    if (live && !window.confirm('Stop reading live calendars and plan from local data instead? New task blocks will stay local until you select a live calendar again.')) return;
    try { onState(await window.desktop.useLocalCalendar()); onNotice('Planning now uses local calendar data.'); } catch (e) { onNotice(e instanceof Error ? e.message : 'Unable to switch to local calendar data.'); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    if (live && !window.confirm('Importing replaces live calendars with this snapshot for planning until you choose live calendars again. Continue?')) return;
    try { onState(await window.desktop.importCalendar(await file.text())); onNotice('Calendar snapshot imported.'); } catch (e) { onNotice(e instanceof Error ? e.message : 'Calendar import failed. The previous snapshot is unchanged.'); }
  }
  async function allowEmpty(allowEmptyCalendar: boolean) {
    try { onState(await window.desktop.updatePlanningSettings({ allowEmptyCalendar })); } catch (e) { onNotice(e instanceof Error ? e.message : 'Unable to save planning settings.'); }
  }
  async function addEvent() {
    if (!eventTitle.trim() || !eventStart || !eventEnd) return;
    try {
      const start = DateTime.fromISO(eventStart, { zone: timezone }).toUTC(), end = DateTime.fromISO(eventEnd, { zone: timezone }).toUTC();
      if (!start.isValid || !end.isValid || end <= start) throw new Error('Choose a valid commitment time and end after its start.');
      onState(await window.desktop.addCalendarEvent({ title: eventTitle, start: start.toISO()!, end: end.toISO()! }));
      setEventTitle(''); setEventStart(''); setEventEnd('');
    } catch (e) { onNotice(e instanceof Error ? e.message : 'Unable to add commitment.'); }
  }
  async function exportBlocks() {
    try { const content = await window.desktop.exportCalendar(); const blob = new Blob([content], { type: 'text/calendar' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'notion-tasks-plan.ics'; a.click(); URL.revokeObjectURL(a.href); } catch (e) { onNotice(e instanceof Error ? e.message : 'Unable to export blocks.'); }
  }

  return <section className="settings-section">
    <div className="settings-intro"><span className="eyebrow">Diagnostics</span><h2>Calendar fallback tools</h2><p>Use these when a live calendar is not an option. Planning never switches to local data on its own, and a failed connection pauses planning until you reconnect or choose local data here.</p></div>
    <div className="planning-card"><h3>Current state</h3>
      <dl className="diagnostics-facts">
        <dt>Scheduling input</dt><dd>{live ? 'Live calendars' : planning.calendarSource === 'ics' ? 'Local ICS snapshot' : planning.calendarSource === 'manual' ? 'Manual commitments' : 'None selected'}</dd>
        <dt>Selected calendars</dt><dd>{sync?.selectedKeys.length ?? 0}</dd>
        <dt>Last live sync</dt><dd>{sync?.lastSyncedAt ? when(sync.lastSyncedAt) : 'Not yet'}</dd>
        <dt>Last error</dt><dd>{sync?.error ?? 'None'}</dd>
        <dt>Calendar changes needing recovery</dt><dd>{pendingRecovery}</dd>
        <dt>Saved local snapshot</dt><dd>{savedSnapshot ? `${savedSnapshot.events.length} events · ${savedSnapshot.importedAt ? when(savedSnapshot.importedAt) : 'no import date'}` : 'None'}</dd>
      </dl>
      {live ? <button className="button button-secondary" onClick={() => void useLocal()}>Use local calendar</button> : null}
    </div>
    <div className="planning-card"><h3>Local calendar</h3>
      <p>{planning.calendarImportedAt && !live ? `Imported snapshot updated ${new Date(planning.calendarImportedAt).toLocaleString()} · ${planning.events.length} fixed events` : 'Import an ICS snapshot covering the next seven dates.'}</p>
      <label className="button button-secondary calendar-import"><Download size={15} />Import .ics snapshot<input aria-label="Import ICS calendar" type="file" accept=".ics,text/calendar" onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      <label className="empty-calendar-choice"><input type="checkbox" checked={planning.settings.allowEmptyCalendar} onChange={e => void allowEmpty(e.target.checked)} />Plan with an explicitly empty calendar plus manual commitments</label>
      {planning.events.map(event => <div className="planning-event" key={event.id}><strong>{event.title}</strong><span>{when(event.start)} – {new Date(event.end).toLocaleTimeString(undefined, { timeZone: timezone })}{event.remote ? ' · live' : event.id.startsWith('manual-') ? ' · manual' : ' · imported'}</span></div>)}
      <div className="manual-event"><input placeholder="Add fixed commitment" aria-label="Commitment title" value={eventTitle} onChange={e => setEventTitle(e.target.value)} /><input aria-label="Commitment starts (planning timezone)" type="datetime-local" value={eventStart} onChange={e => setEventStart(e.target.value)} /><input aria-label="Commitment ends (planning timezone)" type="datetime-local" value={eventEnd} onChange={e => setEventEnd(e.target.value)} /><button className="button button-secondary" onClick={() => void addEvent()}>Add</button></div>
      <small>Manual commitment times are interpreted in {timezone}.</small>
    </div>
    <div className="planning-card"><div className="planning-heading"><div><h3>Task blocks</h3><p>Export an ICS copy of approved blocks, including those stored only on this computer.</p></div><button className="button button-secondary" disabled={!planning.blocks.length} onClick={() => void exportBlocks()}>Export .ics</button></div>
      {planning.blocks.map(block => { const task = state.tasks.find(t => t.id === block.ref.taskId && t.sourceId === block.ref.sourceId); return <div className="planning-event" key={block.id}><strong>{task?.name || 'Unavailable task'}</strong><span>{when(block.start)} · {blockCalendar(block.id)}</span></div>; })}
      {!planning.blocks.length ? <div className="planning-empty">No approved blocks yet.</div> : null}
    </div>
  </section>;
}
