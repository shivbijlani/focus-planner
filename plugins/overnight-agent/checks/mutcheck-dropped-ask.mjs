// mutcheck-dropped-ask.mjs
//
// Proves dropped-ask-sweep pins the behaviour it claims, on throwaway trees with a fixed
// GitHub fixture. Rule this exists for (user-settings.md, 2026-08-26 11:15 / 12:10):
// "a detector that goes to zero right after you edit it has not necessarily been fixed",
// and "mutation-check the GUARDS, not just the matcher".
//
// The guards matter more than the matcher here. This sweep's first live run reported 13
// findings; 9 of them were its own false positives, each killed by one guard:
//   * ask-context scope     -> `merge 198` was the TOP item of the newest turn, 100 lines
//                              below the ask line. (3 false positives)
//   * same-number supersession -> `merge 149` retired in favour of `close 149 152`.
//   * stack consolidation   -> #160-#164 are merged by merging the tip of their stack.
//                              (5 false positives)
// A guard that is not tested is a guard that silently stops guarding, so each has a case
// here AND a mutation that must make that case fail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SWEEP = path.join(HERE, 'dropped-ask-sweep.mjs');

let pass = 0;
let fail = 0;

function build(tmp, journals, fixture) {
  fs.mkdirSync(path.join(tmp, 'journal'), { recursive: true });
  for (const [name, body] of Object.entries(journals)) {
    fs.writeFileSync(path.join(tmp, 'journal', name), body, 'utf8');
  }
  fs.writeFileSync(path.join(tmp, 'planner.md'), '| ID | Task |\n| 1 | x |\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'fixture.json'), JSON.stringify(fixture), 'utf8');
}

function run(tmp) {
  const env = {
    ...process.env,
    PLANNER_PATH: tmp,
    OA_DROPPED_ASK_FIXTURE: path.join(tmp, 'fixture.json'),
  };
  delete env.OA_PR_SWEEP_OFFLINE;
  try {
    return { out: execFileSync('node', [SWEEP], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status ?? 1 };
  }
}

function check(name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-dropped-'));
  let ok = false;
  let detail = '';
  try {
    const r = fn(tmp);
    ok = r === true || r?.ok === true;
    detail = r?.detail || '';
  } catch (e) {
    detail = String(e.message || e);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `  <- ${detail}` : ''}`); }
}

const LINK = 'https://github.com/acme/widget/pull/42';
const A = '<!-- from: overnight-agent -->';

// A journal whose OLD turn carries `merge 42` and whose NEWEST turn does not.
const droppedJournal = `# Task 7: x

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## 🌙 Overnight Agent

**Status:** In-progress

Linked: ${LINK}

## 2026-08-01
${A}
**Needs from you:** reply \`merge 42\` and I will land it.

## 2026-08-20
${A}
**Needs from you:** nothing right now.
`;

const openPr = { 'acme/widget': { prs: { 42: { state: 'OPEN', title: 'the change', base: 'main', head: 'topic' } } } };

console.log('DETECTION\n');

check('FIRES when an ask stops being carried and the PR is still OPEN', (tmp) => {
  build(tmp, { 'task-7.md': droppedJournal }, openPr);
  const { out, code } = run(tmp);
  return { ok: /STILL OPEN: 1/.test(out) && /merge 42/.test(out) && code === 1, detail: out.slice(0, 200) };
});

console.log('\nGUARDS — each must SUPPRESS a finding\n');

check('SILENT when the token is still in the newest turn (even far below the ask line)', (tmp) => {
  // The ask line is a POINTER; the token is 30 lines lower in the same turn. This is the
  // exact shape that produced 3 false positives on the live corpus (#448 `merge 198`).
  const j = droppedJournal.replace(
    '**Needs from you:** nothing right now.',
    `**Needs from you:** the calls below.\n${'\nfiller\n'.repeat(30)}\nReply \`merge 42\`.`,
  );
  build(tmp, { 'task-7.md': j }, openPr);
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 0/.test(out), detail: out.slice(0, 200) };
});

check('SILENT when a DIFFERENT verb on the same number is live (merge -> close)', (tmp) => {
  const j = droppedJournal.replace('**Needs from you:** nothing right now.', '**Needs from you:** reply \`close 42\`.');
  build(tmp, { 'task-7.md': j }, openPr);
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 0/.test(out), detail: out.slice(0, 200) };
});

check('SILENT when the ask is carried by ANOTHER task (rehoming is not dropping)', (tmp) => {
  const other = `# Task 8: y\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\nLinked: ${LINK}\n\n${A}\n**Needs from you:** reply \`merge 42\`.\n`;
  build(tmp, { 'task-7.md': droppedJournal, 'task-8.md': other }, openPr);
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 0/.test(out), detail: out.slice(0, 200) };
});

check('SILENT when the PR is MERGED (retired for the right reason)', (tmp) => {
  build(tmp, { 'task-7.md': droppedJournal },
    { 'acme/widget': { prs: { 42: { state: 'MERGED', title: 'the change' } } } });
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 0/.test(out) && /correctly retired \(merged\/closed\)     : 1/.test(out), detail: out.slice(0, 300) };
});

check('SILENT when the PR is STACKED on another open PR (tip carries it)', (tmp) => {
  build(tmp, { 'task-7.md': droppedJournal }, {
    'acme/widget': {
      prs: {
        42: { state: 'OPEN', title: 'child', base: 'parent-branch', head: 'topic' },
        41: { state: 'OPEN', title: 'parent', base: 'main', head: 'parent-branch' },
      },
    },
  });
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 0/.test(out) && /based on #41/.test(out), detail: out.slice(0, 300) };
});

check('SILENT when the number was only ever in PROSE, never in an ask', (tmp) => {
  const j = `# Task 7: x\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\nLinked: ${LINK}\n\n${A}\nBackground: we could merge 42 one day.\n**Next:** nothing.\n\n${A}\n**Needs from you:** nothing.\n`;
  build(tmp, { 'task-7.md': j }, openPr);
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 0/.test(out), detail: out.slice(0, 200) };
});

check('SILENT when the repo cannot be resolved (never guess)', (tmp) => {
  const j = droppedJournal.replace(`Linked: ${LINK}\n`, '');
  build(tmp, { 'task-7.md': j }, openPr);
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 0/.test(out) && /unresolved/.test(out), detail: out.slice(0, 300) };
});

check('SILENT when the number is a COUNT followed by a noun (`close 3 browser slots`)', (tmp) => {
  // Reproduces the live false positive of 2026-08-27. These verbs are ordinary English, so
  // an ask region reading "close 3 browser slots (~2.2 GB)" tokenised as `close:3`. The
  // number then resolved against the CORPUS-WIDE repo index, so an UNRELATED journal's link
  // to pull/3 attributed it to that repo, and it was reported as a dropped ask for 5 days
  // against a task that had never mentioned the repo. The number is a quantity, not a ref.
  //
  // The second journal is load-bearing and must not be "simplified" away: without a link
  // that lets `3` resolve to a repo, the sweep reports it as `unresolved` and this case
  // passes for the wrong reason -- it reads 0 because it cannot see the defect rather than
  // because the guard suppressed it. Verified by mutation: with the guard reverted, this
  // case FAILS (1 finding) only while task-8 is present.
  const counting = `# Task 7: x\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\n${A}\n**Next:** three reversible wins left — close 3 browser slots (~2.2 GB), trim to 2 CDP MCP servers.\n\n${A}\n**Needs from you:** nothing.\n`;
  const linker = `# Task 8: y\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\nBackground only, no ask: https://github.com/acme/widget/pull/3\n\n${A}\n**Needs from you:** nothing.\n`;
  build(tmp, { 'task-7.md': counting, 'task-8.md': linker },
    { 'acme/widget': { prs: { 3: { state: 'OPEN', title: 'an unrelated open pr', base: 'main', head: 'other' } } } });
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 0/.test(out), detail: out.slice(0, 300) };
});

check('still FIRES on an explicit `#` reference followed by prose (guard is not too broad)', (tmp) => {
  // The lazy fix for the case above is to drop bare numbers, or to reject any number
  // followed by a word. Either would blind the sweep to the most common real phrasing,
  // "merge #42 on your approval", so pin the opposite direction too.
  const j = `# Task 7: x\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\nLinked: ${LINK}\n\n${A}\n**Next:** merge #42 on your approval.\n\n${A}\n**Needs from you:** nothing.\n`;
  build(tmp, { 'task-7.md': j }, openPr);
  const { out } = run(tmp);
  return { ok: /STILL OPEN: 1/.test(out), detail: out.slice(0, 300) };
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
