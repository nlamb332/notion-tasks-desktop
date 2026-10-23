# Notion Tasks

A personal Windows desktop task app with a full list view and compact floating widget. Tasks remain in their original Notion databases; importance stars and desktop preferences stay on this computer.

## Install and connect

1. Open [Releases](https://github.com/nlamb332/notion-tasks-desktop/releases/latest) and download the latest `Notion-Tasks-Setup-<version>.exe` installer.
2. Run the Windows x64 installer and launch **Notion Tasks**. This personal build is unsigned, so Windows may display a publisher warning.
3. Create a Notion internal integration at [Notion integrations](https://www.notion.so/profile/integrations), with permission to read, insert, and update content.
4. Open each original task database's menu in Notion, select **Connections**, and add your integration. Grant access to each source you want to use.
5. In the app, open **Settings → Connection**, enter the integration token locally, and connect.
6. In **Settings → Sources**, paste a database or task-page link, inspect the suggested property mappings, and confirm them. Add further sources the same way.

Typical property mappings (examples only):

| App field | Common Notion properties |
| --- | --- |
| Name | A title property such as `Task` or `Name` |
| Due date | A date property such as `Due Date` or `Due` |
| Completion | The intended `Status` property, with `Done` and `Not started` mapped to complete/reopen |

If your database has multiple status-like properties, explicitly choose the intended one. The app never creates database properties or edits unrelated properties. Saved-view filters are not imported. If a linked database cannot be resolved through the API, copy the original database's link from Notion. Tokens and database links are configured locally; no real credentials or personal source IDs are included in this repository.

## Daily use

### App updates

In **Settings → Preferences → App updates**, choose **Check for updates**, then **Download update**. Once the download completes, save any open draft and choose **Restart and install**. Updates come from this project's public GitHub releases; no GitHub token is required. Download progress and connection failures appear in the app. Closing to the tray or quitting does not install an update automatically. Installed Windows builds support updates; development builds show an explanation instead. Versions before 0.1.4 require one manual installer upgrade to get this feature.

When publishing a new version, upload the generated installer, its `.exe.blockmap`, and `latest.yml` from `release/<version>/` to the same stable GitHub release. Publish the metadata with the matching installer; the updater verifies its SHA-512 checksum before offering installation. Do not include credentials in the build or update configuration. `npm run package` builds locally without publishing.

Use Today, Upcoming, All Tasks, Important, Completed, or a source in the sidebar. Today uses your computer's local calendar date. Enable **Show overdue** in Today to also include unfinished tasks due before today. The toggle is available in full and compact modes, defaults off, and remembers your preference across restarts. Starred tasks are local to this installation. Select a task to edit it; click its completion control to complete or reopen it. Choose a source when adding a task. Open in Notion opens the original page.

Date/time inputs use local time. Moving a due-date range moves its end by the same duration; use Notion to independently change a range's end. Unedited dates retain their original values and timezone metadata.

Click **Add a task** to open a draft in the details pane. Enter the name, due date/time, and destination source, optionally choose **Favorite**, then choose **Create task**. Favorite tasks appear in the Important list and are stored locally with the app's other preferences. Drafts opened from Today default to the current local date; you can change or clear it before saving. Closing or cancelling the draft does not create a Notion page. Sync status appears beside the list heading.

Completing or reopening a task updates the list immediately while Notion saves in the background. **Undo** is available for eight seconds and restores the previous status, including In progress. A failed save removes the optimistic change and shows an error.

Compact mode uses the same task state in a smaller window. Pin it above other windows if desired. Closing the window keeps the app in the notification tray; use the tray's Quit command to exit. Launch at sign-in is opt-in.

The app refreshes every minute while running and on focus. Source failures retain the last cached tasks. Task edits require a successful source connection; offline stars still work. If an edited field has changed in Notion since you loaded it, review the current value before saving again. Notion's API has no atomic compare-and-swap operation, so a concurrent edit between validation and submission cannot be completely prevented.

Credentials are encrypted using Windows-backed Electron safeStorage. Cached task data, mappings, stars, and preferences are local files in the app's Windows user-data directory; task-cache files are not separately encrypted. Disconnect removes the stored credential. Removing a source only affects this app.

## Development

Requires Node.js 22.12+ or 24+ on Windows.

```powershell
git clone https://github.com/nlamb332/notion-tasks-desktop.git
cd notion-tasks-desktop
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run package
```

The Windows installer and unpacked app are emitted into a versioned folder under `release/`. Packaging is unsigned for this personal first release. Development UI hot reload is supported; restart `npm run dev` after main-process or preload changes.

Tests use mocked Notion responses; no test should change your existing Notion tasks. A live integration test needs a token entered locally and a disposable task in a selected source. This app does not use the Notion connection in Codex.

`test:desktop` requires a graphical Windows desktop and a completed `npm run build`; it launches isolated Electron instances and saves fixture screenshots under `.cache/`. See [VALIDATION.md](VALIDATION.md) for checked behavior and remaining live verification.

## First-release boundaries

No notifications, offline write queue, page-body editor, public OAuth sign-in, hosted service, or database-schema changes. The integration needs access to every selected original data source. The compact window is a normal desktop app window, not a Windows Widgets board extension.
