// Sweep: RECURRING jobs Shiv asked for that have silently stopped running.
//
// WHY THIS BUCKET EXISTS (established 2026-08-25 13:00 PT)
// -------------------------------------------------------
// 2026-08-25 10:45 found that #236 carried Shiv's standing instruction "once a day,
// check on ynab and the status" (2026-06-26) and the last verified YNAB pull was
// 2026-06-22 - 64 days of a daily job quietly not happening. That was caught by hand,
// while investigating something else. Nothing measures it.
//
// This is a DIFFERENT bucket from every existing sweep:
//   - inprogress-stall-sweep  : status == in-progress (a #236-class task can be `blocked`)
//   - blocked-readonly-sweep  : ask is dismissive       (#236's ask was a genuine blocker)
//   - stale/armed-trigger     : an irreversible trigger  (a daily check has no trigger)
//   - drift/body-header       : status vs body agreement (#236's status was correct)
// #236 was invisible to all four, because none of them ask "was this supposed to repeat?".
//
// Flag = Shiv asked for a cadence + the agent has not touched it within that cadence.
//
// Harness discipline (per recorded traps):
//  - strip the UTF-8 BOM oa-state.ps1 writes, and NEVER swallow a parse error
//  - regexes bound to distinct `rx*` names so a loop variable cannot shadow them
//  - cadence evidence is only counted from text SHIV wrote - an agent-authored "daily" is
//    the agent quoting itself and must not create its own obligation
//  - ⚠️ AUTHORSHIP IS NOT MARKER-BASED. The first cut keyed Shiv's text off
//    `<!-- from: me -->` and therefore MISSED #236, the founding case: the app appends many
//    of his messages as a bare `## <date>` header with no marker at all (task-236.md:146-148,
//    "once a day, check on ynab and the the status"). A `## <date>` section belongs to Shiv
//    until an agent marker or an agent-shaped heading (`### Run log`, `**<date> (overnight):**`)
//    starts the reply. Same family as the recorded checker-semantics traps.
//  - the cadence word must share a line with an agent-directed verb, or a plan that merely
//    DESCRIBES a daily feature ("let you set a daily eating window") reads as an obligation
//  - the matched evidence line is printed so a human can reject a false positive
//  - population count printed for cross-check against `oa-state scan`
import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
const JOURNALS = path.join(PLANNER, 'journal');
const FIXTURE = process.env.FIXTURE_JOURNAL || null; // mutation-check hook

const rxBoardRow = /^\|\s*(\d+)[^|]*\|([^|]*)\|([^|]*)\|/gm;
const rxSentinel = /^<!--\s*OVERNIGHT-AGENT/m;
const rxFromMe = /^<!--\s*from:\s*me\s*-->/i;
const rxFromAgent = /^<!--\s*from:\s*overnight-agent\s*-->/i;
const rxDateHeader = /^##\s+(\d{4}-\d{2}-\d{2})/;
const rxRunEntry = /^\*\*(\d{4}-\d{2}-\d{2})/;
const rxAgentHeading = /^#{2,4}\s+(Run log|🌙 Overnight Agent)/i;

// Task IDs driven by a live SCHEDULED WORKFLOW, produced by workflow-health-sweep.mjs
// from the app's own `workflows` / `workflow_runs` tables. Scheduled workflows are a
// runner this sweep cannot otherwise see, so without this a healthy job reads as dead.
// FAIL-SAFE: any problem reading it leaves the set EMPTY, which restores the old
// (over-reporting) behaviour rather than silently hiding a real finding. Also refuse
// coverage older than 24h, so a stale file cannot vouch for a workflow that has since
// been disabled.
const COVERED = new Set();
try {
  const cf = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'workflow-coverage.json');
  const raw = JSON.parse(fs.readFileSync(cf, 'utf8'));
  const ageH = (Date.now() - new Date(raw.generated)) / 3600000;
  if (ageH <= 24) for (const t of raw.covered) COVERED.add(String(t));
  else console.log(`note: workflow-coverage.json is ${ageH.toFixed(1)}h old - ignoring it (re-run workflow-health-sweep.mjs).`);
} catch {
  console.log('note: no workflow-coverage.json - run workflow-health-sweep.mjs first; nothing treated as workflow-covered.');
}

// Cadence phrases -> max tolerated idle days before it counts as stopped.
// Ordered most-specific first; the first match wins.
const CADENCES = [
  { rx: /\b(hourly|every hour|each hour)\b/i, name: 'hourly', maxIdle: 2 },
  { rx: /\b(daily|once a day|every day|each day|every night|nightly|each morning|every morning)\b/i, name: 'daily', maxIdle: 3 },
  { rx: /\b(weekly|once a week|every week|each week)\b/i, name: 'weekly', maxIdle: 10 },
  { rx: /\b(monthly|once a month|every month)\b/i, name: 'monthly', maxIdle: 40 },
];

// Words that make a cadence token a description, not an instruction to the agent.
const rxNotAnInstruction = /\b(daily driver|daily use|daily life|daily wear|daily commute|dailies section)\b/i;

// A cadence only creates an obligation when it is attached to something the AGENT does.
const rxAgentVerb = /\b(check|checks|checking|send|sends|run|runs|upload|uploads|post|posts|update|updates|pull|pulls|sync|syncs|back ?up|backs ?up|email|emails|remind|reminds|scan|scans|poll|polls|watch|watches|look|looks|monitor|monitors|digest|report|reports|generate|generates|print|prints)\b/i;

// Line-level classify: the cadence and the verb must co-occur on the SAME line, so a plan
// that merely describes a daily feature elsewhere in the file cannot manufacture a duty.
function classifyLine(line) {
  if (!line) return null;
  if (rxNotAnInstruction.test(line)) return null;
  for (const c of CADENCES) if (c.rx.test(line) && rxAgentVerb.test(line)) return c;
  return null;
}

// Titles are Shiv naming the task; a bare cadence there is enough (no verb required).
function classifyTitle(title) {
  if (!title) return null;
  if (rxNotAnInstruction.test(title)) return null;
  for (const c of CADENCES) if (c.rx.test(title)) return c;
  return null;
}

const board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8');
const boardTitle = new Map();
for (const m of board.matchAll(rxBoardRow)) {
  const id = m[1];
  if (!boardTitle.has(id)) boardTitle.set(id, m[3].trim());
}

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const now = new Date();
const rows = [];
let parseFails = 0;

for (const id of boardTitle.keys()) {
  const jf = FIXTURE && FIXTURE.endsWith(`task-${id}.md`) ? FIXTURE : path.join(JOURNALS, `task-${id}.md`);
  if (!fs.existsSync(jf)) continue;
  const text = fs.readFileSync(jf, 'utf8');
  const lines = text.split(/\r?\n/);

  // ---- Split into SHIV-authored lines vs agent-authored lines ---------------
  // One pass over the WHOLE file. Ownership flips on markers, never on position.
  //
  // ⚠️ Do NOT assume "everything above the sentinel is Shiv's". In the legacy June
  // journals (#175, #296, #363) the agent wrote above the sentinel, and that assumption
  // attributed the agent's own plan text to Shiv - manufacturing three false obligations
  // ("Keep FB checks running weekly" was the AGENT's step 3, not Shiv's instruction).
  const rxAgentStart = /^(<!--\s*from:\s*overnight-agent\s*-->|#{2,4}\s+(Run log|🌙 Overnight Agent)|\*\*\d{4}-\d{2}-\d{2}|<!--\s*OVERNIGHT-AGENT|<!--\s*oa-state)/i;
  const userLines = [];
  const userIdx = new Set();
  let mine = true;                                   // the H1 + the user's own notes
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (rxAgentStart.test(l)) { mine = false; continue; }
    if (rxFromMe.test(l) || rxDateHeader.test(l)) { mine = true; continue; }
    if (mine) { userLines.push(l); userIdx.add(i); }
  }

  // Nominally the region above the sentinel is Shiv's space - but legacy journals (#175,
  // #296, #363) hold the AGENT's research write-up up there, so a cadence found above the
  // sentinel in a journal where Shiv has never left a `<!-- from: me -->` marker cannot be
  // attributed. Report UNSURE rather than asserting an obligation. (#236's instruction sits
  // BELOW its sentinel, so the founding case still flags.)
  const sentIdx = lines.findIndex(l => rxSentinel.test(l));
  const firstAgentIdx = lines.findIndex(l => rxAgentStart.test(l));
  const hasFromMe = lines.some(l => rxFromMe.test(l));

  // ---- Cadence: board title (Shiv's) first, then Shiv's own lines -----------
  let cad = classifyTitle(boardTitle.get(id));
  let source = 'board title';
  let evidence = boardTitle.get(id);
  let evidenceIdx = -1;
  if (!cad) {
    for (const i of userIdx) {
      const c = classifyLine(lines[i]);
      if (c) { cad = c; source = 'your note'; evidence = lines[i].trim(); evidenceIdx = i; break; }
    }
  }
  if (!cad) continue;
  const boundary = sentIdx >= 0 ? sentIdx : firstAgentIdx;
  const unsure = source === 'your note' && !hasFromMe &&
                 (boundary === -1 || evidenceIdx < boundary);

  // ---- Last time the agent actually touched it -------------------------------
  let lastDate = null;
  for (const line of lines) {
    const md = rxRunEntry.exec(line) || rxDateHeader.exec(line);
    if (md && (!lastDate || md[1] > lastDate)) lastDate = md[1];
  }
  const idle = lastDate ? Math.floor((now - new Date(lastDate + 'T12:00:00')) / 86400000) : null;

  let st = null;
  const sf = path.join(stateDir, `task-${id}.json`);
  if (fs.existsSync(sf)) {
    const raw = fs.readFileSync(sf, 'utf8').replace(/^\uFEFF/, '');
    try { st = JSON.parse(raw); } catch (e) { console.error(`PARSE FAIL task-${id}.json: ${e.message}`); parseFails++; }
  }

  // A `proposed` task's cadence has never been approved, so it cannot have STOPPED running -
  // it never started. Flagging it as a dead recurring job is a category error (it is simply
  // waiting on Shiv, which is by design). Verified on #351: ask delivered, awaiting his "go".
  const notYetStarted = st && st.status === 'proposed';

  // ⚠️ UNSCHEDULABLE: a recurring job whose status is TERMINAL is run by nobody.
  // PHASE 1 executes `approved` (+ in-progress whose next step is approved); PHASE 2 explicitly
  // leaves `done`/`skip` alone when not reopened. So a `done` daily job is picked up by neither
  // phase - permanently. This is a STRUCTURAL signal, not a timing one, so it is true the moment
  // the status flips and does NOT wait for an idle threshold to expire.
  //
  // Found 2026-08-25 13:30 on #405 (OneDrive->YouTube video backup, "once a day"): marked `done`
  // on 08-23, its last real poll was 08-22, and it had only ever run as a RIDER on #419's sweep -
  // which stopped mentioning it after 08-21. Queue was empty so nothing was lost, but nothing
  // would have uploaded the next video either. It was invisible to all six sweeps that day:
  // drift waved it through as dual-board, and idle was exactly AT tolerance (3d of 3d), one day
  // short of flagging. Timing-based liveness would have caught it a day late, and only by luck.
  const terminal = st && (st.status === 'done' || st.status === 'skip');

  // ...BUT "no phase will ever run it again" is only true if PHASE 1/2 are the only
  // runners. They are not. A SCHEDULED WORKFLOW is a third runner that lives entirely
  // outside the journals, so a terminal status says nothing about it.
  // Corrected 2026-08-25 20:00 PT: this sweep had been reporting #383 (HeadSpin, weekly)
  // and #252 (weekly plan printout) as UNSCHEDULABLE for several runs while BOTH were
  // being driven by live, healthy weekly workflows - a false alarm repeated in run
  // summaries. Coverage now comes from workflow-health-sweep.mjs, which reads the app's
  // own `workflows`/`workflow_runs` tables. Fail-safe: if the coverage file is absent or
  // stale we treat NOTHING as covered, so the worst case is the old (noisy) behaviour
  // rather than a silently suppressed real finding.
  const covered = COVERED.has(String(id));

  rows.push({
    id, cadence: cad.name, maxIdle: cad.maxIdle, source,
    evidence: (evidence || '').slice(0, 110),
    lastDate, idle, status: st ? st.status : '?',
    unsure, notYetStarted, terminal, covered,
    flag: idle !== null && idle > cad.maxIdle && !unsure && !notYetStarted,
  });
}

rows.sort((a, b) => (b.idle ?? -1) - (a.idle ?? -1));
console.log(`active board rows with a journal + a cadence Shiv asked for: ${rows.length}`);
if (parseFails) console.log(`!! ${parseFails} state files failed to parse - result is NOT trustworthy`);
console.log('');
for (const r of rows) {
  const over = r.idle !== null && r.idle > r.maxIdle;
  const tag = r.terminal ? (r.covered ? 'wf-run ' : 'UNSCHED')
    : r.flag ? 'FLAG   '
    : (over && r.unsure ? 'UNSURE ' : over && r.notYetStarted ? 'unstrt ' : '       ');
  console.log(`${tag}#${r.id}  ${r.cadence.padEnd(7)} idle=${r.idle === null ? '?' : r.idle + 'd'} (tolerance ${r.maxIdle}d)  status=${r.status}  last=${r.lastDate ?? '?'}`);
  console.log(`        via ${r.source}: ${r.evidence}`);
}
const flagged = rows.filter(r => r.flag && !r.terminal);
const unsures = rows.filter(r => r.unsure && r.idle > r.maxIdle);
const unstarted = rows.filter(r => r.notYetStarted && r.idle > r.maxIdle);
const unsched = rows.filter(r => r.terminal && !r.covered);
const wfCovered = rows.filter(r => r.terminal && r.covered);
console.log(`\nFLAGGED (Shiv asked for a cadence; agent has not touched it within that cadence): ` +
  (flagged.map(r => '#' + r.id).join(', ') || '(none)'));
console.log(`UNSCHEDULABLE (recurring job with a TERMINAL status and NO scheduled workflow - nothing will run it again): ` +
  (unsched.map(r => `#${r.id}(${r.status})`).join(', ') || '(none)'));
console.log(`run-by-workflow (terminal status, but a live scheduled workflow drives it - NOT a finding): ` +
  (wfCovered.map(r => `#${r.id}(${r.status})`).join(', ') || '(none)') +
  (COVERED.size ? '' : '   [coverage file missing - nothing treated as covered]'));
console.log(`UNSURE  (cadence line sits in an unattributable region - read it before believing): ` +
  (unsures.map(r => '#' + r.id).join(', ') || '(none)'));
console.log(`not-yet-started (status=proposed; awaiting Shiv, by design): ` +
  (unstarted.map(r => '#' + r.id).join(', ') || '(none)'));

// ⚠️ Read the FLAG list with this caveat, or you will manufacture false alarms.
// `lastDate` measures when the JOURNAL was last written, not when the JOB last ran - and the
// "Quiet runs - don't post no-op updates" preference (user-settings.md) tells polling tasks NOT
// to journal a no-news run. So a well-behaved monitoring task goes idle-looking on a fixed
// schedule (daily at 4d, weekly at 11d) precisely BECAUSE it is behaving correctly.
// Before acting on a FLAG for a polling task, corroborate against something outside the journal:
// the queue/drop folder it watches, or another task's journal that reports the same sweep
// (e.g. #419's poll entries explicitly name #405's `Video Backup` bucket).
// UNSCHEDULABLE now excludes anything a live scheduled workflow drives (see above); the
// remainder really is run by nobody, and that IS a structural fact about the status.
console.log(`\nnote: FLAG is journal-write-based; the quiet-runs rule suppresses no-news entries,`);
console.log(`      so corroborate a polling task against its queue folder before believing a FLAG.`);

