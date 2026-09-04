// session-state-prune-sweep.mjs — how much of session-state is safely reclaimable, and what
// must never be touched. REPORTS BY DEFAULT; deleting is opt-in and gated (GH #481).
//
// WHY THIS FILE EXISTS
// --------------------
// `~/.copilot/session-state/` has never been pruned. Measured 2026-09-04:
//
//     4,120 directories | 2.56 GB | oldest file 27 April
//     500 inuse.<pid>.lock files, of which 477 name a PID that no longer exists
//     23 directories actually held by a live process
//
// That is unbounded growth in the exact directory two liveness sweeps read to decide whether
// a session is alive, so it is not merely disk hygiene: it is the substrate of
// `stuck-run-sweep` and `zero-writer-sweep`. And 477 recorded PIDs on a recycling Windows PID
// space is a standing hazard — a recycled PID makes a long-dead session read ALIVE, which is
// #480's failure mode reached by a second route.
//
// ⛔ WHY THIS DOES NOT DELETE ANYTHING BY DEFAULT
// ----------------------------------------------
// The agent gate's floor list includes "Outcome can result in permanent data loss", and the
// floor outranks this repo's YOLO mode AND outranks a human `approve`. Asked directly:
//
//     consent -Action delete_data -Repo focus-planner
//       -> consent_ok: false, reason: gate-floor-blocks
//
// So the shippable half is the MEASUREMENT and the POLICY: what would go, what is protected,
// and how much that reclaims. Deletion requires `--apply`, which is documented here and is
// not to be run until Shiv says the word. Report mode is the default because a tool whose
// safe mode is the one you have to remember is a tool that eventually deletes something.
//
// THREE VETOES, AND THE SECOND IS THE ONE THAT IS EASY TO MISS
// -----------------------------------------------------------
//   LIVE   a directory held by a live PID. Deleting it kills a running session.
//   BOUND  a directory whose session id appears in the overnight-agent state store. That
//          binding is what lets a task continue across nights instead of cold-starting
//          (#404), and it survives the process: `last_woken_at` can be hours old on a
//          session that is merely idle, not dead. Age alone cannot see this, so a
//          purely-by-age pruner would silently break task continuity — the expensive
//          failure, and invisible until the next wake.
//   RECENT within the retention window. Cheap insurance against a session that is between
//          processes at the moment the sweep runs.
//
// Exit 1 when there is something to report (stdout, no stderr) so run-sweeps.ps1 classifies
// it FINDINGS rather than CRASH. Exit 2 when it cannot measure — a probe that could not look
// must never produce the same bytes as one that looked and found nothing (#346).
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');

const SESSION_ROOT =
  process.env.OA_SESSION_ROOT ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.copilot', 'session-state') : '');
if (!SESSION_ROOT || !fs.existsSync(SESSION_ROOT)) {
  console.error(`Cannot measure: session-state root missing (${SESSION_ROOT || '(unset)'}). Set OA_SESSION_ROOT.`);
  process.exit(2);
}

const STATE_DIR =
  process.env.OA_STATE_DIR ||
  (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state') : '');

// Days a directory must be untouched before it is even a candidate. A NUMBER, not a toggle:
// setting it to 0 would make every session prunable the instant it goes quiet, so 0 is
// treated as unset and falls back to the default rather than silently arming that.
const RETAIN_DAYS = Number(process.env.OA_SESSION_RETAIN_DAYS) || 14;
const RETAIN_MS = RETAIN_DAYS * 24 * 3600 * 1000;

/** Is this PID alive? Signal 0 probes without touching the process. */
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
};

/** Every session id the overnight-agent state store still considers bound to a task. */
const boundSessionIds = () => {
  const ids = new Set();
  if (!STATE_DIR || !fs.existsSync(STATE_DIR)) return ids;
  for (const f of fs.readdirSync(STATE_DIR).filter((x) => /^task-\d+\.json$/.test(x))) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8').replace(/^\uFEFF/, ''));
      const sid = st?.session?.session_id;
      if (sid) ids.add(String(sid));
      // The PREVIOUS session is kept too. `kickoff_continuation` names it so a replacement
      // knows it is continuing work, and #457 is about a session being unable to prove
      // anything about its own past — deleting that history makes the answer unknowable.
      const prior = st?.session?.prior_session_id;
      if (prior) ids.add(String(prior));
    } catch {
      // A state file we cannot parse is not evidence that nothing is bound. Skipping it here
      // only ever makes the pruner MORE eager, so the caller is told rather than left guessing.
      ids.add('__unparsed__');
    }
  }
  return ids;
};

const dirBytes = (dir) => {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirBytes(p);
      else {
        try { total += fs.statSync(p).size; } catch { /* vanished mid-scan */ }
      }
    }
  } catch { /* unreadable */ }
  return total;
};

const bound = boundSessionIds();
const unparsed = bound.delete('__unparsed__');
const now = Date.now();

const rows = [];
for (const name of fs.readdirSync(SESSION_ROOT)) {
  const dir = path.join(SESSION_ROOT, name);
  let stat;
  try {
    stat = fs.statSync(dir);
    if (!stat.isDirectory()) continue;
  } catch { continue; }

  const locks = (() => {
    try { return fs.readdirSync(dir).filter((f) => /^inuse\.\d+\.lock$/.test(f)); } catch { return []; }
  })();
  const pids = locks.map((l) => Number(/^inuse\.(\d+)\.lock$/.exec(l)[1]));
  const livePids = pids.filter(pidAlive);

  // Newest mtime in the directory, not the directory's own — a session writes events.jsonl
  // without necessarily touching the folder entry, so the folder can look stale while the
  // session is working.
  let touched = stat.mtimeMs;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) {
        try { touched = Math.max(touched, fs.statSync(path.join(dir, e.name)).mtimeMs); } catch { /* gone */ }
      }
    }
  } catch { /* unreadable */ }

  const ageDays = (now - touched) / 86400000;
  let veto = null;
  if (livePids.length) veto = 'LIVE';                       // veto LIVE
  else if (bound.has(name)) veto = 'BOUND';                 // veto BOUND
  else if (now - touched < RETAIN_MS) veto = 'RECENT';      // veto RECENT

  rows.push({ name, ageDays, veto, bytes: dirBytes(dir), locks: locks.length, deadLocks: pids.length - livePids.length });
}

const prunable = rows.filter((r) => !r.veto);
const held = rows.filter((r) => r.veto);
const sum = (a) => a.reduce((n, r) => n + r.bytes, 0);
const gb = (b) => (b / 1073741824).toFixed(2);
const byVeto = (v) => held.filter((r) => r.veto === v).length;

console.log(`session-state: ${rows.length} directories, ${gb(sum(rows))} GB total`);
console.log(`  reclaimable : ${prunable.length} dirs, ${gb(sum(prunable))} GB  (untouched > ${RETAIN_DAYS}d)`);
console.log(`  protected   : LIVE ${byVeto('LIVE')}, BOUND ${byVeto('BOUND')}, RECENT ${byVeto('RECENT')}`);
console.log(`  stale locks : ${rows.reduce((n, r) => n + r.deadLocks, 0)} inuse.<pid>.lock files naming a dead PID`);
if (unparsed) {
  console.log('  NOTE: at least one task state file could not be parsed, so the BOUND veto may be');
  console.log('        incomplete. Reported rather than assumed, because that error makes this MORE eager.');
}
console.log('');

if (!APPLY) {
  console.log('DRY RUN - nothing was deleted. This is the default and stays the default.');
  console.log('  Deleting session history is on the agent gate FLOOR ("Outcome can result in');
  console.log('  permanent data loss"), which outranks YOLO mode and outranks an `approve`.');
  console.log('  `--apply` exists for when Shiv says the word, and not before.');
} else {
  console.log('--apply passed: this WOULD delete the reclaimable set. Refusing without explicit');
  console.log('  consent recorded for delete_data on this repo. Nothing was deleted.');
  process.exit(1);
}

const oldest = [...prunable].sort((a, b) => b.ageDays - a.ageDays).slice(0, 3);
if (oldest.length) {
  console.log('');
  console.log('  oldest reclaimable:');
  for (const r of oldest) console.log(`    ${r.name}  ${r.ageDays.toFixed(0)}d  ${(r.bytes / 1048576).toFixed(1)} MB`);
}

process.exit(prunable.length ? 1 : 0);
