// gate.mjs -- the agent gate (#297): agent-gate.md parsed, and the floor/allow verdict for one
// action kind. READ ONLY: nothing here (or anywhere in the port) writes agent-gate.md; that one-way
// property is what makes the file a trustworthy consent channel. See oa-state.ps1 .GATE for the
// full rationale; every pattern below is that file's, verbatim.
import fs from 'node:fs';
import { rx, rxMatches, psIsMatch, lowerInvariant, isNullOrWhiteSpace, netTrim, netTrimEnd } from '../core/net.mjs';
import { readAllText } from '../core/fsx.mjs';
import { PsDate } from '../core/psdate.mjs';
import { joinPath } from '../core/context.mjs';

// --- structure: kept in lockstep with src/config/agentGate.js -----------------------------
export const GateHeadingRe = '^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$';
export const GateBulletRe = '^\\s*[-*+]\\s+(.*)$';
export const GateVersionRe = '(?i)<!--\\s*planner-agent-gate\\s+v(\\d+)';
export const GateSectionMatchers = [
  { Key: 'allow', Phrases: ['do not gate', "don't gate", 'reversible'] },
  { Key: 'ask', Phrases: ['always ask', 'safety floor'] },
];

// --- action vocabulary: kind -> regex GROUPS, all of which must match (AND of ORs) ----------
export const GateActionKinds = {
  merge_pr: ['\\bmerg(?:e|es|ed|ing)\\b|\\bauto-?merges?\\b|\\bland(?:s|ed|ing)? (?:the |a |it )?(?:pr|pull request)\\b'],
  open_pr: [
    '\\b(?:creat(?:e|es|ed|ing)|open(?:s|ed|ing)?|publish(?:es|ed|ing)?|rais(?:e|es|ed|ing)|draft(?:s|ed|ing)?|submit(?:s|ted|ting)?|fil(?:e|es|ed|ing))\\b',
    '\\bpull[- ]requests?\\b|\\bprs?\\b',
  ],
  push_main: [
    '\\bpush(?:es|ed|ing)?\\b|\\bforce-?push(?:es|ed|ing)?\\b',
    '\\bmain\\b|\\bmaster\\b|\\btrunk\\b|\\bdefault branch\\b',
  ],
  delete_branch: [
    '\\bdelet(?:e|es|ed|ing)\\b|\\bremov(?:e|es|ed|ing)\\b|\\bprun(?:e|es|ed|ing)\\b',
    '\\bbranch(?:es)?\\b',
  ],
  send_email_self: [
    '\\bemail(?:s|ing|ed)?\\b|\\be-mail(?:s|ing|ed)?\\b|\\bsend(?:s|ing)?\\b|\\bsent\\b|\\bmail(?:s|ing|ed)?\\b',
    '\\bmyself\\b|\\bmy own\\b|\\bto me\\b|\\bself\\b',
  ],
  send_email_reply: [
    '\\brepl(?:y|ies|ied|ying)\\b|\\brespond(?:s|ed|ing)?\\b|\\bresponses?\\b|\\banswer(?:s|ed|ing)?\\b',
    '\\bemail(?:s|ing|ed)?\\b|\\be-mail(?:s|ing|ed)?\\b|\\bchat\\b|\\bmessages?\\b|\\bdms?\\b|\\binteractions?\\b|\\bthreads?\\b|\\bconversations?\\b',
  ],
  send_email_new_thread: [
    '\\bstart(?:s|ed|ing)?\\b|\\binitiat(?:e|es|ed|ing)\\b|\\bfresh\\b|\\bcold\\b|\\bnew\\b|\\breach(?:es|ed|ing)? out\\b',
    '\\bconversations?\\b|\\bthreads?\\b|\\bemail(?:s|ing|ed)?\\b|\\be-mail(?:s|ing|ed)?\\b|\\bchat\\b|\\bmessages?\\b|\\boutreach\\b',
  ],
  send_email_many: [
    '\\bsend-to-many\\b|\\bgroups?\\b|\\bchannels?\\b|\\bmanager\\b|\\bmass\\b|\\bbroadcast\\b|\\bdistribution list\\b|\\beveryone\\b|\\ball-hands\\b|\\bmany\\b|\\bbulk\\b',
    '\\bemail(?:s|ing|ed)?\\b|\\be-mail(?:s|ing|ed)?\\b|\\bmessages?\\b|\\bchat\\b|\\bchannels?\\b|\\bgroups?\\b|\\bsend(?:s|ing)?\\b|\\bsent\\b|\\bpost(?:s|ed|ing)?\\b',
  ],
  post_public: [
    '\\bpost(?:s|ed|ing)?\\b|\\bpublish(?:es|ed|ing)?\\b|\\btweet(?:s|ed|ing)?\\b|\\bshar(?:e|es|ed|ing)\\b|\\bannounc(?:e|es|ed|ing)\\b',
    '\\bpublic(?:ly)?\\b|\\bsocial\\b|\\btwitter\\b|\\blinkedin\\b|\\binstagram\\b|\\bblog\\b|\\bwebsite\\b|\\bfeed\\b',
  ],
  spend_money: [
    '\\bspend(?:s|ing)?\\b|\\bspent\\b|\\bpurchas(?:e|es|ed|ing)\\b|\\bbuy(?:s|ing)?\\b|\\bbought\\b|\\bpay(?:s|ing)?\\b|\\bpaid\\b|\\bsubscrib(?:e|es|ed|ing)\\b',
    '\\bmoney\\b|\\bpurchases?\\b|\\bpayments?\\b|\\bcards?\\b|\\bdollars?\\b|\\bcosts?\\b|\\bcharges?\\b|\\bsubscriptions?\\b|\\borders?\\b|\\$',
  ],
  delete_data: [
    '\\bdelet(?:e|es|ed|ing)\\b|\\bdrop(?:s|ped|ping)?\\b|\\bdestroy(?:s|ed|ing)?\\b|\\bwip(?:e|es|ed|ing)\\b|\\bpurg(?:e|es|ed|ing)\\b',
    '\\bdata\\b|\\bdatabases?\\b|\\bdbs?\\b|\\bfiles?\\b|\\brecords?\\b|\\btables?\\b|\\brows?\\b|\\bfolders?\\b',
  ],
  deploy: ['\\bdeploy(?:s|ed|ing|ment|ments)?\\b|\\brollouts?\\b|\\broll out\\b|\\bship(?:s|ped|ping)? to prod(?:uction)?\\b'],
  publish_release: [
    '\\bpublish(?:es|ed|ing)?\\b|\\breleas(?:e|es|ed|ing)\\b|\\bcut(?:s|ting)?\\b|\\btag(?:s|ged|ging)?\\b',
    '\\breleases?\\b|\\bversions?\\b|\\bpackages?\\b|\\bnpm\\b|\\btags?\\b|\\bchangelog\\b',
  ],
};

// --- outcome-shaped floor vocabulary (FLOOR rules only) -----------------------------------
export const GateOutcomeKinds = {
  delete_data: "\\bdata ?loss\\b|\\blos(?:e|es|ing)\\b|\\blost\\b|\\bloss\\b|\\bunrecoverable\\b|\\birrecoverable\\b|\\birreversible\\b|\\bpermanent(?:ly)?\\b|\\bcannot be undone\\b|\\bcan(?:no|')?t be undone\\b|\\bcannot be recovered\\b|\\bcan(?:no|')?t be recovered\\b|\\bno backup\\b|\\bdestructive\\b",
  spend_money: '\\bcosts?\\b|\\bexpensive\\b|\\bbilled?\\b|\\bbilling\\b|\\bcharged?\\b|\\bnon-?refundable\\b|\\bout of pocket\\b',
};

// --- blanket grants (ALLOW rules only) -----------------------------------------------------
export const GateBlanketRe = "(?i)\\byolo\\b|\\bdo ?n[o']?t ask\\b|\\bno need to ask\\b|\\bnever ask\\b|\\bwithout asking\\b|\\bjust do\\b|\\bstop asking\\b";

// --- repo scoping -------------------------------------------------------------------------
export const GateRepoTokenRe = '(?:[A-Za-z0-9_.]+/)?[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)+';
export const GateRepoStopWords = [
  'e-mail', 'e-mails', 'follow-up', 'follow-ups', 'read-only', 'sign-in', 'sign-off',
  'check-in', 'one-off', 'day-to-day', 'up-to-date', 'so-called', 'pull-request',
  'pull-requests', 'send-to-many', 'all-hands', 'long-running', 'non-trivial',
  'end-to-end', 'write-up', 'back-and-forth', 'out-of-office', 'opt-in', 'opt-out',
  'double-check', 'third-party', 'first-party', 'real-time', 'on-call', 'ad-hoc',
  'force-push', 'auto-merge', 'case-by-case', 'one-to-one', 'well-known', 'up-front',
];

export function getGateSectionKey(headingText) {
  const t = lowerInvariant(headingText ?? '');
  for (const m of GateSectionMatchers) for (const p of m.Phrases) if (t.includes(p)) return m.Key;
  return null;
}

export function parseAgentGateText(md) {
  const normalised = String(md ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalised.split('\n');
  const out = { Version: null, Allow: [], Ask: [] };
  const v = rx(normalised, GateVersionRe);
  if (v) out.Version = Number(v[1]);
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const h = rx(lines[i], GateHeadingRe);
    if (!h) continue;
    const key = getGateSectionKey(h[2]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const depth = h[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const n = rx(lines[j], GateHeadingRe);
      if (n && n[1].length <= depth) { end = j; break; }
    }
    const items = [];
    for (let j = i + 1; j < end; j++) {
      const b = rx(lines[j], GateBulletRe);
      if (!b) continue;
      const text = netTrim(b[1]);
      if (text) items.push(text);
    }
    if (key === 'allow') out.Allow = items; else out.Ask = items;
  }
  return out;
}

export function readAgentGate(p) {
  const result = { path: `${p ?? ''}`, exists: false, state: 'absent', version: null, allow: [], ask: [], mtime: null };
  let isLeaf = false;
  try { isLeaf = !isNullOrWhiteSpace(p) && fs.statSync(p).isFile(); } catch { isLeaf = false; }
  if (!isLeaf) return result;
  result.exists = true;
  let text = null;
  try {
    text = readAllText(p);
    result.mtime = PsDate.fromInstant(fs.statSync(p).mtimeMs, 'Utc').format('o');
  } catch {
    result.state = 'unreadable';
    return result;
  }
  if (isNullOrWhiteSpace(text)) { result.state = 'empty'; return result; }
  const parsed = parseAgentGateText(text);
  result.version = parsed.Version;
  result.allow = [...parsed.Allow];
  result.ask = [...parsed.Ask];
  result.state = result.allow.length === 0 && result.ask.length === 0 ? 'malformed' : 'ok';
  return result;
}

const trimEndChars = (s, chars) => netTrimEnd(s, chars);

// --- where he can approve: agent-gate.md `## Approvals` (oa-state.ps1 Read-ApprovalChannels) ----
// Defaults; `off` switches a channel off; ANY other value is a rule this engine cannot enforce, so
// the channel is off too (fail closed). An unreadable gate file switches every channel off.
export const ApprovalChannelDefaults = { app: 'editor', 'google-doc': 'no-signature + not-in-sent-ledger' };

export function getApprovalRuleVerdict(channel, rule) {
  const v = lowerInvariant(`${rule ?? ''}`.split('`').join('').replace(/\s+/g, ' ').trim());
  if (['off', 'never', 'disabled', 'none', 'no'].includes(v)) return 'off';
  if (channel === 'app') return v === 'editor' ? 'enabled' : 'unrecognised';
  const tokens = [...new Set(v.split('+').map((t) => t.trim()).filter(Boolean))];
  if (tokens.length === 2 && tokens.includes('no-signature') && tokens.includes('not-in-sent-ledger')) return 'enabled';
  return 'unrecognised';
}

export function readApprovalChannels(p) {
  const out = {};
  for (const k of Object.keys(ApprovalChannelDefaults)) {
    out[k] = { enabled: true, reason: '', rule: ApprovalChannelDefaults[k], source: 'default' };
  }
  let isLeaf = false;
  try { isLeaf = !isNullOrWhiteSpace(p) && fs.statSync(p).isFile(); } catch { isLeaf = false; }
  if (!isLeaf) return out;
  let text;
  try { text = readAllText(p); } catch {
    for (const k of Object.keys(out)) out[k] = { enabled: false, reason: 'unreadable', rule: '', source: 'agent-gate' };
    return out;
  }
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = rx(lines[i], GateHeadingRe);
    if (h && lowerInvariant(netTrim(h[2])) === 'approvals') { start = i; depth = h[1].length; break; }
  }
  if (start < 0) return out;
  for (let j = start + 1; j < lines.length; j++) {
    const n = rx(lines[j], GateHeadingRe);
    if (n && n[1].length <= depth) break;
    const m = rx(lines[j], '^\\s*(?:[-*+]\\s+)?`?([A-Za-z][A-Za-z-]*)`?\\s*:\\s*(.*?)\\s*$');
    if (!m) continue;
    const name = lowerInvariant(m[1]);
    if (!Object.hasOwn(out, name)) continue;
    if (!out[name].enabled) continue;
    const verdict = getApprovalRuleVerdict(name, m[2]);
    out[name] = { enabled: verdict === 'enabled', reason: verdict === 'enabled' ? '' : verdict, rule: netTrim(m[2]), source: 'agent-gate' };
  }
  return out;
}

export function getApprovalOffReason(channel, name) { return `approvals-channel-${channel.reason}:${name}`; }

// The sent-messages ledger write-turn keeps, resolved exactly as the writer resolves it.
export function sentLedgerPath() {
  const env = process.env;
  const home = env.WRITE_TURN_OA_HOME || env.OVERNIGHT_AGENT_HOME || (env.LOCALAPPDATA ? joinPath(env.LOCALAPPDATA, 'overnight-agent') : null);
  return home ? joinPath(home, 'sent-messages.jsonl') : null;
}

export function getGateRepoTokens(rule) {
  const out = [];
  for (const m of rxMatches(`${rule ?? ''}`, GateRepoTokenRe)) {
    const t = trimEndChars(lowerInvariant(m[0]), ['.', ',', ')', '-']);
    const bare = t.split('/').at(-1);
    if (bare.length < 6) continue;
    if (!psIsMatch(bare, '[a-z]')) continue;
    if (GateRepoStopWords.some((w) => lowerInvariant(w) === lowerInvariant(bare))) continue;
    if (!out.some((x) => lowerInvariant(x) === lowerInvariant(bare))) out.push(bare);
  }
  return out;
}

export function testGateRuleCovers(rule, action, applyRepoScope, repo, allowOutcomePhrasing) {
  if (isNullOrWhiteSpace(rule)) return false;
  if (isNullOrWhiteSpace(action)) return false;
  const text = `${rule}`;
  if (applyRepoScope) {
    const tokens = getGateRepoTokens(text);
    if (tokens.length > 0) {
      if (isNullOrWhiteSpace(repo)) return false;
      const want = lowerInvariant(netTrim(`${repo}`));
      const wantBare = want.split('/').at(-1);
      let hit = false;
      for (const t of tokens) {
        if (lowerInvariant(t) === lowerInvariant(want) || lowerInvariant(t) === lowerInvariant(wantBare)) { hit = true; break; }
      }
      if (!hit) return false;
    }
    if (psIsMatch(text, GateBlanketRe)) return true;
  }
  const key = Object.keys(GateActionKinds).find((k) => lowerInvariant(k) === lowerInvariant(action));
  const groups = key ? GateActionKinds[key] : null;
  if (!groups) return false;
  let allGroups = true;
  for (const g of groups) { if (!psIsMatch(text, g)) { allGroups = false; break; } }
  if (allGroups) return true;
  if (allowOutcomePhrasing) {
    const okey = Object.keys(GateOutcomeKinds).find((k) => lowerInvariant(k) === lowerInvariant(action));
    const outcome = okey ? GateOutcomeKinds[okey] : null;
    if (outcome && psIsMatch(text, outcome)) {
      if (groups.length < 2 || psIsMatch(text, groups.at(-1))) return true;
    }
  }
  return false;
}

export function getGateVerdict(gate, action, repo) {
  const stages = [
    { Decision: 'floor', List: 'ask', Rules: [...(gate?.ask ?? [])], Scoped: false, Outcome: true },
    { Decision: 'allow', List: 'allow', Rules: [...(gate?.allow ?? [])], Scoped: true, Outcome: false },
  ];
  const verdict = { decision: 'none', list: null, rule: null };
  if (isNullOrWhiteSpace(action)) return verdict;
  for (const stage of stages) {
    for (const rule of stage.Rules) {
      if (testGateRuleCovers(rule, action, stage.Scoped, repo, stage.Outcome)) {
        verdict.decision = stage.Decision;
        verdict.list = stage.List;
        verdict.rule = rule;
        return verdict;
      }
    }
  }
  return verdict;
}

// Cmd-Gate: the gate as this script actually reads it, rule text verbatim.
export function cmdGate(ctx) {
  const g = readAgentGate(ctx.p.GatePath);
  ctx.emitJson({
    path: `${g.path}`, exists: !!g.exists, state: `${g.state}`, version: g.version,
    allow: [...g.allow], ask: [...g.ask], mtime: g.mtime,
  }, { depth: 4 });
}
