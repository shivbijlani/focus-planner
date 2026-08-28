// cross-task-dependency-sweep.mjs — find tasks parked on ANOTHER task's work that already shipped.
//
// WHY THIS EXISTS
// ---------------
// Found live 2026-08-26 on #249. Its block had been `blocked` since 2026-08-07 with:
//
//     "Next: after that login, execute #393's full-history export + SQLite load."
//
// #393 completed exactly that on 2026-08-08 — 21,335 hourly intervals in
// task-393-scl-usage.sqlite (8.2 MB, on disk, also archived to OneDrive\utilities-analysis).
// The blocker was dead ONE DAY after it was written, and #249 then sat parked for 18 days
// with an ask that needed nothing from Shiv at all.
//
// This is NOT reachable by any existing detector, and the reason is structural: every one of
// them reads a SINGLE journal.
//   - regressive-ask-sweep looks BACKWARDS from the block into that file's own history.
//   - body/terminal-header-drift compare the block against that file's NEWEST turn.
//   - undelivered-plan / reversible-gate ask whether THIS task's plan was delivered.
//   - blocked-readonly asks whether THIS task's own ask needs anything.
// Nobody follows the dependency SIDEWAYS across the link to ask "did the other task do it?"
// A task whose blocker lives in a different file is invisible to the whole suite by construction.
//
// Two arms, both mechanical and both self-evidencing (the proof is a file on disk or another
// journal's own status line):
//
//   A artifact satisfied — the dependency names task #R, and a `task-R-*` deliverable was
//                          WRITTEN AFTER this task last spoke. Strongest arm: it does not
//                          trust any status label, only bytes on disk.
//   B status satisfied   — the dependency names task #R, and #R's own block status is now
//                          terminal (done/skip) while this task is still parked on it.
//
// Both arms require a dependency VERB near the id ("after #R", "once #R", "blocked on #R",
// "execute #R's", "waiting on #R"...). A bare mention such as "see #R for context" is a
// cross-reference, not a dependency, and must not flag.
//
// Quoted spans and blockquotes are stripped before matching: a block that RETRACTS a stale
// dependency necessarily quotes it, and matching raw text would score the correction as the
// defect. Same trap as the #267 false positive and the 2026-08-26 07:00 amnesia arm.
//
// Block boundaries are matched LINE-EXACTLY, never indexOf/includes.
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JDIR = path.join(PLANNER, 'journal');

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';

const TERMINAL = new Set(['done', 'skip', 'complete', 'completed', 'closed']);

function boardIds(file) {
  const set = new Set();
  if (!fs.existsSync(file)) return set;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(\d{1,6})\b/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

// Line-exact block extraction, matching telegram-bridge agentBlockText semantics:
//   <!-- from: me -->              -> block is over, ALWAYS
//   <!-- from: overnight-agent --> -> only a real chat entry once a "## <date>" was seen
function splitAtSentinel(text) {
  const lines = text.split('\n');
  let s = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(SENTINEL)) s = i;
  if (s === -1) return null;
  const rest = lines.slice(s);
  const body = [];
  let sawDate = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].trim();
    if (t === USER) break;
    if (t === AGENT && sawDate) break;
    if (/^##\s+\d{4}-\d{2}-\d{2}/.test(t)) sawDate = true;
    body.push(rest[i]);
  }
  return { before: lines.slice(0, s).join('\n'), block: body.join('\n') };
}

function blockStatus(block) {
  const m = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/m.exec(block);
  return m ? m[1].trim().toLowerCase().replace(/[*_`]/g, '').trim() : null;
}

function unquoted(text) {
  return text
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n')
    .replace(/[\u201c\u201d][\s\S]{0,400}?[\u201c\u201d]/g, ' ')
    .replace(/"[^"\n]{0,400}"/g, ' ');
}

// Every date this journal shows, from any of the three places a run stamps one:
// the Status line, a "**YYYY-MM-DD (overnight)" run-log heading, or a "## YYYY-MM-DD" header.
function latestDate(text) {
  let best = null;
  for (const m of text.matchAll(/(\d{4}-\d{2}-\d{2})/g)) {
    if (!best || m[1] > best) best = m[1];
  }
  return best;
}

// A dependency is an id preceded (within ~60 chars) by a verb that makes this task WAIT on it.
const DEP_VERB =
  '(?:after|once|until|when|pending|awaiting|waiting on|blocked (?:on|by)|gated (?:on|behind)|' +
  'depends? on|dependent on|requires?|needs|execute|run|continues? in|tracked in|superseded by|' +
  'handled (?:in|by)|lands? in|per)';
// The gap between verb and id must stay inside one clause: no ')' (which closes a parenthetical
// and means the verb belonged to something else), and short. Without this, a "Context:" line
// such as "read #279 (… needs you), #192" reads as "needs … #192" and flags a pure cross-reference.
const rxDep = new RegExp(`${DEP_VERB}\\b[^.\\n)]{0,40}?#(\\d{2,6})`, 'gi');

// "**Context:** read #254, #231 (parent)" is the trace SKILL.md asks every block to carry. It
// ENUMERATES what was consulted; it never states a dependency. Drop those lines before matching.
function withoutContextTrace(text) {
  return text
    .split('\n')
    .filter(l => !/^\s*\*{0,2}Context:?\*{0,2}/i.test(l))
    .join('\n');
}

function dependencies(block, selfId) {
  const out = new Map();
  for (const m of withoutContextTrace(unquoted(block)).matchAll(rxDep)) {
    // DEP_VERB is built entirely from non-capturing groups, so the id is capture 1.
    // (Shipped once as m[2]; every id came back `undefined`, artifacts.get(undefined)
    // returned nothing, and the sweep reported a permanent, confident 0. Caught only
    // because the mutation check asserted it FIRES on a known-bad input, not just that
    // it stays quiet on a good one.)
    const id = m[1];
    if (!id || id === selfId) continue;
    if (!out.has(id)) out.set(id, m[0].replace(/\s+/g, ' ').trim());
  }
  return out;
}

const active = boardIds(path.join(PLANNER, 'planner.md'));

// Pass 1: index every journal.
const tasks = new Map();
for (const f of fs.readdirSync(JDIR).sort()) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const text = fs.readFileSync(path.join(JDIR, f), 'utf8');
  const parts = splitAtSentinel(text);
  if (!parts) continue;
  const status = (blockStatus(parts.block) || '').split(/[\s\u00b7|]+/)[0] || '';
  tasks.set(m[1], {
    id: m[1],
    status,
    terminal: TERMINAL.has(status),
    block: parts.block,
    lastDate: latestDate(text),
    statusDate: latestDate(/^.*Status:.*$/mi.exec(parts.block)?.[0] || ''),
  });
}

// Deliverables per task id, with the date they were last written. Two kinds of file live in
// this folder that LOOK like `task-<id>-<slug>` deliverables and are not:
//   - SQLite sidecars: merely READING a WAL-mode database touches -wal/-shm, which would
//     manufacture an "artifact written today" for any task whose data anyone looked at.
//   - OneDrive sync-conflict copies: `task-249-DESKTOP-P9116M3.md` is a stale duplicate of the
//     JOURNAL task-249.md, so it parses as a "task-249 deliverable" — and worse, a conflict copy
//     of task-292.md would read as a deliverable belonging to task 292.
const SIDECAR = /(-wal|-shm|-journal|\.tmp|\.bak)$/i;
const CONFLICT_COPY = /(-DESKTOP-[A-Z0-9]+|\(\d+\)|-Copy)\.[^.]+$/i;
const artifacts = new Map();
for (const f of fs.readdirSync(JDIR)) {
  const m = /^task-(\d+)-/.exec(f);
  if (!m) continue;
  if (SIDECAR.test(f) || CONFLICT_COPY.test(f)) continue;
  const st = fs.statSync(path.join(JDIR, f));
  const day = new Date(st.mtime).toISOString().slice(0, 10);
  if (!artifacts.has(m[1])) artifacts.set(m[1], []);
  artifacts.get(m[1]).push({ name: f, day });
}

let considered = 0;
let withDeps = 0;
const flagged = [];

for (const t of tasks.values()) {
  if (t.terminal) continue;                       // settled work is not an open ask
  considered++;
  const deps = dependencies(t.block, t.id);
  if (!deps.size) continue;
  withDeps++;

  // "Last spoke" is the most recent date anywhere in this journal — conservative, so we only
  // flag a dependency satisfied AFTER this task's own most recent activity.
  const spoke = t.lastDate;
  const reasons = [];

  for (const [refId, phrase] of deps) {
    const ref = tasks.get(refId);

    // Arm A — an artifact for #refId appeared after this task last spoke.
    const later = (artifacts.get(refId) || []).filter(a => spoke && a.day > spoke);
    if (later.length) {
      const newest = later.sort((a, b) => (a.day < b.day ? 1 : -1))[0];
      reasons.push(
        `A artifact satisfied: "${phrase}" — but ${later.length} #${refId} deliverable(s) were ` +
        `written after this task last spoke (${spoke}); newest ${newest.name} on ${newest.day}`
      );
      continue;                                   // A is strictly stronger; don't double-report
    }

    // Arm B — #refId's own block now reads terminal while this task is still parked on it.
    if (ref && ref.terminal && spoke && ref.lastDate && ref.lastDate > spoke) {
      reasons.push(
        `B status satisfied: "${phrase}" — but #${refId} is now "${ref.status}" ` +
        `(its journal last moved ${ref.lastDate}, after this task's ${spoke})`
      );
    }
  }

  if (reasons.length) {
    flagged.push({ id: t.id, status: t.status, onBoard: active.has(t.id), spoke: t.lastDate, reasons });
  }
}

console.log(`considered (sentinel block, non-terminal): ${considered}`);
console.log(`  of those, naming a cross-task dependency: ${withDeps}`);
console.log(`FLAGGED — parked on another task's work that has since shipped: ${flagged.length}`);
for (const r of flagged.sort((a, b) => Number(a.id) - Number(b.id))) {
  console.log(`\n  #${r.id}${r.onBoard ? ' [board]' : ''}  status=${r.status}  last spoke=${r.spoke}`);
  for (const why of r.reasons) console.log(`      ${why}`);
}
if (flagged.length) process.exit(1);
