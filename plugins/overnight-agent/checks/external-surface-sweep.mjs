// external-surface-sweep.mjs — a task's live ask points at a surface `scan` CANNOT SEE, and
// nothing has polled it recently.
//
// WHY THIS EXISTS
// ---------------
// 2026-08-28 08:45 PT. #459 was blocked on Shiv leaving one comment on a Google Doc. He left two
// on 2026-08-27. **No run noticed for a day.** The board read perfectly quiet the whole time —
// 239 journals, 0 reopened, 0 changed, 0 approved — because `oa-state.ps1 scan` hashes JOURNALS,
// and his input was in Google Docs. Every signal the agent watches was green while the thing the
// task was waiting on had already happened.
//
// That run read the comments by hand and wrote down, verbatim: "I have not fixed the watching
// part." It also named the fix — "any in-progress task whose ask names an external artifact
// should have that artifact read before the run concludes there is nothing to do" — and left it
// as prose. This file is that sentence turned into a mechanism, which is the same lesson the
// suite already learned on #423: **a promise recorded in prose is not a mechanism.**
//
// NOT the same thing as external-artifact-sweep.mjs. That one asks "is this task asking Shiv for
// a fact ANOTHER TASK already established?" — it reads only journals, and its subject is the
// agent's own past side-effects. This one asks "is Shiv's ANSWER going to land somewhere I never
// look?" — its subject is an inbound surface, and its output is a poll worklist.
//
// THE PRECISION PROBLEM, AND THE DISCRIMINATOR
// --------------------------------------------
// Nearly every agent turn links a doc, a PR or a folder, so "journal mentions a Google Doc" is
// most of the corpus and useless. The discriminator is that a link proves a DELIVERABLE while
// only the ASK proves an EXPECTATION. Four conditions must all hold:
//
//   1. the task is non-terminal and carries a live ask (liveStatus / liveAsk)
//   2. the ask is not dismissive (#163: a dismissal dismisses only itself)
//   3. the ask directs Shiv to leave a TRACE on a named surface — comment / review / sign /
//      fill / upload / reply-on. "Read it" is excluded on purpose: reading leaves nothing
//      behind, so there is nothing for a run to detect and nothing to watch.
//   4. the newest agent turn yields a RESOLVABLE identifier (doc id, repo#number). An ask with
//      no identifier is not a worklist row, because there is nothing a run could go and poll.
//
// SELF-CLEARING, WHICH IS THE PART THAT MATTERS
// ---------------------------------------------
// The nearby #198 probe is recorded in user-settings.md as a cautionary tale: it "does NOT
// self-clear, so its 6 are a floor, not a worklist", and acting on it would have stacked five
// unwanted turns. A detector that cannot go quiet trains the reader to skip it.
//
// So this one is stateful. `external-surface-polls.json` records when each surface was last
// polled; `record-surface-poll.ps1` stamps it in one line. A row is STALE — and only a stale row
// exits 1 — when it has never been polled, or was last polled more than OA_SURFACE_MAX_AGE_HOURS
// ago (default 6). Polling clears it for that window; a NEW ask re-arms it immediately, because
// a stamp older than the ask's own status date never counts as covering it.
import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';
import { liveStatus, statusStampDate } from './lib-live-status.mjs';
import { surfacesIn, asksForSurfaceAction, isDismissive, surfaceKindsNamed } from './lib-external-surfaces.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JDIR = path.join(PLANNER, 'journal');

const STATE = process.env.OA_SURFACE_STATE ||
  path.join(import.meta.dirname, 'external-surface-polls.json');
const WORKLIST = process.env.OA_SURFACE_WORKLIST ||
  path.join(import.meta.dirname, 'external-surface-worklist.json');
const MAX_AGE_HOURS = Number(process.env.OA_SURFACE_MAX_AGE_HOURS || 6);
const NOW = process.env.OA_NOW ? new Date(process.env.OA_NOW) : new Date();

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const TERMINAL = new Set(['done', 'skip', 'complete', 'completed', 'closed']);

function readPolls() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}

// The newest agent turn only. A doc linked in a turn from six weeks ago is not what the CURRENT
// ask points at, and pairing the two is how a detector invents a surface nobody mentioned.
function newestTurn(text) {
  const i = text.lastIndexOf(AGENT);
  if (i !== -1) return text.slice(i);
  const s = text.lastIndexOf(SENTINEL);
  return s !== -1 ? text.slice(s) : text;
}

const polls = readPolls();
const rows = [];
let considered = 0, asking = 0, withId = 0;

for (const f of fs.readdirSync(JDIR).sort()) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const id = m[1];
  const text = fs.readFileSync(path.join(JDIR, f), 'utf8');
  if (!text.includes(SENTINEL)) continue;

  const ls = liveStatus(text);
  const status = String((ls && typeof ls === 'object' ? ls.status : ls) || '').toLowerCase();
  if (TERMINAL.has(status)) continue;
  considered++;

  // liveAsk is turn-aware and MUST be handed the WHOLE file: the journal is a bottom-appended
  // chat, so the newest turn (and the live ask) sits below the sentinel block. Passing only the
  // block returns the OLDEST turn's ask — the mistake external-artifact-sweep documents.
  const ai = liveAsk(text);
  const ask = ai && typeof ai === 'object' ? ai.ask : ai;
  if (!ask || isDismissive(ask) || !asksForSurfaceAction(ask)) continue;
  asking++;

  // Keep only the kinds the ask actually names, then the LAST link of each kind — a turn that
  // links four docs and says "comment on the doc" means the one it just handed over, and
  // emitting all four is the flooding this suite has been burned by repeatedly.
  const named = new Set(surfaceKindsNamed(ask));
  const byKind = new Map();
  for (const s of surfacesIn(newestTurn(text))) {
    if (!named.has(s.kind)) continue;
    byKind.set(s.kind, s);
  }
  const surfaces = [...byKind.values()];
  if (!surfaces.length) continue;
  withId++;

  const askDate = statusStampDate(
    (/^[ \t]*\*{0,2}Status:?\*{0,2}.*$/m.exec(newestTurn(text)) || [''])[0]
  );

  for (const s of surfaces) {
    const key = `${id}:${s.kind}:${s.id}`;
    const last = polls[key]?.at ? new Date(polls[key].at) : null;
    const ageH = last ? (NOW - last) / 3.6e6 : Infinity;
    // A stamp taken BEFORE the current ask was written cannot have covered it.
    const predatesAsk = !!(last && askDate && last < new Date(`${askDate}T00:00:00Z`));
    const stale = !last || ageH > MAX_AGE_HOURS || predatesAsk;
    rows.push({
      id, status, kind: s.kind, surface: s.id, url: s.url, poll: s.poll,
      askDate: askDate || null,
      lastPolled: last ? last.toISOString() : null,
      hoursSincePoll: last ? Number(ageH.toFixed(1)) : null,
      stale, reason: !last ? 'never polled' : predatesAsk ? 'polled before this ask' :
        ageH > MAX_AGE_HOURS ? `polled ${ageH.toFixed(1)}h ago` : 'fresh',
      ask: String(ask).replace(/\s+/g, ' ').slice(0, 160),
    });
  }
}

const staleRows = rows.filter(r => r.stale);
fs.writeFileSync(WORKLIST, JSON.stringify({ generated: NOW.toISOString(), rows }, null, 2));

console.log(`non-terminal journals with a sentinel block: ${considered}`);
console.log(`  of those, asking Shiv to act on a named surface: ${asking}`);
console.log(`  of those, with a resolvable identifier to poll: ${withId}`);
console.log(`  freshness window: ${MAX_AGE_HOURS}h  (worklist: ${WORKLIST})`);
console.log(`FLAGGED — surface awaiting a poll that scan cannot see: ${staleRows.length}`);
for (const r of staleRows.sort((a, b) => Number(a.id) - Number(b.id))) {
  console.log(`\n  #${r.id}  status=${r.status}  ${r.kind}  (${r.reason})`);
  console.log(`      ask: ${r.ask}`);
  console.log(`      poll: ${r.poll}  ->  ${r.url}`);
  console.log(`      clear: record-surface-poll.ps1 -Id ${r.id} -Kind ${r.kind} -Surface ${r.surface}`);
}
if (staleRows.length) process.exit(1);
