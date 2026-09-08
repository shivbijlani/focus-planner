#!/usr/bin/env node
/**
 * observe-bound-docs.mjs -- polls the catch-up doc comment channels that binding created,
 * so that being BOUND is what makes a channel read, rather than being SELECTED.
 *
 * GH #598.
 *
 * THE DEFECT, IN ONE LINE
 * -----------------------
 * `doc -Observe` is only ever called from PHASE 0.7, for the ONE task a run selects. A run
 * selects one task. So a channel is read only in the runs that were going to work that task
 * anyway -- and the tasks whose ONLY input is doc comments are, by construction, the tasks
 * parked awaiting Shiv and therefore never selected. Binding hands him a mailbox; nothing
 * opens it.
 *
 * WHY `NEVER_READ` UNDERSTATES IT BY AN ORDER OF MAGNITUDE
 * -------------------------------------------------------
 * catchup-doc-sweep's NEVER_READ arm counts channels with `observed_at` EMPTY -- read not even
 * once. That was the visible symptom (0 -> 5 in 90 minutes) and it is what #598 was filed on.
 * But a channel read once and never again is just as unreachable as one never read, and this
 * system already says so in its own code: `oa-state.ps1` sets
 *
 *     $script:DocObservationFreshMinutes = 180
 *
 * and the #500 capacity park refuses to park a task unless its channel was observed INSIDE that
 * window -- "a missing or stale `observed_at` is NOT parkable". 180 minutes is therefore not a
 * number invented here; it is the system's existing, load-bearing definition of a read that
 * still means something. This file reuses it rather than inventing a second threshold, because
 * two thresholds for one idea is how they drift apart.
 *
 * Measured on the live state store, 2026-09-07, 81 bound non-terminal tasks:
 *
 *     FRESH  (<180m):  13     <- 12 of these from a single manual burst, plus the selected task
 *     STALE (>=180m):  68
 *
 * So NEVER_READ said 5 and the true count of channels that cannot currently reach anyone was
 * 68. And the 13 fresh ones decay within the hour with nothing to renew them, so the steady
 * state is ~80 of 81 stale. The metric was not wrong, it was narrow: it measured the channels
 * that had never worked rather than the channels that do not work NOW.
 *
 * THE SECOND CONSEQUENCE, WHICH IS NOT ABOUT COMMENTS AT ALL
 * ---------------------------------------------------------
 * Because the park requires a FRESH observation as positive evidence that a channel is silent,
 * a stale channel is unparkable and the task reads as fully workable. That is #228 exactly: a
 * doc-bound task waiting on humans held the sole slot for ~3.3h because its ask was a pointer
 * and nothing could prove its channel was quiet. #500 shipped the park to stop that; this gap
 * disarms it for 84% of bound tasks. So the pacing control and the comment channel fail
 * together, from one missing poll.
 *
 * WHY BIND-TIME OBSERVE IS NOT THE FIX (AND WOULD HAVE SCORED GREEN)
 * -----------------------------------------------------------------
 * #598's own acceptance criterion #1 -- "catchup-doc-sweep reports channels UNREAD: 0 on a run
 * that binds new tasks" -- is satisfiable WITHOUT fixing anything. Observe at bind time and a
 * freshly created doc reports 0 comments truthfully, `observed_at` is stamped, NEVER_READ goes
 * to zero, and the channel is never read again. The proxy goes green while the thing it stood
 * for is untouched. That criterion was gameable and it was written on this issue by this agent;
 * it is recorded here rather than quietly dropped, because the criterion looking satisfied is
 * precisely how the defect would have survived its own fix.
 *
 * The load-bearing criterion is #2: a task bound and never selected still reports a truthful
 * `doc_new_comments`. That requires PERIODIC polling. Hence this file.
 *
 * SHAPE: BOUNDED, STALENESS-ORDERED, AND SELF-LIMITING
 * ---------------------------------------------------
 * Every poll is a Google call, and this repo has already been bitten by rate limits (#586,
 * #590), so the pass is capped per run. Ordering is oldest-first with never-observed ahead of
 * everything, so the worst channel is always served first and no channel can starve.
 *
 * It is also SELF-LIMITING: channels already inside the freshness window are not candidates at
 * all. So the pass does real work while the fleet is stale and almost none once it is caught
 * up -- it converges to quiet instead of re-reading 81 docs forever. That matters for the same
 * reason catchup-doc-sweep's own header argues its window is not a fudge factor: a check that
 * always fires, or a job that always maxes out, is one that gets switched off.
 *
 * At the default cap of 15 per run on the half-hourly cadence, 81 channels are fully refreshed
 * about every 3 hours, which is the freshness window it is keeping them inside.
 *
 * FAILURE DIRECTION
 * -----------------
 * One unreadable doc must not strand the rest of the pass, so failures are counted and the loop
 * continues. `-Observe` itself refuses a dump that is not positive evidence of a listing, so a
 * transport error CANNOT be recorded as "observed, nothing there" -- it stays stale and is
 * retried next run. That is the correct direction: re-reading a comment costs a duplicate
 * answer, while a false "read and empty" costs an instruction Shiv believes was received.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The system's own definition of a read that still means something (oa-state.ps1
// $script:DocObservationFreshMinutes). A number, not a toggle: 0 would make every channel
// permanently fresh and silently disarm the whole pass, so 0 falls back to the default -- the
// same convention catchup-doc-sweep uses for its windows, and for the same reason.
export const FRESH_MINUTES = Number(process.env.OA_DOC_FRESH_MINUTES) || 180;

// Per-run cap. Also a number, not a toggle, and 0 falls back for the same reason.
export const DEFAULT_LIMIT = Number(process.env.OA_DOC_OBSERVE_LIMIT) || 15;

const TERMINAL = new Set(['done', 'skip']);

/**
 * PURE. No I/O, no clock, no env -- `now` and the options are parameters, so the mutation check
 * can run this on the Linux CI runner with no state store and no Google. Same discipline as
 * ensure-catchup-doc.mjs's `decide()`, and for the same reason: the selection rule is the part
 * with the interesting failure modes, so it must be testable without the effects.
 *
 * Returns the tasks to poll, worst-first: never-observed before observed, then oldest first.
 * Channels already inside the freshness window are NOT candidates.
 */
export function selectStale(rows, { limit = DEFAULT_LIMIT, freshMinutes = FRESH_MINUTES, now = Date.now() } = {}) {
  const freshMs = freshMinutes * 60 * 1000;
  const candidates = [];
  for (const r of rows) {
    if (!r || !r.docId) continue;               // unbound: ensure-catchup-doc's job, not this one
    if (TERMINAL.has(String(r.status || ''))) continue;
    const t = Date.parse(String(r.observedAt ?? ''));
    // Unparseable and absent are the same thing here, and both mean "never credibly read".
    const ageMs = Number.isNaN(t) ? Infinity : now - t;
    if (ageMs < freshMs) continue;              // already fresh -- self-limiting
    candidates.push({ ...r, ageMs });
  }
  candidates.sort((a, b) => {
    if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs;   // oldest / never-observed first
    return Number(a.id) - Number(b.id);                  // stable, so a run is reproducible
  });
  return candidates.slice(0, Math.max(0, limit));
}

/** Human-readable age, for the report. Infinity is a real value here, not an error. */
export const ageLabel = (ms) =>
  ms === Infinity ? 'never' : `${Math.round(ms / 60000)}m`;

/**
 * PURE (the filesystem arrives as the `exists` probe, so this is testable with no disk).
 *
 * Resolve `oa-state.ps1`, which lives at a DIFFERENT relative offset in each of the two deploy
 * targets this file is copied into:
 *
 *   plugin tree  <plugin>/overnight-agent/checks/  -> ../skills/overnight-agent/oa-state.ps1
 *   OA home      %LOCALAPPDATA%/overnight-agent/   -> ./oa-state.ps1        (flat: no subdirs)
 *
 * The plugin-relative path was hard-coded, so in OA home it resolved to
 * `%LOCALAPPDATA%\skills\overnight-agent\oa-state.ps1` -- a directory that does not exist. That
 * is the copy `run-sweeps.ps1` actually invokes, so EVERY observation this file has ever
 * attempted failed, and the failure was per-task: 20 tasks produced 20 identical "the argument
 * ... does not exist" lines and a `failed 20` total, which reads like 20 Google failures rather
 * than one missing file. Hence the two changes here: probe both layouts, and when neither is
 * found say so ONCE and exit, rather than rediscovering it per task.
 *
 * Returns the resolved path, or null when nothing is found. An explicit `OA_STATE_PS1` wins even
 * if it does not exist -- an override that silently falls back to a different binary than the one
 * named is worse than one that fails loudly.
 */
export function resolveOaState({ here, env = {}, exists = () => false } = {}) {
  if (env.OA_STATE_PS1) return env.OA_STATE_PS1;
  const candidates = [
    path.join(here, 'oa-state.ps1'),                                    // OA home (flat)
    path.join(here, '..', 'skills', 'overnight-agent', 'oa-state.ps1'), // plugin tree
  ];
  return candidates.find((c) => exists(c)) || null;
}

// ---------------------------------------------------------------------------------------------
// Everything below is effects. Nothing above imports it.
// ---------------------------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (!isMain) {
  // Imported by the mutation check for `selectStale` alone. Do not touch the state store.
} else {
  const argv = process.argv.slice(2);
  const DRY = argv.includes('--dry-run');
  const limArg = argv.find((a) => a.startsWith('--limit='));
  const LIMIT = limArg ? Number(limArg.split('=')[1]) : DEFAULT_LIMIT;

  const PLANNER = process.env.PLANNER_PATH;
  if (!PLANNER) {
    console.error('PLANNER_PATH is not set. Run via run-sweeps.ps1, which exports it.');
    process.exit(2);
  }
  const STATE_DIR =
    process.env.OA_STATE_DIR ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state') : '');
  if (!STATE_DIR) {
    console.error('No state dir: set OA_STATE_DIR (or run on Windows, where LOCALAPPDATA is set).');
    process.exit(2);
  }

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const PROBE = path.join(HERE, 'mcp-probe.mjs');
  const OA_STATE = resolveOaState({ here: HERE, env: process.env, exists: (p) => fs.existsSync(p) });
  if (!OA_STATE) {
    console.error(
      'oa-state.ps1 not found next to this script, nor at ../skills/overnight-agent/. ' +
        'Set OA_STATE_PS1 to its full path.'
    );
    process.exit(2);
  }
  const EMAIL = process.env.OA_GOOGLE_EMAIL || 'shiv@bijlanis.com';

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  };

  // Same universe as every other sweep: the board is the list of live tasks.
  const boardFile = path.join(PLANNER, 'planner.md');
  const board = fs.existsSync(boardFile) ? fs.readFileSync(boardFile, 'utf8') : '';
  const activeIds = [...board.matchAll(/^\|\s*(\d+)[,\s|]/gm)].map((m) => m[1]);

  const rows = [];
  for (const id of activeIds) {
    const st = readJson(path.join(STATE_DIR, `task-${id}.json`));
    if (!st) continue;
    const doc = st.doc || {};
    rows.push({ id, status: String(st.status || ''), docId: doc.doc_id || '', observedAt: doc.observed_at || '' });
  }

  const bound = rows.filter((r) => r.docId && !TERMINAL.has(r.status));
  const due = selectStale(rows, { limit: LIMIT, now: Date.now() });
  const staleTotal = selectStale(rows, { limit: Number.MAX_SAFE_INTEGER, now: Date.now() }).length;

  console.log('observe-bound-docs (#598)');
  console.log(`  state dir     ${STATE_DIR}`);
  console.log(`  board         ${boardFile} (${activeIds.length} rows)`);
  console.log(`  bound         ${bound.length}`);
  console.log(`  stale         ${staleTotal} (>= ${FRESH_MINUTES}m or never observed)`);
  console.log(`  polling       ${due.length} this pass (cap ${LIMIT})${DRY ? '  [DRY RUN]' : ''}`);
  console.log('');

  if (!due.length) {
    console.log('Every bound channel is inside the freshness window. Nothing to poll.');
    process.exit(0);
  }

  let ok = 0;
  let failed = 0;
  const withComments = [];
  for (const t of due) {
    // The subject is printed BEFORE the result, on the same block, so the line cannot be read as
    // a claim about a task other than the one actually polled.
    const subject = `task ${t.id}  doc ${t.docId}  last read ${ageLabel(t.ageMs)}`;
    if (DRY) {
      console.log(`  PLAN   ${subject}`);
      continue;
    }
    const args = JSON.stringify({ document_id: t.docId, user_google_email: EMAIL });
    const fetched = spawnSync(process.execPath, [PROBE, 'google-workspace', 'call', 'list_document_comments', args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (fetched.status !== 0 || !fetched.stdout) {
      console.log(`  FAIL   ${subject}  -- fetch exited ${fetched.status}`);
      failed++;
      continue;
    }
    const dump = path.join(os.tmpdir(), `oa-doc-observe-${t.id}-${process.pid}.json`);
    try {
      fs.writeFileSync(dump, fetched.stdout, 'utf8');
      // -Observe refuses a dump that is not positive evidence of a listing, so a transport error
      // cannot be recorded here as "read, and empty".
      const obs = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OA_STATE, 'doc', '-Id', String(t.id), '-Observe', dump],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
      if (obs.status !== 0) {
        const why = String(obs.stderr || obs.stdout || '').trim().split(/\r?\n/).pop() || `exit ${obs.status}`;
        console.log(`  FAIL   ${subject}  -- observe: ${why}`);
        failed++;
      } else {
        // Exit 0 is NOT sufficient. `-Observe` reports `observation: "unreadable"` when the dump
        // was not positive evidence of a listing, and that is the one outcome that must never be
        // counted as a successful read -- treating it as success is the exact conflation
        // ("the read failed" vs "he said nothing") this whole channel exists to keep apart.
        let verdict = null;
        try { verdict = JSON.parse(String(obs.stdout || '')); } catch { /* fall through */ }
        const observation = verdict && verdict.observation ? String(verdict.observation) : 'unparseable';
        if (observation !== 'read') {
          console.log(`  FAIL   ${subject}  -- observation: ${observation}`);
          failed++;
        } else {
          const n = Number(verdict.new_comments || 0);
          console.log(`  OK     ${subject}  -- read, ${n} new`);
          if (n > 0) withComments.push({ id: t.id, n });
          ok++;
        }
      }
    } finally {
      try { fs.unlinkSync(dump); } catch { /* best effort */ }
    }
  }

  console.log('');
  // Finding comments and not saying so would rebuild the defect one layer up: the channel would
  // be read, and the reading would reach nobody. This is the line the run is expected to act on.
  if (withComments.length) {
    console.log(`NEW COMMENTS on ${withComments.length} task(s) nothing was going to read:`);
    for (const w of withComments) console.log(`  task ${w.id}: ${w.n} new`);
    console.log('');
  }
  console.log(`observed ${ok}, failed ${failed}, still stale ${Math.max(0, staleTotal - ok)}`);
  // A pass in which EVERY poll failed is a broken pass and must be loud. Partial failure is
  // normal (one doc can be unshared) and must not fail the run, or a single bad doc switches the
  // whole job off -- which is how this repo loses checks.
  process.exit(!DRY && ok === 0 && failed > 0 ? 1 : 0);
}
