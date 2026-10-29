# Plane integration

Plane and Notion can connect independently. A Plane project is a task source, so its work items appear in the same lists, filters, favorites, and compact widget as Notion tasks. This implementation supports one Plane server/key connection at a time and multiple projects accessible to that key.

## Test your API key

1. Open `.env.plane.local` in this project. It is already created and excluded from Git.
2. Paste the key after `PLANE_API_KEY=` and enter your workspace slug after `PLANE_WORKSPACE_SLUG=`. In `https://app.plane.so/my-team/projects/`, the slug is `my-team`.
3. Keep `PLANE_BASE_URL=https://api.plane.so/api/v1` for Plane Cloud; use your server's API URL for self-hosted Plane.
4. Optionally enter `PLANE_PROJECT_ID` to check that project's workflow states.
5. Run `npm run test:plane`. This performs only GET requests and does not change any work items. Without a key and workspace, it reports that the check was skipped.

The tracked `.env.example` can recreate this local file. The app does not automatically import credentials from it: the file is for the connectivity test. Enter the same key in the app to establish its encrypted desktop connection.

## Connect in the app

The owner-filtering preview uses version `0.1.7-rc.2` on `codex/plane-preview`. Build its separate Windows installer with `npm run package:preview`; the output is `release-preview/0.1.7-rc.2/Notion-Tasks-Preview-Setup-0.1.7-rc.2.exe`. It installs as **Notion Tasks Preview** with its own settings and encrypted credentials, so enter the Plane connection in that app after installing.

Run `npm run dev`, then open **Settings → Connection**. Enter the Plane API key, workspace slug, and API base URL; choose **Connect Plane**. Open **Sources**, select a Plane project, and confirm its complete and reopen states before saving the source. You can also paste a project URL.

Select a task to edit its title, status, or target date. Create tasks with **Add task**, and use the completion control to complete or reopen them. Plane target dates contain a calendar date only, so time inputs are disabled. **Open in Plane** opens the original work item. Stars and source colors stay local.

In Sources → Remap, optionally select **Assignees** as the Plane **Owner field**, or a Notion people property if available. Existing mappings remain compatible; choose the owner field once for an existing source, then save and refresh. The **Owner** filter is available in the full view's filter bar and in compact mode. It matches any owner on a task. Sources without an owner mapping always remain visible under this filter; unassigned tasks in a mapped source appear when **All owners** is selected. Owner mapping reads assignments for display and filtering; task edits do not change assignments.

## Implementation

| File | Responsibility |
| --- | --- |
| `src/main/plane.ts` | Plane v1 API requests, key header, project/state discovery, pagination, task normalization, task writes, and conflict detection |
| `src/main/index.ts` | Provider routing, independent connections, refresh, cached tasks, and guarded desktop operations |
| `src/main/persistence.ts` | Separate encrypted credentials and saved Plane connection metadata |
| `src/shared/types.ts` | Shared task/source models and typed Plane connection operations |
| `src/preload.ts` | Restricted bridge between the interface and Electron main process |
| `src/renderer/App.tsx` | Connection form, project selection, mixed task display, and editing controls |
| `scripts/plane-api-smoke.mjs` | Read-only connectivity test using your local key |
| `scripts/plane-smoke.mjs` | Synthetic end-to-end Electron test with no real workspace changes |

The renderer clears the key form after connecting. API requests run in Electron's main process. Installed credentials use Windows-backed Electron `safeStorage`, with separate files for Plane and Notion; the plaintext testing file remains local. The packaged app includes neither local environment files nor test credentials.

Sources and task IDs include Plane server/workspace/project identity. Failed source refreshes retain the last cache and prevent edits until the source reconnects. Before changing a field, the app reads the latest work item and checks it against the value originally loaded; a conflict requires review. This is not an atomic server-side lock, so simultaneous writes can still race between the check and update.

The integration modifies only task name, workflow state, and target date. It does not delete work items or modify project schemas, assignees, descriptions, or labels.

API references: [authentication](https://developers.plane.so/api-reference/introduction), [projects](https://developers.plane.so/api-reference/project/list-projects), [work items](https://developers.plane.so/api-reference/issue/list-issues), [updates](https://developers.plane.so/api-reference/issue/update-issue-detail).
