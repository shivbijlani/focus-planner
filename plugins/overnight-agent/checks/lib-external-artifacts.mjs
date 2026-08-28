// lib-external-artifacts.mjs — extract the artifacts this agent created OUTSIDE the planner folder.
//
// WHY THIS EXISTS
// ---------------
// Found 2026-08-26 (13:30 PT run, learning #6). Task #228 "Emirates nov trip" spent TWO MONTHS
// blocked on "confirm destination — I'll assume India via DXB". Task #310 had already created a
// Google Calendar event on 2026-06-24: *Ibrahim Maalouf & Hiba Tawaji, Fri 27 Nov 2026, Dubai
// Opera*, with Kiley invited. Dubai was never a layover; it was the destination, with a ticketed
// dated anchor already on Shiv's calendar — put there by this agent.
//
// `cross-task-dependency-sweep` read 0 on that run and missed it CORRECTLY: it reads journals, and
// the #228 <-> #310 link never existed in any journal. It existed only as a calendar event.
//
// The general defect: **every artifact this agent produces outside the planner folder — calendar
// events, pull requests, issues, uploaded documents — is indexed nowhere.** So a later task can ask
// the user for something an earlier task already established, and no detector can see it, because
// every detector reads only journals and the two boards.
//
// The response to that was written down as a prose rule ("before asking for a date or a
// destination, search the calendar and the journals"). This file exists because THIS SETTINGS FILE
// HAS ALREADY PROVEN prose rules do not hold — the PHASE 3 banner was broken three times while
// living further down the same document. So the rule gets an index and a detector instead.
//
// WHAT COUNTS AS AN ARTIFACT
// --------------------------
// Only self-evidencing records: a URL or an explicit creation statement that a human could verify
// by clicking. We never infer "the agent probably made a thing" from prose alone.
//
//   calendar  google.com/calendar/event?eid=...   (34 live across 15 journals)
//   pr        github.com/<owner>/<repo>/pull/<n>  (190 live)
//   issue     github.com/<owner>/<repo>/issues/<n>(63 live)
//
// Quoted spans and blockquotes are NOT stripped here, deliberately: unlike a dependency phrase, a
// URL inside a quote is still evidence the artifact exists. Quoting a calendar link does not make
// the event stop existing. (This is the opposite call from cross-task-dependency-sweep, and the
// reason is that this extractor indexes NOUNS, not CLAIMS.)
import fs from 'node:fs';
import path from 'node:path';

const RX = {
  calendar: /https?:\/\/(?:www\.)?google\.com\/calendar\/event\?eid=([A-Za-z0-9_\-=]+)/g,
  pr: /https?:\/\/github\.com\/([^/\s)"']+)\/([^/\s)"']+)\/pull\/(\d+)/g,
  issue: /https?:\/\/github\.com\/([^/\s)"']+)\/([^/\s)"']+)\/issues\/(\d+)/g,
};

// Month names -> a "27 November 2026" / "Nov 27, 2026" style date is what a calendar bullet carries;
// ISO dates are what run logs carry. Index both.
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const RX_DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const RX_DATE_DMY = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})[a-z]*\\.?,?\\s+(\\d{4})\\b`, 'gi');
const RX_DATE_MDY = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi');

const MONTH_NUM = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

export function datesIn(text) {
  const out = new Set();
  for (const m of text.matchAll(RX_DATE_ISO)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(RX_DATE_DMY)) {
    const mo = MONTH_NUM[m[2].toLowerCase().slice(0, 4)] || MONTH_NUM[m[2].toLowerCase().slice(0, 3)];
    if (mo) out.add(`${m[3]}-${mo}-${String(m[1]).padStart(2, '0')}`);
  }
  for (const m of text.matchAll(RX_DATE_MDY)) {
    const mo = MONTH_NUM[m[1].toLowerCase().slice(0, 4)] || MONTH_NUM[m[1].toLowerCase().slice(0, 3)];
    if (mo) out.add(`${m[3]}-${mo}-${String(m[2]).padStart(2, '0')}`);
  }
  return [...out];
}

// Distinctive entities = capitalised words that are not sentence-initial boilerplate and not on the
// stop list. Deliberately crude: the index is a lookup aid, and a false entity costs a wasted grep,
// while a missing entity costs another #228. Tuned so "Dubai", "Dubai Opera", "Emirates" survive.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those',
  'i', 'you', 'your', 'my', 'we', 'it', 'is', 'are', 'was', 'were', 'be', 'been',
  'status', 'result', 'next', 'deliverable', 'context', 'run', 'log', 'plan', 'task', 'tasks',
  'needs', 'from', 'your', 'call', 'overnight', 'agent', 'proposed', 'approved', 'done', 'skip',
  'added', 'google', 'calendar', 'event', 'events', 'github', 'pull', 'request', 'issue',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays', 'sundays',
  'weekday', 'weekdays', 'weekend', 'weekends', 'today', 'tomorrow', 'yesterday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

export function entitiesIn(text) {
  const out = new Set();
  // Strip URLs first: an eid blob is full of capitals and would flood the entity set.
  const clean = text.replace(/https?:\/\/\S+/g, ' ').replace(/[*_`>#|\[\]()]/g, ' ');
  for (const m of clean.matchAll(/\b([A-Z][A-Za-z\u00c0-\u024f'’\-]{2,})\b/g)) {
    const w = m[1];
    if (STOP.has(w.toLowerCase())) continue;
    out.add(w);
  }
  return [...out];
}

const SENTINEL = '<!-- OVERNIGHT-AGENT';

// The line an artifact URL sits on carries its title/date/venue ("- *Ibrahim Maalouf & Hiba Tawaji
// — À la Française* — Fri 27 Nov 2026, 20:30, Dubai Opera. [event](...)"). Take that line plus one
// line of lead-in, which is where a "📅 Added to your Google Calendar" header lives.
function contextFor(lines, i) {
  const lead = i > 0 ? lines[i - 1] : '';
  return `${lead}\n${lines[i]}`.trim();
}

export function artifactsInJournal(taskId, text) {
  const lines = text.split(/\r?\n/);
  // Only index artifacts recorded at or below the sentinel where possible — above it is the user's
  // own space and may contain links they pasted, which the agent did not create. If there is no
  // sentinel, index the whole file (legacy journals) but mark it.
  let s = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(SENTINEL)) s = i;
  const start = s === -1 ? 0 : s;
  const agentOwned = s !== -1;

  const found = [];
  const seen = new Set();
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (const [kind, rx] of Object.entries(RX)) {
      rx.lastIndex = 0;
      for (const m of line.matchAll(rx)) {
        const ref = kind === 'calendar' ? m[1] : `${m[1]}/${m[2]}#${m[3]}`;
        const key = `${kind}:${ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ctx = contextFor(lines, i);
        found.push({
          task: taskId,
          kind,
          ref,
          url: m[0],
          context: ctx.replace(/\s+/g, ' ').slice(0, 300),
          dates: datesIn(ctx),
          entities: entitiesIn(ctx),
          agentOwned,
          line: i + 1,
        });
      }
    }
  }
  return found;
}

export function buildIndex(journalDir) {
  const all = [];
  for (const f of fs.readdirSync(journalDir).sort()) {
    const m = /^task-(\d+)\.md$/.exec(f);
    if (!m) continue;
    const text = fs.readFileSync(path.join(journalDir, f), 'utf8');
    all.push(...artifactsInJournal(m[1], text));
  }
  return all;
}
