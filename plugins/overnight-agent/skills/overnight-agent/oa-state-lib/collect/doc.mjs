// doc.mjs -- catch-up-doc binding helpers (oa-state.ps1 doc helpers).
import fs from 'node:fs';
import { readJournalText, testPath, writeAllTextUtf8 } from '../core/fsx.mjs';
import { asArray, get, has, isNullOrWhiteSpace, psStr, psIsMatch, psMatch, psSplit, rx, rxMatches, rxTest, netTrimEnd } from '../core/net.mjs';
import { fromJson } from '../core/psjson.mjs';
import { nowIso } from './state.mjs';
import { getFenceMaskedText } from './journal.mjs';
import { parseDateTime, PsDate } from '../core/psdate.mjs';
import { DocObservationFreshMinutes } from '../plan/status.mjs';

export const DocMetaRe = '<!--\\s*doc-meta\\s+docId=(?<id>[A-Za-z0-9_\\-]+)(?:\\s+docUrl=(?<url>\\S+))?\\s*-->';
export function getDocMetaFromJournal(path, content = null) {
  let text = content;
  if (text === null || text === undefined || text === '') text = readJournalText(path);
  if (!text) return null;
  const m = rx(getFenceMaskedText(text), DocMetaRe);
  if (!m) return null;
  return { doc_id: m.groups.id, doc_url: m.groups.url !== undefined ? m.groups.url : '' };
}

export function addDocMetaStamp(path, docId, docUrl) {
  let content = readJournalText(path);
  if (content === null || content === undefined) content = '';
  const existing = getDocMetaFromJournal(path);
  if (existing) return false;
  const stamp = docUrl ? `<!-- doc-meta docId=${docId} docUrl=${docUrl} -->` : `<!-- doc-meta docId=${docId} -->`;
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  if (content.length === 0) { writeAllTextUtf8(path, stamp + nl); return true; }
  const lines = psSplit(content, '\\r?\\n');
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (psIsMatch(lines[i], '<!--\\s*tg-meta\\b')) { at = i + 1; break; }
  if (at < 0) for (let i = 0; i < lines.length; i++) if (psIsMatch(lines[i], '^#\\s')) { at = i + 1; break; }
  if (at < 0) at = 0;
  const out = [];
  if (at > 0) out.push(...lines.slice(0, at));
  out.push(stamp);
  if (at < lines.length) out.push(...lines.slice(at));
  writeAllTextUtf8(path, out.join(nl));
  return true;
}

function parseDumpComments(src) {
  const acc = [];
  let cur = null;
  for (const ln of psSplit(src, '\\r?\\n')) {
    const m = rx(ln, '^\\s*(?:Comment|Reply)\\s+ID:\\s*(\\S+?)\\s*$');
    if (m) {
      if (cur) acc.push(cur);
      cur = { id: m[1], created: '' };
      continue;
    }
    if (cur) {
      const c = rx(ln, '^\\s*Created:\\s*(.+?)\\s*$');
      if (c && !cur.created) cur.created = c[1];
    }
  }
  if (cur) acc.push(cur);
  return acc;
}

export function readObservedComments(path) {
  if (!testPath(path)) throw new Error(`no such observation file: ${path}`);
  const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  let rows = [];
  const trimmed = text.trim();
  let dumpText = text;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = fromJson(trimmed);
      for (const e of asArray(parsed)) {
        const eid = has(e, 'id') ? psStr(get(e, 'id')) : '';
        if (!eid) continue;
        rows.push({ id: eid, created: has(e, 'created') ? psStr(get(e, 'created')) : '' });
      }
      if (rows.length > 0) return rows;
      const payload = [];
      if (parsed && has(parsed, 'content')) {
        for (const c of asArray(get(parsed, 'content'))) if (c && has(c, 'text') && psStr(get(c, 'text'))) payload.push(psStr(get(c, 'text')));
      }
      if (parsed && has(parsed, 'structuredContent')) {
        const sc = get(parsed, 'structuredContent');
        if (sc && has(sc, 'result') && psStr(get(sc, 'result'))) payload.push(psStr(get(sc, 'result')));
      }
      if (payload.length > 0) dumpText = payload.join('\n');
    } catch {
      // Fall through to dump parser.
    }
  }
  rows = parseDumpComments(dumpText);
  if (rows.length === 0 && psIsMatch(dumpText, 'Comment ID:')) {
    rows = parseDumpComments(dumpText.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n'));
  }
  const seen = new Set();
  return rows.filter((r) => {
    if (!r || !psStr(r.id)) return false;
    const id = psStr(r.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function testObservationReadable(text) {
  const s = psStr(text);
  if (rxTest(s, '(?i)Found\\s+\\d+\\s+comments?\\b')) return true;
  if (rxTest(s, '(?i)No\\s+comments\\s+found\\b')) return true;
  if (rxTest(s, '(?im)(?:Comment|Reply)\\s+ID:\\s*\\S')) return true;
  const trimmed = s.trim();
  if (trimmed === '[]') return true;
  if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && rxTest(trimmed, '"id"\\s*:\\s*"[^"]')) return true;
  return false;
}

export function newDocObject(docId, docUrl, boundAt, seen, pending, observedAt) {
  return {
    doc_id: docId,
    doc_url: docUrl,
    bound_at: boundAt,
    seen_ids: asArray(seen).filter((x) => psStr(x) !== ''),
    pending_ids: asArray(pending).filter((x) => psStr(x) !== ''),
    observed_at: observedAt,
  };
}

export function getDocState(st, path, content = null) {
  const doc = st && has(st, 'doc') ? get(st, 'doc') : null;
  if (doc && psStr(get(doc, 'doc_id'))) return { doc, source: 'state', healed: false };
  const stamp = getDocMetaFromJournal(path, content);
  if (stamp) {
    return { doc: newDocObject(stamp.doc_id, stamp.doc_url, nowIso(), [], [], ''), source: 'journal', healed: true };
  }
  return { doc: null, source: 'none', healed: false };
}

export function getDocChannelState(doc) {
  if (!doc || !psStr(get(doc, 'doc_id'))) return null;
  const raw = get(doc, 'observed_at');
  if (raw === null || raw === undefined || !psStr(raw)) return 'unread';
  // #808 (oa-state.ps1 Get-DocChannelState): use the parsed value by its kind -- never its text,
  // which drops the offset and was then shifted again by the host's UTC offset.
  let parsed;
  if (raw instanceof PsDate) parsed = raw;
  else { try { parsed = parseDateTime(String(raw)); } catch { return 'unread'; } }
  const age = (Date.now() - parsed.instantMs()) / 60000;
  if (age >= DocObservationFreshMinutes) return 'stale';
  return 'fresh';
}
