// external-artifact-sweep.mjs — a task is asking Shiv for something a DIFFERENT task already
// established as a dated artifact outside the planner.
//
// WHY THIS EXISTS
// ---------------
// 2026-08-26, learning #6. #228 "Emirates nov trip" was blocked for two months on
// "confirm destination — I'll assume India via DXB", while #310 had already put
// *Ibrahim Maalouf & Hiba Tawaji, Fri 27 Nov 2026, Dubai Opera* on Shiv's Google Calendar,
// with Kiley invited. Dubai was the destination, dated and ticketed, created by this agent.
//
// Every existing detector reads journals and the two boards. #228<->#310 was never a journal
// link — it was a calendar event. `cross-task-dependency-sweep` read 0 and was RIGHT to: it
// follows dependencies a journal NAMES. Nothing followed an artifact the agent WROTE.
//
// THE PRECISION PROBLEM, AND THE DISCRIMINATOR
// --------------------------------------------
// Naive entity matching floods: "Microsoft", "Kiley", "Google" appear in dozens of tasks, so any
// ask sharing one with any artifact would flag. Five checkers in this suite have already cried
// wolf; a sixth would be worse than nothing.
//
// The discriminator is **entity rarity**, measured against the live corpus: an entity that occurs
// in more than MAX_TASKS distinct journals is ambient vocabulary, not an identifying fact. Only
// rare entities (Dubai, Emirates, Maalouf) can bridge two tasks meaningfully. This is the same
// shape as orphan-liveness-sweep's tombstone test — a mechanical property of the data decides,
// not a judgement call.
//
// Three conditions must ALL hold, so the flag is narrow by construction:
//   1. the task is non-terminal and its block carries a live ask
//   2. the ask is TEMPORAL or LOCATIVE ("when", "what date", "which destination", "confirm where")
//      — the only two question types a dated calendar artifact can actually answer
//   3. some OTHER task's artifact carries a date AND shares a rare entity with this journal
//
// Quoted spans are stripped from the ask before matching, per the #267 false-positive lesson:
// a block that QUOTES a stale question would otherwise be scored as still asking it.
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex, entitiesIn } from './lib-external-artifacts.mjs';
import { liveAsk } from './lib-live-ask.mjs';
import { liveStatus } from './lib-live-status.mjs';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) { console.error('set PLANNER_PATH'); process.exit(1); }
const JDIR = path.join(PLANNER, 'journal');

const SENTINEL = '<!-- OVERNIGHT-AGENT';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';
const TERMINAL = new Set(['done', 'skip', 'complete', 'completed', 'closed']);

// An entity appearing in more than this many journals is ambient, not identifying.
const MAX_TASKS = 4;

function splitAtSentinel(text) {
  const lines = text.split('\n');
  let s = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(SENTINEL)) s = i;
  if (s === -1) return null;
  const rest = lines.slice(s);
  const body = [];
  let sawDate = false;
  for (const line of rest) {
    const t = line.trim();
    if (t === USER) break;
    if (t === AGENT && sawDate) break;
    if (/^##\s+\d{4}-\d{2}-\d{2}/.test(t)) sawDate = true;
    body.push(line);
  }
  return body.join('\n');
}

function blockStatus(block) {
  const m = /^[ \t]*\*{0,2}Status:?\*{0,2}[ \t]*:?[ \t]*\*{0,2}([^\n\u00b7|]*)/m.exec(block);
  return m ? m[1].trim().toLowerCase().replace(/[*_`]/g, '').split(/[\s\u00b7|]+/)[0] : '';
}

function unquoted(text) {
  return text
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n')
    .replace(/[\u201c\u201d][\s\S]{0,400}?[\u201c\u201d]/g, ' ')
    .replace(/"[^"\n]{0,400}"/g, ' ');
}

// Condition 2: only "when" and "where" questions are answerable by a dated calendar artifact.
const RX_TEMPORAL =
  /\b(when\b|what\s+date|which\s+date|what\s+day|which\s+day|exact\s+date|dates?\b[^.\n]{0,30}\?|depart|departure|arrive|arrival|leave\b|travel\s+dates?|how\s+long)/i;
const RX_LOCATIVE =
  /\b(where\b|which\s+(city|country|destination|airport)|what\s+(city|country|destination|airport)|confirm\s+(the\s+)?destination|destination\b)/i;

// A dismissive opener means the block is NOT asking Shiv for anything ("none", "nothing required").
// Per the #163 lesson the dismissal dismisses only itself — text after a clause break can still
// carry a real ask — so we only treat it as dismissive when the clause break is absent or the
// remainder carries no interrogative of its own.
const RX_DISMISSIVE = /^\s*\**\s*(none|nothing|no\s+action|n\/a)\b/i;

function askKind(ask) {
  if (!ask) return null;
  const a = unquoted(ask);
  if (RX_DISMISSIVE.test(a)) {
    const rest = a.replace(/^[\s\S]{0,80}?[.;:\u2014\u2013]\s/, '');
    if (rest === a || !/\?|\bwhich\b|\bwhat\b|\bwhen\b|\bwhere\b|\bconfirm\b|\btell me\b/i.test(rest)) {
      return null;
    }
  }
  const t = RX_TEMPORAL.test(a);
  const l = RX_LOCATIVE.test(a);
  if (t && l) return 'temporal+locative';
  if (t) return 'temporal';
  if (l) return 'locative';
  return null;
}

// ---- pass 1: journals -------------------------------------------------------
// liveAsk/liveStatus are turn-aware and MUST be given the whole file: the journal is a
// bottom-appended chat, so the newest agent turn (and therefore the live ask) sits BELOW the
// sentinel block. Passing only the block returns the OLDEST turn's ask — which on the first cut
// of this sweep resurrected a stale "destination if not India" question on #228 that the newest
// turn had already retired. Every other sweep in this suite passes full text; so does this one.
const journals = new Map();
for (const f of fs.readdirSync(JDIR).sort()) {
  const m = /^task-(\d+)\.md$/.exec(f);
  if (!m) continue;
  const text = fs.readFileSync(path.join(JDIR, f), 'utf8');
  const block = splitAtSentinel(text);
  if (block === null) continue;
  const ls = liveStatus(text);
  const status = (typeof ls === 'object' && ls ? ls.status : ls) || blockStatus(block);
  journals.set(m[1], { id: m[1], text, block, status: String(status || '').toLowerCase() });
}

// ---- pass 2: entity rarity across the corpus --------------------------------
// Count DISTINCT tasks per entity, from journal text (not just artifacts), so rarity reflects the
// whole corpus rather than the 61 tasks that happen to have created artifacts.
const entityTasks = new Map();
for (const j of journals.values()) {
  for (const e of new Set(entitiesIn(j.text))) {
    if (!entityTasks.has(e)) entityTasks.set(e, new Set());
    entityTasks.get(e).add(j.id);
  }
}
const isRare = e => (entityTasks.get(e)?.size || 0) <= MAX_TASKS;

// ---- pass 3: artifacts ------------------------------------------------------
const artifacts = buildIndex(JDIR).filter(a => a.dates.length > 0);

// ---- detect -----------------------------------------------------------------
let considered = 0;
let asking = 0;
const flagged = [];

for (const j of journals.values()) {
  if (TERMINAL.has(j.status)) continue;
  considered++;
  const askInfo = liveAsk(j.text);
  const ask = askInfo && typeof askInfo === 'object' ? askInfo.ask : askInfo;
  const kind = askKind(ask);
  if (!kind) continue;
  asking++;

  const mine = new Set(entitiesIn(j.text).filter(isRare));
  // DISCRIMINATOR: if this journal already cites the artifact's task, the link HAS been made and
  // there is nothing to surface. Without this the sweep re-flags every task a previous run already
  // repaired — #228 cites #310 by id since 2026-08-26, so flagging it again would be crying wolf
  // about work that is done. The defect this sweep exists for is "the two tasks never knew about
  // each other", and a citation is the proof that they now do.
  const cites = new Set(
    [...j.text.matchAll(/#(\d{2,6})\b/g)].map(m => m[1])
  );
  const hits = [];
  for (const a of artifacts) {
    if (a.task === j.id) continue;
    if (cites.has(a.task)) continue;
    const shared = a.entities.filter(e => mine.has(e));
    if (!shared.length) continue;
    hits.push({ a, shared });
  }
  if (hits.length) {
    flagged.push({ id: j.id, status: j.status, kind, ask: (ask || '').replace(/\s+/g, ' ').slice(0, 160), hits });
  }
}

console.log(`non-terminal journals with a sentinel block: ${considered}`);
console.log(`  of those, asking a WHEN/WHERE question: ${asking}`);
console.log(`  dated external artifacts indexed: ${artifacts.length}`);
console.log(`  entity rarity gate: an entity in >${MAX_TASKS} journals is ambient and cannot bridge`);
console.log(`FLAGGED — asking Shiv for something another task already created: ${flagged.length}`);
for (const f of flagged.sort((a, b) => Number(a.id) - Number(b.id))) {
  console.log(`\n  #${f.id}  status=${f.status}  ask=${f.kind}`);
  console.log(`      ask: ${f.ask}`);
  for (const h of f.hits.slice(0, 3)) {
    console.log(`      -> #${h.a.task} [${h.a.kind}] ${h.a.dates.join(', ')}  via ${h.shared.slice(0, 4).join(', ')}`);
    console.log(`         ${h.a.context.slice(0, 160)}`);
  }
}
if (flagged.length) process.exit(1);
