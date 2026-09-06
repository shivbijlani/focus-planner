# Behaviour

This page is the acceptance suite: the requirements a rebuilt implementation must satisfy, grouped
by area and derived from the repository's 1,194 named tests across 83 files. Per-domain detail and
exact test provenance live on each `Domain-*` page; this page states the cross-cutting, testable
behaviour a rebuild is checked against.

## Board integrity

- The board reader and writer resolve `Wake` vs `Linked ID` **by header name**, never by fixed
  column index, on both a well-formed and a ragged row; a ragged Deferred row keeps its `Linked ID`
  and never has it misread as a `Wake` date (#426).
- A value misfiled into `Wake` is recovered into `Linked ID` without ever fabricating a snooze, and
  once recovered, snoozing the row afterward preserves the link rather than overwriting it (#446).
- Task-id allocation never collides: it ignores a foreign journal's own high id, skips ids that
  already have a journal, and skips the union of live content ids and journal ids, even when the
  content's own "max id" bookkeeping has gone stale (#528).
- A deleted id is tombstoned for a bounded TTL so a stale replica of its journal cannot hijack a
  freshly reused id; an expired tombstone releases the id; an invalid id in the store is ignored
  rather than accepted.

## Prioritisation and sort order

- `Work Priority`, urgency icon, the `## Priorities` list, section (`Today`/`Deferred`), board row
  order and task id compose into one deterministic sort key, applied in that precedence (see
  [Prioritisation](Prioritisation)).
- A row's `eligible` flag is computed once by `scan` from snooze state, reopened/unanswered-reply
  state, section, and the Today-gate verdict — never re-derived downstream.
- A Today row holds the gate against all Deferred rows unless declared exhausted, and an exhaustion
  declaration is cancelled by board-text change, TTL expiry, a superseding turn, or a live/unanswered
  reply reclaiming exclusivity — never by an unrelated `mark` call.
- The `Overnight Agent concurrency` setting parses only a bare integer, defaults safely and visibly
  to `1` on any malformed or missing value, and an explicit argument outranks the settings file which
  outranks the default.

## Storage and sync

- A local edit and a remote edit to the same file merge without data loss under the storage layer's
  CRDT rules; a delete on one side and an edit on the other resolve to a defined winner rather than
  silently dropping either change.
- Pagination, diagnostics logging, and sync-status reporting never leak file contents or raw
  provider tokens into a diagnostics record.
- A corrupted or partially-written tombstone/sidecar file is tolerated on read rather than crashing
  the sync engine; sync status coalesces rapid successive changes into one visible state rather than
  flickering.

## Journals and rendering

- Journal markdown parses into a chat thread where `<!-- from: agent-name -->` attributes a block to
  an agent, `<!-- from: me -->` reverts to the human, a bare `AUTO` marker also flags an
  agent-authored block, and a multi-line HTML comment is hidden from the rendered thread while still
  present in the file.
- The same journal-chat rendering logic runs identically whether invoked from the main app or
  embedded standalone in a generated task paper — one implementation, no divergent copy.
- A journal turn provenance marker is required for a block to read as agent-authored; an absent or
  malformed marker never silently reads as human consent (issue #272 in `overnight-agent`).

## Telegram bridge

- The digest extracts only the newest turn's blocking ask per task, never re-surfacing an
  already-answered one; digest ordering matches the board's own priority order.
- A reply routed back from Telegram is matched to the correct task/journal even when several
  messages arrive batched together, and an ambiguous or unmatched reply is never silently discarded
  without a visible signal.
- Live-status arbitration resolves two conflicting status updates for the same task to one
  deterministic value rather than a race (#202).

## Overnight-agent reliability

- A stuck workflow run is detected via a per-session lock-file liveness check and, under `--repair`,
  is actually fixed rather than only reported.
- An MCP server process is reaped only when no live owning session remains anywhere in its ancestor
  chain, and only after also passing a cohort check that catches processes no single rule would
  otherwise flag.
- A journal write refuses outright on each of `write-turn.ps1`'s named corruption classes (lost
  interpolation, doubled apostrophe, bad heading anchor, stray or missing provenance marker) rather
  than writing corrupted content.
- A journal's computed content hash depends only on its bytes, identically across PowerShell hosts
  with different default text encodings.
- Every `mutcheck-*` guard, when its real subject file is mutated on exactly one behavior, causes
  exactly the owning check arm to fail — proving the guard is load-bearing rather than decorative.

## Configuration and settings

- `agent-gate.md` is never overwritten by the agent that reads it; a missing or malformed settings
  cell resolves to a safe default and is reported as such, never silently substituted.
- `AGENTS.md` is regenerated with a version stamp so a stale copy is distinguishable from a current
  one at a glance.
- A user-settings edit is written back as a single, surgical cell change — the rest of the file's
  structure and content survive untouched.

## Repository tooling

- An empty (not merely missing) `node_modules` directory is detected and reported distinctly, before
  a downstream command fails with a confusing "not recognized" error.
- The verified PR merge order is checkable as a static property of the plan itself (no duplicates,
  no excluded-and-queued conflict, non-decreasing expected test count) independent of ever touching
  GitHub.
- A conflict between two open issues is flagged only when they share a specific, non-trivial target
  — two issues merely sharing a topic, or a long sentence merely containing a short one's words, are
  never flagged.

## Coverage note

`install-prompt` (0 test files) and portions of `overnight-agent` (behaviour enforced by PowerShell
`mutcheck-*` scripts rather than a conventional test runner) are the two acknowledged gaps in this
acceptance suite; see [Domain-install-prompt](Domain-install-prompt) and
[Domain-overnight-agent](Domain-overnight-agent) for what a rebuild should add first.
