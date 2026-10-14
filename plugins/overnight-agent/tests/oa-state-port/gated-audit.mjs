// gated-audit.mjs -- READ-ONLY measurement for the gated-dispatch consent guard (#804 floor PR).
//
//   node gated-audit.mjs --journal <dir> --state <dir> [--out <json>]
//
// Run it on a COPY of the live planner folder and state dir. It reads, never writes.
//  A. Current: every task whose NEWEST agent turn has a numbered `[gated]` step, with the journal
//     consent verdict and the state (status / last_woken_at): how many the guard would refuse, and
//     of those, how many carry a reply that LOOKS like an approval (the false-negative candidates
//     a human must read).
//  B. History: every agent turn with a `[gated]` step that was followed by a LATER agent turn
//     reporting progress (status in-progress / done / blocked), with the replies in between:
//     was there a human-attributed affirmative between them? A gated step acted on with none is
//     a past dispatch without consent (a lead to read, not a verdict: the later turn may not
//     have executed the gated step itself).
import fs from 'node:fs';
import path from 'node:path';
import {
  getAgentEndIndex, getNewestAgentTurn, getConsentFacts, getFenceMaskedText, ConsentAffirmRe, TurnEndRe,
} from '../../skills/overnight-agent/oa-state-lib/collect/journal.mjs';
import { readJournalText } from '../../skills/overnight-agent/oa-state-lib/core/fsx.mjs';
import { rxMatches, psIsMatch } from '../../skills/overnight-agent/oa-state-lib/core/net.mjs';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const journalDir = arg('--journal');
const stateDir = arg('--state');
const GATED_STEP = /^[ \t]*[1-9][0-9]*\.[ \t]+\[gated\]/m;
const STATUS = /^[ \t]*\*\*Status:\*\*[ \t]*([A-Za-z -]+)/m;
const managedHeading = /^[ \t]*##[^\r\n]*(\u{1F319}|Overnight Agent)/mu;

const hasGated = (turn) => GATED_STEP.test(getFenceMaskedText(turn));
const statusOf = (turn) => ((STATUS.exec(turn) || [])[1] || '').trim().toLowerCase();

const current = [];
const history = [];
const files = fs.readdirSync(journalDir).filter((f) => /^task-\d+\.md$/.test(f)).sort();
for (const f of files) {
  const id = f.replace(/^task-|\.md$/g, '');
  const content = readJournalText(path.join(journalDir, f));
  const end = getAgentEndIndex(content);
  if (end < 0) continue;
  const agentLeft = content.slice(0, end);
  const trailing = content.slice(end);
  const newest = getNewestAgentTurn(agentLeft) || '';
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(stateDir, `task-${id}.json`), 'utf8').replace(/^\uFEFF/, '')); } catch { st = null; }
  if (hasGated(newest)) {
    const c = getConsentFacts(trailing);
    const looksLikeYes = psIsMatch(trailing, ConsentAffirmRe);
    current.push({
      id, turn_status: statusOf(newest), state_status: st?.status ?? null,
      last_woken_at: st?.session?.last_woken_at ?? null, last_turn_at: st?.last_turn_at ?? null,
      consent_ok: !!c.consent_ok, reason: c.reason, affirmative_in_trailing: looksLikeYes,
      trailing_excerpt: trailing.trim().slice(0, 240),
    });
  }
  // History: split at every turn-end marker; each chunk is [replies to the previous turn][turn].
  const masked = getFenceMaskedText(content);
  const ends = rxMatches(masked, TurnEndRe).map((m) => m.index + m[0].length);
  let prevEnd = -1;
  let prevTurn = null;
  for (const e of ends) {
    const chunk = content.slice(prevEnd < 0 ? 0 : prevEnd, e);
    const h = managedHeading.exec(getFenceMaskedText(chunk));
    if (!h) { prevEnd = e; continue; }
    const replies = chunk.slice(0, h.index);
    const turn = chunk.slice(h.index);
    if (prevTurn && hasGated(prevTurn.text)) {
      const s = statusOf(turn);
      if (/^(in[ -]progress|done|blocked|complete)/.test(s)) {
        const c = getConsentFacts(replies);
        history.push({ id, gated_turn_status: statusOf(prevTurn.text), next_status: s, consent_ok: !!c.consent_ok,
          reason: c.reason, affirmative_in_replies: psIsMatch(replies, ConsentAffirmRe),
          replies_excerpt: replies.trim().slice(0, 200), gated_steps: (prevTurn.text.match(/^[ \t]*[1-9][0-9]*\.[ \t]+\[gated\][^\r\n]*/gm) || []).map((x) => x.trim().slice(0, 140)) });
      }
    }
    prevTurn = { text: turn };
    prevEnd = e;
  }
}

const refused = current.filter((r) => !r.consent_ok);
const summary = {
  journals: files.length,
  current_gated: current.length,
  current_would_refuse: refused.length,
  current_refused_with_affirmative_text: refused.filter((r) => r.affirmative_in_trailing).length,
  current_refused_but_woken_after_turn: refused.filter((r) => r.last_woken_at && r.last_turn_at && Date.parse(r.last_woken_at) > Date.parse(r.last_turn_at)).length,
  history_gated_then_acted: history.length,
  history_acted_without_consent: history.filter((h) => !h.consent_ok).length,
};
const out = { summary, current, history };
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(summary, null, 2));
