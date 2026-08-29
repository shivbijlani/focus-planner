// pr-ask-liveness-sweep.mjs — the first detector that leaves the filesystem.
//
// WHY (2026-08-26 12:30 PT)
// ------------------------
// 41 sweeps existed. Every one read journals, the board and agent state. NOT ONE ever asked
// GitHub anything. So the queue could hold an ask like **`merge 120`** long after PR #120 was
// merged, closed, renumbered — or had silently gone un-mergeable — and every existing checker
// called it healthy: the wording is fine, the markers are right, it is not truncated, it is
// not self-answerable. It is simply DEAD, and it still occupies a slot in the phone digest.
//
// This is the "falsified premise" class recorded EIGHT times in user-settings.md, always found
// by hand. It is also the only stale-ask class with a SAFETY edge: `merge` is on SKILL.md's
// irreversible list, so a one-word approval against a wrong number authorises a merge nobody
// reviewed.
//
// TWO DIMENSIONS, because one of them was learned the hard way twice
// ------------------------------------------------------------------
// A. ASK-LEVEL — a live ask names a PR/issue that is merged, closed, absent, or CONFLICTING.
//    user-settings.md's own rule: "a queue entry is only live if the PR is MERGEABLE at the
//    moment you surface it - check mergeable, not just state." That rule was written after
//    `merge 121` was advertised as live while being impossible to execute. Nothing enforced
//    it, so this sweep does.
//
// B. REPO-LEVEL — ANY open PR that is CONFLICTING, even if no ask names it yet. This is the
//    generalization the same section asked for: "Applying the rule to every open PR (not just
//    the one being asked about) turned up #126 ... not on the ask list, so blocking nothing
//    yet, but the next dead ask waiting to happen." #126 then went conflicting AGAIN on
//    2026-08-26 when PR #187 landed on main - exactly as predicted, and again found by hand.
//
// MERGEABILITY IS COMPUTED LAZILY. GitHub answers UNKNOWN until it has built the test-merge
// commit; asking is what triggers it. We therefore poll rather than treat UNKNOWN as clean -
// reading UNKNOWN as "fine" is precisely how a CONFLICTING PR would slip through.
//
// NOT a finding, deliberately:
//   * open + MERGEABLE          - the healthy case.
//   * unresolved (no repo URL)  - guessing the repo would manufacture false "dead" claims.
//                                 Reported separately, never counted.
//   * a number in PROSE but not in the operative ask - history may reference merged PRs.
//
// GUARD: lines that DOCUMENT this defect are skipped, per the rule established 2026-08-26
// 11:15 after a detector fired on its own description.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { liveAsk } from './lib-live-ask.mjs';
import { repoIndexFromText, repoState } from './lib-gh-refs.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);
const OFFLINE = process.env.OA_PR_SWEEP_OFFLINE === '1';

const WATCHED = (process.env.OA_PR_SWEEP_REPOS || 'shivbijlani/focus-planner')
  .split(',').map((s) => s.trim()).filter(Boolean);

const ACTION = String.raw`merge|land|ship|build|close|approve|review|rebase|reopen|revert`;
const rxToken = new RegExp(String.raw`\b(${ACTION})\s+#?(\d{1,4})\b`, 'gi');
const DOC_GUARD = /(pr-ask-liveness|falsified premise|postmortem|this sweep|dead ask|never surface|detector)/i;

// RETRACTION GUARD (2026-08-29). A line that NAMES an old ask in order to WITHDRAW it is
// documentation, not a live ask. Widening the universe to boardless journals surfaced this
// immediately: #353 says "The old ask here (`merge 150` then `merge 126`) is done - both are
// merged. Ignore it if you see it above." and was flagged for the very tokens it retracts.
//
// Telling the user about a dead ask their own journal already declares dead is pure noise,
// and noise is how a detector gets ignored. Kept deliberately NARROW - phrases that only
// occur when withdrawing an ask - because a loose guard here would silence real findings.
// Notably absent: a bare "is done", which appears in legitimate asks ("merge 42 once review
// is done") and would suppress them.
const RETRACTION_GUARD = /(the old ask|already (?:merged|landed|shipped)|both are merged|ignore it if|ask (?:is|was) (?:dead|retired|already)|no longer (?:needed|blocking|open))/i;

function sleep(sec) {
  const end = Date.now() + sec * 1000;
  while (Date.now() < end) { /* deliberate spin: keeps the sweep dependency-free */ }
}

// TESTABILITY SEAM. A detector that only runs against live GitHub cannot be
// mutation-checked, and this file's own rule is that a detector does not ship without a
// test that tries to defeat it. OA_PR_SWEEP_FIXTURE points at a JSON file supplying
// { "owner/repo": { prs: { "<n>": {state,isDraft,title,mergeable} } } }, which replaces
// BOTH gh calls. Unset in production, so the live path is unchanged.
const FIXTURE = process.env.OA_PR_SWEEP_FIXTURE
  ? JSON.parse(fs.readFileSync(process.env.OA_PR_SWEEP_FIXTURE, 'utf8'))
  : null;

function fixtureState(repo) {
  const m = new Map();
  for (const [n, v] of Object.entries(FIXTURE?.[repo]?.prs || {})) {
    m.set(Number(n), { state: v.state, isDraft: !!v.isDraft, title: v.title || '', kind: 'pr' });
  }
  return m;
}

function lookupState(repo) {
  return FIXTURE ? fixtureState(repo) : repoState(repo);
}

/** Poll until GitHub has computed mergeability (it is lazy; UNKNOWN != clean). */
function mergeability(repo, tries = 6) {
  if (FIXTURE) {
    const nodes = Object.entries(FIXTURE[repo]?.prs || {})
      .filter(([, v]) => v.state === 'OPEN')
      .map(([n, v]) => ({ number: Number(n), title: v.title || '', mergeable: v.mergeable || 'MERGEABLE', isDraft: !!v.isDraft }));
    return { nodes, unknown: nodes.filter((n) => n.mergeable === 'UNKNOWN').length };
  }
  const [owner, name] = repo.split('/');
  const q = `{ repository(owner:"${owner}", name:"${name}") { pullRequests(states:OPEN, first:100) { nodes { number title mergeable isDraft } } } }`;
  let nodes = [];
  for (let i = 0; i < tries; i++) {
    try {
      const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${q}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
      nodes = JSON.parse(out).data.repository.pullRequests.nodes;
    } catch { return { nodes: [], unknown: -1 }; }
    const unknown = nodes.filter((n) => n.mergeable === 'UNKNOWN').length;
    if (!unknown) return { nodes, unknown: 0 };
    if (i < tries - 1) sleep(10);
  }
  return { nodes, unknown: nodes.filter((n) => n.mergeable === 'UNKNOWN').length };
}

// ---- The universe of tasks to check -------------------------------------------------------
// It used to be "rows on planner.md", which quietly made this detector blind to the tasks most
// likely to carry a `merge NNN` ask. 69 journals have no board row at all, and they are almost
// exactly the agent-programme cluster (#425, #442, #443, #399, #395, #379, #434, #439 ...) —
// i.e. the tasks that TALK ABOUT PRs. Measured 2026-08-29: this sweep reported 0 stale asks
// while #425 sat asking for `merge 252`, a PR that had been merged an hour earlier. It was not
// a matcher bug; the task was never looked at.
//
// A board row is a presentation choice, not a liveness signal. The signal for "finished" is the
// COMPLETED board (the user's own completion action) plus the terminal agent status filtered
// below. So the universe is: every journal, minus anything the user has completed.
function boardIds(file) {
  const ids = new Set();
  let text;
  try { text = fs.readFileSync(path.join(PLANNER, file), 'utf8'); } catch { return ids; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*[,|]/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

const openBoard = boardIds('planner.md');
const completedBoard = boardIds('planner-completed.md');

let journalIds = [];
try {
  journalIds = fs.readdirSync(JOURNAL)
    .map((f) => (f.match(/^task-(\d+)\.md$/) || [])[1])
    .filter(Boolean);
} catch { /* no journal dir */ }

const active = new Set(openBoard);
let orphansAdded = 0;
for (const id of journalIds) {
  if (active.has(id) || completedBoard.has(id)) continue;
  active.add(id);
  orphansAdded += 1;
}

// ---- Dimension B: repo-wide mergeability (also reused by A) -------------------------------
const mergeMap = new Map();
const conflicting = [];
let unknownLeft = 0;
if (!OFFLINE) {
  for (const repo of WATCHED) {
    const { nodes, unknown } = mergeability(repo);
    if (unknown === -1) continue;
    unknownLeft += unknown;
    const m = new Map();
    for (const n of nodes) {
      m.set(n.number, n);
      if (n.mergeable === 'CONFLICTING') conflicting.push({ repo, ...n });
    }
    mergeMap.set(repo, m);
  }
}

// ---- Dimension A: asks that name a PR/issue ------------------------------------------------
const findings = [];
const unresolved = [];
let considered = 0;
let refsChecked = 0;

for (const id of [...active].sort((a, b) => Number(a) - Number(b))) {
  const f = path.join(JOURNAL, `task-${id}.md`);
  if (!fs.existsSync(f)) continue;

  let status = '?';
  try {
    status = JSON.parse(fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '')).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(f, 'utf8');
  const { ask, context } = liveAsk(text);
  if (!ask) continue;

  const tokens = [];
  for (const line of `${ask}\n${context}`.split(/\r?\n/)) {
    if (DOC_GUARD.test(line) || RETRACTION_GUARD.test(line)) continue;
    for (const m of line.matchAll(rxToken)) tokens.push({ verb: m[1].toLowerCase(), num: Number(m[2]), raw: m[0] });
  }
  if (!tokens.length) continue;

  considered++;
  const idx = repoIndexFromText(text);
  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 58);

  const bad = [];
  for (const t of [...new Map(tokens.map((x) => [`${x.verb}:${x.num}`, x])).values()]) {
    const repo = idx.get(`pr:${t.num}`) || idx.get(`issue:${t.num}`) || idx.get(`n:${t.num}`);
    if (!repo) { unresolved.push({ id, token: t.raw, title }); continue; }
    if (OFFLINE) continue;

    refsChecked++;
    const st = lookupState(repo).get(t.num);
    if (!st) { bad.push({ ...t, repo, verdict: 'missing', detail: 'no such PR/issue in repo' }); continue; }
    if (st.state === 'MERGED') { bad.push({ ...t, repo, verdict: 'dead-merged', detail: st.title }); continue; }
    if (st.state === 'CLOSED') { bad.push({ ...t, repo, verdict: 'dead-closed', detail: st.title }); continue; }
    const mg = mergeMap.get(repo)?.get(t.num);
    if (mg && mg.mergeable === 'CONFLICTING') {
      bad.push({ ...t, repo, verdict: 'unexecutable', detail: `CONFLICTING - ${st.title}` });
    }
  }

  if (bad.length) findings.push({ id, status, title, ask: ask.replace(/\s+/g, ' ').slice(0, 130), bad });
}

// ---- Report ---------------------------------------------------------------------------------
console.log(`[A] task universe: ${openBoard.size} open-board row(s) + ${orphansAdded} journal(s) with no board row`);
console.log(`[A] active non-terminal tasks whose live ask names an action on a PR/issue: ${considered}`);
console.log(`[A] references resolved to a repo and checked against GitHub: ${refsChecked}`);
console.log(`[A] unresolved (no URL in the journal ties the number to a repo): ${unresolved.length}`);
console.log(`[A] FLAGGED - ask points at a PR that is merged, closed, absent or unexecutable: ${findings.length}`);
console.log(`[B] watched repos: ${WATCHED.join(', ')}`);
console.log(`[B] open PRs CONFLICTING (latent dead asks): ${conflicting.length}${unknownLeft ? `   (${unknownLeft} still UNKNOWN)` : ''}\n`);

for (const h of findings) {
  console.log(`#${h.id.padEnd(4)} ${h.status.padEnd(11)} ${h.title}`);
  console.log(`      ask : ${h.ask}`);
  for (const b of h.bad) {
    const flag = b.verdict === 'missing' ? '   <-- WRONG REFERENCE (irreversible verb!)' : '';
    console.log(`      ${b.verdict.padEnd(12)} \`${b.raw}\` -> ${b.repo}#${b.num}  ${b.detail}${flag}`);
  }
  console.log('');
}

if (conflicting.length) {
  console.log('[B] CONFLICTING open PRs - fix on the topic branch before anyone is asked to merge them:');
  for (const c of conflicting) console.log(`   ${c.repo}#${c.number}${c.isDraft ? ' (draft)' : ''}  ${c.title.slice(0, 66)}`);
  console.log('');
}

if (unresolved.length) {
  console.log('unresolved (reported, not a finding - repo unknown, guessing would be worse):');
  for (const u of unresolved.slice(0, 20)) console.log(`   #${u.id.padEnd(4)} \`${u.token}\`  ${u.title}`);
}

process.exit(findings.length + conflicting.length ? 1 : 0);
