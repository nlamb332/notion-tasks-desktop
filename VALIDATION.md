# Validation record

The desktop shell, Notion and Plane adapters, and renderer are checked by automated tests and integration review.

## Verified

- `npm run typecheck`: passes.
- `npm test`: 143 tests pass across backend, renderer helpers, optimistic completion/Undo, Notion boundary contracts, Plane pagination/endpoint isolation, provider credential persistence, owner mapping/filtering, desktop synchronization contracts, rolling-calendar scheduling, ICS validation, local approval, live Google/Notion adapters, and backward-compatible planning persistence. The suite passed under both UTC and America/Chicago on this run.
- `npm run build`: production renderer and Electron bundles build successfully.
- `npm run test:desktop`: passes when the Electron process-launch permission is enabled. This includes shell, mocked Notion integration (including breakdown recovery), Plane integration, and updater suites using isolated profiles and synthetic API responses.
- `node scripts/smoke.mjs --dev`: the Vite development renderer and Electron bridge pass the same shell smoke checks. Production retains its strict content policy; the development URL is limited to unpackaged loopback HTTP.
- `npm audit`: zero known advisories after patched tool versions and the build-time proxy dependency override.

Rolling-calendar unit coverage verifies a task placed into a gap between fixed events, leaf-only scheduling and estimate rollups, completed-child remaining effort, stale-plan rejection and idempotent approval, fixed-event conflict moves that remain uncommitted until approval, breakdown prerequisite blocking and recovery journal persistence, spring DST working-hour capacity, manual-calendar completeness gating, recurrence rejection, transparent/cancelled events, malformed event intervals, and persistence migration from pre-planning state. Live calendar orchestration tests cover atomic refresh failure behavior, unchanged-refresh revision stability, missing selections, ownership-marker loss, main-authoritative proposals, explicit recovery, partial writes with restart persistence, and stale destination rejection. Provider tests mock OAuth, Google event pagination/recurrence and ownership, Notion pagination/property mapping/markers/version conflicts, and no credential-bearing failures. Both UTC and America/Chicago runs pass. `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:desktop` pass. No live provider accounts or writes were used. An isolated Electron UI check also exercised Notion calendar discovery, explicit property mapping, live availability selection and the default write destination, with no renderer errors or horizontal overflow.

The Notion integration smoke uses synthetic provider responses only. Its breakdown cases cover persisted incremental child links and estimates, a rejected create followed by safe resume, an ambiguous create resolved to the exact refreshed task identity, duplicate-link rejection, exact task identity under concurrent creation, and reconciliation after restarting Electron. No real task data was changed.

The desktop integration suite exercises synthetic Notion URL fixtures, multiple sources, deduplication, page identity, create through IPC and the visible UI, edit, native status completion/reopening, conflict handling, preservation of unmapped Status 1, partial-source failures, cached task retention, offline write blocking, local stars, encrypted credential storage, credential deletion on disconnect, and last-successful-sync persistence. Tests do not modify real Notion content.

The shell smoke suite checks onboarding, the real preload bridge, renderer sandbox/context isolation, compact mode, always-on-top, and close-to-tray. Populated full, detail, and compact windows were captured and visually inspected; regression checks detect horizontal overflow in the detail view and compact document.

Review findings corrected include local date parsing, named timezone conversion, completion by configured option ID, database URLs using the `/p/` route, preserving multiple data sources in a database, Retry-After handling, avoiding automatic create retries after ambiguous server failures, stable form baselines for conflicts, stale async source/connection responses, persistence on close, and avoiding duplicate task-name identity fallbacks.

Final review regressions also verify that moving a range preserves duration (calendar days for date-only ranges), and source remapping is blocked while that source has queued or active task writes.

Version 0.1.1 adds inline header sync status, task drafts with due dates before creation, and optimistic completion with eight-second Undo. Eight completion tests cover immediate overlays, pending and acknowledged Undo, exact-status restoration, rejected writes, conflicts, repeat-click suppression, expiry, and newer synchronized task data. The desktop test explicitly pauses the mock Notion status write and verifies both immediate removal and immediate Undo before allowing the response to complete. Draft creation is checked to perform no write before confirmation and to preserve the chosen due date.

Version 0.1.2 defaults new Today-list drafts to the current local date. Desktop regression checks verify full and compact Today entry points, an editable suggested date, and blank defaults in All Tasks.

## Remaining verification requiring local setup

Owner filtering is verified with multi-owner tasks, other-owner and unassigned tasks, legacy sources without owner mappings, provider/server identity isolation, Notion people extraction, Plane roster names, and persisted cached owners. The desktop suite selects an owner in the visible full and compact filters and confirms that an unmapped Notion source stays visible while unmatched mapped-source tasks are hidden.

Plane desktop checks exercise the visible connection form, project discovery and mapping, task display, title and date edits, completion/reopening, UI creation, compact mode, conflict protection, independent disconnect, and blocked offline edits. Plane setup/details screenshots were visually inspected. Desktop-test responses are synthetic. Live read-only project, member, and assigned-task retrieval also succeeded against the configured self-hosted Plane server; no live Plane work items were changed. A real write cycle should use a disposable task. See [Plane integration](PLANE_INTEGRATION.md).

Automated verification does not establish live Notion access. Live permission checks and a real create/edit/complete cycle should use a disposable task after entering a token locally. Automated API tests use synthetic schemas and mocked responses. No token belongs in this repository or its issues.

The Windows installer is a personal unsigned build. Packaging does not install it or exercise Windows login startup. Login startup is opt-in. Windows tray shell behavior was exercised in Electron; end-to-end sign-in and installer UI were not automated.

Notion offers no atomic compare-and-swap write; preflight conflict checks cannot prevent a change made between validation and submission.
