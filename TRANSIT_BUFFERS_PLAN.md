# Location-aware transit buffers

Design for [issue #21](https://github.com/nlamb332/notion-tasks-desktop/issues/21). This is a proposal, not implemented behavior.

## Recommendation

Ship manual buffers first. Read event locations, classify each one, and reserve a user-set default travel time between commitments at different physical places. Let the user override any single gap. Keep buffers as internal planning constraints that never write to a calendar.

Do not add a maps provider or any device location access in the first version. Buffer accuracy depends mostly on knowing whether two events are in different places, and that works without a third party. A routing provider can be added later behind the same `travelMinutes` lookup if manual defaults prove too coarse in real use.

## Current state

- `RemoteCalendarEvent` and `CalendarEvent` have no location field. Google's `location`, `hangoutLink`, and `conferenceData` are returned by the API but discarded when events are mapped in `src/main/google-calendar.ts`.
- Notion calendars map only title and date properties, and ICS import reads no `LOCATION`.
- `generatePlan` treats busy time as the union of fixed events and retained blocks, so anything reserved must become a busy interval there.
- Approval already regenerates the plan and rejects any difference, and `refreshCalendarSnapshot` bumps `inputRevision` when event JSON changes. Adding location to `CalendarEvent` therefore makes a location edit stale a proposal with no new mechanism.

## Interpreting locations

| Source | Where the value comes from |
|---|---|
| Google | The event's `location` string. A `hangoutLink` or `conferenceData` marks the event as virtual, unless `location` also names a physical place. |
| Notion | An optional location property chosen during calendar mapping. It accepts rich text, select, or place properties. Calendar setup still never changes the schema. |
| ICS | `LOCATION`, unescaped the same way as `SUMMARY`. |
| Manual commitments | An optional location field in Diagnostics. |

Each event is classified into one kind. The order matters, and the first match wins.

| Kind | Rule | Example |
|---|---|---|
| `override` | The user set a place for this event | Marked "Campus" |
| `virtual` | Has a conference link, or the text is a URL or a known term such as Zoom, Teams, Meet, or "Online" | `https://zoom.us/j/…` |
| `physical` | Any other non-empty text, normalized by trimming, lowercasing, and collapsing whitespace | `Kellogg Global Hub 1120` |
| `unknown` | Empty text | No location |

Two physical events count as the same place when their normalized text matches, or when the user has saved both strings as aliases of one place. This is deliberately strict: `Global Hub 1120` and `Global Hub 2130` count as different places until the user groups them. The false-positive cost is a small extra buffer, which is safer than a missed trip. Fuzzy address matching is out of scope.

## User experience

Add a **Travel** card to Planning, below Working hours:

- **Default travel time**, in minutes. Default 20, range 0 to 240. Zero turns the feature off.
- **Unknown locations**, with three choices: *Treat as the same place* (default), *Add a shorter buffer*, or *Always add the default*. A shorter buffer defaults to 10 minutes.
- **Home base**, an optional label. No address is needed in the manual version; it only makes the first and last trips of the day explicit.
- **Saved places**, which group location strings that mean the same place.

Unknown defaults to no buffer because many personal events have no location, and blocking time around all of them would shrink capacity without evidence of travel. The Travel card and each affected gap show that the choice was applied.

On the week calendar from issue #20, reserved time appears as a hatched band labeled *Travel · 20 min*, visually distinct from events and blocks. Selecting a band offers **Change this gap** (minutes, or none) and **Same place** (which saves an alias). A proposal row that was pushed later by travel explains that in its reason text.

When a real gap is shorter than the buffer, the calendar shows *Tight: 10 of 20 min*. The fixed events are never moved, and no task can be placed in that gap.

## Data model

```ts
type LocationKind = 'physical' | 'virtual' | 'unknown';

interface CalendarEvent {
  // existing fields
  location?: string;          // Raw provider text, kept local
  locationKind?: LocationKind;
}

interface TravelSettings {
  defaultMinutes: number;     // 0 disables travel reservation
  unknownPolicy: 'same-place' | 'short-buffer' | 'default';
  unknownMinutes: number;
  homeBase: string | null;
  places: { id: string; name: string; aliases: string[] }[];
}

interface TravelOverride {
  fromKey: string;            // Stable event identity, or 'home'
  toKey: string;
  minutes: number | null;     // null means no travel for this gap
  fromFingerprint: string;    // Location and end time when set
  toFingerprint: string;      // Location and start time when set
}
```

`TravelSettings` joins `PlanningSettings`, and overrides sit beside them in `PlanningData`. `cleanPlanning` validates both, so existing state loads with travel off until the user sets a default. Upgrades therefore do not silently change capacity. An override is ignored when either fingerprint no longer matches, because a moved event may no longer be the same trip. The Travel card lists ignored overrides so they are not lost silently.

## Planning rules

Buffers live in one pure function, used by generation, approval, and the placement checks from issue #20:

```ts
travelIntervals(events, settings, overrides, days): TravelInterval[]
```

1. Sort each planning date's timed events in the planning timezone. Skip all-day events, because they do not establish a place, and skip transparent or cancelled events, which never reach `CalendarEvent`.
2. Skip `virtual` events when pairing. A virtual meeting does not move the person, so a trip spans from the last physical event to the next one. Travel is reserved immediately before the next physical commitment and must not overlap the virtual meeting. If the remaining free time is shorter than the buffer, the gap is marked tight. Whether someone can join a call while travelling is left as a per-gap override.
3. For each adjacent pair, look up `travelMinutes(from, to)`: an override first, then zero for the same place, then the unknown policy if either side is unknown, otherwise the default.
4. Place the buffer directly before the later event, clipped to the free gap between the two. If clipped, mark it tight.
5. For the first physical event of a working day, reserve travel from Home base when one is set. Do the same after the last physical event if the working window extends past it. With no Home base, reserve nothing, because the app cannot assume where the day starts.
6. Approved task blocks have no location. They are assumed to happen wherever the person already is, and they cannot sit inside a travel band.

`generatePlan` adds these intervals to `busy`, so proposal generation needs no other change. `capacityMinutes` falls accordingly, which keeps the capacity summary honest. Travel intervals are never owned blocks, and an existing approved block that newly overlaps one produces a move proposal through the same path as a fixed-event conflict, with its own reason text. A buffer never overlaps a fixed event by construction, because step 4 clips it.

Approval needs no separate logic. `approvePlan` regenerates and compares, and `placementConflict` checks the same intervals, so a dragged block cannot land on a travel band.

## Decision: internal constraints only

Buffers stay inside the app in the first version. Writing them to a calendar would add app-owned events to the ownership journal, change what other people see as free time, and create events whose start depends on other people's edits. An opt-in setting could come later, using the existing durable ownership model, but only if real use shows a need to show travel to others.

## Routing provider: later and optional

A provider becomes worthwhile only if manual defaults are repeatedly wrong. Any integration should meet these conditions before work begins:

- **Opt-in.** Off by default, with a clear statement that event locations are sent to that provider.
- **Credentials.** The user supplies their own API key, stored with `safeStorage` like existing tokens.
- **Data sharing.** Only origin and destination strings are sent, never event titles, attendees, or descriptions. No device location is used.
- **Cost.** Results are cached by normalized origin, destination, mode, and hour-of-week. Requests are limited to pairs in the seven-day horizon. Current pricing and quotas must be checked when a provider is chosen.
- **Failure.** A failed or ambiguous lookup falls back to the manual default and is shown as such. A lookup failure never blocks planning.
- **Cache privacy.** The cache stays in the local user-data directory and is cleared with **Disconnect**. Its terms must be checked, since some providers restrict caching of route results.

Travel modes would be a setting on that integration. They are not needed for manual buffers.

## Privacy

Raw location strings are stored in the same local state file as cached events and task data, which is not separately encrypted. `SECURITY.md` and the README should be updated to disclose this when the feature ships. Locations must never appear in logs. The manual version makes no new network requests.

## Acceptance scenarios

Assume a 20-minute default, working hours of 09:00 to 17:00, and no Home base unless stated.

| Scenario | Setup | Expected result |
|---|---|---|
| Different places | Hub 10:00–11:00, Clinic 12:00–13:00 | 11:40–12:00 is reserved. A 30-minute task can start at 11:00 but not 11:45. |
| Same place | Hub 10:00–11:00, Hub 12:00–13:00 | Nothing is reserved. The full hour is free. |
| Saved aliases | `Hub 1120` and `Hub 2130` saved as one place | Treated as the same place. |
| Remote meeting | Hub 10:00–11:00, Zoom 12:00–13:00 | Nothing is reserved around the Zoom meeting. |
| Remote between places | Hub 10:00–11:00, Zoom 11:00–12:00, Clinic 12:00–13:00 | No free time remains, so the gap is marked tight and the events are unchanged. |
| Unknown location, default policy | Hub 10:00–11:00, no location 12:00–13:00 | Nothing is reserved, and the Travel card shows that policy. |
| Unknown location, short buffer | The same events, with a 10-minute unknown buffer | 11:50–12:00 is reserved. |
| Back-to-back | Hub 10:00–11:00, Clinic 11:00–12:00 | Shown as *Tight: 0 of 20 min*. Both events stay fixed. |
| Short gap | Hub 10:00–11:00, Clinic 11:10–12:00 | The whole gap is reserved and shown as *Tight: 10 of 20 min*. |
| First of the day with Home base | Home base set, Hub 10:00 | 09:40–10:00 is reserved. |
| First of the day without Home base | Hub 10:00 | Nothing is reserved before it. |
| Override | The 11:40 trip above is changed to none | The hour is free. |
| Stale override | Clinic moves to 14:00 after the override | The override is ignored and listed, and the default applies. |
| Location changes after generation | Clinic's location changes while a proposal is open | The next refresh changes `inputRevision`, and approval reports the plan as stale. **Refresh draft and keep my moves** drops any move that now conflicts. |
| Time changes after generation | Clinic moves earlier into a proposed block | Approval rejects the plan, and no calendar write happens. |
| Manual drag onto travel | A proposed block is dropped on a travel band | The block stays where it was, and the conflict names the trip. |
| Approved block conflict | A new meeting creates a trip overlapping an approved block | A move proposal is offered for approval. The block is not moved automatically. |
| Calendar output | Any of the above | No travel event is written to any calendar. |

## Rollout

1. Carry `location` and its kind through Google, Notion, ICS, and manual events. Add a test for each provider. This step changes no planning behavior.
2. Add `TravelSettings`, `travelIntervals`, and the unit tests from the table above, with travel off by default.
3. Connect the intervals to `generatePlan` and `placementConflict`, and add the Travel card.
4. Draw travel bands on the week calendar, with per-gap overrides. This step depends on issue #20.
5. Review real use, then decide whether a routing provider is justified.

## Open questions for review

- Should the unknown-location default stay at no buffer, or should it be the short buffer? This doc recommends no buffer, to protect capacity.
- Should Home base be prompted for during setup, or stay optional in the Travel card? This doc recommends optional.
- Should a tight gap be a warning only, or should it also appear in the proposal summary? This doc recommends both, because it is the one case the planner cannot fix.
