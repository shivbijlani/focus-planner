# Lanes — scope each agent PC to part of the plan

**Bottom line.** Someone who runs the Overnight Agent on more than one PC can say "ADO work runs on
the work laptop, home errands run on the desktop". A task gets a *lane* from a tag in its board row,
from an assignment made in the app, or from the first parent task that has one; each PC is assigned
the lanes it serves, and one or more PCs can also take every task that has no lane (*catch-all*). A
PC's agent only ever picks up, wakes or binds a session for a task in a lane it serves — enforced in
the state engine, not left to the agent's judgement. The lane assignment lives in one file the app
writes and the agent only reads, so an agent can never give itself work. Someone with one PC, or
with no lanes set up, sees and gets exactly what they get today: no new UI, no new files, no change
in what the agent picks.

This page is the contract for that feature (spec scenario 10, "I run agents on multiple PCs and
assign work to one"; decision "Multiple PCs: lanes and per-device metadata files first; capability
routing later"). It is written so a clean implementation — the engines, the app, or both — passes
the same test vectors without reading any other implementation. It builds on
[Domain-agent-metadata](Domain-agent-metadata): the device identity, the per-device file and its
staleness rules are reused, not redefined. Capability routing (`needs:`, `assign:`, `exclude:`) and
a claim primitive between two catch-all PCs are later slices and are **not** part of it.

## What the user sees

| Situation | What changes |
| --- | --- |
| One PC, or no lanes set up (no `agent-lanes.json` in the planner folder) | Nothing. The agent picks work exactly as today; `#lane:` text in a title is just text; the app shows no lane UI. |
| Two or more PCs have announced themselves, no lanes set up yet | The app offers **Devices & lanes** in its settings. Nothing else changes until the user assigns a lane. |
| Lanes set up; a task carries a lane a live PC serves | A small lane chip on the row. Only that PC's agent works it. |
| A task carries a lane that no live PC serves | The chip shows ⏳ and "Waiting for a PC that serves lane *ado*" (naming the PC and when it was last seen, if one is assigned but asleep). The task waits; it is never dropped and never silently handed to another PC. |
| A task carries two different lanes (for example a `#lane:` tag and a different assignment) | The chip shows ⚠ and the two lanes. No PC works it until the user resolves it. |
| A task has no lane | Any catch-all PC may work it. A PC with no lanes assigned is catch-all, so before anyone assigns anything every PC behaves as it does today. |
| Two or more live PCs are catch-all | The Devices panel warns that both may pick the same task with no lane. |
| `agent-lanes.json` cannot be read or does not validate | A banner says the lanes file is broken and agents are paused until it is fixed. Every PC's agent stops picking new work (fail closed), rather than guessing who should do what. |

## Words

- **Lane** — a short name such as `ado` or `home`: lower-case letters, digits and hyphens, starting
  with a letter, at most 32 characters (`^[a-z][a-z0-9-]{0,31}$`). The names `none`, `any`, `all`,
  `catchall` and `default` are reserved; only `none` has a meaning (below).
- **Device** — one PC running the agent, identified by the random device key from
  [Domain-agent-metadata](Domain-agent-metadata) (32 lower-case hex characters). Renaming the PC keeps
  the key.
- **Announcement** — a device's own `agent-metadata/<device-key>.json`, which every run's `scan`
  refreshes. Lanes add nothing to that file: its existence and `lastSeenAt` are the announcement.
- **Serves** — a device serves a lane when the lanes file assigns that lane to it; a device serves
  the tasks with no lane when it is catch-all.

## How a task gets its lane

A task's lane is resolved from three sources. The first two are the task's **own** lane; the third
is **inherited**.

1. **A `#lane:<name>` tag in the task's board row.** Typed by hand into the Task cell, for example
   `Renew the ADO PAT #lane:ado`. Case does not matter (`#Lane:ADO` is `ado`). The tag must start
   the cell or follow a character that is not a letter or digit, so `me#lane:home` is not a tag. Text
   inside an HTML comment (`<!-- … -->`) is ignored. A tag whose name is empty, breaks the lane-name
   rule or is reserved (other than `none`) makes the task's lane **invalid**.
2. **An assignment in the lanes file** (`tasks` map), made from the app's row menu. It names the task
   by ID.
3. **The first parent that has a lane.** The board's `Linked ID` column names a task's parent. If the
   task has no own lane, each ID in its Linked ID cell is resolved in the order written, and the
   first one that resolves to anything (a lane, an explicit `none`, a conflict or an invalid lane)
   decides. A parent that is not on the board (completed or deleted) contributes only its lanes-file
   assignment. The walk is depth-first, never visits a task twice in one resolution (which also cuts
   cycles), and stops after 16 levels.

Rules that make this predictable:

- **Own lanes must agree.** If a task's own sources name two different lanes — two tags, or a tag and
  a lanes-file assignment that differ — the task is in **conflict** and no PC works it. The same lane
  named twice is fine. There is no precedence between own sources: a conflict is the user's to
  resolve, never the engine's to guess.
- **An own lane beats an inherited one.** A child of an `ado` epic tagged `#lane:home` is `home`.
- **`none` opts out.** `#lane:none` (or a `none` assignment) means "this task has no lane, even though
  its parent does". It is served by catch-all PCs and is inherited like any lane, so a whole subtree
  can opt out at its root.
- **Problems propagate.** A child whose first lane-bearing parent is in conflict or invalid is itself
  in conflict or invalid, so a typo in an epic never routes its children to the wrong PC.
- **A lane nobody serves is still a lane.** `#lane:cloud` with no PC assigned `cloud` waits and is
  surfaced; it does not fall back to catch-all.
- **The journal is not a source.** A `lane:` line in a task journal has no effect (see *Decisions*).

> [!IMPORTANT]
> **Technical detail: resolution test vectors.** Every implementation (both engines and the app) must
> reproduce this table exactly; the same vectors ship as a machine-readable fixture.

<details>
<summary><strong>Show technical detail</strong></summary>

Board (`## Today`, header `| ID | 🎯 | Task | Work Priority | Added | Linked ID |`, every Added cell
`2026-09-01`, every urgency 🟡) and lanes-file `tasks` map `{ "5": "ado", "10": "ado", "25": "ado",
"26": "ado" }`. Task 5 is not on the board.

| # | ID | Task cell | Linked ID | `lane` | `lane_source` | `lane_from` | `lane_problem` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 10 | `ADO epic` | | `ado` | `map` | | |
| R2 | 11 | `ADO child` | `10` | `ado` | `inherited` | `10` | |
| R3 | 12 | `Grandchild` | `11` | `ado` | `inherited` | `10` | |
| R4 | 20 | `Home errand #lane:home` | | `home` | `tag` | | |
| R5 | 21 | `Untagged` | | *null* | *null* | | |
| R6 | 22 | `Child overrides #lane:ado` | `20` | `ado` | `tag` | | |
| R7 | 23 | `Opt out #lane:none` | `10` | *null* | `tag` | | |
| R8 | 24 | `Two lanes #lane:home #lane:ado` | | *null* | `tag` | | `conflict` (`ado`, `home`) |
| R9 | 25 | `Tag vs map #lane:home` | | *null* | `tag` | | `conflict` (`ado`, `home`) |
| R10 | 26 | `Agrees #lane:ado` | | `ado` | `tag` | | |
| R11 | 27 | `Bad tag #lane:a_b` | | *null* | `tag` | | `invalid` (`a_b`) |
| R12 | 28 | `Shouting #LANE:ADO` | | `ado` | `tag` | | |
| R13 | 29 | `Cycle one` | `30` | *null* | *null* | | |
| R14 | 30 | `Cycle two` | `29` | *null* | *null* | | |
| R15 | 31 | `Two parents` | `21, 20` | `home` | `inherited` | `20` | |
| R16 | 32 | `Child of a conflict` | `24` | *null* | `inherited` | `24` | `conflict` (`ado`, `home`) |
| R17 | 33 | `Parent completed` | `5` | `ado` | `inherited` | `5` | |
| R18 | 34 | `Hidden <!-- #lane:ado -->` | | *null* | *null* | | |
| R19 | 35 | `Cloud job #lane:cloud` | | `cloud` | `tag` | | |
| R20 | 36 | `In brackets (#lane:home).` | | `home` | `tag` | | |
| R21 | 37 | `Empty #lane:` | | *null* | `tag` | | `invalid` (empty) |
| R22 | 38 | `Twice #lane:home and #lane:HOME` | | `home` | `tag` | | |
| R23 | 39 | `Email me#lane:home` | | *null* | *null* | | |
| R24 | 40 | `Grandchild of opt-out` | `23` | *null* | `inherited` | `23` | |
| R25 | 41 | `Reserved #lane:any` | | *null* | `tag` | | `invalid` (`any`) |

Tag grammar: after removing `<!--.*?-->`, every match of `(?<![\p{L}\p{N}])#lane:([A-Za-z0-9_-]*)`
(case-insensitive prefix) in the Task cell (located by header name `Task`, as the fingerprint does).
The captured text is lower-cased with a locale-independent mapping and then checked against the
lane-name rule; `none` is allowed, the other reserved names are not. A task whose own sources agree
on `none` and a lane at once (`#lane:none #lane:ado`) is a conflict. When own sources agree and
include a tag, `lane_source` is `tag`; when only the lanes file names it, `map`. For an inherited
result, `lane_from` is the ID of the ancestor whose own source decided it (not the nearest parent).
Linked IDs are the IDs the board reader already extracts from the `Linked ID` cell (a date there is
not an ID), canonicalised (leading zeros stripped). When an ID has more
than one row on the board, the tags of every row count. `lane_candidates` lists the distinct names
seen (sorted ordinally) for a conflict or an invalid lane, and is empty otherwise.

</details>

## Where the assignment lives: `agent-lanes.json`

One small file in the planner folder, beside `planner.md`: **`agent-lanes.json`**. The app writes
it; every PC's agent reads it; no agent ever writes it. Its absence is what makes the feature
invisible: when it does not exist, lanes are off everywhere.

It holds two maps: which lanes each device serves (and whether it is catch-all), and which tasks the
user has assigned to a lane from the app. Board tags stay in the board.

**Why a separate file, not a section of `agent-gate.md`.** The lane mapping is authority, like
consent: a PC that could edit it could give itself any task. It therefore gets the same protection as
`agent-gate.md` — the sanctioned write tool refuses it as a target (guard G20) and the per-device
publisher never touches it. It is still kept out of `agent-gate.md` because that file is prose the
user writes, read by a rule vocabulary that has nothing to do with machines and task IDs; it exists for
every user (so "absent means off" would not work); and a broken or half-synced lanes map must never
risk the consent reader. A JSON file is also invisible in the app's file tree (which lists only
markdown), so a single-PC user never sees it. It cannot live in `agent-metadata/`, because every file
there is written by an agent.

> [!NOTE]
> **Technical detail: annotated sample and field rules.** The envelope a writer produces and a
> reader validates.

<details>
<summary><strong>Show technical detail</strong></summary>

```json
{
  "schema": "fp-agent-lanes@1",
  "revision": 3,
  "updatedAt": "2026-10-03T12:00:00.000Z",
  "devices": {
    "49c15e85f7f7ffd841a8cb86d233f965": { "name": "HOME-DESKTOP", "lanes": ["home"], "catchAll": true },
    "86b8ff7cab63af69cc52ff83591b0ffd": { "name": "WORK-LAPTOP", "lanes": ["ado"], "catchAll": false }
  },
  "tasks": { "5": "ado", "10": "ado", "25": "ado", "26": "ado" }
}
```

| Field | Rule |
| --- | --- |
| `schema` | Exactly `fp-agent-lanes@1`. |
| `revision` | Optional integer ≥ 1, one more than the previous on every app write. Not used by the engines; the app ignores a copy older than one it already accepted in this session. |
| `updatedAt` | Optional ISO-8601 UTC of the last app write. Informational. |
| `devices` | Optional object (absent = `{}`). At most 64 keys, each a device key (`^[0-9a-f]{32}$`). |
| `devices[k].name` | Optional display name copied from the device's announcement when the app wrote the entry, so a hand-editor can tell devices apart. Never authoritative. |
| `devices[k].lanes` | Optional array (absent = `[]`) of at most 16 lane names, each already valid and lower-case; reserved names (including `none`) are not allowed. Duplicates are ignored. |
| `devices[k].catchAll` | Optional boolean (absent = `false`). |
| `tasks` | Optional object (absent = `{}`). At most 2000 keys, each a canonical task ID (decimal digits, no leading zeros); each value a valid lane name or `none`. |

The file is UTF-8 (a leading BOM is tolerated), at most 256 KiB, and must parse as one JSON object.
Unknown extra fields anywhere are ignored (forward compatibility). **Any other violation makes the
whole file invalid** — there is no partial use, because dropping one device's entry would silently
widen that PC to catch-all. Writers emit keys in the order shown, devices and tasks sorted by key
(tasks numerically), two-space indent, LF line endings.

</details>

> [!IMPORTANT]
> **Technical detail: lanes-file validation vectors.** What a reader concludes from each file.

<details>
<summary><strong>Show technical detail</strong></summary>

| # | `agent-lanes.json` | Verdict |
| --- | --- | --- |
| C1 | absent | **off** — lanes play no part anywhere |
| C2 | empty, or only whitespace | invalid |
| C3 | `not json` | invalid |
| C4 | `{ "schema": "fp-agent-lanes@2" }` | invalid |
| C5 | `{ "schema": "fp-agent-lanes@1" }` | ok — no devices, no assignments (every PC is catch-all; tagged tasks wait) |
| C6 | a device key `86B8FF7CAB63AF69CC52FF83591B0FFD` (upper case) or of 31 characters | invalid |
| C7 | a device with `"lanes": ["none"]` | invalid |
| C8 | a device with `"lanes": ["Ado"]` | invalid |
| C9 | a device with `"catchAll": "yes"` | invalid |
| C10 | `"tasks": { "010": "ado" }` | invalid |
| C11 | `"tasks": { "10": "none" }` | ok |
| C12 | `"tasks": { "10": "a_b" }` | invalid |
| C13 | an extra top-level `"notes": "x"` | ok (ignored) |
| C14 | larger than 256 KiB | invalid (not parsed) |
| C15 | a UTF-8 BOM before a valid object | ok |
| C16 | 65 devices, or a device with 17 lanes, or 2001 tasks | invalid |
| C17 | a device with `"lanes": ["ado", "ado"]` | ok (one `ado`) |
| C18 | a device entry `{ "catchAll": true }` | ok (no lanes, catch-all) |
| C19 | `[]`, or `"devices": []` | invalid |

</details>

## What a device serves

Each run, the engine works out which device it is and what that device serves:

| This PC | Serves |
| --- | --- |
| Lanes off (no file) | Everything — today's behaviour, byte for byte. |
| File invalid | **Nothing**: no task is eligible, dispatched or bound here until the file is fixed. (Rows still report the lane their board tags give them.) |
| No device identity yet (`device.json` absent in the agent home) | It cannot have been assigned anything, so it is **unassigned**. |
| Device identity unreadable or corrupt | **Nothing** (it cannot know which entry is its own). |
| Its key is not in `devices` (unassigned) | Catch-all: every task with no lane. |
| Its key is in `devices` | Exactly the listed lanes, plus every task with no lane when `catchAll` is `true`. |

A task is **served here** when it has a lane this device serves, or has no lane (including an explicit
`none`) and this device is catch-all. A task in conflict or with an invalid lane is served nowhere.

The device identity is the one the per-device publisher created: `device.json` in the agent home (the
parent of the state folder), and its key derived as in [Domain-agent-metadata](Domain-agent-metadata).
The lanes reader never creates it.

> [!IMPORTANT]
> **Technical detail: served-here vectors.** Using the sample file above and the resolution vectors.

<details>
<summary><strong>Show technical detail</strong></summary>

Device A = `86b8ff7cab63af69cc52ff83591b0ffd` (id `3f2b9c4e-8d1a-4b7e-9f60-2c5d8e1a7b34`; serves `ado`,
not catch-all). Device B = `49c15e85f7f7ffd841a8cb86d233f965` (id `00000000-0000-4000-8000-000000000000`;
serves `home`, catch-all). Device C = `0f4c028b56c2f65942cb7d72a7d34e6f` (id
`11111111-1111-4111-8111-111111111111`; not in the file, so catch-all).

| Task resolves to | Examples | A | B | C |
| --- | --- | --- | --- | --- |
| `ado` | R1 R2 R3 R6 R10 R12 R17 | ✅ | — | — |
| `home` | R4 R15 R20 R22 | — | ✅ | — |
| no lane (including `none`) | R5 R7 R13 R14 R18 R23 R24 | — | ✅ | ✅ |
| `cloud` (no device serves it) | R19 | — | — | — |
| conflict or invalid | R8 R9 R11 R16 R21 R25 | — | — | — |

With a file that does not validate, every cell is —. With no file, every cell is ✅.

</details>

## Engine rules (agent side)

Both state engines (`oa-state.mjs`, the one the agent runs, and the `oa-state.ps1` fallback) apply
lanes identically. **The agent cannot work around them by skipping a step**: they are properties of
the commands the agent must call, the same way the consent floor and the snooze and paused-task
guards are.

**Reading.** Every command that decides eligibility re-reads `agent-lanes.json` from the folder that
holds `planner.md` and `device.json` from the agent home. Nothing is cached between commands, so an
edit made in the app applies from the next command after it syncs.

**`scan`.** When lanes are off, nothing about `scan` changes — no new fields, no new rows, the same
bytes. When the file exists:

- every row gains `lane`, `lane_source`, `lane_from`, `lane_problem`, `lane_candidates` and
  `lane_served_here`;
- a row not served here is never `eligible`, never `plan_review_due`, and never holds the Today gate
  on this PC (its `today_release_reason` is `lane_not_served`), so another PC's Today task cannot stall
  this PC's Deferred work;
- the compact worklist leaves out rows not served here (they are another PC's business) and reports
  them in a `lanes` summary — this device's key, whether it is assigned, the lanes it serves, whether
  it is catch-all, the file's state and the count of rows left out; the full worklist (`-OutFile`)
  keeps every row with its lane fields, so a run stays auditable.

**`session`.** Waking (`-ForDispatch`), checking (`-CheckDispatch`) or binding a new session
(`-SessionId`) for a task not served here is refused before anything is written, with a message that
names the task's lane, where it came from and what this PC serves — `session_lane_not_served`,
`session_lane_conflict`, `session_lane_invalid` or `session_lanes_config_invalid`. Releasing a binding,
recording a dead session and reading a task's session are always allowed, so a PC can still clean up
after a lane change.

**Never written by an agent.** The sanctioned write tool's G20 guard refuses `agent-lanes.json` as a
target exactly as it refuses `agent-gate.md` and `user-settings.md`, the per-device publisher writes
only its own `agent-metadata/<key>.json`, and the end-to-end sandbox asserts the file is byte-identical
after a run.

**Concurrency.** "Concurrency 1" stays per PC: each PC works one task at a time, and a task still
working from an earlier run holds that PC's slot. Lanes make sure two PCs never hold the same laned
task; two catch-all PCs can still pick the same task with no lane (today's multi-PC behaviour), which
is why the app warns about it.

> [!IMPORTANT]
> **Technical detail: engine behaviour vectors.** Each is a characterization case recorded once and
> run against both engines.

<details>
<summary><strong>Show technical detail</strong></summary>

| # | Setup | Expected |
| --- | --- | --- |
| E1 | No `agent-lanes.json` (every existing case) | `scan`, `scan -Compact` and `session` output unchanged. |
| E2 | Device A; row 20 (`home`) has an unanswered human reply | Row 20: `eligible: false`, `lane_served_here: false`; absent from the compact rows; counted in `summary.lanes.rows_out_of_lane`. |
| E3 | Device A; the only workable Today row is `home` | It does not hold the Today gate here (`holds_today_gate: false`, `today_release_reason: lane_not_served`); A's workable `ado` Deferred row is eligible. |
| E4 | Device A; `session -Id 20 -CheckDispatch` / `-ForDispatch` | Exit 1, `session_lane_not_served: …`, no file changed. |
| E5 | Device A; `session -Id 20 -SessionId <new>` | Exit 1, `session_lane_not_served: …`, no binding written. |
| E6 | Device A; `session -Id 20 -SessionRelease` | Allowed, as today. |
| E7 | File invalid (C3) | Every row `eligible: false`; `summary.lanes.state: invalid`; dispatch refused with `session_lanes_config_invalid`. |
| E8 | File C5, device unassigned, no tags | Same eligibility and order as with no file; rows carry the lane fields with `lane: null` and `lane_served_here: true`. |
| E9 | Device A; row 24 (conflict) | Not eligible; `session -Id 24 -CheckDispatch` refused with `session_lane_conflict`. |
| E10 | `device.json` corrupt | Nothing served; `summary.lanes.state: device_identity_corrupt`. |

`summary.lanes` (compact and `-OutFile` summaries only; the full array output has no summary):
`{ "state": "ok" | "invalid" | "device_identity_corrupt", "reason": <text or null>, "device": <key or
null>, "assigned": <bool>, "serves": [<lanes>], "catch_all": <bool>, "rows_out_of_lane": <n> }`.

</details>

## App rules

The app reads `agent-lanes.json` and the `agent-metadata/` announcements through the active storage
provider, like every other planner file. It is the only writer of `agent-lanes.json`.

**When anything shows.** The **Devices & lanes** panel is offered only when at least two devices have
announced (valid files in `agent-metadata/`, fresh or stale) or the lanes file already exists. Lane
chips and the lane row-menu appear only when the lanes file exists. With one PC and no file the app
renders exactly what it renders today, and `#lane:` text in a title is shown as typed.

**Devices & lanes panel.** One line per announced device: its name, last seen, and fresh/stale (the
staleness rule from [Domain-agent-metadata](Domain-agent-metadata)). For each, the user adds or
removes lanes and switches catch-all. It warns when two or more fresh devices are catch-all, and when
a lane used by a task is served by no device. Devices listed in the file that no longer announce are
shown as "not seen" so their entry can be removed. Saving writes the whole file (new `revision`,
`updatedAt`, the device's current name). **Turn lanes off** deletes the file after a confirmation,
returning every PC to today's behaviour.

**Row chip.** A row with a lane shows a chip with the lane name. When no fresh device serves it, the
chip shows ⏳ with "Waiting for a PC that serves lane *x*" — naming the assigned PC and when it was
last seen, or "No PC serves lane *x*" if none is assigned. A conflict or invalid lane shows ⚠ with the
problem. A row with no lane shows nothing. The title text is never altered.

**Row menu.** "Lane…" sets the task's assignment in the lanes file: a lane, "No lane" (`none`) or
"Inherit" (removes the assignment). When the row has a `#lane:` tag the menu says so and does not
offer a different lane, since that would create a conflict; the user edits the title instead.

**Broken file.** When the file does not validate, a banner says agents are paused until it is fixed;
the panel shows the reason and offers to replace it with an empty valid file.

> [!NOTE]
> **Technical detail: app visibility scenarios.** Smoke and unit tests cover these.

<details>
<summary><strong>Show technical detail</strong></summary>

| # | Planner folder | Expected |
| --- | --- | --- |
| A1 | no `agent-metadata/`, no lanes file | no panel, no chips, no menu item; `#lane:home` shown as typed |
| A2 | one device file, no lanes file | as A1 |
| A3 | two device files, no lanes file | panel offered; no chips, no menu item |
| A4 | lanes file (sample), A fresh | row 10 chip `ado`; row 21 no chip |
| A5 | lanes file, A stale | row 10 chip ⏳ "Waiting for a PC that serves lane ado — WORK-LAPTOP, last seen …" |
| A6 | lanes file, row 35 `#lane:cloud` | chip ⏳ "No PC serves lane cloud" |
| A7 | lanes file, row 24 | chip ⚠ naming `ado` and `home` |
| A8 | lanes file does not validate | banner; no chips |
| A9 | B and C both fresh and catch-all | panel warning |
| A10 | assign `home` to device C in the panel | file rewritten with `revision` + 1 and C's entry; nothing in `agent-metadata/` written |

</details>

## Edge cases

- **The file arrives on one PC before another.** Until it syncs, a PC follows the copy it has; a task
  can briefly be worked twice or briefly wait. Both settle at the next run.
- **A task moves lane while a session is live on the old PC.** The old PC stops waking it (dispatch is
  refused) but keeps the binding, so its 🤖 link stays; the new PC starts its own session and the board
  shows "🤖 2". The old binding is released by hand or when the task completes.
- **A PC is wiped.** It gets a new device key, so it is unassigned (catch-all) until the user assigns
  the new entry; the old entry shows as "not seen".
- **Two PCs cloned from one image** share a device key and therefore an assignment; the publisher
  already warns about this (`foreign_writer_suspected`).
- **A parent is completed.** Its board row is gone, so only a lanes-file assignment for it still
  passes down; a lane that came from its `#lane:` tag stops applying to its children. Assigning the
  epic in the app, rather than tagging it, survives completion.
- **Lanes are a routing rule, not a security boundary.** They stop an honest agent from taking another
  PC's work and stop any agent from changing the assignment. They do not stop a compromised PC from
  editing its own agent home to claim another PC's key.

## Machine identity on agent messages

Every turn the sanctioned write tool appends already carries `<!-- oa-by: session=<id> host=<computer
name> -->`, the same computer name a device announces. Lanes rely on that and add nothing to journals.
Showing the PC's name in the app's chat bubble is deferred.

## Decisions taken conservatively (open questions)

These were not settled by the product owner; the most conservative choice was taken and each is easy
to revisit:

1. **No `lane:` directive in the journal (yet).** The journal is a file the agent writes, so a lane
   read from it would let an agent re-route its own task — the same reason consent is read from
   human-authored segments and the enterprise product removed journal leases. Tags (in the board,
   which agents never edit) and the lanes file (which agents cannot write) cover the same need.
2. **The tag is `#lane:<name>`, not a bare `#name`.** A bare hashtag the user wrote for another reason
   would silently move a task to another PC; a misspelt explicit tag waits and is surfaced instead.
3. **A separate `agent-lanes.json`**, protected like `agent-gate.md`, rather than a section of it (see
   *Where the assignment lives*).
4. **Own sources conflict instead of taking precedence.** A tag and an app assignment that disagree
   stop the task rather than picking one.
5. **A broken file stops every PC.** Fail closed, like an unreadable gate switches every approval
   channel off: a transient sync glitch costs one run, a wrong guess could run work on the wrong
   machine.
6. **An unassigned PC is catch-all; an assigned PC is not, unless switched on.** Before anything is
   assigned every PC behaves as today; assigning a lane to the work laptop makes it work only that
   lane.
7. **A lane nobody serves waits**, surfaced in the app, rather than falling back to catch-all.
8. **No claim between catch-all PCs.** Two catch-all PCs can still take the same task with no lane;
   the app warns. A claim primitive, if one is built, lives outside the journal.
9. **Announcements reuse the metadata file unchanged.** The heartbeat in each run's `scan` is the
   announcement; a separate watchdog announcement is deferred.
10. **The title is not rewritten.** The app shows a chip but never strips or adds `#lane:` text, and the
    app's own assignments go to the lanes file, so they never change a row's 🤖 fingerprint. Adding a
    tag by hand does change the fingerprint; the link reappears at the next wake.

## Delivery

Three slices, each its own pull request (Refs #652): this contract; the engines (both, with
characterization cases E1–E10, the resolution vectors as a fixture, mutation checks, G20, and an
end-to-end sandbox scenario with two device identities in which the agent works only its own lane and
leaves `agent-lanes.json` untouched); then the app (lanes reader and resolver run against the same
vectors, the panel, chips and row menu, and smoke tests for A1–A3 proving a single-PC user sees no
change). Until the engine slice ships, the file has no effect.

**Engines (shipped).** `plugins/overnight-agent/skills/overnight-agent/oa-state-lib/plan/lanes.mjs`
(the Node engine the agent runs) and the twin functions in `oa-state.ps1` (`Read-Lanes`,
`Resolve-TaskLane`, `Assert-LaneServed`, …); `scan` and `session` call them, and both write tools'
G20 lists `agent-lanes.json`. Tests: `plugins/overnight-agent/tests/lanes/lanes.test.mjs` runs every
resolution, validation and served-here vector in `tests/lanes/vectors.json` (the machine-readable copy
of the tables above); the characterization cases `cases/lanes.json` pin E2–E10 and R1–R25 from the
PowerShell engine and the Node engine passes the same goldens; `mutcheck-lanes.ps1` proves each rule
load-bearing on both engines; `tests/write-turn-port/g20-lanes.test.mjs` covers G20; and the
end-to-end sandbox scenario `lanes-scoped` (m1–m4) with invariant h4 checks a real run.
