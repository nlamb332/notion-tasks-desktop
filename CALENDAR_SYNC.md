# Live calendar sync

User scope (2026-10-30): connect Notion and/or Google, select calendars from both for scheduling, and select a default calendar for writing approved task events. Preserve seven-day recommendations and approval before creating, moving or deleting calendar events. Existing/unowned events are fixed.

## Provider meaning

Google means real Google Calendar accounts and their calendars. Notion means explicit existing Notion databases/data sources with selected title and date properties, using the app's existing Notion integration. Those database calendars can also appear in Notion Calendar. Google calendars displayed in the standalone Notion Calendar app use their underlying Google account; do not claim an independent Notion Calendar API connection or copy task due dates into scheduled time.

Task sources and calendar destinations are independent: Notion or Plane tasks can be scheduled into either calendar provider. The Notion destination is an event database; writing an approved block creates an event page with the selected title/date fields and a link back to the original task, without altering the task deadline or database schema.

## Main flow

1. Connect Google via desktop OAuth or use the existing Notion connection.
2. List Google calendars; add Notion calendars by resolving a database URL and explicitly selecting title/date properties. Show actual read/write permissions and reject invalid mappings.
3. Select multiple calendars that block scheduling, across either provider. Select one writable destination. Always include the destination when reading availability. Read-only sources remain valid for availability.
4. Refresh while running (approximately every minute), on focus, before generation and before approval. Show last successful sync and errors. No files are needed for the normal connected flow; local import/export remains available as a fallback.
5. Freshly read the union of all selected calendars for the seven local planning dates, including recurrence-expanded Google instances and overnight/all-day events. Do not replace a failed/incomplete read with an empty calendar. Require all selected sources and their pagination to finish before treating coverage as fresh.
6. Generate a draft; show the destination and exact additions/moves/removals. Approval writes only the selected changes to their designated remote calendars. Never move or delete unowned events.
7. Changes made by the user in Google/Notion are read back. Adopt the actual time of a known owned event and its new version; deletion removes its local allocation and may produce a new recommendation, never an automatic recreation. If an owned event moves outside the visible window, retrieve it by its durable ID before deciding it was deleted.

## Provider contract

The provider-neutral contract is `src/shared/calendar.ts`. Provider modules own only remote requests and normalization; the runtime owns selection, eligibility, proposal authority, ownership mapping, journals and orchestration. Notion mappings use the actual data-source ID and existing property IDs. Provider factories accept injected fetch/token access for mocked tests. Service errors are sanitized and classified, never raw credential-bearing response bodies.

Google module exports `GoogleCalendarClient`, constructed with `{getAccessToken: () => Promise<string>, fetch?: typeof fetch}`, plus `listCalendars()`. It exports `GoogleOAuthClient` constructed with callbacks to load/save/clear encrypted credentials, open the system browser, and optional fetch/timeout/clock hooks. The OAuth object exposes `configureClient(json: unknown)`, `isConfigured()`, `isConnected()`, `connect()`, `cancelConnection()`, `getAccessToken()`, and `disconnect()`. It exports its credential store type for main-process persistence only. Desktop credential JSON may include an optional client secret; none is embedded in source or exposed in AppState.

Notion module exports `NotionCalendarClient`, constructed with `{getToken: () => string | Promise<string>, fetch?: typeof fetch}`. Calendar definitions are explicitly configured through the existing source resolver/property inspection. Provider methods implement the shared contract. Token requests use the existing 2025-09-03 Notion API version and fixed official API origin.

## Ownership and write reliability

- A durable local mapping (block ID -> provider/calendar/event ID/version), plus app ownership marker, establishes ownership. Titles alone never do. Private Google extended properties and an explicit machine-readable Notion page-body marker identify this installation and block. Treat markers without a matching local mapping as fixed unless reconciling a known pending create operation.
- Persist an approved operation journal before network writes. Keep exact intended times and chosen destination, per-step outcomes and confirmed remote identities. Remote APIs are not one transaction; persist confirmed successes individually and show partial failures honestly.
- Google creates use a deterministic legal event ID derived from installation/block identity. On ambiguous outcomes, reconcile by GET, verifying ownership and exact intended operation; never overwrite an existing conflicting event.
- Notion does not offer caller-selected page IDs. An uncertain create is not automatically retried. Include the operation marker in the created page body and expose explicit reconciliation (select matching existing event or confirm absence before a retry). Confirmed remote effects must survive restart.
- Google moves/deletes use ETags and If-Match. Notion checks last_edited_time immediately before mutation, and documents its lack of atomic compare-and-swap. Scope reads/writes to the configured official API origins.
- Before approval, refresh remote state and validate the selected transaction against an authoritative proposal stored in the main process. Never send renderer-supplied arbitrary remote IDs or ownership claims. Reject stale proposals. Never silently move times to make an approval fit.
- Serialize approval operations and coordinate refreshes. Do not silently mix local and remote approval outcomes. Changing defaults only affects future additions; moves/removals use existing blocks' own durable destination bindings.
- Disconnect clears protected credentials and stops polling/writes. It never deletes calendar events. Account changes must not rebind existing ownership to another account.

## Google OAuth and permissions

Use the system browser, PKCE S256, random state, and a timed loopback listener on 127.0.0.1 with an ephemeral port. Validate callback state/path; close the listener on success/cancel/timeout. Store client configuration and refresh/access tokens using Electron safeStorage in a separate credential file, never renderer state or logs. Fail closed if secure storage is unavailable. Request offline access and refresh expired tokens; expose reconnect on revoked grants.

For selected existing calendars, use calendar.calendarlist.readonly, calendar.events.readonly and calendar.events.owned scopes, with write destinations restricted to owner calendars. Clearly disable unsupported free-busy-only calendars instead of silently claiming their busy time was read. The OAuth client must be registered in Google Cloud, Calendar API enabled and consent configured. Add a setup guide/import UI for desktop client JSON; do not claim live Google verification without signing in with actual registered credentials.

Use bounded full refresh of the rolling seven-day window with Google singleEvents=true and full pagination. This avoids mixing incompatible rolling-window parameters with syncToken. A later incremental cache can replace polling. Include recurring exceptions, cancellations, transparency and calendar-local all-day boundaries correctly. Polling while the app runs is sufficient; do not introduce a hosted webhook service for this desktop feature.

## Evidence and validation

Official references checked for this implementation:
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://developers.google.com/workspace/calendar/api/v3/reference/events/list
- https://developers.google.com/workspace/calendar/api/guides/extended-properties
- https://developers.google.com/workspace/calendar/api/guides/version-resources
- https://developers.google.com/workspace/calendar/api/auth
- https://developers.notion.com/reference/query-a-data-source
- https://www.notion.com/en-us/help/use-notion-calendar-with-notion

Use mock provider responses and isolated desktop profiles, never real tasks/calendars for automated tests. Cover both providers, unioned busy windows, destination selection, no writes before approval, unowned-event protection, recurrence/timezones, refresh failures, pagination, stale plans, external moves/deletions, ETag/version conflicts, uncertain/partial creates and restart recovery. Test under both UTC and America/Chicago. Run typecheck, unit tests, build and full desktop checks. Document any live OAuth/Notion access still requiring user setup. Do not publish another release without a fresh user request.
