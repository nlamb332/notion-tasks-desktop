import type { ChangeEvent } from 'react';

interface Props {
  configured: boolean;
  connected: boolean;
  connecting: boolean;
  onConnect(): void;
  onRefresh(): void;
  onCancel(): void;
  onDisconnect(): void;
  onOpenSetup(): void;
  onImport(file?: File): void;
}

export function GoogleCalendarConnection(props: Props) {
  function importFile(event: ChangeEvent<HTMLInputElement>) {
    props.onImport(event.target.files?.[0]);
    event.target.value = '';
  }

  return <div className="calendar-provider-connection">
    <h4>Google Calendar</h4>
    <p>For Google calendars shown in Notion Calendar, connect the same Google account here. No Notion database is needed.</p>
    {!props.configured ? <p className="calendar-setup-status" role="status">Google sign-in is not configured for this app yet. Complete the one-time app setup below to enable it.</p> : null}
    <div className="calendar-connection-actions">
      <button className="button button-primary" disabled={props.connecting} onClick={!props.configured ? props.onOpenSetup : props.connected ? props.onRefresh : props.onConnect}>
        {props.connecting ? 'Connecting…' : !props.configured ? 'Set up Google Calendar' : props.connected ? 'Refresh Google calendars' : 'Connect Google'}
      </button>
      {props.connecting ? <button className="button button-secondary" onClick={props.onCancel}>Cancel sign-in</button> : null}
      {props.connected ? <button className="button button-secondary" onClick={props.onDisconnect}>Disconnect Google</button> : null}
    </div>
    <details className="calendar-setup-panel" open={!props.configured}>
      <summary>Google app setup</summary>
      <p>This app needs its own Google Cloud desktop registration before it can request access to your calendar. Signing in to Notion Calendar does not configure this app.</p>
      <ol>
        <li>Create or select a Google Cloud project and enable the Google Calendar API.</li>
        <li>Configure consent, add your account as a test user if needed, and create an OAuth client with type <strong>Desktop app</strong>.</li>
        <li>Download that client's JSON setup file, import it below, then choose <strong>Connect Google</strong> and sign in.</li>
      </ol>
      <button className="button button-secondary" onClick={props.onOpenSetup}>Open Google Cloud setup</button>
      <label className="calendar-client-import">Import Google desktop client file<input aria-label="Google Calendar desktop client JSON" type="file" accept="application/json,.json" onChange={importFile}/></label>
      <small>This file configures Google sign-in once. Calendar events sync directly after connection.</small>
    </details>
  </div>;
}
