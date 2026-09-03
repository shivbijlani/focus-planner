// installed-skill-drift-sweep.mjs
//
// GUARDS: the skill files the agent ACTUALLY EXECUTES must be a version we can name.
//
// repo-drift-sweep (2026-08-26 18:00) asks whether every *detector* is in git. It walks the
// run-sweeps.ps1 registry in %LOCALAPPDATA%. It never looks at
// ~\.copilot\installed-plugins\focus-planner\ -- the plugin the CLI loads and runs. So the
// live SKILL.md and the live oa-state.ps1 were checked by nothing at all.
//
// Why that matters, measured 2026-08-26 18:40: the installed oa-state.ps1 was byte-identical
// to commit 90716eb -- the #191 sibling-skill fix, which is NOT an ancestor of origin/main.
// So the running agent was executing a hand-deployed file that exists on no merged ref, while
// origin/main still carried the 217-line Aug-3 version with none of the reopen fixes. Two
// consequences, both silent:
//
//   1. FORWARD: a fix can be committed, pushed, PR'd and green in git while production stays
//      broken, because deploying it is a manual copy nobody scheduled.
//      unstamped-runlog-reopen-sweep probes the INSTALLED script; it was red for 8
//      consecutive runs (17:17 -> 18:32) against a branch that was green the whole time, and
//      the run that shipped it recorded "turns green when 192 lands". That is false: merging
//      to main does not write to installed-plugins. Nothing would have turned it green.
//   2. BACKWARD: a plugin reinstall/update would overwrite the hand-deployed file with main's
//      copy and silently REVERT both reopen fixes, with no detector to notice.
//
// VERDICTS
//   MAIN         the installed bytes match origin/main. Fine.
//   BRANCH-ONLY  they match some other ref but not main -- a live fix that is backed up (it is
//                pushed) but that a reinstall would revert. A finding, severity "revert risk".
//   UNVERSIONED  they match no ref at all -- not recoverable from git. A finding, severity
//                "no backup". Same rationale repo-drift-sweep uses to rank an open-PR file as
//                backed-up rather than lost: reachable-from-a-ref is the line that matters.
//   MISSING      the file is on origin/main but is ABSENT from the installed tree -- merged and
//                never deployed. A finding, severity "merged but dead". (Added 2026-08-26 19:15.)
//
// WHY `MISSING` EXISTS (the direction the first cut could not see)
// ----------------------------------------------------------------
// The original sweep walked the INSTALLED tree and asked "is this file in git?". That answers
// the BACKWARD direction only. It structurally cannot see the FORWARD one -- a file that main
// ADDS and the installed tree LACKS is never enumerated, so it can never be reported.
//
// That is not hypothetical. PR #151 ("reap stale MCP servers before PHASE 0") merged as 3be794c,
// +271/-1 across exactly two files: it ADDED reap-stale-mcp.ps1 to the plugin and wired the
// reaper into SKILL.md's PHASE 0. Measured 2026-08-26 19:10: the installed tree contains NO
// reap-stale-mcp.ps1, and the installed SKILL.md contains ZERO occurrences of the string
// "reap-stale-mcp". Every line of that PR is merged and dead. The sweep -- built one run earlier
// for precisely this failure -- reported 0 findings for it.
//
// The reaper still runs each night ONLY because user-settings.md carries a redundant prose row
// telling the agent to invoke a hand-placed copy in %LOCALAPPDATA%. In other words the merged
// automation is inert and the thing actually holding the behaviour up is the sentence that
// automation was written to replace -- the same "existed only as a sentence" failure class
// user-settings.md names elsewhere. A detector that watches only one direction will keep
// certifying that state as healthy.
//
// GUARDS (each must be load-bearing; see mutcheck-installed-skill-drift.mjs)
//   g1 template-exclusion: the bundled user-settings.md is a PLACEHOLDER by design -- SKILL.md
//      says so and the real settings live in OneDrive. It matches 13 stale branches and no
//      main, so without this guard the sweep reports permanent BRANCH-ONLY noise on a file
//      nobody should ever deploy from. Excluding it is a conscious exclusion, printed, not a
//      silent skip.
//   g2 newline-normalisation (BOTH SIDES): these files round-trip through OneDrive and Windows
//      editors, AND the repo itself stores some blobs with CRLF and some with LF (measured on
//      main 2026-08-26: reap-stale-mcp.ps1 = 254 CRLF / 0 bare LF, SKILL.md = 585 CRLF, while
//      check-google-token.ps1 and ensure-mcp-browsers.ps1 are pure LF). So normalising only the
//      working copy and comparing it to the RAW STORED BLOB ID is unsound in one direction:
//      for any CRLF-stored blob the verdict MAIN becomes UNREACHABLE, and a perfectly deployed
//      file reports UNVERSIONED forever. That is a detector that can never reach zero -- the
//      exact decay mode the 11:15 rule exists to prevent. Caught 2026-08-26 19:20 by deploying
//      reap-stale-mcp.ps1 byte-for-byte from main and watching the sweep still call it
//      UNVERSIONED. The fix compares norm(installed) against norm(blob CONTENT), so both sides
//      go through the same normalisation. Blob contents are fetched once per UNIQUE object id
//      (218 refs collapse to a handful of distinct blobs), so it stays one git process.
//   g4 lazy-fanout + in-process blob ids (added 2026-09-02, #398): the sweep must not pay the
//      full `files x refs` cross-product, nor a subprocess per blob, to answer the common case.
//      See the COST section below. Guarded by three arms in mutcheck-installed-skill-drift.mjs:
//      M_FANOUT_SKIPPED (correctness), M_EAGER_FANOUT and M_BLOBID_SPAWN (budget).
//   g3 plugin-scoping (MISSING only): the installed root maps onto the marketplace root, so the
//      repo carries files under the prefix that are NOT plugin content and are never installed
//      -- here plugins/README.md, the marketplace registry's own README. Reporting those as
//      MISSING would be a permanent false finding on day one. The rule is structural, not a
//      filename allow-list: a repo path is in scope only when its FIRST path segment is a
//      directory that exists in the installed tree (i.e. an actually-installed plugin). That
//      also correctly ignores a second plugin the user has not installed, and it is independent
//      of how deep OA_REPO_PREFIX points.
// NOT a guard, deliberately: main-first precedence. A file on main AND on a side branch must
//   report MAIN, and the `both` case in mutcheck-installed-skill-drift.mjs asserts it. It is
//   NOT in the mutant list, because it cannot be isolated by mutation: main is reachable under
//   two names (origin/main and the local main), so every main-matching file has >= 2 hits and
//   any inversion of the precedence breaks onMain and crlf as well as both. The harness said
//   so out loud -- neutering it broke 3 of 6 cases. Per the standing rule, a change that breaks
//   everything is the MATCHER, not a guard; calling it one would have certified matcher logic
//   as a safety property. Its correctness is evidenced by the baseline case instead.
//
// COST (measured 2026-09-02, #398 -- read this before "simplifying" either mechanism back)
// ----------------------------------------------------------------------------------------
// This sweep runs in PHASE 0 of every overnight run, on a */30 schedule, and auto-deploy
// invokes it TWICE (classify before the write, re-verify after). At 211 files x 273 refs it
// was 429 s per invocation. Two separate defects, and fixing either alone leaves most of the
// cost on the table:
//
//   1. SPAWN COST, not compute. Measured live: pid 11448 held 23 MINUTES of wall clock for
//      15 SECONDS of CPU -- ~99% waiting -- with exactly ONE `git.exe` child alive at a time,
//      continuously. The `--batch-check`/`--batch` calls were already batched and are not the
//      culprit; `blobIdOf()` was, because it shelled out to `git hash-object --stdin` once per
//      unique blob AND once per installed file. That is O(blobs) serial process spawns, and
//      process creation on Windows under load is ~100-490 ms (the same per-spawn cost #397
//      removed from sync-oa-home.ps1: 79.2 s -> 3.9 s).
//
//      A git blob id is sha1("blob " + <bytelength> + "\0" + <bytes>) BY DEFINITION. Computing
//      it in process is not an approximation of `git hash-object` -- it is the same function,
//      with the same bytes. So this costs zero subprocesses and cannot drift.
//
//   2. QUESTION SIZE. The fan-out across all refs exists only to EXPLAIN a mismatch as
//      BRANCH-ONLY. A file that matches origin/main was never going to be classified
//      BRANCH-ONLY -- the old code `continue`d before the fan-out loop and threw those results
//      away. So the cross-product was computed unconditionally to produce an explanation that
//      is only ever needed for files that already failed the cheap check. Asking main first and
//      fanning out only over the leftovers is therefore provably classification-identical, not
//      a heuristic: the discarded work is exactly the work no longer done.
//
// DELIBERATELY NOT DONE: pruning refs already merged into origin/main. It would cut the ref set
// (#402 counts 38 merged local branches), but it is NOT verdict-neutral -- a file whose only
// backup is a merged-but-unpushed-elsewhere branch would silently fall from BRANCH-ONLY to
// UNVERSIONED, i.e. the sweep would report a file as unrecoverable that is in fact recoverable.
// The correctness bar for #398 is that classifications are IDENTICAL, so trading a verdict for
// speed fails it. With main-first in place the ref count no longer drives the common-case cost
// anyway, which is what made this optional rather than load-bearing.
//
// exit 1 = findings.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

const REPO =
  process.env.OA_REPO || 'V:\\repos\\focus-planner';
const INSTALLED =
  process.env.OA_INSTALLED_PLUGIN ||
  join(homedir(), '.copilot', 'installed-plugins', 'focus-planner');
// Path prefix inside the repo that the installed tree maps onto.
const REPO_PREFIX = process.env.OA_REPO_PREFIX || 'plugins';

// g1: files that are bundled templates, not deployable artifacts.
const TEMPLATES = new Set(['user-settings.md']);

const EXTS = new Set(['.ps1', '.md', '.json', '.mjs', '.js']);

// Budget instrumentation. These are load-bearing: the guards that keep this sweep cheap are
// PERFORMANCE properties, and a mutant that reverts one produces perfectly correct verdicts.
// Only a counter can kill it, so the counters are part of the contract, not decoration.
// See M_EAGER_FANOUT / M_BLOBID_SPAWN in mutcheck-installed-skill-drift.mjs.
let gitSpawns = 0;
let refQueries = 0;

function git(args, opts = {}) {
  gitSpawns++;
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

// g2: compare content, not bytes. Normalise CRLF and a trailing-newline difference, which is
// all that separates a OneDrive round-trip from a real edit.
function norm(text) {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

// g4: a git blob id IS sha1("blob <bytelength>\0" + bytes). Computing it here is the same
// function `git hash-object --stdin` computes over the same bytes -- it just does not cost a
// process. The utf8 encode reproduces exactly what execFileSync did with a string `input`, so
// the ids are byte-for-byte what the old code produced. Proven by T_BLOBID_PARITY.
function blobIdOf(text) {
  const bytes = Buffer.from(norm(text), 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else {
      const dot = name.lastIndexOf('.');
      if (dot > 0 && EXTS.has(name.slice(dot))) out.push(p);
    }
  }
  return out;
}

if (!existsSync(INSTALLED)) {
  console.log(`installed plugin not found: ${INSTALLED}`);
  console.log('\nnothing to check.');
  process.exit(0);
}

const files = walk(INSTALLED).sort();

// Every ref we consider a backup: origin/main first (g3), then all local and remote heads.
const refs = ['origin/main'];
for (const line of git([
  'for-each-ref',
  '--format=%(refname:short)',
  'refs/heads',
  'refs/remotes',
]).split('\n')) {
  const r = line.trim();
  if (r && r !== 'origin/main' && !r.endsWith('/HEAD')) refs.push(r);
}

const rows = files.map((abs) => {
  const rel = relative(INSTALLED, abs).split(sep).join('/');
  return { abs, rel, repoPath: `${REPO_PREFIX}/${rel}` };
});

// Map "ref:path" -> objectname (or null when missing).
const objOf = new Map();
// g2 (git side): a stored blob may itself be CRLF or LF. Compare NORMALISED content, so fetch
// each distinct blob once and hash it through the same norm() the installed side uses.
// Without this, MAIN is unreachable for every CRLF-stored blob.
const normOf = new Map(); // objectname -> normalised blob id

// Resolve a batch of "<ref>:<path>" queries. TWO git processes for the whole batch regardless
// of its size -- one `--batch-check` to name the objects, one `--batch` to read the ones we
// have not already read. Callers decide HOW MANY queries to ask; this decides how cheaply.
function resolveQueries(queries) {
  if (!queries.length) return;
  refQueries += queries.length;

  const batch = git(['cat-file', '--batch-check=%(objectname) %(rest)'], {
    input: queries.join('\n') + '\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = batch.split('\n').filter(Boolean);
  lines.forEach((line, i) => {
    const q = queries[i];
    const m = /^([0-9a-f]{40})\s/.exec(line);
    objOf.set(q, m ? m[1] : null);
  });

  // Only blobs we have not already hashed -- phase 2 re-reads nothing phase 1 already read.
  const uniq = [
    ...new Set(queries.map((q) => objOf.get(q)).filter(Boolean)),
  ].filter((o) => !normOf.has(o));
  if (!uniq.length) return;

  gitSpawns++;
  const raw = execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPO,
    input: Buffer.from(uniq.join('\n') + '\n', 'utf8'),
    maxBuffer: 256 * 1024 * 1024,
  });
  let off = 0;
  while (off < raw.length) {
    const nl = raw.indexOf(0x0a, off);
    if (nl < 0) break;
    const header = raw.slice(off, nl).toString('utf8');
    const hm = /^([0-9a-f]{40}) \S+ (\d+)$/.exec(header);
    if (!hm) break;
    const size = Number(hm[2]);
    const body = raw.slice(nl + 1, nl + 1 + size);
    normOf.set(hm[1], blobIdOf(body.toString('utf8')));
    off = nl + 1 + size + 1; // trailing LF after the body
  }
}
const normObjOf = (q) => {
  const o = objOf.get(q);
  return o ? normOf.get(o) : null;
};

const findings = [];
const report = [];
const skipped = [];

// The files that actually get a verdict, with their normalised installed-side blob id.
const checkRows = [];
for (const r of rows) {
  const base = r.rel.split('/').pop();
  if (TEMPLATES.has(base)) {
    skipped.push(r.rel);
    continue;
  }
  r.want = blobIdOf(readFileSync(r.abs, 'utf8'));
  checkRows.push(r);
}

// --- PHASE 1: ask origin/main about every file. ONE query per file. -----------------------
resolveQueries(checkRows.map((r) => `origin/main:${r.repoPath}`));

// --- PHASE 2 (g4 lazy-fanout): fan out across the remaining refs ONLY for the files main did
// not explain. On a no-drift tree that list is EMPTY and phase 2 costs nothing. This is not a
// heuristic: a file matching main returns MAIN below and never consults `hits`, so the fan-out
// results for those files were computed and then discarded by the old code.
const unmatched = checkRows.filter((r) => {
  const mainObj = normObjOf(`origin/main:${r.repoPath}`);
  return !(mainObj && mainObj === r.want);
});
if (unmatched.length) {
  const fanOut = [];
  for (const r of unmatched) {
    for (const ref of refs) {
      if (ref !== 'origin/main') fanOut.push(`${ref}:${r.repoPath}`);
    }
  }
  resolveQueries(fanOut);
}

// Classification runs in FILE ORDER over one loop, exactly as before, so the report table is
// byte-identical to the pre-#398 sweep rather than merely equivalent.
for (const r of checkRows) {
  const want = r.want;

  // Main-first precedence. See the note in the sweep header: this is matcher logic, not a
  // guard, so it is asserted by the `both` baseline case rather than by a mutant.
  const mainObj = normObjOf(`origin/main:${r.repoPath}`);
  if (mainObj && mainObj === want) {
    report.push({ rel: r.rel, verdict: 'MAIN', where: 'origin/main' });
    continue;
  }

  const hits = [];
  for (const ref of refs) {
    if (ref === 'origin/main') continue;
    if (normObjOf(`${ref}:${r.repoPath}`) === want) hits.push(ref);
  }

  if (hits.length) {
    const row = {
      rel: r.rel,
      verdict: 'BRANCH-ONLY',
      where: hits.slice(0, 3).join(', ') + (hits.length > 3 ? ` (+${hits.length - 3})` : ''),
    };
    report.push(row);
    findings.push(row);
  } else {
    const row = { rel: r.rel, verdict: 'UNVERSIONED', where: 'no ref' };
    report.push(row);
    findings.push(row);
  }
}

// --- FORWARD direction: files on main that never reached the installed tree ----------------
// g3 plugin-scoping: only paths whose first segment is a directory that actually exists in the
// installed tree are in scope. That excludes marketplace-level scaffolding (plugins/README.md)
// and any plugin the user has not installed, without hardcoding a filename.
const installedTopDirs = new Set(
  readdirSync(INSTALLED, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name),
);
const installedRel = new Set(rows.map((r) => r.rel));

let mainPaths = [];
try {
  mainPaths = git(['ls-tree', '-r', '--name-only', 'origin/main', '--', REPO_PREFIX])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  mainPaths = [];
}

const missing = [];
for (const p of mainPaths) {
  if (!p.startsWith(REPO_PREFIX + '/')) continue;
  const rel = p.slice(REPO_PREFIX.length + 1);
  if (!installedTopDirs.has(rel.split('/')[0])) continue; // g3
  const base = rel.split('/').pop();
  if (TEMPLATES.has(base)) continue; // g1, applied symmetrically
  const dot = base.lastIndexOf('.');
  if (!(dot > 0 && EXTS.has(base.slice(dot)))) continue; // same file-type scope as walk()
  if (installedRel.has(rel)) continue;
  const row = { rel, verdict: 'MISSING', where: 'origin/main' };
  missing.push(row);
  report.push(row);
  findings.push(row);
}

console.log(`installed plugin: ${INSTALLED}`);
console.log(`repo:             ${REPO}  (refs searched: ${refs.length})`);
console.log(`files checked:    ${report.length - missing.length}` + (skipped.length ? `   bundled templates excluded: ${skipped.join(', ')}` : ''));
// Budget line (#398). Deliberately does NOT match the verdict-row regex the deploy scripts
// parse (`^\s{2}(MAIN|BRANCH-ONLY|UNVERSIONED|MISSING)\s+\S+\s+\[`). It is what makes
// M_EAGER_FANOUT and M_BLOBID_SPAWN killable, since both leave every verdict correct.
console.log(`git budget:       ${gitSpawns} spawn(s), ${refQueries} ref-quer(ies)`);
console.log('');
for (const row of report) {
  console.log(`  ${row.verdict.padEnd(12)} ${row.rel}    [${row.where}]`);
}

if (!findings.length) {
  console.log('\nno drift: every installed skill file is the version on main, and every file on main is installed.');
  process.exit(0);
}

console.log(`\nFINDINGS: ${findings.length} file(s) differ between main and the running agent`);
for (const f of findings) {
  if (f.verdict === 'BRANCH-ONLY') {
    console.log(
      `  ${f.rel}: live fix exists only on ${f.where} -- a plugin reinstall REVERTS it, ` +
        'and merging that branch does NOT deploy it (installed-plugins is written by hand).',
    );
  } else if (f.verdict === 'MISSING') {
    console.log(
      `  ${f.rel}: on origin/main but ABSENT from the installed tree -- merged and never ` +
        'deployed, so the running agent does not have it at all.',
    );
  } else {
    console.log(
      `  ${f.rel}: matches no git ref -- the running agent is executing code that is not ` +
        'recoverable from git.',
    );
  }
}
process.exit(1);
