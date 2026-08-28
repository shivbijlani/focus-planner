// mutcheck-external-surface.mjs — prove external-surface-sweep FIRES on the two known-bad inputs
// it was built for, goes QUIET the five ways it could cry wolf, and SELF-CLEARS when polled.
//
// This suite has shipped detectors that read a confident, permanent 0 — cross-task-dependency-sweep
// (wrong capture group, every id `undefined`) and reversible-gate-sweep (filtered out exactly the
// journals its victim lived in). Both were caught only by a mutation check asserting they FIRE.
//
// The stakes here are higher than usual because the sweep's healthy steady state is a small number,
// so "it printed 1" is not evidence it works. Every guard below is neutered in turn; if the sweep's
// answer does not change, the guard is decoration and this file fails.
//
// Method: synthetic planner folders, running the REAL sweep as a child process. No reimplementation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = import.meta.dirname;
const SWEEP = path.join(DIR, 'external-surface-sweep.mjs');
const LIB = path.join(DIR, 'lib-external-surfaces.mjs');
const S = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->';
const A = '<!-- from: overnight-agent -->';
const DOC = 'https://docs.google.com/document/d/1aN7SPJQeM2WtIfucnfJ6Secz_HXK7FvxSKVSMlUPwlI/edit';
const DOC2 = 'https://docs.google.com/document/d/1aZ6izDT3jB2o8Sw3N_32i50kubGJzgiIbBs9sMbB0uQ/edit';

// ---- fixtures ---------------------------------------------------------------

// #459 EXACTLY as it stood on 2026-08-27, the day Shiv's two comments sat unseen. This is the
// case the sweep exists for; if it does not fire here, nothing else matters.
const T459 = `# Task 459: Resume review loop
${S}

${A}

**Status:** In progress · step 1 · 2026-08-26

📄 **[The doc](${DOC})** — converted cleanly, headings and scores intact.

**Needs from you:** open the doc and leave **one** comment on any line — that's all step 1 needs.
`;

// #446 as found live on 2026-08-28: a second, independent instance of the same defect. Its turn
// links MANY artifacts, which is the flooding case the noun gate exists for.
const T446 = `# Task 446: PARs technical summaries
${S}

${A}

**Status:** In progress · doc is ready to comment on · 2026-08-28

**[PARs Master](${DOC2})**
Also: [variant A](${DOC}) and [the folder](https://drive.google.com/drive/folders/1izh2gosVZVBc62KzIBhnTUPsZlSfsF7l)
and [the PR](https://github.com/shivbijlani/Resume/pull/3).

**Your call:** comment on the doc, or \`draft technical summaries\`.
`;

// QUIET 1 — terminal. A done task's ask is history; polling it forever is noise.
const T900_DONE = T459.replace('**Status:** In progress · step 1 · 2026-08-26', '**Status:** Done · 2026-08-27')
  .replace('# Task 459', '# Task 900');

// QUIET 2 — the ask wants nothing. Dismissive per #163.
const T901_NONE = `# Task 901: quiet
${S}

${A}

**Status:** in-progress · 2026-08-26

📄 [The doc](${DOC})

**Needs from you:** none. I'll carry on next run.
`;

// QUIET 3 — READ-ONLY ask. Reading a doc leaves no trace, so there is nothing to watch. This is
// the single largest false-positive family: most turns link a deliverable for Shiv to look at.
const T902_READONLY = `# Task 902: read only
${S}

${A}

**Status:** in-progress · 2026-08-26

📄 [The doc](${DOC})

**Needs from you:** have a read of the doc when you get a minute. Nothing to action.
`;

// QUIET 4 — a real surface ask, but NO resolvable identifier. Nothing to poll = not a worklist row.
const T903_NOID = `# Task 903: no link
${S}

${A}

**Status:** in-progress · 2026-08-26

**Needs from you:** leave a comment on the doc I shared with you last week.
`;

// QUIET 5 — the live ask QUOTES a past request (#267). The quoted span must not read as a live
// one. Note the quote sits INSIDE the newest ask: putting it in an older turn would prove nothing,
// because liveAsk would never look at it.
const T904_QUOTED = `# Task 904: quoting
${S}

${A}

**Status:** in-progress · 2026-08-26

📄 [The doc](${DOC})

**Needs from you:** confirm the wording I settled on. My earlier ask, "open the doc and leave a
comment on any line", is already handled and needs nothing more.
`;

// ---- harness ----------------------------------------------------------------
let failures = 0;
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

function makePlanner(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-surface-'));
  const j = path.join(root, 'journal');
  fs.mkdirSync(j);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(j, name), body, 'utf8');
  return root;
}

/** Run the sweep; return { code, out, flagged, ids }. */
function run(planner, { state = null, now = null, sweep = SWEEP } = {}) {
  const stateFile = state ?? path.join(planner, 'polls.json');
  const env = {
    ...process.env,
    PLANNER_PATH: planner,
    OA_SURFACE_STATE: stateFile,
    OA_SURFACE_WORKLIST: path.join(planner, 'worklist.json'),
  };
  if (now) env.OA_NOW = now;
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [sweep], { env, encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 1;
  }
  const m = /FLAGGED[^:]*:\s*(\d+)/.exec(out);
  return {
    code, out,
    flagged: m ? Number(m[1]) : -1,
    ids: [...out.matchAll(/^\s+#(\d+)\s+status=/gm)].map(x => x[1]),
  };
}

/** Copy the sweep + lib into a scratch dir with `edit` applied to the lib, and run that copy. */
function withMutatedLib(edit) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mut-'));
  for (const f of ['external-surface-sweep.mjs', 'lib-external-surfaces.mjs', 'lib-live-ask.mjs', 'lib-live-status.mjs']) {
    fs.copyFileSync(path.join(DIR, f), path.join(scratch, f));
  }
  const p = path.join(scratch, 'lib-external-surfaces.mjs');
  const src = fs.readFileSync(p, 'utf8');
  const mutated = edit(src);
  if (mutated === src) throw new Error('mutation was a no-op — the guard text moved, fix the mutcheck');
  fs.writeFileSync(p, mutated, 'utf8');
  return path.join(scratch, 'external-surface-sweep.mjs');
}

// ---- 1. it FIRES on both live victims ---------------------------------------
{
  const p = makePlanner({ 'task-459.md': T459 });
  const r = run(p);
  ok('FIRES on #459 (the Google Doc comments that sat a day unseen)', r.flagged === 1 && r.ids.includes('459'),
    `flagged=${r.flagged} ids=${r.ids}`);
  ok('  and exits 1 so run-sweeps reports FINDINGS', r.code === 1, `code=${r.code}`);
}
{
  const p = makePlanner({ 'task-446.md': T446 });
  const r = run(p);
  ok('FIRES on #446 (second live instance, found by this sweep on 2026-08-28)', r.flagged === 1,
    `flagged=${r.flagged}`);
  ok('  and emits ONE row, not one per linked artifact (noun gate)', r.flagged === 1, r.out.match(/gdoc|gdrive|github/g)?.join(',') || '');
}

// ---- 2. it stays QUIET the five ways it could cry wolf -----------------------
for (const [label, files] of [
  ['terminal task', { 'task-900.md': T900_DONE }],
  ['dismissive ask (#163)', { 'task-901.md': T901_NONE }],
  ['read-only ask — the big false-positive family', { 'task-902.md': T902_READONLY }],
  ['surface ask with no resolvable id', { 'task-903.md': T903_NOID }],
  ['ask is quoted history (#267)', { 'task-904.md': T904_QUOTED }],
]) {
  const r = run(makePlanner(files));
  ok(`QUIET on ${label}`, r.flagged === 0 && r.code === 0, `flagged=${r.flagged} code=${r.code}`);
}

// ---- 3. it SELF-CLEARS, and re-arms ------------------------------------------
{
  const p = makePlanner({ 'task-459.md': T459 });
  const stateFile = path.join(p, 'polls.json');
  const key = '459:gdoc:1aN7SPJQeM2WtIfucnfJ6Secz_HXK7FvxSKVSMlUPwlI';

  fs.writeFileSync(stateFile, JSON.stringify({ [key]: { at: '2026-08-28T09:00:00.000Z' } }), 'utf8');
  const fresh = run(p, { state: stateFile, now: '2026-08-28T11:00:00.000Z' });
  ok('SELF-CLEARS after a poll (2h < 6h window)', fresh.flagged === 0 && fresh.code === 0,
    `flagged=${fresh.flagged}`);

  const stale = run(p, { state: stateFile, now: '2026-08-28T20:00:00.000Z' });
  ok('RE-ARMS once the poll goes stale (11h > 6h window)', stale.flagged === 1, `flagged=${stale.flagged}`);

  // The failure this guard prevents: a surface stamped last week counting as coverage for an ask
  // written today. That is how #459 would have stayed invisible even WITH a poll record.
  fs.writeFileSync(stateFile, JSON.stringify({ [key]: { at: '2026-08-20T09:00:00.000Z' } }), 'utf8');
  const pre = run(p, { state: stateFile, now: '2026-08-20T10:00:00.000Z' });
  ok('a poll PREDATING the ask never counts as covering it', pre.flagged === 1, `flagged=${pre.flagged}`);
}

// ---- 4. every guard is mutation-proven load-bearing ---------------------------
// If neutering a guard does not change the answer, the guard is decoration.
{
  // g1 — the surface-ACTION requirement. Neutered, the read-only ask floods in.
  const s1 = withMutatedLib(src => src.replace(
    'return RX_SURFACE_ACTION.test(a) && surfaceKindsNamed(a).length > 0;',
    'return surfaceKindsNamed(a).length > 0;'));
  const r1 = run(makePlanner({ 'task-902.md': T902_READONLY }), { sweep: s1 });
  ok('g1 load-bearing: without the action gate, a read-only ask flags', r1.flagged === 1, `flagged=${r1.flagged}`);

  // g2 — the noun/KIND gate. Neutered, #446's one ask emits every artifact its turn links.
  const s2 = withMutatedLib(src => src.replace(
    'for (const [rx, ks] of NOUN_KINDS) if (rx.test(a)) ks.forEach(k => kinds.add(k));',
    "for (const [, ks] of NOUN_KINDS) ks.forEach(k => kinds.add(k));"));
  const r2 = run(makePlanner({ 'task-446.md': T446 }), { sweep: s2 });
  ok('g2 load-bearing: without the noun gate, one ask floods to every linked artifact',
    r2.flagged > 1, `flagged=${r2.flagged}`);

  // g3 — quote stripping (#267). Neutered, quoted history reads as a live request.
  const s3 = withMutatedLib(src => src.replace(
    "  const stripped = String(text || '')",
    "  if (true) return String(text || '');\n  const stripped = String(text || '')"));
  const r3 = run(makePlanner({ 'task-904.md': T904_QUOTED }), { sweep: s3 });
  ok('g3 load-bearing: without quote stripping, quoted history flags', r3.flagged === 1, `flagged=${r3.flagged}`);

  // g4 — the #163 dismissal rule. Neutered so ANY dismissive opener kills the whole ask, the
  // qualified-dismissal case ("none — but comment on the doc") would be silently dropped.
  const T905_QUALIFIED = T901_NONE
    .replace('# Task 901', '# Task 905')
    .replace("**Needs from you:** none. I'll carry on next run.",
      '**Needs from you:** none to proceed. But do leave a comment on the doc if you disagree.');
  const base = run(makePlanner({ 'task-905.md': T905_QUALIFIED }));
  ok('a QUALIFIED dismissal still carries its ask (#163)', base.flagged === 1, `flagged=${base.flagged}`);
  const s4 = withMutatedLib(src => src.replace(
    '  if (!RX_DISMISSIVE.test(a)) return false;',
    '  if (!RX_DISMISSIVE.test(a)) return false;\n  return true;'));
  const r4 = run(makePlanner({ 'task-905.md': T905_QUALIFIED }), { sweep: s4 });
  ok('g4 load-bearing: a whole-ask dismissal drops the qualified case', r4.flagged === 0, `flagged=${r4.flagged}`);
}

console.log(`\n${failures ? `FAILURES: ${failures}` : 'all assertions passed'}`);
process.exit(failures ? 1 : 0);
