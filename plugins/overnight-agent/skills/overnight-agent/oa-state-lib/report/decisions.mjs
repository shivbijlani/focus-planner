// decisions.mjs -- durable coordinator dispatch decision records (#561).
import fs from 'node:fs';
import path from 'node:path';
import { fromJson, toJson, truncationWarning } from '../core/psjson.mjs';
import { asArray, get, has, netTrim, psStr, psTruthy, toInt, lowerInvariant } from '../core/net.mjs';
import { readAllText, testPath, ensureDir, writeAllTextUtf8 } from '../core/fsx.mjs';
import { PsDate, localOffsetMinutesAtWall } from '../core/psdate.mjs';

export const DecisionOutcomeWords = ['dispatched', 'paused', 'cutoff', 'capacity', 'refused', 'failed_send', 'busy_from_earlier_run'];
const INT_MAX = 2147483647;

function parseOffsetStamp(value) {
  if (value instanceof PsDate) return { utcMs: value.toUniversalTime().wallMs };
  const s = psStr(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
    const fracMs = Number((m[7] || '').padEnd(3, '0').slice(0, 3) || 0);
    const wall = Date.UTC(y, mo - 1, d, h, mi, se, fracMs);
    if (!m[8]) return { utcMs: wall - localOffsetMinutesAtWall(wall) * 60000 };
    if (m[8] === 'Z') return { utcMs: wall };
    const om = /^([+-])(\d{2}):?(\d{2})$/.exec(m[8]);
    const off = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]));
    return { utcMs: wall - off * 60000 };
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const [mo, d, y, h, mi, se] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi, se, 0);
    return { utcMs: wall - localOffsetMinutesAtWall(wall) * 60000 };
  }
  return null;
}

function formatUtcO(utcMs) {
  const d = new Date(utcMs);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}0000Z`;
}

export function getDecisionNow(ctx) {
  if (!ctx.p.DecisionNow) return { utcMs: Date.now() };
  const parsed = parseOffsetStamp(ctx.p.DecisionNow);
  if (!parsed) throw new Error(`decisions_now_invalid: -DecisionNow must be an ISO timestamp, got '${ctx.p.DecisionNow}'`);
  return parsed;
}

export function convertToDecisionStamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'utcMs')) return formatUtcO(value.utcMs);
  const parsed = parseOffsetStamp(value);
  if (!parsed) return psStr(value);
  return formatUtcO(parsed.utcMs);
}

export function getDecisionOutcomeMap(ctx) {
  const map = new Map();
  if (!ctx.p.Outcomes) return map;
  const raw = testPath(ctx.p.Outcomes) ? readAllText(ctx.p.Outcomes) : ctx.p.Outcomes;
  let parsed;
  try { parsed = fromJson(raw); } catch { throw new Error('decisions_outcomes_json: -Outcomes must be a JSON array, or a file holding one'); }
  for (const o of asArray(parsed)) {
    const id = psStr(get(o, 'id'));
    if (!id) throw new Error('decisions_outcome_id: every outcome must name a row id');
    const word = psStr(get(o, 'outcome'));
    if (!DecisionOutcomeWords.some((x) => x.toLowerCase() === word.toLowerCase())) {
      throw new Error(`decisions_outcome_word: '${word}' is not one of ${DecisionOutcomeWords.join(', ')}`);
    }
    map.set(id, o);
  }
  return map;
}

export function convertToDecisionWord(text) {
  let word = lowerInvariant(netTrim(psStr(text))).replace(/[^a-z0-9:_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!word) word = 'unknown';
  if (word.length > 40) word = word.slice(0, 40);
  return word;
}

export function getDecisionReason(row, outcomes) {
  const id = psStr(get(row, 'id'));
  if (outcomes.has(id)) return psStr(get(outcomes.get(id), 'outcome'));
  if (psTruthy(get(row, 'eligible')) && has(row, 'dispatch_skip_reason') && psStr(get(row, 'dispatch_skip_reason'))) {
    return psStr(get(row, 'dispatch_skip_reason'));
  }
  if (!psTruthy(get(row, 'eligible'))) {
    let cause = '';
    for (const field of ['today_release_reason', 'no_journal_reason', 'status']) {
      if (has(row, field) && psStr(get(row, field))) { cause = psStr(get(row, field)); break; }
    }
    if (!cause) cause = 'unknown';
    return `ineligible:${convertToDecisionWord(cause)}`;
  }
  return 'not_dispatched';
}

export function limitRunLedger(pathName, now, retainDays) {
  if (retainDays <= 0) return;
  if (!testPath(pathName)) return;
  const cutoff = now.utcMs - retainDays * 86400000;
  const lines = readAllText(pathName).split(/\r?\n/).filter((x) => x.trim());
  const kept = [];
  for (const line of lines) {
    let stamp = null;
    try {
      const entry = fromJson(line);
      for (const field of ['startedAt', 'at']) {
        if (has(entry, field) && psStr(get(entry, field))) { stamp = psStr(get(entry, field)); break; }
      }
    } catch { stamp = null; }
    const when = stamp ? parseOffsetStamp(stamp) : null;
    if (when && when.utcMs < cutoff) continue;
    kept.push(line);
  }
  if (kept.length === lines.length) return;
  writeAllTextUtf8(pathName, `${kept.join('\n')}\n`);
}

export function cmdDecisions(ctx) {
  if (!ctx.p.RunId) throw new Error('decisions requires -RunId');
  if (!ctx.p.ScanFile) throw new Error('decisions requires -ScanFile (the `scan -Compact` output)');
  if (!testPath(ctx.p.ScanFile)) throw new Error(`decisions_scan_missing: ${ctx.p.ScanFile}`);
  const scan = fromJson(readAllText(ctx.p.ScanFile));
  if (!(has(scan, 'summary') && has(scan, 'rows'))) {
    throw new Error('decisions_requires_compact_scan: pass the output of `scan -Compact`, which carries summary + rows');
  }
  const now = getDecisionNow(ctx);
  const outcomes = getDecisionOutcomeMap(ctx);
  const scanRows = asArray(get(scan, 'rows'));
  const seen = new Set();
  const candidates = [];
  for (const r of scanRows) {
    const id = psStr(get(r, 'id'));
    const sectionLower = lowerInvariant(psStr(get(r, 'section')));
    if (!(outcomes.has(id) || psTruthy(get(r, 'eligible')) || sectionLower === 'today')) continue;
    seen.add(id);
    candidates.push({
      id,
      order: get(r, 'order') !== null && get(r, 'order') !== undefined ? toInt(get(r, 'order')) : INT_MAX,
      section: psStr(get(r, 'section')),
      eligible: psTruthy(get(r, 'eligible')),
      reason: getDecisionReason(r, outcomes),
      today: sectionLower === 'today',
    });
  }
  for (const id of outcomes.keys()) {
    if (seen.has(id)) continue;
    candidates.push({ id: psStr(id), order: INT_MAX, section: 'unlisted', eligible: false, reason: psStr(get(outcomes.get(id), 'outcome')), today: false });
  }
  const ordered = [...candidates].sort((a, b) => (a.order - b.order) || a.id.padStart(10, ' ').localeCompare(b.id.padStart(10, ' '), 'en-US', { sensitivity: 'base' }));
  const must = ordered.filter((r) => r.today || outcomes.has(r.id));
  const rest = ordered.filter((r) => !(r.today || outcomes.has(r.id)));
  const room = Math.max(0, ctx.p.MaxDecisionRows - must.length);
  const keptIds = new Set([...must, ...rest.slice(0, room)].map((r) => r.id));
  const kept = ordered.filter((r) => keptIds.has(r.id)).map((r) => ({
    id: r.id,
    order: r.order === INT_MAX ? null : r.order,
    section: r.section,
    eligible: r.eligible,
    reason: r.reason,
  }));
  const dispatched = [];
  for (const r of kept) {
    if (r.reason !== 'dispatched') continue;
    const o = outcomes.get(r.id);
    let stamp = null;
    if (has(o, 'at') && psStr(get(o, 'at'))) stamp = convertToDecisionStamp(get(o, 'at'));
    dispatched.push({
      id: r.id,
      at: stamp || convertToDecisionStamp(now),
      sessionId: has(o, 'sessionId') ? psStr(get(o, 'sessionId')) : null,
    });
  }
  const s = get(scan, 'summary');
  const record = {
    schema: 'oa-decisions/1',
    kind: 'decision',
    runId: ctx.p.RunId,
    at: convertToDecisionStamp(now),
    summary: {
      scan_seconds: get(s, 'scan_seconds'),
      rows_total: get(s, 'rows_total'),
      rows_eligible: get(s, 'rows_eligible'),
      rows_returned: get(s, 'rows_returned'),
      rows_omitted: get(s, 'rows_omitted'),
      today_holding: get(s, 'today_holding'),
      rows_recorded: kept.length,
      rows_dropped: ordered.length - kept.length,
    },
    rows: kept,
    dispatched,
  };
  const json = toJson(record, { depth: 6, compress: true });
  if (json.truncated) ctx.out(truncationWarning(json.depth));
  const dir = path.dirname(ctx.p.RunLedger);
  if (dir) ensureDir(dir);
  fs.appendFileSync(ctx.p.RunLedger, `${json.text}\n`, 'utf8');
  limitRunLedger(ctx.p.RunLedger, now, ctx.p.RetainDays);
  ctx.out(json.text);
}
