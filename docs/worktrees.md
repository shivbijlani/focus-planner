# Working in a git worktree

Short version:

> **Run `npm ci` inside the worktree. Do not junction `node_modules` into it.**
> When you are finished, tear the worktree down with
> `pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path <worktree>` rather than
> `git worktree remove --force`.

## Why: `git worktree remove --force` deletes through a junction

The trick that used to get handed to every sub-session was to junction the main
checkout's `node_modules` into a fresh worktree, so it did not have to spend a
minute on `npm ci`:

```powershell
# DO NOT DO THIS
cmd /c "mklink /J node_modules V:\repos\focus-planner\node_modules"
```

`git worktree remove --force` then deletes **through** that junction. It does not
remove the link; it walks into the shared directory and empties it. Reproduced in
an isolated sandbox on 2026-09-02 (git for Windows, PowerShell 7.6.5):

```
shared node_modules top-level entries: before=4 after=0
git exit code: 0
  vitest   = False
  vite     = False
  react    = False
  .bin     = False
```

Three things make this worse than it first looks.

- **It exits 0.** Nothing warns, so the session that caused it moves on.
- **It is shared damage.** The emptied directory is the main checkout's, so *every*
  other worktree and the main checkout lose their dependencies at the same moment.
  Under concurrency — the normal mode now — one session tidying up breaks all its
  siblings.
- **It is silent until it is misattributed.** `node_modules` still exists; it is
  merely empty, so every existence check passes. The failure surfaces minutes
  later, in a different session, as `'vitest' is not recognized` or a partial test
  run — which reads like a broken change rather than a missing toolchain.

This was observed live and recorded as [#321](https://github.com/shivbijlani/focus-planner/issues/321).

### A measured correction

#321 assumed `Remove-Item -Recurse` shared the hazard. Measured on the same box,
same junction shape, 3 entries in the target every time:

| Form | Link removed | Target entries | Verdict |
| --- | --- | --- | --- |
| `[IO.Directory]::Delete($p,$false)` | yes | 3 | safe |
| `[IO.Directory]::Delete($p,$true)` | yes | 3 | safe |
| `Remove-Item -Recurse -Force` (pwsh 7.6.5) | yes | 3 | safe |
| `Remove-Item -Recurse -Force` (powershell 5.1) | yes | 3 | safe |
| `cmd /c rmdir` | yes | 3 | safe |

The delete-through is **git's own removal code**, not PowerShell's. "Use `rmdir`
instead of `Remove-Item`" therefore protects nothing; the fix is to unlink
*before* git runs.

## Do this instead

### Setting a worktree up

```powershell
git worktree add V:\repos\copilot-worktrees\focus-planner\<name> -b <branch>
cd V:\repos\copilot-worktrees\focus-planner\<name>
npm ci
```

`npm ci` costs about a minute once. Emptying the shared install costs every
concurrent session its toolchain, plus the time each one spends debugging a
change that was never broken.

If sharing really is wanted, share something that is **not deleted through**: a
package *store* that lives outside every worktree (pnpm-style), or npm's own HTTP
cache via `npm ci --cache <path>`. Neither puts a reparse point inside a directory
that git is going to recursively delete.

### Tearing a worktree down

```powershell
pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path <worktree> -DryRun   # look first
pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path <worktree>
```

The helper ([`scripts/worktree-safety.ps1`](../scripts/worktree-safety.ps1)):

1. refuses to run against the **main checkout** (only a linked worktree can be removed);
2. finds every directory link in the worktree by its **reparse-point attribute**, not
   by name — a junction called `.pnpm-store` is exactly as destructive as one called
   `node_modules` — and records it without descending through it;
3. unlinks each one **before** git is invoked;
4. **aborts without calling git** if any link survives that pass;
5. runs `git worktree remove --force` from the main checkout;
6. re-measures every junction target afterwards and **fails** if one went from
   populated to empty.

Step 6 is the part that matters most: it converts #321 from a silent success into
a reported failure.

If a junction remains for some reason, the manual safe teardown is to remove the
**link** first and only then call git:

```powershell
cmd /c "rmdir node_modules"          # removes the junction, never the target
git worktree remove --force <worktree>
```

Run `git worktree remove` from the main checkout, not from inside the worktree.
Measured 2026-09-02: `git -C <wt> worktree remove --force <wt>` exits 255 with
`failed to delete ...: Permission denied` **after** it has already deregistered the
worktree, leaving an orphaned directory and a misleading failure code.

## When it has already happened

`npm test` runs [`scripts/check-node-modules.mjs`](../scripts/check-node-modules.mjs)
first, which reports the emptied-but-present state explicitly instead of letting it
arrive as a missing binary. To repair:

```powershell
cd V:\repos\focus-planner
npm ci
```

No source is ever lost — only the installed dependencies.

## Briefing a sub-session

Any brief that hands someone a worktree must say:

- run `npm ci` inside the worktree; **do not** junction `node_modules`;
- tear the worktree down with `scripts/remove-worktree.ps1`, not
  `git worktree remove --force`;
- never delete or reinstall the main checkout's `node_modules` to fix a local
  problem — other sessions are using it.

## Guard

[`scripts/mutcheck-worktree-safety.ps1`](../scripts/mutcheck-worktree-safety.ps1)
builds throwaway git repos, fake shared installs and real junctions under a temp
directory, removes each guard in turn, and asserts the shared target dies without
it. Arm A is a deliberate control: with the unlink defence removed it reproduces
the 2026-09-02 damage exactly, which is what proves the harness can still see the
failure the other arms claim to prevent.

```powershell
pwsh -NoProfile -File scripts/mutcheck-worktree-safety.ps1
```

It is Windows-only (junctions are an NTFS feature) and self-skips elsewhere; CI
runs it on `windows-latest`.
