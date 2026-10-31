# Google Calendar setup

Google Calendar sync uses a desktop OAuth client registered in Google Cloud. The app opens the system browser and listens only on `127.0.0.1` at an ephemeral port for the sign-in callback. OAuth uses state validation and PKCE. The client JSON is accepted for its client ID and optional client secret; API and OAuth origins are fixed by the app.

## Register a desktop client

1. In Google Cloud Console, create or select a project and enable the Google Calendar API.
2. Configure the OAuth consent screen and add your account as a test user while the app is in Testing.
3. Create an OAuth client with application type **Desktop app** and download its JSON file.
4. In Notion Tasks, import that client JSON and choose **Connect Google Calendar**. Complete consent in the system browser.

Google can expire refresh tokens after seven days when an external OAuth consent screen is left in Testing. In that configuration, add your Google account as a test user and expect to reconnect when the grant expires. The app handles `invalid_grant` by removing stale tokens, retaining the client configuration for reconnect, and showing a reconnect error; it does not promise permanent sign-in for a testing client. See [Google OAuth refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration) and [Google's OAuth testing guidance](https://support.google.com/cloud/answer/15549945).

The connection requests calendar-list read access, event read access, and event write access limited to calendars you own. Calendars shared with free/busy-only access are shown as unavailable because their events cannot be read. The app stores the imported client configuration and tokens through the desktop app's encrypted credential store. Disconnecting removes local credentials and requests token revocation; it never deletes calendar events.

No real account or live calendar is used by automated tests. Live sync requires a client you register and explicit consent in the browser.
