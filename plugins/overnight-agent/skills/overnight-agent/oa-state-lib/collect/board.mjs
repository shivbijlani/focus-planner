// board.mjs -- planner.md board readers (oa-state.ps1 THE BOARD).
import crypto from 'node:crypto';
import os from 'node:os';
import { readAllText, readJournalText, testPath } from '../core/fsx.mjs';
import { fromJson } from '../core/psjson.mjs';
import { asArray, get, isNullOrWhiteSpace, psIsMatch, psMatch, psSplit, rxMatches, rxReplace, psStr, lowerInvariant } from '../core/net.mjs';
import { parseExactYmd, PsDate } from '../core/psdate.mjs';

export function testSnoozeActive(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const d = parseExactYmd(s);
  if (d && d.date.compare(PsDate.now().date) >= 0) return s;
  return null;
}

export function getSnoozeFromStore(ctx) {
  const map = {};
  if (!testPath(ctx.p.SnoozeStore)) return null;
  let json;
  try {
    const raw = readAllText(ctx.p.SnoozeStore);
    if (isNullOrWhiteSpace(raw)) return map;
    json = fromJson(raw);
  } catch (e) {
    ctx.warn(`oa-state: could not parse ${ctx.p.SnoozeStore} (${e?.message ?? String(e)}); falling back to planner.md markers`);
    return null;
  }
  for (const wrapper of ['tasks', 'snoozed']) {
    const v = get(json, wrapper);
    if (v) { json = v; break; }
  }
  if (!json || typeof json !== 'object') return map;
  for (const [name, rawVal] of Object.entries(json)) {
    if (!/^\d+$/.test(name)) continue;
    let val = rawVal;
    if (typeof val !== 'string') val = get(val, 'until');
    const active = testSnoozeActive(String(val ?? ''));
    if (active) map[name] = active;
  }
  return map;
}

export function getBoardRowId(line) {
  const s = String(line ?? '');
  if (!psIsMatch(s, '^\\s*\\|')) return null;
  const first = asArray(psSplit(s.trim().replace(/^\|+|\|+$/g, ''), '\\|'))[0];
  if (first === undefined || first === null) return null;
  const m = psMatch(String(first).trim(), '^(\\d+)');
  return m ? m[1] : null;
}

export const BoardLinkedMinIndex = 5;

export function getBoardRowLinkedIds(line, linkedIndex = -1) {
  const clean = rxReplace(String(line ?? ''), '<!--.*?-->', '');
  const cells = psSplit(clean.trim().replace(/^\|+|\|+$/g, ''), '\\|').map((x) => String(x).trim());
  let last = cells.length - 1;
  while (last >= 0 && isNullOrWhiteSpace(cells[last])) last--;
  if (last < BoardLinkedMinIndex) return [];
  const idx = linkedIndex >= BoardLinkedMinIndex && linkedIndex <= last ? linkedIndex : last;
  const cell = cells[idx] ?? '';
  if (psIsMatch(cell, '^\\d{4}-\\d{2}-\\d{2}')) return [];
  const ids = [];
  for (const m of rxMatches(cell, '(?<!\\d)\\d{1,6}(?!\\d)')) {
    if (!ids.some((x) => x.toLowerCase() === m[0].toLowerCase())) ids.push(m[0]);
  }
  return ids;
}

export function getSnoozeFromBoard(ctx) {
  const map = {};
  if (!testPath(ctx.p.PlannerBoard)) return map;
  for (const line of psSplit(readAllText(ctx.p.PlannerBoard), '\\r?\\n')) {
    const tid = getBoardRowId(line);
    if (!tid) continue;
    const m = psMatch(line, '<!--\\s*snooze:(\\d{4}-\\d{2}-\\d{2})\\s*-->');
    if (m) {
      const active = testSnoozeActive(m[1]);
      if (active) map[tid] = active;
    }
  }
  return map;
}

export function getSnoozeMap(ctx) {
  const board = getSnoozeFromBoard(ctx);
  const store = getSnoozeFromStore(ctx);
  if (store === null) return board;
  return { ...board, ...store };
}

export function getPrioritiesRank(lines) {
  const rank = {};
  let inSection = false;
  let n = 0;
  for (const line of asArray(lines)) {
    if (psIsMatch(line, '^##\\s')) { inSection = psIsMatch(line, '^##\\s*Priorities\\b'); continue; }
    if (!inSection) continue;
    const m = psMatch(line, '^\\s*\\d+\\.\\s+(\\d+)\\s*$');
    if (m) rank[m[1]] = n++;
  }
  return rank;
}

export function getBoardMap(ctx) {
  const map = {};
  if (!testPath(ctx.p.PlannerBoard)) return map;
  const lines = psSplit(readJournalText(ctx.p.PlannerBoard), '\\r?\\n');
  let section = 'other';
  let pos = 0;
  let linkedIdx = -1;
  for (const line of lines) {
    if (psIsMatch(line, '^##\\s*Today\\b')) { section = 'today'; linkedIdx = -1; continue; }
    if (psIsMatch(line, '^##\\s*Deferred\\b')) { section = 'deferred'; linkedIdx = -1; continue; }
    if (psIsMatch(line, '^##\\s')) { section = 'other'; linkedIdx = -1; continue; }
    if (psIsMatch(line, '^\\s*\\|') && psIsMatch(line, '\\bLinked\\s*ID\\b')) {
      const hdr = psSplit(String(line).trim().replace(/^\|+|\|+$/g, ''), '\\|').map((x) => String(x).trim());
      for (let i = 0; i < hdr.length; i++) if (psIsMatch(hdr[i], '^Linked\\s*ID$')) { linkedIdx = i; break; }
    }
    const id = getBoardRowId(line);
    if (!id) continue;
    const cells = psSplit(String(line).trim().replace(/^\|+|\|+$/g, ''), '\\|').map((x) => String(x).trim());
    const wpMatch = cells.length >= 4 ? psMatch(cells[3], '^(P[0-9])$') : null;
    pos++;
    map[id] = {
      section,
      urgency: cells.length >= 2 ? cells[1] : '',
      work_priority: wpMatch ? wpMatch[1] : null,
      board_pos: pos,
      linked: getBoardRowLinkedIds(line, linkedIdx),
    };
  }
  return map;
}

export function getBoardLinkFacts(ctx, id) {
  const facts = { Read: false, RowFound: false, Ids: [], Note: '', Path: psStr(ctx.p.PlannerBoard) };
  if (isNullOrWhiteSpace(ctx.p.PlannerBoard)) {
    facts.Note = 'no planner board path configured';
    return facts;
  }
  if (!testPath(ctx.p.PlannerBoard)) {
    facts.Note = `no board file at ${ctx.p.PlannerBoard}`;
    return facts;
  }
  let map;
  try { map = getBoardMap(ctx); } catch (e) {
    facts.Note = `board unreadable: ${e?.message ?? String(e)}`;
    return facts;
  }
  facts.Read = true;
  const row = map[String(id)];
  if (!row) {
    facts.Note = `no board row for task ${id}`;
    return facts;
  }
  facts.RowFound = true;
  facts.Ids = [...(row.linked ?? [])];
  return facts;
}

export const UrgencyRank = {
  [String.fromCodePoint(0x1F534)]: 0,
  [String.fromCodePoint(0x1F7E1)]: 1,
  [String.fromCodePoint(0x1F4D6)]: 2,
  [String.fromCodePoint(0x26AA)]: 3,
};

export function getCompletedBoardIds(ctx) {
  const ids = {};
  if (isNullOrWhiteSpace(ctx.p.PlannerCompleted)) return ids;
  if (!testPath(ctx.p.PlannerCompleted)) return ids;
  let lines = [];
  try { lines = psSplit(readJournalText(ctx.p.PlannerCompleted), '\\r?\\n'); } catch { return ids; }
  for (const line of lines) {
    const id = getBoardRowId(line);
    if (id) ids[id] = true;
  }
  return ids;
}

export function getUrgencyRank(icon) {
  if (isNullOrWhiteSpace(icon)) return 4;
  const s = String(icon);
  for (const [k, v] of Object.entries(UrgencyRank)) if (s.includes(k)) return v;
  return 4;
}

export function getTodaySectionText(ctx) {
  if (!testPath(ctx.p.PlannerBoard)) return '';
  const lines = psSplit(readJournalText(ctx.p.PlannerBoard), '\\r?\\n');
  const out = [];
  let inToday = false;
  for (const line of lines) {
    if (psIsMatch(line, '^##\\s')) { inToday = psIsMatch(line, '^##\\s*Today\\b'); continue; }
    if (!inToday) continue;
    const t = String(line).trim();
    if (t.length > 0) out.push(t);
  }
  return out.length ? `${out.join(os.EOL)}${os.EOL}` : '';
}

// Private copy of Get-Sha256 (CRLF->LF, UTF-8, lowercase hex) to avoid depending on collect/journal.mjs.
function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function getTodaySectionHash(ctx) { return sha256(getTodaySectionText(ctx)); }

export function getSectionRank(section) {
  const s = lowerInvariant(String(section ?? ''));
  if (s === 'today') return 0;
  if (s === 'deferred') return 1;
  return 2;
}

export function getPriorityRank(wp) {
  const m = psMatch(wp, '^P([0-9])$');
  return m ? Number(m[1]) : 9;
}
