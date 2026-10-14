// journal.mjs -- journal readers ported 1:1 from oa-state.ps1. These are pure parsers: they
// decide turn boundaries, authorship, open asks, and consent; state/board code builds on them.
import crypto from 'node:crypto';
import { fileNameWithoutExtension, readJournalText as readJournalTextCore } from '../core/fsx.mjs';
import {
  netRe, netTrim, netTrimEnd, isNullOrWhiteSpace, psIsMatch, psReplace, psSplit, psEq,
  rx, rxMatches, rxTest,
} from '../core/net.mjs';
import { fromJson } from '../core/psjson.mjs';
import { PsDate } from '../core/psdate.mjs';

export const HumanAuthor = 'me';
export const SelfAuthor = 'overnight-agent';
export const ProvenanceRe = '(?m)^[ \\t]*<!--[ \\t]*from:[ \\t]*([^>\\r\\n]*?)[ \\t]*-->';
export const LegacyStateRe = '(?m)^[ \\t]*<!--[ \\t]*oa-state';
export const FenceOpenRe = '^[ ]{0,3}(?<f>`{3,}|~{3,})(?<info>[^\\r\\n]*)$';
export const FenceCloseRe = '^[ ]{0,3}(?<f>`{3,}|~{3,})[ \\t]*$';
export const ConsentAffirmRe = '(?i)(?<![\\w-])(approved?|approve it|yes|yep|yeah|go ahead|go for it|go|lgtm|ship it|do it|vibe it|send it|make it so|proceed|merge[ \\t]+#?\\d+)(?![\\w-])';

export const TurnEndMarker = '<!-- /overnight-agent turn-end -->';
export const TurnEndRe = '(?m)^[ \\t]*<!--[ \\t]*/overnight-agent[ \\t]+turn-end[ \\t]*-->[ \\t]*\\r?$';
export const RunLogRe = '(?m)^[ \\t]*###[ \\t]+Run log[ \\t]*\\r?$';
export const RunLogBodyLineRe = '^(?:[ \\t\\r]*$|[ \\t]*###[ \\t]+Run log[ \\t\\r]*$|[ \\t]*\\*\\*.*$|[ \\t]*[-*+][ \\t].*$|[ \\t]*\\d+\\.[ \\t].*$|[ \\t]+\\S.*$)';
export const ManagedHeadingRe = '^##[^\\r\\n]*Overnight Agent';
export const NeedsFromYouRe = '(?im)^[ \\t]*\\*\\*[ \\t]*Needs from you[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?(.*)$';
export const YourCallRe = '(?im)^[ \\t]*\\*\\*[ \\t]*Your call[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?(.*)$';
export const DismissiveAskRe = '(?i)^[ \\t]*(none|nothing|nada|n/a|no)\\b';
export const AskClauseBreakRe = '[.;:]|\\u2014|\\u2013|(?<=\\s)-(?=\\s)';
export const OptionalRemainderRe = '(?i)\\b(optional(ly)?|if you want|if you would like|if you ?d like|if you like|when you ?re ready|when you are ready|when you get to it|when you have time|no rush|not urgent|up to you|self-serve|whenever you)\\b';
export const AskDeclRe = '(?im)^[ \\t]*<!--[ \\t]*oa-ask[ \\t]*:[ \\t]*(blocking|offer|none)[ \\t]*-->[ \\t\\r]*$';

const MemoTables = new Map();
export const MemoMaxEntries = 4096;

export function getSha256(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

export function getMemoised(table, key, compute) {
  let t = MemoTables.get(table);
  if (!t) { t = new Map(); MemoTables.set(table, t); }
  if (t.has(key)) return t.get(key);
  const value = compute();
  if (t.size >= MemoMaxEntries) t.clear();
  t.set(key, value);
  return value;
}

export function getFenceMaskedText(text) {
  if (text === null || text === undefined || text === '') return text ?? '';
  const s = String(text);
  if (s.indexOf('`') < 0 && s.indexOf('~') < 0) return s;
  return getMemoised('fenceMask', s, () => getFenceMaskedTextCore(s));
}

export function getFenceMaskedTextCore(text) {
  const s = String(text ?? '');
  let out = '';
  let i = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  while (i < s.length) {
    const nl = s.indexOf('\n', i);
    const lineEnd = nl < 0 ? s.length : nl;
    const raw = s.slice(i, lineEnd);
    const line = netTrimEnd(raw, ['\r']);
    let couldFence = false;
    const probe = Math.min(4, line.length);
    for (let p = 0; p < probe; p++) {
      const ch = line[p];
      if (ch === '`' || ch === '~') { couldFence = true; break; }
      if (ch !== ' ') break;
    }
    let mask = false;
    if (!inFence) {
      if (couldFence) {
        const m = rx(line, FenceOpenRe);
        if (m) {
          const f = m.groups?.f ?? m[1];
          const info = m.groups?.info ?? m[2] ?? '';
          if (!(f[0] === '`' && info.includes('`'))) {
            inFence = true;
            fenceChar = f[0];
            fenceLen = f.length;
            mask = true;
          }
        }
      }
    } else {
      mask = true;
      if (couldFence) {
        const c = rx(line, FenceCloseRe);
        if (c) {
          const cf = c.groups?.f ?? c[1];
          if (cf[0] === fenceChar && cf.length >= fenceLen) inFence = false;
        }
      }
    }
    if (mask) {
      out += ' '.repeat(line.length);
      if (raw.length > line.length) out += raw.slice(line.length);
    } else {
      out += raw;
    }
    if (nl < 0) break;
    out += '\n';
    i = nl + 1;
  }
  return out;
}

export function getLastIndexOfPattern(content, pattern) {
  let idx = -1;
  for (const m of rxMatches(String(content ?? ''), pattern)) idx = m.index;
  return idx;
}

export function testIsRunLogBodyOnly(region) {
  for (const line of psSplit(String(region ?? ''), '\\r?\\n')) {
    if (!psIsMatch(line, RunLogBodyLineRe)) return false;
  }
  return true;
}

export function getNewestAgentTurn(agentLeft) {
  if (agentLeft === null || agentLeft === undefined || agentLeft === '') return '';
  const s = String(agentLeft);
  return getMemoised('newestAgentTurn', s, () => getNewestAgentTurnCore(s));
}

export function getNewestAgentTurnCore(agentLeft) {
  const s = String(agentLeft ?? '');
  const scan = getFenceMaskedText(s);
  let idx = getLastIndexOfPattern(scan, '(?m)' + ManagedHeadingRe);
  if (idx < 0) idx = getLastIndexOfPattern(scan, ProvenanceRe);
  if (idx < 0) return s;
  return s.substring(idx);
}

export function testAskTextIsOpen(value) {
  const v = netTrim(`${value ?? ''}`);
  if (v.length === 0) return false;
  if (!psIsMatch(v, DismissiveAskRe)) return true;
  const m = rx(v, AskClauseBreakRe);
  if (!m) return false;
  const rest = netTrim(v.substring(m.index + m[0].length));
  if (rest.length === 0) return false;
  const flat = psReplace(rest, `[${String.fromCharCode(0x2019)}']`, ' ');
  if (psIsMatch(rest, OptionalRemainderRe) || psIsMatch(flat, OptionalRemainderRe)) return false;
  return true;
}

export function getDeclaredAsk(agentLeft) {
  if (agentLeft === null || agentLeft === undefined || agentLeft === '') return '';
  const s = String(agentLeft);
  return getMemoised('declaredAsk', s, () => getDeclaredAskCore(s));
}

export function getDeclaredAskCore(agentLeft) {
  const turn = getNewestAgentTurn(agentLeft);
  if (turn.length === 0) return '';
  const scan = getFenceMaskedText(turn);
  let val = '';
  for (const m of rxMatches(scan, AskDeclRe)) val = m[1];
  return val.toLowerCase();
}

export function testHasOpenAsk(agentLeft) {
  const declared = getDeclaredAsk(agentLeft);
  if (declared === 'blocking' || declared === 'offer') return true;
  const turn = getNewestAgentTurn(agentLeft);
  if (turn.length === 0) return false;
  if (rxTest(turn, YourCallRe)) return true;
  for (const m of rxMatches(turn, NeedsFromYouRe)) {
    if (testAskTextIsOpen(m[1])) return true;
  }
  return false;
}

export function testAskTextIsBlocking(value) {
  const v = netTrim(`${value ?? ''}`);
  if (v.length === 0) return false;
  return !psIsMatch(v, DismissiveAskRe);
}

export function testHasBlockingAsk(agentLeft) {
  const turn = getNewestAgentTurn(agentLeft);
  if (turn.length === 0) return false;
  if (rxTest(turn, YourCallRe)) return true;
  for (const m of rxMatches(turn, NeedsFromYouRe)) {
    if (testAskTextIsBlocking(m[1])) return true;
  }
  return false;
}

export function getBlockingAskVerdict(agentLeft) {
  const declared = getDeclaredAsk(agentLeft);
  if (declared) return { blocking: declared === 'blocking', source: 'declared', declared };
  return { blocking: testHasBlockingAsk(agentLeft), source: 'inferred', declared: '' };
}

export function getAgentEndIndex(content) {
  const s = String(content ?? '');
  const scan = getFenceMaskedText(s);
  const sentinelMarker = scan.lastIndexOf('OVERNIGHT-AGENT do not edit');
  let selfMarker = -1;
  for (const m of rxMatches(scan, ProvenanceRe)) {
    if (psEq(netTrim(m[1]), SelfAuthor)) selfMarker = m.index;
  }
  const agentMarker = Math.max(selfMarker, getLastIndexOfPattern(scan, LegacyStateRe), sentinelMarker);
  if (agentMarker < 0) return -1;

  let turnEnd = -1;
  for (const m of rxMatches(scan, TurnEndRe)) {
    if (m.index >= agentMarker) turnEnd = m.index + m[0].length;
  }
  if (turnEnd >= 0) {
    if (turnEnd < s.length && s[turnEnd] === '\r') turnEnd++;
    if (turnEnd < s.length && s[turnEnd] === '\n') turnEnd++;
  }

  const from = turnEnd >= 0 ? turnEnd : agentMarker;
  let boundary = -1;
  let sawManaged = false;
  let isFirstHeading = true;
  for (const h of rxMatches(scan, '(?m)^##[ \\t][^\\r\\n]*')) {
    if (h.index < from) continue;
    let managed = psIsMatch(h[0], ManagedHeadingRe);
    if (!managed && isFirstHeading && turnEnd < 0 && agentMarker === sentinelMarker && h.index > agentMarker) managed = true;
    isFirstHeading = false;
    if (!managed) { boundary = h.index; break; }
    sawManaged = true;
  }
  if (boundary < 0) {
    if (sawManaged) return s.length;
    if (turnEnd >= 0) return turnEnd;
    return s.length;
  }
  if (!sawManaged && turnEnd >= 0) return turnEnd;
  const end = boundary;

  const runLog = getLastIndexOfPattern(scan, RunLogRe);
  if (runLog >= end) {
    const afterRunLog = scan.indexOf('\n## ', runLog);
    const regionEnd = afterRunLog < 0 ? s.length : afterRunLog + 1;
    const region = s.substring(runLog, regionEnd);
    if (testIsRunLogBodyOnly(region)) return regionEnd;
  }
  return end;
}

export function testTrailingHasHuman(trailing, consent = null) {
  const c = consent || getConsentFacts(trailing);
  return !!(c.human_segments > 0);
}

export function testTrailingHasUser(trailing) {
  const t = String(trailing ?? '');
  if (netTrim(t).length === 0) return false;
  const scan = getFenceMaskedText(t);
  const entries = netRe('(?m)(?=^## )').split(scan).filter((x) => netTrim(x).length > 0);
  for (const entry of entries) {
    const marks = rxMatches(entry, ProvenanceRe);
    if (marks.length === 0) return true;
    for (const m of marks) if (psEq(netTrim(m[1]), HumanAuthor)) return true;
  }
  return false;
}

export function getAboveSentinelRegion(content) {
  if (content === null || content === undefined || content === '') return '';
  const s = String(content);
  const scan = getFenceMaskedText(s);
  const i = scan.lastIndexOf('OVERNIGHT-AGENT do not edit');
  if (i < 0) return s;
  return s.substring(0, i);
}

export function getNewestDatedHumanAbove(region) {
  const r = String(region ?? '');
  if (r === '') return null;
  const scan = getFenceMaskedText(r);
  const headings = [];
  for (const m of rxMatches(scan, '(?m)^[ \\t]*##[ \\t]+(\\d{4})-(\\d{2})-(\\d{2})\\b')) {
    headings.push({ Index: m.index, Date: PsDate.fromParts(Number(m[1]), Number(m[2]), Number(m[3])) });
  }
  if (headings.length === 0) return null;
  let newest = null;
  for (const m of rxMatches(scan, ProvenanceRe)) {
    if (!psEq(netTrim(m[1]), HumanAuthor)) continue;
    let owner = null;
    for (const h of headings) {
      if (h.Index < m.index) owner = h; else break;
    }
    if (owner === null) continue;
    if (newest === null || owner.Date.compare(newest) > 0) newest = owner.Date;
  }
  return newest;
}

export function getAuthorSegments(region) {
  if (region === null || region === undefined) return [];
  const r = String(region);
  const segments = [];
  const scan = getFenceMaskedText(r);
  const marks = rxMatches(scan, ProvenanceRe);
  const headings = rxMatches(scan, '(?m)^[ \\t]*##[ \\t]+\\S');
  if (marks.length === 0) {
    if (netTrim(r).length > 0) segments.push({ Author: 'unknown', Text: r, Index: 0 });
    return segments;
  }
  const preamble = r.substring(0, marks[0].index);
  if (netTrim(preamble).length > 0) segments.push({ Author: 'unknown', Text: preamble, Index: 0 });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : r.length;
    let cut = end;
    for (const h of headings) {
      if (h.index >= start && h.index < end) { cut = h.index; break; }
    }
    const text = r.substring(start, cut);
    segments.push({ Author: netTrim(marks[i][1]), Text: text, Index: start });
    if (cut < end) {
      const orphan = r.substring(cut, end);
      if (netTrim(orphan).length > 0) segments.push({ Author: 'unknown', Text: orphan, Index: cut });
    }
  }
  return segments;
}

export function getConsentFacts(trailing) {
  const result = {
    consent_ok: false,
    human_segments: 0,
    affirmative_phrase: null,
    affirmative_author: null,
    affirmative_unattributed: false,
    affirmative_answered: false,
    reason: 'no-trailing-content',
  };
  if (isNullOrWhiteSpace(trailing)) return result;
  const segments = getAuthorSegments(trailing);
  result.human_segments = segments.filter((s) => psEq(s.Author, HumanAuthor)).length;
  const scan = getFenceMaskedText(String(trailing ?? ''));
  const agentTurnAt = [];
  for (const m of rxMatches(scan, ProvenanceRe)) {
    if (psEq(netTrim(m[1]), SelfAuthor)) agentTurnAt.push(m.index);
  }
  for (const m of rxMatches(scan, '(?m)^[ \\t]*##[^\\r\\n]*Overnight Agent')) agentTurnAt.push(m.index);
  for (const seg of segments) {
    const m = rx(seg.Text, ConsentAffirmRe);
    if (!m) continue;
    if (psEq(seg.Author, HumanAuthor)) {
      const at = Number(seg.Index) + m.index;
      const served = agentTurnAt.some((x) => x > at);
      if (served) {
        if (!result.affirmative_answered) {
          result.affirmative_answered = true;
          result.affirmative_phrase = m[0];
          result.affirmative_author = seg.Author;
        }
        continue;
      }
      result.consent_ok = true;
      result.affirmative_phrase = m[0];
      result.affirmative_author = seg.Author;
      result.reason = 'human-authored-affirmative';
      return result;
    }
    if (!result.affirmative_unattributed) {
      result.affirmative_unattributed = true;
      if (!result.affirmative_answered) {
        result.affirmative_phrase = m[0];
        result.affirmative_author = seg.Author;
      }
    }
  }
  if (result.affirmative_answered) result.reason = 'human-affirmative-already-answered';
  else if (result.affirmative_unattributed) result.reason = 'affirmative-not-attributable-to-human';
  else if (result.human_segments > 0) result.reason = 'human-spoke-but-no-affirmative';
  else result.reason = 'no-human-authored-content';
  return result;
}

export function testTrailingHasConsent(trailing) {
  return !!getConsentFacts(trailing).consent_ok;
}

export function parseLegacyOaState(content) {
  const matches = rxMatches(String(content ?? ''), 'oa-state\\s*\\r?\\n\\s*(\\{.*?\\})\\s*\\r?\\n\\s*-->', { s: true });
  if (matches.length === 0) return null;
  try { return fromJson(matches[matches.length - 1][1]); } catch { return null; }
}

export const readJournalText = readJournalTextCore;

export function getJournalFacts(path) {
  let content = readJournalText(path);
  if (content === null || content === undefined) content = '';
  const id = psReplace(fileNameWithoutExtension(path), '^task-', '');
  let agentEnd = getAgentEndIndex(content);
  const hasAgentBlock = agentEnd >= 0;
  if (agentEnd < 0) agentEnd = 0;
  const agentLeft = content.substring(0, Math.min(agentEnd, content.length));
  const trailing = agentEnd < content.length ? content.substring(agentEnd) : '';
  const consent = getConsentFacts(trailing);
  const askVerdict = getBlockingAskVerdict(agentLeft);
  return {
    Id: id,
    Path: path,
    HasAgentBlock: hasAgentBlock,
    FullHash: getSha256(content),
    AgentLeftHash: getSha256(agentLeft),
    HasTrailingUser: testTrailingHasUser(trailing),
    NewestHumanAbove: getNewestDatedHumanAbove(getAboveSentinelRegion(content)),
    HasTrailingHuman: testTrailingHasHuman(trailing, consent),
    HasOpenAsk: testHasOpenAsk(agentLeft),
    HasBlockingAsk: !!askVerdict.blocking,
    AskSource: `${askVerdict.source}`,
    AskDeclared: `${askVerdict.declared}`,
    Consent: consent,
    Trailing: trailing,
    Content: content,
    Legacy: parseLegacyOaState(content),
  };
}
