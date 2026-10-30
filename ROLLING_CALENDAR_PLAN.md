# Rolling calendar planning

Status: implementation draft, 2026-10-30.

## Product goal

Help a user turn estimated task effort into a realistic plan for the next seven days. Fill available working time around existing commitments, explain what fits and what does not, and require approval before committing a recommendation. Task due dates remain deadlines rather than scheduled work times.

## Feature descriptions

### Estimate task effort

Task details accept a positive whole number of minutes, with convenient presets and an explicit Unknown state. Unknown is not zero. Estimates are local planning metadata keyed by provider, source ID, and task ID, so both Notion and Plane work without changing a remote database schema. Show total and remaining effort separately. Estimate changes invalidate pending recommendations.

### Break it down

An unknown or oversized task offers an editable breakdown form. The user enters child task names and minute estimates, orders the steps, and reviews the total before choosing Create subtasks. Create real tasks in the parent's source through the existing provider service. Persist local parent-child links and display navigable links in both directions. Do not silently create remote properties or claim that local links appear in Notion or Plane. Remote relationship mapping is a future optional capability.

Parents with children become containers: show the sum of descendant leaf estimates as total effort, and the sum of unfinished leaf estimates as remaining effort. Completed children contribute to total, not remaining. If any relevant leaf is unknown, label the rollup incomplete and show the known subtotal. Schedule leaves only, never both a parent and its children. Prevent cycles and multiple parents. The initial UI supports one breakdown level; validation still prevents malformed graphs. Creating children does not automatically complete a parent.

Persist a breakdown operation with a stable ID and child outcomes before/after remote calls. On partial failure show which children exist and retry only missing steps. Never repeat a child creation whose result is uncertain without reconciliation; show recovery needed instead. Local graph changes must not disappear on task refresh.

### Plan the next week

A Planning view shows seven local dates beginning today, working hours, fixed commitments, approved task blocks, proposed blocks, and an unscheduled list with reasons. Default working hours are Monday-Friday 09:00-17:00 in the user's selected IANA timezone, editable before generating. The horizon ends at local midnight after the seventh date; today begins at the later of working-hours start and now. No work is placed in the past.

The initial implementation accepts an explicit calendar snapshot through a documented import UI. Prefer a supported, validated ICS subset with clear errors for unsupported recurrence/timezone constructs; never silently omit busy events and present the snapshot as complete. A manual fixed-event form can supplement imports. Display snapshot provenance and import time. This is an explicitly labelled local planning calendar, not a claim of live Google/Outlook synchronization. Live provider integration is a separate phase requiring provider selection and OAuth registration.

Treat imported/manual events as fixed. Busy all-day events occupy their local dates; transparent/free and cancelled events do not block. For any recurrence support, expand occurrences and exceptions within the horizon correctly; otherwise reject the import with an actionable explanation. Reject invalid timezones and malformed intervals. A disconnected, failed, or incomplete import must not become an empty calendar with apparent availability. Require a usable snapshot, or an explicit user choice to plan against an empty calendar.

### Review and approve

Generate recommendations without calendar mutations. Show each task, duration, proposed time, reason, and any change from an existing approved block. Users approve selected recommendations or the whole plan, dismiss items, and regenerate. Approval writes local task blocks only in phase one. Clearly label them as local and provide ICS export of approved blocks for external calendars. Exported copies cannot be tracked or moved in another calendar; display that limitation near export. Live sync is required before promising externally flexible events.

Each recommendation carries an input revision. Before approval, validate against the current task metadata, graph, working hours, snapshot, and approved blocks. Reject stale plans and regenerate, rather than silently altering what was approved. A new fixed event overlapping an approved task block produces a conflict and a proposed move, not an automatic move. Moving, removing, or resizing an approved block requires a fresh approval. Past/in-progress blocks remain unchanged. Dismissing a proposal does not delete approved work.

### Rolling replanning

Recompute a draft after task estimates, completion, calendar import, or working-hours changes and on date rollover/focus; show a Needs review state. No background calendar mutation. Reuse existing fitting blocks to minimize churn. Fully completed tasks propose removal of future blocks; deleted/inaccessible tasks are flagged for review. Reserve remaining duration after subtracting future approved allocations, without double booking. Past blocks do not imply completed effort; require explicit progress/completion from the user. Unfinished past work can reappear as a proposal.

## Requirements and scheduling policy

1. Planning metadata and local blocks survive restart, provider refresh, and upgrade from existing persisted state. Stable and preview identities remain isolated.
2. Use integer minutes; reject NaN, infinity, negative, zero, fractional, and excessive values at the main-process boundary as well as in the UI. Choose and document a reasonable maximum.
3. Eligible tasks are unfinished, explicitly selected for planning, estimated leaves from accessible selected sources. Unknown effort appears in Unscheduled with a Break it down action. Missing or stale source data is visible.
4. Sort deterministically: overdue first, then earliest due deadline, starred tasks, then stable source/task ID. Within a breakdown, explicit step order is a finish-to-start prerequisite; block successors if predecessors are unknown or cannot fit. Arbitrary cross-task dependencies are deferred.
5. Find gaps by intersecting working windows with the horizon and subtracting the union of fixed busy intervals and retained approved blocks. Use half-open intervals so touching boundaries do not overlap.
6. Default to contiguous task placement. Optional splitting uses a configurable minimum block (default 15 minutes), never loses remainder minutes, and never exceeds the estimated remaining effort. If splitting is omitted initially, explain Task too long for available gaps and leave it unscheduled.
7. Place work before its due deadline when possible. Date-only deadlines mean end of that local date. Never silently schedule late work: use an explicit Late/overdue outcome requiring approval. No due date means any horizon slot is eligible.
8. Show capacity, allocated minutes, and unallocated minutes. Explain no estimate, prerequisite blocked, no fitting gap, outside horizon, calendar unavailable, and deadline cannot be met distinctly.
9. Only durable app block IDs establish flexibility. Never infer ownership from an event title. Reimported exported blocks must be reconciled by stable UID or treated as fixed to prevent duplicate scheduling.
10. Approval is idempotent and atomic for local state. Repeated clicks/restart recovery cannot duplicate blocks. Imported fixed events have no edit/delete operation through the planner.
11. Time calculations use Luxon and explicit IANA zones with UTC instants for intervals. Test DST gaps/folds, local day boundaries, overnight events, and timezone changes. A timezone change invalidates the draft.
12. No credentials, tokens, calendar contents, or task titles in diagnostic logs. Calendar data stays in the existing user-data storage. Disclose cache behavior consistently with existing task-cache documentation.

## Architecture

Keep the existing Electron main/preload/renderer boundary and provider adapters.

| Area | Responsibility |
| --- | --- |
| `src/shared/types.ts` or dedicated shared planning types | TaskRef, estimate, breakdown graph, calendar snapshot, fixed interval, owned block, plan proposal, revision and approval results |
| `src/main/planning.ts` | Pure deterministic scheduler, graph rollups, interval union/subtraction, dependency ordering, unscheduled explanations |
| `src/main/calendar.ts` | Calendar import validation and normalized snapshots; approved-block ICS export; future CalendarProvider interface |
| `src/main/persistence.ts` | Backward-compatible validated planning store, metadata, snapshots, owned blocks, operation journal and input revision |
| `src/main/index.ts` | Authenticated existing-window IPC, runtime validation, provider-backed child creation, invalidation, serialized/idempotent approval |
| `src/preload.ts` | Narrow typed methods to estimate, break down, configure/import calendar, generate/read/approve plan and export |
| `src/renderer` | Estimate editor, breakdown review, Planning view, settings, conflict/partial-failure recovery and accessible review controls |

Suggested records:

- TaskRef: provider + sourceId + taskId, serialized collision-safely.
- TaskPlanning: TaskRef, estimateMinutes|null, parentRef|null, stepOrder, selectedForPlanning.
- CalendarSnapshot: ID, importedAt, timezone, coverage, normalized fixed events, completeness/status, revision.
- PlanningSettings: timezone, weekly windows, optional minimum split duration, snapshot selection.
- OwnedBlock: durable ID/UID, TaskRef, UTC start/end, approvedAt, revision, provenance='planner'.
- PlanProposal: ID, generatedAt, inputRevision, horizon, suggested additions/moves/removals, retained block IDs, unscheduled reasons.
- BreakdownOperation: operation ID, parent ref, child request IDs, created refs, per-child outcome and recovery status.

The scheduler performs no network or disk writes. The main process owns authoritative state and rejects arbitrary renderer-supplied fixed/flexible flags. Treat proposals as derived data and validate/recompute from authoritative inputs on approval. Publish state through the existing state subscription.

## Delivery phases

1. Deliver a usable local vertical slice: estimates, real child tasks with local relationships and rollups, working hours, calendar snapshot import/manual commitments, seven-day recommendations, explicit approval, persistent owned blocks and approved-block export. Document exact supported import formats and limitations. Manual commitments alone are insufficient to claim external calendar gap filling; import must be available or the feature explicitly marked incomplete.
2. Live calendar connection: user chooses Google or Microsoft; implement installed-app OAuth, encrypted credential storage in main, calendar selection, busy reads with recurrence handling, owned-event writes with provider IDs/ETags, freshness validation and retry/reconciliation. Check current official provider documentation before implementation. Read selected calendars, write only a user-selected destination, and never edit unowned events. New approval authorizes specific provider writes; subsequent rolling changes still require approval.
3. Optional remote estimate/relation mappings, arbitrary dependency graphs, assisted breakdown suggestions, richer progress tracking and split policies.

No model service or AI credential is required for phase one: Break it down is a guided, user-authored form. Do not invent estimates without user review. No release publication, tag push, real task creation or real calendar write is authorized by implementation/testing alone.

## Acceptance and validation

- A 60-minute task fits a free hour between two fixed events; neither fixed event changes.
- An unknown parent becomes real 20- and 40-minute child tasks after confirmation, with a 60-minute rollup; only children are scheduled. Completing the first yields 40 remaining minutes.
- Existing old persistence loads with empty planning defaults; estimates and links survive source sync and restart.
- A seven-date plan contains no overlapping blocks, past work, out-of-window work or parent/child double counting. Overcapacity leaves explained unscheduled effort.
- Reimport adding a meeting conflicts with approved work, produces an uncommitted move, and rejects approval of the old draft.
- Approving twice produces one set of owned blocks. A partial breakdown retry does not duplicate successful children.
- An unsupported recurring import fails visibly; it never yields misleading free time. All-day, transparent, cancelled, overlapping and overnight events are covered.
- Tests cover DST, stale approval, parent cycles, unknown descendants, deterministic ordering, selected approvals, completed tasks, preservation of past blocks, and remainder duration.
- Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:desktop`. Use mocks and isolated desktop profiles; never real source/calendar mutations in tests. Update README and VALIDATION with implemented behavior and remaining live-provider limits. Local packaging is optional unless preparing a preview; follow AGENTS.md in that case.
