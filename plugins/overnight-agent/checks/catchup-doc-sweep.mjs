// catchup-doc-sweep.mjs — is the catch-up doc's comment channel actually being READ?
//
// WHY THIS FILE EXISTS (GH #421)
// -----------------------------
// Shiv's instruction on task #468, in his own words:
//
//     "The document comments will be the primary communication mechanism. Each turn, you
//      will read the comments and amend the document."
//
// Every primitive needed to honour that has shipped:
//
//   #422  lib-doc-comments.mjs   attribution — whose comment is this (readingView/consentView)
//   #423  oa-state.ps1 doc       durable binding + a two-phase watermark (-Observe / -Ack)
//   #424  telegram-bridge        the topic posts the link once, then stays quiet
//   #425  write-turn.ps1         the journal turn became a pointer to the doc
//
// And yet, measured on the live state store on 2026-09-03 — the day after the binding
// shipped — the one and only doc-bound task read:
//
//     task-468.json  doc.seen_ids []   doc.pending_ids []   doc.observed_at ""
//
// `observed_at` empty means `doc -Observe` has NEVER been called, on the only task that
// has a doc. So the channel Shiv was told is primary is read by nothing. `scan` reports
// `doc_new_comments` from the last `-Observe`, so with no observation it is structurally
// pinned at 0 — a comment he writes is not "missed", it is unreachable, and the run says
// zero either way.
//
// THIS IS THE #196/#346 SHAPE, IN A THIRD SURFACE
// -----------------------------------------------
// #196: merged did not mean running. #346: a mandated inbox check silently did not run,
// and a search that COULD NOT LOOK returned the same bytes as one that looked and found
// nothing. Both are the same defect: a capability that exists, is documented, and is
// invoked by no phase — with a success-shaped result when it is skipped.
//
// The four issues above each shipped a primitive and a guard for that primitive. None of
// them asserts that a RUN ever calls one. That is the gap this sweep closes, and it is
// why the fix is not "remember to call -Observe": prose has already failed this repo in
// exactly this way, which is what write-turn.ps1's own header says about its five
// corruption classes ("each of these classes was documented in prose first and broken
// anyway").
//
// WHAT IT REPORTS
// ---------------
//   NEVER_READ            bound, `observed_at` empty. The channel has never been read.
//   SPOKE_WITHOUT_READING the newest turn is more than READ_WINDOW_HOURS newer than the last
//                         observation — the run wrote without reading first.
//
//                         THE WINDOW IS NOT A FUDGE FACTOR. PHASE 0.7 reads BEFORE the run
//                         writes its turns, so in a perfectly healthy run `last_turn_at` is
//                         always a few minutes newer than `observed_at`. A bare
//                         `last_turn_at > observed_at` therefore fires on every doc-bound task
//                         the run touches. Measured on the first live run after this sweep
//                         shipped: observed 14:36:51, turn 14:43:50, flagged — a false positive
//                         produced by the correct sequence. That is exactly the always-firing
//                         advisory #433 warns about, and this file's own header argues against
//                         it two paragraphs up, so shipping it here would have been the
//                         detector flagging its own healthy path. Within the window the read and
//                         the turn belong to one working session; beyond it, the run answered
//                         from a read belonging to an earlier session, which is the real defect.
//   UNACKED               `-Observe` reported comments and nothing ever `-Ack`ed them.
//                         Two-phase is deliberate (#423), so this is the crash-window
//                         residue that means an instruction was seen and dropped.
//
// WHAT IT DELIBERATELY DOES NOT REPORT (each gate is mutation-proven load-bearing)
// -------------------------------------------------------------------------------
//   TERMINAL  a done/skip task. Closed work has no live channel to read, and flagging it
//             would rebuild #170 (writing at tasks Shiv has finished) as a metric.
//   UNBOUND   a task with no doc. Whether every task SHOULD have one is #421's open
//             "Scope" question ("242 tasks x 1 doc is a lot of Drive clutter for rows like
//             'buy a bath mat'"). Answering it by flagging 200 rows would make this sweep
//             unreadable on day one, and an always-firing detector gets switched off.
//   FRESH     observed at or after the newest turn. That is the healthy loop; it must go
//             quiet, or the sweep cannot distinguish fixed from broken.
//
// Exit 1 when there are findings (stdout, no stderr) so run-sweeps.ps1 classifies it
// FINDINGS rather than CRASH.
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) {
  console.error('PLANNER_PATH is not set. Run via run-sweeps.ps1, which exports it.');
  process.exit(2);
}

// LOCALAPPDATA does not exist off Windows, and `path.join(undefined, …)` throws. The
// mutation check runs on the Linux CI runner, so the state dir is an explicit parameter
// first and the Windows default only a fallback. (#425's CI went red on exactly this
// class of Linux-only path bug, so it is spelled out rather than assumed.)
const STATE_DIR =
  process.env.OA_STATE_DIR ||
  (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state') : '');
if (!STATE_DIR) {
  console.error('No state dir: set OA_STATE_DIR (or run on Windows, where LOCALAPPDATA is set).');
  process.exit(2);
}

const JOURNALS = path.join(PLANNER, 'journal');

// How far a turn may trail its read and still count as the same working session. Configurable so
// a long run can widen it without editing code, but a NUMBER, not a toggle: setting it to 0
// restores the always-fires behaviour this constant exists to prevent, so 0 is treated as "unset"
// and falls back to the default rather than silently arming the false positive.
const READ_WINDOW_HOURS = Number(process.env.OA_DOC_READ_WINDOW_HOURS) || 6;
const READ_WINDOW_MS = READ_WINDOW_HOURS * 3600 * 1000;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

// The board is the universe of live tasks, same as every other sweep.
const boardFile = path.join(PLANNER, 'planner.md');
const board = fs.existsSync(boardFile) ? fs.readFileSync(boardFile, 'utf8') : '';
const activeIds = [...board.matchAll(/^\|\s*(\d+)[,\s|]/gm)].map((m) => m[1]);

const TERMINAL = new Set(['done', 'skip']);

const ts = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? null : t;
};

const findings = [];
let bound = 0;
let considered = 0;

for (const id of activeIds) {
  const st = readJson(path.join(STATE_DIR, `task-${id}.json`));
  if (!st) continue;

  if (TERMINAL.has(String(st.status))) continue; // gate TERMINAL

  considered++;

  // `?? {}` rather than `null` so that DELETING the gate below yields a finding instead of a
  // TypeError. A mutant that crashes proves the line is reachable, not that it is load-bearing.
  const doc = st.doc ?? {};
  if (!doc.doc_id) continue; // gate UNBOUND

  bound++;

  const observedAt = ts(doc.observed_at);
  const lastTurnAt = ts(st.last_turn_at);
  const pending = Array.isArray(doc.pending_ids) ? doc.pending_ids.length : 0;

  const row = {
    id,
    status: String(st.status ?? ''),
    docId: String(doc.doc_id ?? ''),
    observed_at: doc.observed_at || '(never)',
    last_turn_at: st.last_turn_at || '(none)',
    pending,
    journal: fs.existsSync(path.join(JOURNALS, `task-${id}.md`)),
  };

  if (!observedAt) {
    findings.push({ ...row, kind: 'NEVER_READ' });
    continue;
  }

  // gate FRESH: an observation at, after, or within READ_WINDOW_MS before the newest turn is the
  // healthy read-then-work-then-write loop of a single run.
  if (lastTurnAt && lastTurnAt - observedAt > READ_WINDOW_MS) {
    findings.push({ ...row, kind: 'SPOKE_WITHOUT_READING' });
    continue;
  }

  if (pending > 0) findings.push({ ...row, kind: 'UNACKED' });
}

const byKind = (k) => findings.filter((f) => f.kind === k).length;

console.log(`Catch-up doc channels UNREAD: ${findings.length}`);
console.log(
  // "active board rows", not "live non-terminal tasks". The denominator is `activeIds` (parsed
  // from planner.md) minus TERMINAL, so it counts tasks ON THE BOARD -- measured 2026-09-05:
  // 108 live non-terminal tasks exist, but only 84 are on the board, so the old wording silently
  // dropped 24 of them. A reader reconciling "5 of 84" against 108 finds a gap with nothing
  // explaining it and reasonably concludes the metric is broken.
  //
  // 84 is the RIGHT denominator -- SKILL.md treats a task on neither board as closed, so an
  // off-board task is not work this feature could serve. Only the label was wrong, so this is a
  // wording fix and deliberately not a logic change.
  `  (${bound} of ${considered} active board rows are doc-bound; ` +
    `never read ${byKind('NEVER_READ')}, spoke-without-reading ${byKind('SPOKE_WITHOUT_READING')}, ` +
    `unacked ${byKind('UNACKED')})\n`,
);

for (const f of findings) {
  console.log(`#${f.id} [${f.status}]  ${f.kind}`);
  console.log(`     doc:       ${f.docId}`);
  console.log(`     observed:  ${f.observed_at}`);
  console.log(`     last turn: ${f.last_turn_at}${f.pending ? `   pending comments: ${f.pending}` : ''}`);
  if (f.kind === 'NEVER_READ') {
    console.log('     -> no run has ever called `oa-state.ps1 doc -Observe` for this task, so a');
    console.log('        comment on the doc reaches nothing and `scan` reports 0 either way.');
  }
  if (f.kind === 'SPOKE_WITHOUT_READING') {
    console.log(`     -> the newest turn is more than ${READ_WINDOW_HOURS}h newer than the last read:`);
    console.log('        the run answered from an observation belonging to an earlier session.');
  }
  if (f.kind === 'UNACKED') {
    console.log('     -> comments were reported new by -Observe and never -Ack`ed: seen and dropped.');
  }
  console.log('');
}

process.exit(findings.length ? 1 : 0);
