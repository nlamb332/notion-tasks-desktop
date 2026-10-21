# Credentials and local data

Enter Notion integration tokens only in the installed app. Never commit tokens, private keys, database exports, task caches, or personal source links. Source examples and automated tests use synthetic data.

The app encrypts its token using Windows-backed Electron safeStorage. Runtime files live under the Windows user-data directory (normally `%APPDATA%/notion-tasks-desktop/`):

- `notion-token.enc`: encrypted integration token.
- `state.json`: cached tasks, source configuration, stars, and desktop preferences. This cache is not separately encrypted.

These runtime files, `.env` files, build output, development caches, keys, and local project notes are excluded from source control. Test instances use temporary directories under `.cache/`; never attach those directories or screenshots to issues without reviewing their contents.

Release assets consist of the Windows installer and its SHA-256 checksum file. They do not include local application data, test caches, build logs, or private source configuration. Installers are unsigned personal builds.

## Reporting a problem

Use a private communication channel with the repository owner for a suspected credential exposure. Do not paste the credential into an issue, pull request, or release comment. Revoke an exposed Notion integration token and replace it locally.
