// dropped-ask-sweep.mjs — an ask that was being CARRIED, and silently stopped being carried.
//
// WHY THIS EXISTS (2026-08-27 09:15 PT, left open as a question by the previous run)
// ---------------------------------------------------------------------------------
// On 2026-08-27 the ask `merge 201` was surfaced in the 07:50 turn on #448, was ABSENT
// from the 08:00 turn, and was restored by hand at 08:30 with the note:
//
//     "#201 was surfaced at 07:50 and silently absent from the 08:00 turn's asks.
//      regressive-ask-sweep read clean, so it did not catch a drop between two agent
//      turns. Worth checking whether that sweep models turn-to-turn ask disappearance
//      at all."
//
// It does not. All three of `regressive-ask-sweep`'s arms (amnesia / slot re-ask /
// stale grab) ask whether the CURRENT ask CONTRADICTS history. Every one of them needs
// the ask to still be present in order to fire. This defect is the opposite shape:
// nothing contradicts anything, the ask is simply GONE, and the file reads clean because
// what is missing leaves no trace. Same blind spot in every neighbour:
//
//   * pr-ask-liveness-sweep  — validates the LIVE ask points at a live PR. A dropped ask
//                              is not a live ask, so it is out of scope by construction.
//   * terminal/body-header-drift — compare the block header to the newest turn.
//   * undelivered-plan-sweep — asks whether a PLAN was delivered, not whether an ask survived.
//   * swallowed-message-sweep — the user's message going unanswered, not the agent's ask.
//
// THE HARM
// --------
// The digest and the wrap-up surface each task's LIVE ask (`lib-live-ask.mjs`). An ask
// that stops being carried is therefore invisible on every surface Shiv reads, while the
// PR it names stays open forever. This is the mechanism behind the cost already recorded
// in user-settings.md — #273 (46d), #363 (40d), #357 (52d), #339 (59d), #232 (69d) — each
// parked on a word that was never re-asked. Those were all found BY HAND.
//
// DEFINITION (deliberately narrow — a wrong positive here rewrites a healthy ask)
// -------------------------------------------------------------------------------
// FLAG a token `<action> <n>` when ALL of:
//   1. it appeared in the ASK REGION of some agent turn (not merely in prose — history
//      legitimately narrates old PR numbers), and
//   2. it appears in the live ask of NO journal — rehoming to another task is a correct
//      outcome, not a drop, so the live surface is computed corpus-wide, and
//   3. the thing it names is still OPEN on GitHub. Merged/closed means the ask retired
//      for the right reason; that is the healthy case and must never be a finding.
//
// NOT a finding, deliberately:
//   * unresolved (no link in any journal ties the number to a repo) — reported apart.
//   * a number in prose but never in an ask region — it was never an ask to drop.
//   * still carried anywhere — including by a different task.
//
// Boundaries and dialects come from `lib-live-ask.mjs` (`agentTurnSlices`/`askInSlice`),
// never re-derived here: a checker that models the parser loosely reports on a document
// the parser never saw. Same rule that produced the #267 false positive.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { liveAsk, agentTurnSlices, askInSlice } from './lib-live-ask.mjs';
import { repoIndexFromText, repoState } from './lib-gh-refs.mjs';
const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JDIR = path.join(PLANNER, 'journal');
const OFFLINE = process.env.OA_PR_SWEEP_OFFLINE === '1';

// TESTABILITY SEAM, copied from pr-ask-liveness-sweep: a detector that only runs against
// live GitHub cannot be mutation-checked, and this suite's rule is that a detector does
// not ship without a test that tries to defeat it. OA_DROPPED_ASK_FIXTURE supplies
// { "owner/repo": { prs: { "<n>": {state,isDraft,title,base,head} } } } and replaces BOTH
// gh calls. Unset in production, so the live path is unchanged.
const FIXTURE = process.env.OA_DROPPED_ASK_FIXTURE
  ? JSON.parse(fs.readFileSync(process.env.OA_DROPPED_ASK_FIXTURE, 'utf8'))
  : null;

// `close`, `build` and `review` are here for SUPERSESSION, not detection: an ask
// legitimately changes verb when the plan changes (`merge 149` -> `close 149 152`), and
// the live surface is keyed by NUMBER, so the replacement verb must be tokenised or the
// exemption can never fire. Caught by mutcheck-dropped-ask, which failed on exactly this.
const ACTION = String.raw`merge|land|ship|approve|rebase|reopen|revert|publish|deploy|close|build|review`;
const rxToken = new RegExp(String.raw`\b(${ACTION})\s+#?(\d{1,4})\b`, 'gi');

// A turn that DOCUMENTS this defect class quotes example tokens. Matching them would make
// the sweep fire on its own postmortem — the trap recorded 2026-08-26 11:15.
const DOC_GUARD = /(dropped-ask|regressive-ask|silently absent|stopped being carried|was surfaced at|this sweep|detector|postmortem|for example|e\.g\.)/i;

const rxDate = /(\d{4}-\d{2}-\d{2})/;

function tokensIn(text) {
  const out = new Set();
  if (!text) return out;
  for (const line of String(text).split('\n')) {
    if (DOC_GUARD.test(line)) continue;
    for (const m of line.matchAll(rxToken)) out.add(`${m[1].toLowerCase()}:${m[2]}`);
  }
  return out;
}

// Stacked PRs, and the default branch, per repo. One `gh` call, cached.
//
// A PR whose base is ANOTHER open PR's branch is merged by merging the tip of its stack,
// so its own `merge N` ask is CORRECTLY retired once the chain is consolidated behind a
// single ask. Flagging it would tell a run to re-surface 5 asks Shiv deliberately
// collapsed into one (`merge 168` carries the 11-PR telegram-bridge chain). Proven on the
// live repo: #160 -> #158, #161 -> #160, #162 -> #161, #163 -> #162, #164 -> #163.
const stackCache = new Map();
function stackInfo(repo) {
  if (stackCache.has(repo)) return stackCache.get(repo);
  const info = { base: new Map(), heads: new Map(), def: 'main' };
  if (FIXTURE) {
    for (const [n, v] of Object.entries(FIXTURE[repo]?.prs || {})) {
      if (v.state !== 'OPEN') continue;
      info.base.set(Number(n), v.base || 'main');
      if (v.head) info.heads.set(v.head, Number(n));
    }
    stackCache.set(repo, info);
    return info;
  }
  try {
    const json = execFileSync(
      'gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '400',
        '--json', 'number,baseRefName,headRefName'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 },
    );
    for (const o of JSON.parse(json)) {
      info.base.set(o.number, o.baseRefName);
      info.heads.set(o.headRefName, o.number);
    }
  } catch { /* unreadable — treat everything as unstacked, i.e. report it */ }
  stackCache.set(repo, info);
  return info;
}

// The date a turn was written: the `## YYYY-MM-DD` heading that opens its chat entry sits
// just ABOVE the agent marker, so read backwards from the marker rather than inside the
// slice (the slice body is full of other dates).
function turnDate(text, offset) {
  const head = text.slice(Math.max(0, offset - 400), offset).split('\n').reverse();
  for (const l of head) {
    const m = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(l.trim());
    if (m) return m[1];
  }
  const m = rxDate.exec(text.slice(offset, offset + 400));
  return m ? m[1] : null;
}

const files = fs.readdirSync(JDIR).filter((f) => /^task-\d+\.md$/.test(f)).sort();

const carried = new Map();   // token -> {id, turnIndex, turnCount, date}  (most recent ask that carried it)
const liveSurface = new Set();
const globalRepoIdx = new Map();
const perFileRepoIdx = new Map();

for (const f of files) {
  const id = /^task-(\d+)\.md$/.exec(f)[1];
  const text = fs.readFileSync(path.join(JDIR, f), 'utf8');

  const idx = repoIndexFromText(text);
  perFileRepoIdx.set(id, idx);
  for (const [k, v] of idx) {
    if (!globalRepoIdx.has(k)) globalRepoIdx.set(k, v);
    else if (globalRepoIdx.get(k) !== v) globalRepoIdx.set(k, null); // ambiguous -> refuse
  }

  // 1. the live surface — what Shiv can still see today, from ANY task.
  //
  // Scope = the WHOLE newest agent turn, not just the ask line and its 4-line context.
  // A turn routinely states the ask line as a pointer ("Needs from you: the two calls
  // below.") and then spells the tokens out 100 lines lower; scoring only the context
  // window called #448's `merge 198` dropped while it was the top item of the newest
  // turn. A detector must err toward "still carried" — a wrong positive here rewrites a
  // healthy ask.
  const slices = agentTurnSlices(text);
  const live = liveAsk(text);
  if (slices.length) {
    for (const t of tokensIn(slices[slices.length - 1].slice)) liveSurface.add(t);
  }
  for (const t of tokensIn(`${live.ask || ''}\n${live.context || ''}`)) liveSurface.add(t);

  // 2. every ask this journal has ever carried.
  for (const s of slices) {
    const hit = askInSlice(s.slice);
    if (!hit) continue;
    for (const t of tokensIn(`${hit.ask}\n${hit.context}`)) {
      const prev = carried.get(t);
      const rec = { id, turnIndex: s.index + 1, turnCount: slices.length, date: turnDate(text, s.offset) };
      // keep the MOST RECENT carrier, so "last carried" is accurate corpus-wide
      if (!prev || String(rec.date || '') >= String(prev.date || '')) carried.set(t, rec);
    }
  }
}

// An ask is still carried if ANY action still names that NUMBER — an ask legitimately
// changes verb when the plan changes. `merge 149` was retired in favour of `close 149 152`
// (the merge-queue table's own live entry); keying on the verb reported it as dropped
// while Shiv is actively being asked about it, which is the worst kind of wrong positive.
const liveNumbers = new Set([...liveSurface].map((t) => t.split(':')[1]));
const dropped = [...carried.entries()].filter(([t]) => !liveNumbers.has(t.split(':')[1]));

function resolveRepo(token, id) {
  const n = token.split(':')[1];
  const local = perFileRepoIdx.get(id);
  for (const src of [local, globalRepoIdx]) {
    if (!src) continue;
    for (const key of [`pr:${n}`, `n:${n}`]) {
      if (src.has(key) && src.get(key)) return src.get(key);
    }
  }
  return null;
}

function lookupState(repo) {
  if (!FIXTURE) return repoState(repo);
  const m = new Map();
  for (const [n, v] of Object.entries(FIXTURE[repo]?.prs || {})) {
    m.set(Number(n), { state: v.state, isDraft: !!v.isDraft, title: v.title || '', kind: 'pr' });
  }
  return m;
}

const flagged = [];
const unresolved = [];
const retired = [];
const stacked = [];

for (const [token, rec] of dropped) {
  const n = Number(token.split(':')[1]);
  const repo = resolveRepo(token, rec.id);
  if (!repo) { unresolved.push({ token, rec }); continue; }
  if (OFFLINE) { unresolved.push({ token, rec, repo, why: 'offline' }); continue; }
  const st = lookupState(repo).get(n);
  if (!st) { unresolved.push({ token, rec, repo, why: 'not found in repo' }); continue; }
  if (st.state !== 'OPEN') { retired.push({ token, rec, repo, st }); continue; }
  const info = stackInfo(repo);
  const base = info.base.get(n);
  const parent = base && info.heads.has(base) ? info.heads.get(base) : null;
  if (parent) { stacked.push({ token, rec, repo, st, parent }); continue; }
  flagged.push({ token, rec, repo, st });
}

// One row per TARGET, not per verb. #149 was carried as both `merge 149` and (later)
// `close 149 152`; reporting it twice reads as two problems and inflates the count.
const byTarget = new Map();
for (const r of flagged) {
  const key = `${r.repo}#${r.token.split(':')[1]}`;
  const prev = byTarget.get(key);
  if (!prev) { byTarget.set(key, { ...r, verbs: [r.token.split(':')[0]] }); continue; }
  prev.verbs.push(r.token.split(':')[0]);
  // keep the most recent carrier as the reported one
  if (String(r.rec.date || '') > String(prev.rec.date || '')) { prev.rec = r.rec; }
}
const targets = [...byTarget.values()];

const today = new Date().toISOString().slice(0, 10);
const ageDays = (d) => (d ? Math.round((Date.parse(today) - Date.parse(d)) / 86400000) : null);

console.log(`journals scanned                                   : ${files.length}`);
console.log(`distinct action tokens ever carried in an ask      : ${carried.size}`);
console.log(`...still carried in some task's LIVE ask           : ${carried.size - dropped.length}`);
console.log(`...no longer carried anywhere                      : ${dropped.length}`);
console.log(`   of those, correctly retired (merged/closed)     : ${retired.length}`);
console.log(`   of those, stacked — ask consolidated upward     : ${stacked.length}`);
console.log(`   of those, unresolved (repo unknown${OFFLINE ? ' / offline' : ''})        : ${unresolved.length}`);
console.log(`FLAGGED — ask stopped being carried, target STILL OPEN: ${targets.length}`);

for (const r of targets.sort((a, b) => Number(a.token.split(':')[1]) - Number(b.token.split(':')[1]))) {
  const age = ageDays(r.rec.date);
  const n = r.token.split(':')[1];
  console.log(
    `\n  ${r.repo}#${n}${r.st.isDraft ? ' (draft)' : ''}  ${r.st.state}` +
    `   — last asked as ${r.verbs.map((v) => `\`${v} ${n}\``).join(' / ')}`,
  );
  console.log(`      last carried: #${r.rec.id} turn ${r.rec.turnIndex}/${r.rec.turnCount}` +
    `${r.rec.date ? ` on ${r.rec.date}` : ''}${age !== null ? ` (${age}d ago)` : ''}`);
  console.log(`      title: ${r.st.title}`);
}

if (stacked.length) {
  console.log(`\nstacked (reported, not a finding — merging the tip carries these):`);
  for (const s of stacked.sort((a, b) => Number(a.token.split(':')[1]) - Number(b.token.split(':')[1]))) {
    console.log(`   \`${s.token.replace(':', ' ')}\`  based on #${s.parent}`);
  }
}

if (unresolved.length) {
  console.log(`\nunresolved (reported, not a finding):`);
  for (const u of unresolved.sort((a, b) => a.token.localeCompare(b.token))) {
    console.log(`   \`${u.token.replace(':', ' ')}\`  last carried #${u.rec.id}` +
      `${u.rec.date ? ` on ${u.rec.date}` : ''}${u.why ? `  — ${u.why}` : ''}`);
  }
}

if (flagged.length) process.exit(1);