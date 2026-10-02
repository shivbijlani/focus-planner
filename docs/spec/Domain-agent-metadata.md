# Agent metadata — per-device session links (🤖)

**Bottom line.** A task on the board shows a 🤖 link that opens the agent session working it — and
only when that session was bound to *this* task, not to an earlier task that happened to have the
same ID. Each PC running the Overnight Agent publishes one small file describing its own task
sessions; the app reads only those files, never journals or the agent's private state, to paint the
link. Someone with one PC sees nothing new except the 🤖 link where a session exists. Someone with
two or more PCs sees which machine is working a task.

This page is the contract for that feature (spec scenario 10, "I run agents on multiple PCs and
assign work to one"; concept issue #652). It is written so a clean implementation — publisher,
reader or both — passes the same test vectors without reading any other implementation. Lanes,
device announcements and capability routing are later slices and are **not** part of it.

## What the user sees

| Situation | What the row shows |
| --- | --- |
| No agent, or no `agent-metadata/` folder in the planner folder | Nothing changes. No extra reads beyond one folder listing, no new UI, prompts or settings. |
| One PC has a live session for the task, bound to this row | One 🤖 link beside 📔 / 💬 / 📄. No device name anywhere. |
| One PC has more than one live session for the task | One 🤖 link per session (normally there is only one). |
| Two or more PCs have live sessions for the task | A single **🤖 2** (the number of sessions) button that opens a small menu: one entry per session, labelled with the device name. |
| The PC that published the link has not refreshed it recently | The same link, dimmed, with "last seen …" in its tooltip. It is not removed: the PC may just be asleep. |
| The row's title or Added date was edited after the session was bound | No link, until the binding is revalidated (see *Revalidation*). Editing back to the original text brings it back. |
| The task's ID was reused by a new task | No link: the new row's fingerprint does not match the old binding. |
| A published link is not a safe link | No link for that session (the other sessions still show). |

On the narrow (mobile) layout the 🤖 link follows the journal icons, which that layout hides; it
adds nothing there. A link opens in a new tab/app (`target="_blank"`, `rel="noopener noreferrer"`).

## Why fingerprints: the reused-ID problem

Task IDs are reused. The agent's per-task state is keyed by the task ID alone, so a session bound to
"task 356" would, after 356 was deleted and a new task created with the same number, silently point
the new row at the old task's session — exposing unrelated history. The board's tombstones and
self-healing IDs reduce reuse but do not prevent it, and they stay in place; fingerprints are an
additional check at the place the link is shown.

At **binding time** the publisher records a fingerprint of the row the session was bound to: a
SHA-256 over the normalised `[ID, Added, Task title]` of that row. The app computes the same
fingerprint from the row it is painting and shows the link only when the two are equal.

**The one case this cannot protect against: identical recreation.** If a task is deleted and a new
task is created with the same ID, the same Added date and the same normalised title, the two rows are
indistinguishable and the old session's link is shown on the new row. This is documented rather than
patched: nothing in the row can tell the two apart.

## The file

One file per device, written only by that device, in the planner folder (the folder that holds
`planner.md`, synced by OneDrive or Google Drive):

`agent-metadata/<device-key>.json` — `<device-key>` is 32 lower-case hex characters (see *Device
identity*). The folder is created by the first publish. The app never writes, renames or deletes
anything in it, and the sidebar file tree does not show it.

> [!NOTE]
> **Technical detail: annotated sample** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```json
{
  "schema": "fp-agent-task-metadata@1",
  "device": {
    "key": "86b8ff7cab63af69cc52ff83591b0ffd",
    "id": "3f2b9c4e-8d1a-4b7e-9f60-2c5d8e1a7b34",
    "name": "SHIV-DESKTOP"
  },
  "planner": { "board": "planner.md" },
  "revision": 42,
  "publishedAt": "2026-10-02T21:30:05.120Z",
  "lastSeenAt": "2026-10-02T21:30:05.120Z",
  "heartbeatMinutes": 30,
  "truncated": false,
  "tasks": {
    "468": {
      "fingerprint": "sha256:9945c3c23d25ea6448ffaeb4ca719b074eb20db11e3920c9b3ae2a7c42c21815",
      "bindings": [
        {
          "source": "copilot-app",
          "sessionId": "8864eba8-24dc-468a-a7c7-cb5efd2b6085",
          "status": "live",
          "boundAt": "2026-09-04T18:00:00.000Z",
          "verifiedAt": "2026-10-02T21:30:04.000Z",
          "url": "ghapp://sessions/8864eba8-24dc-468a-a7c7-cb5efd2b6085"
        }
      ]
    }
  }
}
```

| Field | Rule |
| --- | --- |
| `schema` | Exactly `fp-agent-task-metadata@1`. Any other value: the reader ignores the whole file (invalid). |
| `device.key` | 32 lower-case hex; must equal the file name stem **and** the key derived from `device.id`. |
| `device.id` | The device's random identity (UUID, lower-case). Not derived from hardware, account or path. |
| `device.name` | Display name, 1–64 characters after trimming, no control characters. The computer name by default — the same value the journal's `oa-by host=` stamp already carries. |
| `planner.board` | The board file name relative to the planner folder (`planner.md`). Never an absolute path. |
| `revision` | Integer ≥ 1, strictly increasing on every write by this device. |
| `publishedAt` | ISO-8601 UTC; when `tasks` last changed. |
| `lastSeenAt` | ISO-8601 UTC; when the device last wrote this file (every publish, even with no change). |
| `heartbeatMinutes` | Integer 1–1440: how often the device intends to publish. Optional; default 15. |
| `truncated` | `true` when caps forced entries to be dropped (see *Caps*). |
| `tasks` | Object keyed by canonical task ID (decimal digits, no leading zeros). At most 500 keys. |
| `tasks[id].fingerprint` | `sha256:` + 64 lower-case hex: the binding-time fingerprint of the row. |
| `tasks[id].bindings[]` | 1–4 entries, sorted by `sessionId`. |
| `bindings[].source` | Lower-case token `^[a-z][a-z0-9-]{0,31}$`; `copilot-app` for the GitHub Copilot app. |
| `bindings[].sessionId` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. |
| `bindings[].status` | `live` in v1. The reader shows only `live`; any other value is kept for forward compatibility and not shown. |
| `bindings[].boundAt` | ISO-8601 UTC when the session was bound to the task, or `null`. |
| `bindings[].verifiedAt` | ISO-8601 UTC when the host last *observed* the session (it appeared in the host's own session list), or `null` if never observed. |
| `bindings[].url` | Optional. Present only when observed from the host and safe (see *Safe links*). |

Unknown extra fields are ignored by readers (forward compatibility). The file is UTF-8 without BOM,
LF line endings, two-space indented, keys in the order shown, at most 256 KiB.

</details>

## Device identity

Each PC that runs the agent has a random device ID created once, on first publish, and kept in the
agent's home on that PC (`%LOCALAPPDATA%\overnight-agent\device.json`, outside the synced planner
folder). The key used in the file name is derived from it:

`key = first 32 hex characters of SHA-256( "fp-device@1" + LF + lower-case(device.id) )`

The ID is random, so neither it nor the key reveals the user name, machine serial, file paths or any
secret, and renaming the PC keeps the same file. Wiping the agent home creates a new device; the old
file stays (shown as stale) until the user deletes it. Two PCs restored from the same disk image share
a device ID; the publisher detects that (see *OneDrive*) and warns rather than fighting over the file.

> [!NOTE]
> **Technical detail: device key vectors** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| `device.id` | `device.key` |
| --- | --- |
| `00000000-0000-4000-8000-000000000000` | `49c15e85f7f7ffd841a8cb86d233f965` |
| `3f2b9c4e-8d1a-4b7e-9f60-2c5d8e1a7b34` | `86b8ff7cab63af69cc52ff83591b0ffd` |

`device.json` (agent home, never synced):

```json
{ "schema": "fp-agent-device@1", "id": "3f2b9c4e-8d1a-4b7e-9f60-2c5d8e1a7b34", "createdAt": "2026-10-02T21:00:00.000Z" }
```

</details>

## The fingerprint

The fingerprint is computed from three cells of the board row, located **by header name** in the
row's own table (`ID`, `Task`, `Added`), so column order and the Deferred table's extra `Wake`
column do not matter. Cells are the raw text between pipes, trimmed. Normalisation makes cosmetic
edits harmless and real edits visible:

| Part | Normalisation |
| --- | --- |
| ID | Unicode NFKC; take the part before `,[` (an attached tracker link); the first run of decimal digits; strip leading zeros (`0` stays `0`). No digits → the row has no fingerprint and never shows a link. |
| Added | Remove HTML comments; NFKC; collapse whitespace; trim. `YYYY-MM-DD` or `YYYY/M/D` (optionally followed by a time) and US `M/D/YYYY` become `YYYY-MM-DD` when they name a real calendar date. Anything else (including an impossible date such as `2026-02-30`) is kept as lower-cased text. Empty stays empty. |
| Title | Remove HTML comments (snooze markers and other machine notes); NFKC; remove emoji (Extended_Pictographic, regional indicators, skin-tone modifiers, variation selectors U+FE0E/U+FE0F, zero-width joiner U+200D, keycap U+20E3, tag characters U+E0020–U+E007F); collapse every run of whitespace (including no-break spaces) to one space; trim; lower-case with a locale-independent mapping. Punctuation and markdown are kept. |

`fingerprint = "sha256:" + lower-hex( SHA-256( UTF-8( "fp-task@1" LF id LF added LF title ) ) )`

None of the three normalised parts can contain a line feed, so the joined text is unambiguous and
the same in any language — no JSON serialiser is involved.

> [!NOTE]
> **Technical detail: fingerprint test vectors** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

Rows V1–V9 and V17 are cosmetic variants of V1 and must produce the same fingerprint; V10–V15 and
V18 are real differences and must not. `↦` shows the canonical text (LF shown as `⏎`).

| # | ID cell | Added cell | Task cell | Fingerprint |
| --- | --- | --- | --- | --- |
| V1 | `468` | `2026-09-02` | `Work GitHub issues` | `sha256:9945c3c23d25ea6448ffaeb4ca719b074eb20db11e3920c9b3ae2a7c42c21815` ↦ `fp-task@1⏎468⏎2026-09-02⏎work github issues` |
| V2 | `468` | `2026-09-02` | `  work   GITHUB<TAB>issues ` | same as V1 |
| V3 | `468` | `2026-09-02` | `🚀 Work GitHub issues ✅` | same as V1 |
| V4 | `468` | `2026-09-02` | `Work GitHub issues <!-- snooze:2026-10-09 -->` | same as V1 |
| V5 | `468` | `9/2/2026` | `Work GitHub issues` | same as V1 |
| V6 | `468` | `2026/9/2` | `Work GitHub issues` | same as V1 |
| V7 | `0468` | `2026-09-02` | `Work GitHub issues` | same as V1 |
| V8 | `468,[12345](https://dev.azure.com/x)` | `2026-09-02` | `Work GitHub issues` | same as V1 |
| V9 | `４６８` (full-width) | `2026-09-02` | `Work<NBSP>ＧｉｔＨｕｂ issues` | same as V1 |
| V10 | `468` | `2026-09-02` | `Work GitLab issues` | `sha256:709b3190ed8f9a81a6e3fc6b9ea69cde73ef519b85cd276d11b9fb6653359905` |
| V11 | `468` | `2026-09-03` | `Work GitHub issues` | `sha256:db0d477f53f5aa943b89a4aa196cee25b8ca4b4024ad1da6e0f25e11d07128dc` |
| V12 | `469` | `2026-09-02` | `Work GitHub issues` | `sha256:35c1337c0190acb991a5e1d7c790607b47f6123cddf2281c5de7a5ca4471041f` |
| V13 | `468` | *(empty)* | `Work GitHub issues` | `sha256:e53a335d866d1aa024e4b970c8cca8e0cc845bf3298461961cf5b5053c784cdc` |
| V14 | `468` | `2026-02-30` | `Work GitHub issues` | `sha256:cf8ba2a1401965221b0a8251bd73a1ba6dc67bcb9d221709fa4f22290982068a` |
| V15 | `468` | `Sept 2` | `Work GitHub issues` | `sha256:ca6cb914b85e67c04de7d89ace0639bd50ac70a67ae35a7994bcd71112ea0354` ↦ `…⏎sept 2⏎…` |
| V16 | `abc` | `2026-09-02` | `Work GitHub issues` | none — the row never shows a link |
| V17 | `468` | `2026-09-02` | `Work 👨‍👩‍👧 GitHub issues` | same as V1 |
| V18 | `468` | `2026-09-02` | `Work GitHub issues!` | `sha256:4f32d20ff057228053020ba0f4dd91871eaf4e7245f1624da6a89510b58fec23` |

The same vectors live as machine-readable fixtures beside the publisher and the reader tests, and
both suites run every one.

</details>

## Publisher rules (agent side)

The publisher is part of the sanctioned write tool — the only path by which an agent changes files
in the planner folder — as a subcommand of the agent's journal writer. The Overnight Agent
coordinator runs it once per run, after the session bindings for that run have settled. It works
whichever state engine (Node or the PowerShell fallback) produced the bindings, because it only
reads their result.

**What goes in.** A task is published when all of these hold: its per-task state has a `session`
whose `state` is `live`; its ID has a row in `planner.md` (any table; completed tasks have moved to
`planner-completed.md` and are therefore pruned); and that row has a fingerprint. Everything else is
left out, so a completed, deleted, released or dead binding disappears from the file at the next
publish. Nothing from the journal, the session's workspace, project, prompts or lineage is
published.

**Binding-time capture.** The publisher keeps a private ledger in the agent home
(`agent-metadata-publisher.json`, never synced) mapping `(task ID, session ID)` to the fingerprint
captured for it. The first publish that sees a pair captures the fingerprint of the row as it is
then — normally minutes after the bind, in the same run. A later publish **reuses the captured
fingerprint even if the row has changed**: that is what makes an edit, or a reused ID, hide the link.

**Revalidation.** The captured fingerprint is replaced with the current row's fingerprint only when:
(a) the task's session was woken after the capture (its `last_woken_at` moved past the capture
time) — the coordinator just handed that session the current row, so the binding is affirmed for it;
(b) a different session is bound (a new pair, captured fresh); or (c) the publisher is run with an
explicit `-Revalidate <id>` for that task. Nothing else revalidates.

**Safe links.** A binding's `url` is published only when the host's own session list (a snapshot of
the Copilot app's session list passed to the publisher) contains that session and reports a link for
it, and the link is one of:

- `ghapp://sessions/<sessionId>` where `<sessionId>` is exactly the binding's session ID (compared
  case-insensitively) — the Copilot app's own session link; or
- an `https://` URL with a host, no user name or password, no whitespace or control characters, at
  most 2048 characters.

A link is never synthesised from the session ID: a link the host did not report is not published
(the enterprise product learned this when a synthesised link opened a 404). When a list snapshot is
given and the session is absent from it, the binding is left out (the session is gone from the app).
When no snapshot is given, the last observed `url` and `verifiedAt` from the private ledger are
reused, and a never-observed binding is published without a `url`.

**Writing.** The publisher writes only `agent-metadata/<own key>.json`. It never reads-to-modify,
renames or deletes any other file in the folder. The write is atomic: the full content goes to
`agent-metadata/.<own key>.json.tmp` and is renamed over the target, retried up to 5 times with
back-off when the sync client briefly holds the file; if every attempt fails the previous file is
left intact and the command fails. `revision` is one more than the larger of the private ledger's
last revision and the revision in the current file. `publishedAt` changes only when `tasks`
changes; `lastSeenAt` changes on every publish. The state engines write each per-task state file
atomically, so the publisher reads them without the state lock (it never writes state); a state
file that cannot be read keeps whatever was published for that task rather than dropping it. A
per-device publisher lock in the agent home serialises two publishers on the same PC. A capture is
kept while its row is missing from the board, so a task deleted and recreated under the same ID is
compared with the original row rather than recaptured from the new one.

**Caps.** At most 500 tasks (lowest IDs first), 4 bindings per task (sorted by session ID) and
256 KiB per file; anything over a cap is dropped deterministically and `truncated` is set.

**OneDrive and other synced folders.** Two PCs never write the same file, so simultaneous publishes
cannot conflict. A sync client may still leave conflict copies (`<key> (1).json`, `<key>-PC.json`)
or a half-synced file; readers ignore any name that is not exactly `<32 hex>.json` and any file that
does not validate, so these are harmless and the publisher leaves them alone. If the current file's
`revision` is higher than the last revision this device wrote, another machine is writing with the
same device ID (a cloned agent home): the publisher still writes (its own key, its own file) but
reports `foreign_writer_suspected` so the run can tell the user.

> [!NOTE]
> **Technical detail: command and receipt** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```
node write-turn.mjs publish-metadata [-PlannerDir <dir>] [-StateDir <dir>] [-SessionsListFile <file>]
                                     [-Revalidate <id>[,<id>...]] [-HeartbeatMinutes 30] [-DryRun]
```

Defaults follow the state engine: planner folder `OVERNIGHT_AGENT_PLANNER_DIR`, else
`%USERPROFILE%\OneDrive\Apps\Focus Planner`; agent home `OVERNIGHT_AGENT_HOME`, else
`%LOCALAPPDATA%\overnight-agent`; state `<agent home>\state`. Under `OA_SANDBOX_ROOT` every path must
be inside the sandbox. `-SessionsListFile` holds the raw output of the Copilot app's session listing
(a JSON array of `{ id, app_url, … }`, optionally preceded by a one-line header).

Receipt on stdout (exit 0):

```json
{ "ok": true, "path": "agent-metadata/86b8ff7cab63af69cc52ff83591b0ffd.json", "written": true,
  "revision": 42, "tasks": 3, "bindings": 3, "changed": false, "truncated": false,
  "skipped": [{ "id": "512", "reason": "no_board_row" }], "warnings": [] }
```

`path` is relative to the planner folder (no absolute paths in output). Exit 3: bad arguments or a
sandbox violation. Exit 1: the write failed after retries (nothing changed on disk). `-DryRun` prints
the receipt and the would-be file without writing anything.

</details>

## Reader rules (app side)

The app reads `agent-metadata/` through the active storage provider — the same path every other
planner file takes — and nothing else to paint the 🤖 link: no journals, no agent state.

**Listing.** One listing of the folder per refresh. Only direct children whose name is exactly
`^[0-9a-f]{32}\.json$` are candidates; temp files, conflict copies and anything else are ignored
without a read. If the folder is absent, the feature is off: no reads, no UI.

**Limits.** A refresh starts at most once every 5 minutes (the first refresh after the board loads
or the storage source changes is immediate); at most 64 candidate files (lexicographically first)
are read, the rest ignored and counted in diagnostics; at most 2 reads run at once; a throttled
response (HTTP 429) pauses all reads until the later of its `Retry-After` and 5 minutes, keeping
everything already known.

**Validation.** A file is used only if it is at most 256 KiB, parses as JSON, has the v1 `schema`,
its `device.key` equals both its file-name stem and the key derived from `device.id`, its `revision`
is a positive integer, and its timestamps parse. Individual task entries or bindings that break a
field rule are dropped; the rest of the file still counts. A `url` is re-checked against *Safe
links*; a failing `url` hides that binding (it does not fall back to a link-less badge).

**States.** Each device's projection is in exactly one state, decided per refresh:

| State | When | Effect |
| --- | --- | --- |
| fresh | Read and valid; `lastSeenAt` within max(15 min, 2 × `heartbeatMinutes`) of now. | Links shown. |
| stale | Read and valid but `lastSeenAt` is older than that. | Links shown, dimmed, tooltip "last seen …". Never treated as removal. |
| unavailable | The read failed, timed out, was throttled, or the file did not validate this time. | The last good copy from this app session is kept and shown as stale; with no good copy, nothing is shown. A transient failure is never a deletion. |
| removed | A successful listing no longer contains the file, or a successful read no longer contains the task / binding. | That device's links (or that task's) disappear. |
| invalid | Schema, key or size check fails and there is no last good copy. | Ignored entirely. |

**Reordered arrival.** A file whose `revision` is lower than the last revision already accepted for
that key in this app session is ignored (an older copy arriving late from a sync client).

**Per-row visibility.** For a board row: compute its fingerprint (no fingerprint → nothing); collect
every `live` binding from every fresh, stale or unavailable-with-good-copy projection whose
`tasks[<canonical ID>].fingerprint` equals the row's fingerprint; drop duplicates of the same
`(device, sessionId)`; if none remain, show nothing. Bindings from one device → one 🤖 per binding;
bindings from two or more devices → one **🤖 N** menu with device names.

A binding with no `url` is shown as a 🤖 that is not a link (tooltip only), so the user still learns a
session exists.

> [!NOTE]
> **Technical detail: visibility scenarios** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

Board row for all cases: ID `468`, Added `2026-09-02`, Task `Work GitHub issues` (fingerprint V1).
"Now" is `2026-10-02T21:30:00Z`.

| # | Files in `agent-metadata/` | Expected for row 468 |
| --- | --- | --- |
| S1 | *(folder absent)* | nothing, and no file reads |
| S2 | one valid file, task 468 fingerprint V1, one live binding with `ghapp://` url, `lastSeenAt` 21:25 | one 🤖 link, no device name |
| S3 | as S2 but fingerprint V10 (title edited since bind) | nothing |
| S4 | as S2 but the row's title is now `🚀 work  github issues` | one 🤖 link (cosmetic edit) |
| S5 | two valid files (devices A and B), both V1, one live binding each | one **🤖 2** button; menu lists A and B by `device.name` |
| S6 | as S2 but `lastSeenAt` 19:00, `heartbeatMinutes` 30 | one 🤖 link, dimmed, "last seen" tooltip |
| S7 | as S2 plus `86b8…(1).json` and `.86b8….json.tmp` | one 🤖 link (the extra files are never read) |
| S8 | as S2 but file name stem ≠ `device.key` | nothing |
| S9 | as S2 but `url` is `javascript:alert(1)` | nothing |
| S10 | as S2 but `url` is `ghapp://sessions/<other id>` | nothing |
| S11 | as S2, then the next read fails | one 🤖 link, dimmed (last good copy kept) |
| S12 | as S2, then a successful listing without the file | nothing |
| S13 | as S2, then a read returns `revision` lower than the accepted one | unchanged from S2 |
| S14 | as S2 but binding `status` is `dead` | nothing |
| S15 | as S2 but no `url` | one 🤖, not a link |
| S16 | as S2 but the row's ID is `469` | nothing |
| S17 | 70 valid files | only the 64 lexicographically first are read |

</details>

## Privacy

The file carries task IDs, fingerprints (one-way hashes of text already in the same synced folder),
session IDs, the device's display name and the app's own session links. It never carries tokens,
credentials, absolute local paths, workspace or project names, journal or prompt text, or the
agent's state files. Publisher output reports paths relative to the planner folder only.

## Decisions taken conservatively (open questions)

These were not settled by the product owner; the most conservative choice was taken and each is easy
to revisit:

1. **Copilot app links are allowed alongside `https`.** The consumer host reports
   `ghapp://sessions/<id>` for every session; an `https`-only rule would mean no link ever. The
   `ghapp` form is accepted only for the exact session ID of the binding.
2. **Only `live` bindings are shown.** A dead session may still open its transcript, but a dead or
   deleted session may also open nothing; hiding it avoids a broken link.
3. **Wake revalidates.** Waking the bound session hands it the current row, so it re-captures the
   fingerprint. The alternative — only an explicit `-Revalidate` — would leave a single-PC user
   without the link after any rename until someone ran a command.
4. **Bootstrap trusts the current row.** Bindings that existed before the first publish are captured
   against the row as it is at that first publish. A binding that already pointed at a reused ID
   at that moment is not detected.
5. **Stale threshold scales with the publisher's cadence.** The consumer agent publishes once per
   30-minute run, so a fixed 15-minute threshold would show every link as stale half the time;
   `max(15 min, 2 × heartbeatMinutes)` keeps the enterprise 15 minutes as the floor.
6. **No link-less fallback for unsafe links.** A binding whose `url` fails validation is hidden, not
   shown as a plain 🤖, so a tampered file cannot advertise a session.
7. **Hidden on mobile.** The narrow layout hides the journal icons today; the 🤖 link follows them
   rather than adding new UI there.
8. **Old devices are not garbage-collected.** A device that stops publishing stays visible as stale
   until its file is deleted by hand; the app never deletes another device's file.

## Delivery

Three slices, each its own pull request (Refs #652): this contract; the publisher in the sanctioned
write tool with its own fixtures, mutation checks and the end-to-end sandbox assertion that the
sandbox planner folder gains a metadata file with no live paths in it; then the app reader, the row
badge and the smoke tests for S1–S5. Until the publisher ships, no file exists and the app shows
nothing new.

**Publisher (shipped).** `plugins/overnight-agent/skills/overnight-agent/agent-metadata.mjs`, run
as `write-turn.mjs publish-metadata`; the coordinator runs it as the last step before its wrap-up.
Its contract tests are `plugins/overnight-agent/tests/agent-metadata/publish.test.mjs` (every
vector in `tests/agent-metadata/vectors.json`, the machine-readable copy of the tables above), and
`plugins/overnight-agent/checks/mutcheck-agent-metadata.mjs` proves each rule is load-bearing. The
end-to-end sandbox scenario `metadata-published` (l1–l5) and invariant h3 check a real run. The
PowerShell state engine has no publisher of its own and needs none: the publisher reads the state
files either engine writes.
