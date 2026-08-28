# Overnight Agent — the nightly check suite

This directory is the versioned copy of the checks the Overnight Agent runs against
the planner every night.

## Why it exists

On 2026-08-26 a run measured something the settings file had only ever asserted.
Of the 73 files that make up this suite, **70 existed in exactly one place**:
`%LOCALAPPDATA%\overnight-agent` on a single laptop. No git history, no backup,
not even inside OneDrive.

That set included:

- all **37 detectors** that run every night,
- all **6 shared libraries** they import,
- all **19 mutation checks** that prove the detectors' guards are load-bearing,
- and **both safety wrappers** — `run-sweeps.ps1`, which exists because six sweeps
  once silently measured nothing and reported clean, and `run-telegram-mirror.ps1`,
  which exists because invoking the bridge by hand floods the user's Telegram in a
  way that cannot be undone.

A disk failure would have taken the entire enforcement layer with it, including the
mutation proofs that are the only evidence any of it works.

## How it stays fixed

Copying the files here fixes the problem once. It does not keep it fixed — the agent
writes new sweeps into `%LOCALAPPDATA%` most nights, and an archive nobody checks is
stale within a day. That is the same failure shape this project keeps re-learning: a
rule kept as prose regresses; a rule kept as an executable check does not.

So the archive is enforced by a check of its own, `repo-drift-sweep.mjs`, registered
in the standing suite. Every night it asks: **is every file the live registry depends
on present in git, and identical to what is running?**

It reports three things:

| Finding | Meaning |
| --- | --- |
| `UNVERSIONED` | A file the live suite depends on that exists in **no git ref at all**. This is the arm that prevents recurrence — a sweep written tonight and never committed is caught the next morning. |
| `MODIFIED` | Archived and live copies have diverged. The direction is reported, because *live ahead* (uncommitted work) and *repo ahead* (undeployed work) need opposite fixes. |
| `ORPHANED` | Archived but no longer referenced by the live registry. Informational — a retired sweep is not a defect, but a silently vanished one should still be visible. |

Two design decisions are worth knowing, because both were bugs first:

- **The corpus is derived from `run-sweeps.ps1`, not from a list kept here.** A
  hand-maintained roster would be one more thing to forget to update — the exact
  class of bug the sweep exists to catch. It parses the live registry and then walks
  each sweep's imports transitively, so a shared library can never be left behind.
- **"Versioned" is resolved against every git ref, not the current branch.** A file
  sitting in an open pull request is backed up and has history. Checking only the
  working tree reported two such files as lost on the very first run. A detector
  whose headline finding is wrong on night one is a detector nobody reads on night two.

Line endings are normalized before comparison. The repository has `core.autocrlf=true`
and no `.gitattributes`, so git stores LF and checks out CRLF; a byte-for-byte hash
would flag all 70 files as modified on a fresh clone.

## Moving files between the machine and the repo

`sync-checks.ps1` does this in either direction, and neither direction runs without
an explicit switch:

```powershell
# See what the machine has that the repo does not
sync-checks.ps1 -Capture

# Actually copy machine -> repo
sync-checks.ps1 -Capture -Confirm

# Disaster recovery: repo -> machine (overwrites live checks; backs each up first)
sync-checks.ps1 -Restore -Confirm
```

`-Restore` overwrites checks that are currently in use, so it is deliberately not the
default behaviour of running the script with no arguments.

## Running the suite

The suite is invoked only through its wrapper, never file-by-file:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File run-sweeps.ps1
```

The wrapper exports `PLANNER_PATH`, `BRIDGE_SRC` and `OA_TODAY`. Six of the sweeps
import the telegram-bridge source and exit 1 **having measured nothing** if
`BRIDGE_SRC` is unset — and because a sweep that *finds problems* also exits 1, the
exit code alone cannot distinguish "found issues" from "never ran". That ambiguity is
why the wrapper exists and why the sweeps are not run directly.

## Verifying a change

Detectors ship with a mutation check (`mutcheck-*.mjs`). It runs the real detector as
a child process against synthetic fixtures and asserts that disabling each guard
breaks **exactly** its own case and nothing else. This is not ceremony: it has already
caught a guard that looked correct and did nothing, and a harness whose own fixtures
produced a constant background finding that masked the signal it was measuring.

```powershell
node mutcheck-repo-drift.mjs
```
