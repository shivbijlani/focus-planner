// owned-target-gate-sweep.mjs
//
// WHY: a NEW DIMENSION of the "approval-gating work that needs no approval" defect class,
// found 2026-08-26 14:30 on task #403 (26 days parked).
//
// `reversible-gate-sweep` already covers gated work whose product is a NEW artifact — its verb
// list is (draft|write up|research|generate|scaffold|compare|shortlist|price out|look up|
// spec out|sketch|outline|prototype|propose|find alternatives|monitor|watch). Every one of those
// CREATES something.
//
// It has no verb for MODIFYING something that already exists. #403's ask was:
//
//     "a yes on step 2 (fold into settings), or tell me to leave it as just the checklist."
//
// Step 2 was "fold this philosophy into user-settings.md". That file is the AGENT'S OWN config:
// the agent rewrites it every single run and writes a timestamped backup each time. The plan's
// own risk line even read "No purchases or irreversible actions involved" — it self-certified as
// reversible and then gated itself anyway. Nothing in reversible-gate-sweep could see it, because
// "fold" is not a creation verb and no OFFER construction ("I'll …", a backticked token) appears.
//
// THE DISCRIMINATOR — measured, not assumed. A naive modify-verb scan over the live corpus returns
// 8 asks, of which only 1 is a defect (12.5% precision — this suite has cried wolf five times, so
// that is not shippable). The property that separates them is WHAT IS BEING MODIFIED:
//
//   FLAG   #403  fold into *settings*                 -> agent-owned file, rewritten every run
//   quiet  #241  "apply 241" edits *Master-Resume.md* -> Shiv's document; he wants the diff first
//   quiet  #222  YNAB write-backs incl. moving        -> external system + category changes
//   quiet  #234  YNAB memos                           -> external system (standing approval is
//                                                        Amazon-scoped and does not travel)
//   quiet  #351  "turn on the nightly sweep"          -> arms an automation with outward effects
//   quiet  #289  "record-requests" (send email)       -> irreversible send
//   quiet  #295, #296  dismissive "nothing …"         -> not asking for anything
//
// So: modifying an artifact THE AGENT ITSELF OWNS AND ROUTINELY REWRITES is unambiguously
// reversible and must never be gated. Modifying Shiv's own documents, or anything in an external
// system, legitimately may be. That is a mechanical property of the ask, not a judgement call —
// the same shape as orphan-liveness-sweep's tombstone test and external-artifact-sweep's rarity
// test.
//
// NOTE ON SCOPE: this sweep deliberately does NOT require a board row. reversible-gate-sweep
// filtered on board membership and was blind to #280 and #233 for exactly that reason
// (see the 2026-08-26 13:30 and 14:00 run learnings). Orphans are included here.

import fs from 'node:fs';
import path from 'node:path';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const TODAY = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);

// 1. The ask must be GATING — asking Shiv for permission or a decision. Without this, ordinary
//    descriptive prose ("I updated the settings") matches and the sweep floods.
const GATES = [
  /\ba\s+yes\s+on\b/i,
  /\byour\s+(?:yes|ok|okay|approval|sign-?off|go|green\s*light)\b/i,
  /\bappro(?:ve|val)\b/i,
  /\bsay\s+the\s+word\b/i,
  /\bone\s+word\b/i,
  /\btell\s+me\s+to\b/i,
  /\bwant\s+me\s+to\b/i,
  /\bshould\s+I\b/i,
  /\bI'?ll\b/i,
  /\bI\s+can\b/i,
  /\bif\s+you(?:'?d)?\s+(?:want|like)\b/i,
];

// 2. A verb whose product is a CHANGE to something that already exists (not a new artifact).
const MODIFY = new RegExp(
  String.raw`\b(fold(?:ing)?\s+(?:\w+\s+){0,3}?in(?:to)?|add(?:ing)?\s+(?:\w+\s+){0,3}?to|updat(?:e|ing)|record(?:ing)?|captur(?:e|ing)|writ(?:e|ing)\s+(?:\w+\s+){0,3}?(?:in|into|to)|sav(?:e|ing)\s+(?:\w+\s+){0,3}?(?:in|into|to)|edit(?:ing)?|amend(?:ing)?|bak(?:e|ing)\s+(?:\w+\s+){0,2}?in|not(?:e|ing)\s+(?:\w+\s+){0,3}?in|persist(?:ing)?|stor(?:e|ing)\s+(?:\w+\s+){0,3}?(?:in|into|to))\b`,
  'gi'
);

// 3. THE DISCRIMINATOR — the target is an artifact the agent owns and rewrites unattended.
const OWNED = new RegExp(
  String.raw`\b(user-?settings(?:\.md)?|agent\s+settings|my\s+settings|the\s+settings|settings\s+file|SKILL\.md|the\s+skill|agent[- ]memory(?:\.md)?|agent\s+state|oa-?state|the\s+journal|this\s+journal|journals?\b|task-\d+[\w-]*\.md|the\s+checklist|the\s+deliverable|the\s+brief|the\s+primer)\b`,
  'i'
);

// 4. Hard suppressor. An irreversible verb means the gate is legitimate even when the ask also
//    touches an agent-owned file — do the reversible half, keep the ask for the rest.
//
//    NOTE: an EXTERNAL-system suppressor (ynab|linkedin|amazon|…) was written here first and
//    DELETED after the mutation check proved it never fired. OWNED is a strict allow-list, so an
//    external target simply is not on it and needs no second gate. Worse, the suppressor was
//    actively harmful: "approve and I'll record the YNAB totals in the journal" gates an
//    agent-owned edit and IS a defect, but the word "YNAB" would have silenced it.
const IRREVERSIBLE = /\b(send|submit|buy|order|purchase|merge|deploy|book|publish|pay|post|apply\s+to|checkout|sign\s+up)\b/i;

// Board is read only to report whether the task is visible to Shiv — never to filter.
let board = '';
try { board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8'); } catch { /* none */ }
const onBoard = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) onBoard.add(m[1]);
}

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);
const hits = [];
let considered = 0;

// A dismissive opener ("none", "nothing") dismisses only ITSELF — per the #163 precedence fix.
// Text after the clause break is a real ask and must still be examined.
function afterDismissal(ask) {
  if (!/^\W*(none|nothing)\b/i.test(ask)) return ask;
  const brk = ask.search(/[.;:—–]|\s-\s/);
  return brk === -1 ? '' : ask.slice(brk + 1);
}

for (const f of fs.readdirSync(JOURNAL)) {
  const m = f.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];

  let status = '?';
  try {
    // oa-state.ps1 writes UTF-8 *with BOM*; JSON.parse throws without stripping it.
    const raw = fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '');
    status = JSON.parse(raw).status;
  } catch { /* untracked */ }
  if (TERMINAL.has(status)) continue;

  const text = fs.readFileSync(path.join(JOURNAL, f), 'utf8');

  // A turn written today is not rot.
  const dates = [...text.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((d) => d[1]).filter((d) => d <= TODAY).sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  if (last === TODAY) continue;
  const ageDays = last ? Math.round((new Date(TODAY) - new Date(last)) / 86400000) : null;

  considered++;

  const { ask: rawAsk } = liveAsk(text);
  if (!rawAsk) continue;
  const ask = afterDismissal(rawAsk);
  if (!ask.trim()) continue;

  if (!GATES.some((re) => re.test(ask))) continue;
  if (IRREVERSIBLE.test(ask)) continue;

  // Proximity: the owned target must sit near the modify verb, so an unrelated mention of
  // "the journal" elsewhere in a long ask cannot bridge to an unrelated verb.
  MODIFY.lastIndex = 0;
  let why = null;
  for (const v of ask.matchAll(MODIFY)) {
    const from = Math.max(0, v.index - 30);
    const window = ask.slice(from, v.index + v[0].length + 60);
    const t = window.match(OWNED);
    if (t) { why = { verb: v[0].trim(), target: t[0].trim() }; break; }
  }
  if (!why) continue;

  const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 62);
  hits.push({ id, status, ageDays, title, why, orphan: !onBoard.has(id), ask: ask.trim().slice(0, 190) });
}

hits.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

console.log(`considered (non-terminal, not written today): ${considered}`);
console.log(`FLAGGED — gates a modification to an artifact the agent itself owns: ${hits.length}\n`);
for (const h of hits) {
  console.log(`#${h.id.padEnd(4)} ${String(h.ageDays ?? '?').padStart(3)}d  ${h.status.padEnd(11)} ${h.title}${h.orphan ? '   [no board row]' : ''}`);
  console.log(`      gated : "${h.why.verb}" -> "${h.why.target}"  (agent-owned; rewritten unattended every run)`);
  console.log(`      ask   : ${h.ask}\n`);
}
if (hits.length) {
  console.log('Do the edit, link the result, and drop the gate. Keep an ask only if the CONTENT needs');
  console.log('a decision Shiv alone can make (e.g. exact wording) — not because the file is being touched.');
}
process.exit(hits.length ? 1 : 0);
