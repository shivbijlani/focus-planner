// ensure-catchup-doc.mjs — the doc-binding invariant, as code instead of as an instruction.
//
// WHY THIS FILE EXISTS (task #468)
// --------------------------------
// Shiv, on the catch-up doc, reading a Pending bullet that said "bind the remaining 83 open
// tasks, one per wake":
//
//     "It sounds like a one-off patch. Wouldn't it be better if the architecture was so that
//      if a task did not produce a document then it would be made to produce the document.
//      In other words the pseudo code would be
//          if doc does not exist then create doc else continue"
//
// He is right, and that pseudocode is this file. Binding was never a backlog of 83 items to
// work through; it was a missing invariant, and a backlog is what a missing invariant looks
// like from the inside. Working the backlog by hand leaves the hole open: every task created
// after the backfill arrives unbound, and the count climbs again the moment attention moves.
//
// THE REASON IT WASN'T DONE WAS WRONG
// -----------------------------------
// The doc previously claimed the sub-session "has no instrument to do it with" — that Google
// Docs was not on a working session's tool surface. Shiv pushed on exactly that ("Why not.
// shouldn't that happen by default now"), and he was right to: it is false. `create_doc` is
// available through the same capability probe that every edit to that page already goes
// through, and `oa-state.ps1 doc -DocId` has bound documents since #423. Both halves existed.
// Nothing joined them. The gap was never capability — it was that no code called them in
// sequence, and "no code calls it" had been misdiagnosed as "it cannot be called".
//
// That is worth naming because it is the same misread as #346 and as the comment-observation
// bug: a step that nothing invokes is indistinguishable from a step that cannot run, and both
// report success. The fix in every case is the same — make something call it, on a schedule,
// and count what happens.
//
// WHERE THE INVARIANT LIVES, AND WHY NOT IN THE SUB-SESSION
// ---------------------------------------------------------
// One level up from the task. The run that dispatches a wake resolves the binding BEFORE the
// sub-session starts, so the session opens with a doc already bound and can never be the party
// that forgets. Putting the check inside the sub-session would make the thing being enforced
// depend on the thing being enforced against — the sub-session would have to remember to run
// the check that exists because sub-sessions do not remember.
//
// It also keeps `write-turn.ps1` out of it. The obvious alternative was a G-guard refusing a
// turn from an unbound open task, and that is the wrong instrument twice over: it would refuse
// turns on 83 of 88 board rows the first night it was armed, and a guard that always fires gets
// switched off — the argument catchup-doc-sweep.mjs's own header makes. Refusing also destroys
// work over a missing artefact, when creating the artefact is cheap and reversible. Create,
// don't refuse.
//
// WHAT IT DOES NOT DO (each gate is mutation-proven load-bearing)
// --------------------------------------------------------------
//   TERMINAL   done/skip tasks get no doc. Closed work has no live channel, and creating docs
//              for finished tasks rebuilds #170 — writing at work Shiv has already finished —
//              in a new surface.
//   BOUND      a bound task is never touched. This is the "else continue" half, and it matters
//              more than the create half: rebinding would point a task at a fresh empty doc and
//              silently orphan the page Shiv has been commenting on. The binding in oa-state.ps1
//              refuses a conflicting id for the same reason (#423); this refuses to ask.
//   NO STATE   a board row with no state file is skipped rather than seeded. Creating state as a
//              side effect of doc creation would make this file a second writer of task state,
//              and one writer per fact is the rule that #473 exists to hold.
//   LIMIT      at most --limit creations per run (default 5). Blast radius: the first armed run
//              faces every unbound task at once, and a bug that creates one wrong document
//              should not create 83 of them before anyone reads the output.
//
// TESTABILITY
// -----------
// The decision is pure and the effects are not. `decide()` answers CREATE / CONTINUE / SKIP from
// state alone, with no I/O, so the mutation check can run every gate on fixtures on the Linux CI
// runner where neither the capability probe nor PowerShell exists. `--dry-run` prints the
// decisions and performs none of them.
//
// USAGE
//   node ensure-catchup-doc.mjs --dry-run          decide for every active board row, do nothing
//   node ensure-catchup-doc.mjs                    create + bind, up to --limit
//   node ensure-catchup-doc.mjs --task 468         one task
//   node ensure-catchup-doc.mjs --limit 1          tighter blast radius

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DRY = flag('dry-run');
const ONLY = opt('task', '');
const LIMIT = Number(opt('limit', '5')) || 5;
const EMAIL = process.env.OA_GOOGLE_EMAIL || 'shiv@bijlanis.com';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) {
  console.error('PLANNER_PATH is not set. Run via run-sweeps.ps1, which exports it.');
  process.exit(2);
}

// Same Linux-safety shape as catchup-doc-sweep.mjs: explicit parameter first, Windows default
// only as a fallback, because `path.join(undefined, …)` throws on the CI runner.
const STATE_DIR =
  process.env.OA_STATE_DIR ||
  (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state') : '');
if (!STATE_DIR) {
  console.error('No state dir: set OA_STATE_DIR (or run on Windows, where LOCALAPPDATA is set).');
  process.exit(2);
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

const TERMINAL = new Set(['done', 'skip']);

// PURE. No I/O, no clock, no environment — so the mutation check can drive every branch from a
// fixture. Everything that can fail lives on the other side of this function.
export function decide(state) {
  if (!state) return { action: 'SKIP', reason: 'no-state' }; // gate NO STATE
  if (TERMINAL.has(String(state.status))) return { action: 'SKIP', reason: 'terminal' }; // gate TERMINAL
  const doc = state.doc ?? {};
  if (doc.doc_id) return { action: 'CONTINUE', reason: 'bound' }; // gate BOUND
  return { action: 'CREATE', reason: 'unbound' };
}

// The board is the universe of live tasks, same as every other sweep. Row shape is
// `| id | icon | title | …`, so the title is the third cell.
const boardFile = path.join(PLANNER, 'planner.md');
const board = fs.existsSync(boardFile) ? fs.readFileSync(boardFile, 'utf8') : '';
const rows = [];
for (const line of board.split(/\r?\n/)) {
  const m = /^\|\s*(\d+)[,\s|]/.exec(line);
  if (!m) continue;
  const cells = line.split('|').map((c) => c.trim());
  rows.push({ id: m[1], title: cells[3] || `Task ${m[1]}` });
}

const probe = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'mcp-probe.mjs');

function createDoc(title, id, taskTitle) {
  // Seeded, not empty. An empty document bound to a task is worse than no document: it looks
  // like a page that lost its contents, and Shiv has no way to tell "created, awaiting its first
  // wake" from "written and then wiped". The stub says which it is.
  const content = [
    `Catch-up: Task ${id} — ${taskTitle}`,
    '',
    'This page was created automatically when the task was bound to a catch-up doc, and has not',
    'been written yet. Its first wake replaces this text with the current state of the work.',
    '',
    'Comments on this page are the primary channel for this task. The agent never comments here —',
    'it answers by editing the page — so every comment on it is yours.',
  ].join('\n');
  const args = JSON.stringify({ user_google_email: EMAIL, title, content });
  const r = spawnSync(process.execPath, [probe, 'google-workspace', 'call', 'create_doc', args], {
    encoding: 'utf8',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // The id is echoed back in the result prose; a doc id is the long opaque Drive key.
  const m = /document\/d\/([A-Za-z0-9_-]{25,})/.exec(out) || /["'\s]([A-Za-z0-9_-]{40,})["'\s]/.exec(out);
  return m ? m[1] : null;
}

function bind(id, docId) {
  const oa = path.join(
    process.env.OA_SKILL_DIR ||
      path.join(
        process.env.USERPROFILE || '',
        '.copilot',
        'installed-plugins',
        'focus-planner',
        'overnight-agent',
        'skills',
        'overnight-agent',
      ),
    'oa-state.ps1',
  );
  // -DocUrl is not decoration. The journal stamp carries it, and write-turn.ps1's G10 accepts a
  // turn that names the doc by URL as well as by id; binding without it leaves the stamp id-only
  // and quietly narrows what counts as a valid pointer turn.
  const url = `https://docs.google.com/document/d/${docId}/edit`;
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', oa, 'doc', '-Id', id, '-DocId', docId, '-DocUrl', url],
    { encoding: 'utf8' },
  );
  return r.status === 0;
}

let created = 0;
let contd = 0;
let skipped = 0;
let failed = 0;
const capped = [];

for (const row of rows) {
  if (ONLY && row.id !== ONLY) continue;
  const st = readJson(path.join(STATE_DIR, `task-${row.id}.json`));
  const d = decide(st);

  if (d.action === 'CONTINUE') {
    contd++;
    continue;
  }
  if (d.action === 'SKIP') {
    skipped++;
    continue;
  }

  // gate LIMIT — decided CREATE, but this run has already created its allowance.
  if (created >= LIMIT) {
    capped.push(row.id);
    continue;
  }

  if (DRY) {
    console.log(`CREATE ${row.id} ${row.title}`);
    created++;
    continue;
  }

  const title = `Catch-up: Task ${row.id} — ${row.title}`;
  const docId = createDoc(title, row.id, row.title);
  if (!docId) {
    console.log(`FAILED ${row.id} could not create doc`);
    failed++;
    continue;
  }
  if (!bind(row.id, docId)) {
    console.log(`FAILED ${row.id} created ${docId} but binding refused`);
    failed++;
    continue;
  }
  console.log(`CREATE ${row.id} ${docId}`);
  created++;
}

console.log(
  `ensure-catchup-doc: created ${created}, continued ${contd}, skipped ${skipped}, failed ${failed}${
    capped.length ? `, deferred ${capped.length} to a later run (limit ${LIMIT})` : ''
  }${DRY ? ' [dry-run]' : ''}`,
);

// Exit non-zero only on a real failure. An unbound task is not an error here — it is the work,
// and this run either did it or deferred it under the limit. Reporting deferral as failure would
// make the check red on every run until coverage completed, which is the always-firing detector
// this file's header argues against.
process.exit(failed > 0 ? 1 : 0);
