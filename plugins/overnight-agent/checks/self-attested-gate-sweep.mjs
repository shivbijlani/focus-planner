// self-attested-gate-sweep.mjs
//
// WHY: the FOURTH dimension of the `approval-gating work that needs no approval` defect
// class, found live on 2026-08-27 on task #448 — by which time the other three arms of the
// family had all gone green on the very same ask:
//
//   reversible-gate-sweep   verbs that CREATE a reversible artifact   -> 0 on #448
//   owned-target-gate-sweep verbs that MODIFY an artifact we own      -> 0 on #448
//   deliverable-gate-sweep  the gate lives in the linked deliverable  -> 0 on #448
//
// Measured, not assumed: re-running both verb-based sweeps with OA_TODAY advanced a day (to
// defeat their "written today is not rot" skip) still reported 0. The blindness is
// STRUCTURAL, not a timing artifact.
//
// THE SHAPE THEY ALL MISS. #448's ask was:
//
//     **`deploy it`** — copy the fixed script into the plugin that actually runs on this
//     machine. What it costs: nothing visible; it is a file copy with a backup, and I
//     measured that it changes no current verdict.
//
// That is a local file copy with a backup — SKILL.md's "local, undoable edits" — and it was
// parked behind a one-word reply anyway. It was the 5th instance of the class, committed by
// the very turn that named the class and cited its four previous victims.
//
// WHY THE VERB-BASED ARMS CANNOT SEE IT. They decide reversibility from the VERB, and both
// carry `deploy` on a hard IRREVERSIBLE list (reversible-gate-sweep:66,
// owned-target-gate-sweep:88). But `deploy`, `apply`, `install`, `enable`, `point`, `switch`
// are ambiguous by nature: "deploy to production" is irreversible, "deploy = copy this file
// into a local folder, backup taken" is not. No verb list can separate those, because the
// distinction is not in the verb at all — it is in the OBJECT and the blast radius.
//
// THE DISCRIMINATOR USED HERE. Do not judge the verb. Use the agent's OWN ATTESTATION: when
// the ask itself certifies the action is a backed-up / undoable / measured-to-change-nothing
// local operation, the agent has already concluded it is reversible. Gating it is then a
// defect BY ITS OWN ACCOUNT, and no heuristic about the verb is required. This is a
// mechanical property of the ask's text, in the same spirit as owned-target-gate-sweep's
// allow-list — not a judgement call.
//
// JUDGE THE TOKEN, NOT THE PROSE. The suppressor looks only at the command token the user is
// asked to reply with, never at the surrounding sentences. #448's ask ends with "That is why
// the ask is 'deploy', not 'merge'" — a whole-ask keyword scan would find "merge" and
// silence the finding, which is precisely the self-suppression trap that let this sit. The
// tokens on offer were `deploy it` and `backfill too`; neither is an external action, so it
// is flagged.
//
// FALSE-POSITIVE POSTURE. Three checkers in this suite have already cried wolf, so all four
// conditions must hold together and each is mutation-proven load-bearing by
// mutcheck-self-attested-gate.mjs. The attestation requirement is the tight one: an agent
// does not write "it is a file copy with a backup, and it changes nothing" about an action
// it believes is dangerous.
//
// exit 1 = findings.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveAsk } from './lib-live-ask.mjs';

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const JOURNAL = path.join(PLANNER, 'journal');
const TODAY = process.env.OA_TODAY || new Date().toISOString().slice(0, 10);

// 1. THE GATE — the ask is asking Shiv to authorise something, not merely narrating.
const GATES = [
  /\bone\s+word\b/i,
  /\bsay\s+the\s+word\b/i,
  /\bappro(?:ve|val)\b/i,
  /\byour\s+(?:yes|ok|okay|call|approval|sign-?off|go|green\s*light)\b/i,
  /\btell\s+me\s+to\b/i,
  /\bwant\s+me\s+to\b/i,
  /\bshould\s+I\b/i,
  /\bif\s+you(?:'?d)?\s+(?:want|like)\b/i,
  /\breply\s+with\b/i,
  /\bwaiting\s+on\s+(?:you|your)\b/i,
  /\bstands?\b[^.]{0,40}\bdecision\b/i,
  /\bdecision\b[^.]{0,40}\bstands?\b/i,
];

// 2. THE ATTESTATION — the agent certifying, in the ask, that the thing it is gating is
//    reversible. This is the discriminator; everything else is a guard around it.
//
//    Each alternative was taken from real agent prose, not invented. Kept to statements about
//    REVERSIBILITY or ABSENCE OF EFFECT — never mere reassurance like "it's fine" or "safe",
//    which the mutation check confirms would flood.
const ATTEST = [
  /\bfile\s+copy\b/i,
  /\bwith\s+a\s+backup\b/i,
  /\bbacked\s+up\b/i,
  /\b(?:easily\s+)?reversible\b/i,
  /\bundo(?:ne|able)?\b/i,
  /\broll(?:ing)?\s*back\b/i,
  /\brevert(?:ed|ible)?\b/i,
  /\bpurely\s+additive\b/i,
  /\bno(?:thing)?\s+visible\b/i,
  /\bchanges?\s+no(?:thing|\s+\w+\s+verdict|\s+current\s+verdict)\b/i,
  /\b(?:0|no)\s+(?:differences|verdicts?\s+differ)\b/i,
  /\bdoes\s+not\s+change\s+anything\b/i,
  /\bno\s+external\s+(?:effect|side[- ]effect)/i,
  /\blocal(?:ly)?[^.]{0,30}\bundoable\b/i,
];

// 3. THE TOKEN — a short imperative the user is asked to type back, in the house format
//    **`deploy it`**. Bounded length keeps ordinary inline code (paths, filenames, flags)
//    from being mistaken for a command.
const TOKEN_RE = /`([^`\r\n]{2,28})`/g;

// 4. THE SUPPRESSOR — applied to the TOKEN ONLY (see header). These are genuinely external
//    actions that SKILL.md gates regardless of how safe the agent believes they are, so an
//    ask offering one is doing the right thing.
const EXTERNAL_TOKEN =
  /^(?:merge|send|email|mail|buy|order|purchase|pay|publish|deploy\s+to\s+prod\w*|submit|post|book|checkout|sign\s+up|apply\s+to|delete|drop)\b/i;

// A token has to look like an instruction, not a noun. Without this, any short backticked
// identifier in the ask (`planner.md`, `--dry-run`) reads as a command token.
const TOKEN_IS_COMMAND = /^[a-z][a-z0-9]*(?:[ -][a-z0-9.]+){0,3}$/i;
const NOT_A_COMMAND = /\.(?:md|ps1|mjs|js|json|ya?ml|txt|html?)$|^--|^-[a-z]$|^#\d+$|^\d+$/i;

// 5. THE CARRY-FORWARD. An ask that survives a night is normally RE-STATED in the next turn
//    as a pointer — #448's live ask is literally:
//
//        "nothing new. The **`deploy it`** decision above still stands, word for word."
//
//    The token is live; the attestation that justifies flagging it ("it is a file copy with a
//    backup … it changes no current verdict") is two turns up. Judging only the live ask
//    therefore goes blind the moment an ask is carried forward — which is exactly what
//    happened on #448, and is the norm rather than the exception for anything that waits.
//
//    So when the live ask names a token but attests nothing, and says in so many words that it
//    is restating an earlier decision, resolve the attestation from the most recent earlier
//    mention of that SAME token. Bounded deliberately: it requires the carry-forward phrasing,
//    it matches the identical token, and it reads a fixed window around that mention rather
//    than the whole journal — so it cannot drift into mining unrelated history.
const CARRY_FORWARD =
  /\b(?:still\s+stands?|unchanged|nothing\s+new|no(?:thing)?\s+change[sd]?|as\s+(?:above|before)|from\s+the\s+entr(?:y|ies)\s+above|decision\s+above|above\s+still)\b/i;
const CARRY_WINDOW = 700;

const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const TERMINAL = new Set(['done', 'skip']);

// Board membership is REPORTED, never used to filter — reversible-gate-sweep filtered on it
// and went blind to #280 and #233 for 22 days (see run-sweeps.ps1:178).
let board = '';
try { board = fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8'); } catch { /* none */ }
const onBoard = new Set();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)\s*[,|]/);
  if (m) onBoard.add(m[1]);
}

export function commandTokens(ask) {
  const out = [];
  for (const m of ask.matchAll(TOKEN_RE)) {
    const t = m[1].trim();
    if (!t) continue;
    if (NOT_A_COMMAND.test(t)) continue;
    if (!TOKEN_IS_COMMAND.test(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

// Exported so the mutation check drives the same code path the sweep does.
// `journal` is the full journal text, used only to resolve a carried-forward ask (see
// CARRY_FORWARD). Omitting it reduces this to live-ask-only judgement.
export function judge(ask, journal = '') {
  if (!ask) return null;
  if (!GATES.some((re) => re.test(ask))) return null;

  const tokens = commandTokens(ask);
  if (!tokens.length) return null;

  // Every token external => the gate is legitimate in full. If ANY token is a local action,
  // that half should have been done already, so it is still a finding (same rationale as
  // reversible-gate-sweep's "mixed ask is still a defect").
  const local = tokens.filter((t) => !EXTERNAL_TOKEN.test(t));
  if (!local.length) return null;

  const hits = (text) =>
    [...new Set(ATTEST.filter((re) => re.test(text)).map((re) => (text.match(re) || [''])[0].trim()))];

  let attest = hits(ask);
  let via = 'ask';

  if (!attest.length && journal && CARRY_FORWARD.test(ask)) {
    // Resolve from an EARLIER mention of the same token. Walk backwards through ALL of them,
    // not just the most recent: an ask that has waited several nights is re-stated as a
    // pointer each night, so the nearest earlier mentions are themselves pointers. The
    // explanation lives at the FIRST one going back that actually attests something. #448 had
    // five such pointers stacked above the 02:54 turn that carried the real justification.
    const askAt = journal.lastIndexOf(ask);
    const before = askAt >= 0 ? askAt : journal.length;
    for (const t of local) {
      const needle = '`' + t + '`';
      let at = journal.lastIndexOf(needle, before);
      while (at >= 0) {
        const window = journal.slice(Math.max(0, at - CARRY_WINDOW), at + CARRY_WINDOW);
        const found = hits(window);
        if (found.length) {
          attest = found;
          via = `carried-forward:${t}`;
          break;
        }
        at = journal.lastIndexOf(needle, at - 1);
      }
      if (attest.length) break;
    }
  }

  if (!attest.length) return null;

  return { attest, tokens, local, via };
}

function main() {
  const hits = [];
  let considered = 0;

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

    const dates = [...text.matchAll(/(20\d\d-\d\d-\d\d)/g)].map((d) => d[1]).filter((d) => d <= TODAY).sort();
    const last = dates.length ? dates[dates.length - 1] : null;
    const ageDays = last ? Math.round((new Date(TODAY) - new Date(last)) / 86400000) : null;

    considered++;

    const { ask } = liveAsk(text);
    const verdict = judge(ask, text);
    if (!verdict) continue;

    const title = (text.match(/^#\s*Task\s*\d+:\s*(.+)/m) || [, ''])[1].trim().slice(0, 62);
    hits.push({ id, status, ageDays, title, onBoard: onBoard.has(id), ...verdict, ask: ask.slice(0, 200) });
  }

  hits.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  console.log(`considered (non-terminal journals): ${considered}`);
  console.log(`FLAGGED — ask certifies its own action is reversible, then gates it: ${hits.length}\n`);
  for (const h of hits) {
    const age = h.ageDays == null ? '  ?' : `${String(h.ageDays).padStart(3)}d`;
    console.log(`#${h.id.padEnd(6)} ${age} ${h.status.padEnd(12)} ${h.onBoard ? '' : '[orphan] '}${h.title}`);
    console.log(`      token(s) : ${h.local.join(', ')}`);
    console.log(`      attests  : ${h.attest.join(' | ')}   (via ${h.via})`);
    console.log(`      ask      : ${h.ask.replace(/\s+/g, ' ')}\n`);
  }

  process.exit(hits.length ? 1 : 0);
}

// Importable by the mutation check without running the corpus scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
