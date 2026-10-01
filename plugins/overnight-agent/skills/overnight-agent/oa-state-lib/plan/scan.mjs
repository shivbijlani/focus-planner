// scan.mjs -- the scan worklist command and compact projection (oa-state.ps1 Get-ScanRows..Cmd-Scan).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { joinPath, splitParent } from '../core/context.mjs';
import { ensureDir, isFile, readJournalText, testPath, writeAllTextUtf8 } from '../core/fsx.mjs';
import { fromJson, toJson } from '../core/psjson.mjs';
import { PsDate, parseDateTime, parseExactYmd } from '../core/psdate.mjs';
import {
  asArray, ciContains, get, has, lowerInvariant, netTrim, psIsMatch, psMatch, psReplace,
  psSplit, psStr, psTruthy, rx, rxMatches, rxReplace, setMember,
} from '../core/net.mjs';
import { getSha256, getFenceMaskedText, getJournalFacts } from '../collect/journal.mjs';
import { readState, testPollDue } from '../collect/state.mjs';
import { getAgentModelSettings } from '../collect/settings.mjs';
import * as Board from '../collect/board.mjs';
import * as Doc from '../collect/doc.mjs';
import * as Sessions from '../collect/sessions.mjs';
import * as Pause from './pause.mjs';
import { DocObservationFreshMinutes, PausedStatus } from './status.mjs';
import {
  getSessionActivities, getTodayGateVerdict, testReopenedClosed, testUnansweredUser, testWorkable,
} from './workable.mjs';

export const BoardLinkedMinIndex = 5;
export const DocMetaRe = '<!--\\s*doc-meta\\s+docId=(?<id>[A-Za-z0-9_\\-]+)(?:\\s+docUrl=(?<url>\\S+))?\\s*-->';
export const UrgencyRank = {
  [String.fromCodePoint(0x1f534)]: 0,
  [String.fromCodePoint(0x1f7e1)]: 1,
  [String.fromCodePoint(0x1f4d6)]: 2,
  [String.fromCodePoint(0x26aa)]: 3,
};

export function testSnoozeActive(raw) {
  if (!raw) return null;
  const t = netTrim(String(raw));
  const d = parseExactYmd(t);
  if (d && d.date.compare(PsDate.now().date) >= 0) return t;
  return null;
}

export function getSnoozeFromStore(ctx) {
  const map = {};
  if (!testPath(ctx.p.SnoozeStore)) return null;
  let json;
  try {
    const raw = readJournalText(ctx.p.SnoozeStore);
    if (netTrim(raw).length === 0) return map;
    json = fromJson(raw);
  } catch (e) {
    ctx.warn(`oa-state: could not parse ${ctx.p.SnoozeStore} (${e?.message ?? e}); falling back to planner.md markers`);
    return null;
  }
  for (const wrapper of ['tasks', 'snoozed']) {
    if (has(json, wrapper) && psTruthy(get(json, wrapper))) { json = get(json, wrapper); break; }
  }
  for (const [name, propValue] of Object.entries(json ?? {})) {
    if (!/^\d+$/.test(name)) continue;
    let val = propValue;
    if (typeof val !== 'string') val = get(val, 'until');
    const active = testSnoozeActive(String(val ?? ''));
    if (active) map[name] = active;
  }
  return map;
}

export function getBoardRowId(line) {
  const s = String(line ?? '');
  if (!psIsMatch(s, '^\\s*\\|')) return null;
  const first = psSplit(netTrim(netTrim(s), ['|']), '\\|')[0];
  if (first === undefined || first === null) return null;
  const m = psMatch(netTrim(first), '^(\\d+)');
  return m ? m[1] : null;
}

export function getBoardRowLinkedIds(line, linkedIndex = -1) {
  const clean = rxReplace(String(line ?? ''), '<!--.*?-->', '');
  const cells = psSplit(netTrim(netTrim(clean), ['|']), '\\|').map((x) => netTrim(x));
  let last = cells.length - 1;
  while (last >= 0 && netTrim(cells[last]).length === 0) last--;
  if (last < BoardLinkedMinIndex) return [];
  const idx = linkedIndex >= BoardLinkedMinIndex && linkedIndex <= last ? linkedIndex : last;
  const cell = cells[idx];
  if (psIsMatch(cell, '^\\d{4}-\\d{2}-\\d{2}')) return [];
  const ids = [];
  for (const m of rxMatches(cell, '(?<!\\d)\\d{1,6}(?!\\d)')) {
    if (!ids.some((x) => lowerInvariant(x) === lowerInvariant(m[0]))) ids.push(m[0]);
  }
  return ids;
}

export function getSnoozeFromBoard(ctx) {
  const map = {};
  if (!testPath(ctx.p.PlannerBoard)) return map;
  for (const line of psSplit(readJournalText(ctx.p.PlannerBoard), '\\r?\\n')) {
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
    const s = psStr(line);
    if (psIsMatch(s, '^##\\s')) { inSection = psIsMatch(s, '^##\\s*Priorities\\b'); continue; }
    if (!inSection) continue;
    const m = psMatch(s, '^\\s*\\d+\\.\\s+(\\d+)\\s*$');
    if (m) { rank[m[1]] = n; n++; }
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
      const hdr = psSplit(netTrim(netTrim(line), ['|']), '\\|').map((x) => netTrim(x));
      for (let i = 0; i < hdr.length; i++) if (psIsMatch(hdr[i], '^Linked\\s*ID$')) { linkedIdx = i; break; }
    }
    const id = getBoardRowId(line);
    if (!id) continue;
    const cells = psSplit(netTrim(netTrim(line), ['|']), '\\|').map((x) => netTrim(x));
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

export function getCompletedBoardIds(ctx) {
  const ids = {};
  if (!ctx.p.PlannerCompleted || !testPath(ctx.p.PlannerCompleted)) return ids;
  let lines;
  try { lines = psSplit(readJournalText(ctx.p.PlannerCompleted), '\\r?\\n'); } catch { return ids; }
  for (const line of lines) {
    const id = getBoardRowId(line);
    if (id) ids[id] = true;
  }
  return ids;
}

export function getUrgencyRank(icon) {
  const s = String(icon ?? '');
  if (netTrim(s).length === 0) return 4;
  for (const [k, v] of Object.entries(UrgencyRank)) if (s.includes(k)) return v;
  return 4;
}

export function getTodaySectionText(ctx) {
  if (!testPath(ctx.p.PlannerBoard)) return '';
  const lines = psSplit(readJournalText(ctx.p.PlannerBoard), '\\r?\\n');
  let out = '';
  let inToday = false;
  for (const line of lines) {
    if (psIsMatch(line, '^##\\s')) { inToday = psIsMatch(line, '^##\\s*Today\\b'); continue; }
    if (!inToday) continue;
    const t = netTrim(line);
    if (t.length > 0) out += `${t}\n`;
  }
  return out;
}

export function getTodaySectionHash(ctx) { return getSha256(getTodaySectionText(ctx)); }
export function getSectionRank(section) { return lowerInvariant(psStr(section)) === 'today' ? 0 : lowerInvariant(psStr(section)) === 'deferred' ? 1 : 2; }
export function getPriorityRank(wp) {
  const m = psMatch(psStr(wp), '^P([0-9])$');
  return m ? Number(m[1]) : 9;
}

export function getDocMetaFromJournal(pathValue, content = null) {
  let contentValue = content;
  if (contentValue === null || contentValue === undefined || contentValue === '') contentValue = readJournalText(pathValue);
  if (!contentValue) return null;
  const m = rx(getFenceMaskedText(contentValue), DocMetaRe);
  if (!m) return null;
  return { doc_id: m.groups?.id ?? m[1], doc_url: (m.groups?.url ?? '') };
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

export function getDocState(st, pathValue, content = null) {
  const doc = st && has(st, 'doc') ? get(st, 'doc') : null;
  if (doc && psStr(get(doc, 'doc_id'))) return { doc, source: 'state', healed: false };
  const stamp = getDocMetaFromJournal(pathValue, content);
  if (stamp) {
    return { doc: newDocObject(stamp.doc_id, stamp.doc_url, nowIso(), [], [], ''), source: 'journal', healed: true };
  }
  return { doc: null, source: 'none', healed: false };
}

export function getDocChannelState(doc) {
  if (!doc || !psStr(get(doc, 'doc_id'))) return null;
  const observed = psStr(get(doc, 'observed_at'));
  if (!observed) return 'unread';
  let parsed;
  try { parsed = parseDateTime(observed); } catch { return 'unread'; }
  const age = PsDate.now().diffMs(parsed.toLocalTime()) / 60000;
  if (age >= DocObservationFreshMinutes) return 'stale';
  return 'fresh';
}

function nowIso() { return PsDate.now().format('yyyy-MM-ddTHH:mm:ssK'); }

export function convertToIsoText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof PsDate) return value.format('yyyy-MM-ddTHH:mm:ssK');
  const s = psStr(value);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  try { return parseDateTime(s).format('yyyy-MM-ddTHH:mm:ssK'); } catch { return s; }
}

export function getSessionState(st) {
  if (st && has(st, 'session') && get(st, 'session') && psStr(get(get(st, 'session'), 'session_id'))) return get(st, 'session');
  return null;
}

export function getReplacements24h(st) {
  if (!st) return 0;
  let events = [];
  if (has(st, 'session_replacements') && psTruthy(get(st, 'session_replacements'))) events = asArray(get(st, 'session_replacements'));
  else if (get(st, 'session') && psStr(get(get(st, 'session'), 'prior_session_id')) && psStr(get(get(st, 'session'), 'replaced_at'))) {
    events = [{ at: get(get(st, 'session'), 'replaced_at') }];
  }
  const now = Date.now();
  const since = now - 24 * 3600000;
  let count = 0;
  for (const event of events) {
    const ms = instantMs(get(event, 'at'));
    if (ms !== null && ms >= since && ms <= now) count++;
  }
  return count;
}

function instantMs(value) {
  try {
    if (value instanceof PsDate) return value.toUniversalTime().wallMs;
    const d = parseDateTime(psStr(value));
    return d.toUniversalTime().wallMs;
  } catch {
    const n = Date.parse(psStr(value));
    return Number.isNaN(n) ? null : n;
  }
}

export function testSessionProcessDead(ctx, sessionId) {
  try { return !!testSessionProcessDeadCore(ctx, sessionId); } catch { return false; }
}

function validSessionId(sessionId) {
  const sid = psStr(sessionId);
  return !!sid && !/[\\/]/.test(sid) && sid !== '.' && sid !== '..';
}

export function testSessionProcessDeadCore(ctx, sessionId) {
  if (!validSessionId(sessionId)) return false;
  const sessionDir = joinPath(ctx.p.SessionStateDir, psStr(sessionId));
  if (!testPath(sessionDir) || !fs.statSync(sessionDir).isDirectory()) return false;
  const locks = fs.readdirSync(sessionDir).filter((n) => /^inuse\.\d+\.lock$/i.test(n));
  if (locks.length === 0) return false;
  for (const lock of locks) {
    const m = /^inuse\.(\d+)\.lock$/i.exec(lock);
    if (!m) return false;
    const pidValue = Number(m[1]);
    if (!Number.isInteger(pidValue) || pidValue <= 0) return false;
    try { process.kill(pidValue, 0); return false; } catch { /* missing owner is dead evidence */ }
  }
  const eventsPath = joinPath(sessionDir, 'events.jsonl');
  if (!isFile(eventsPath)) return false;
  const stat = fs.statSync(eventsPath);
  if (stat.mtime.getTime() > Date.now() - 15 * 60000) return false;
  const lines = readJournalText(eventsPath).split(/\r?\n/).filter((x) => x.length > 0);
  if (lines.length) {
    try {
      const last = fromJson(lines[lines.length - 1]);
      if (psStr(get(last, 'type')) === 'session.shutdown' && psStr(get(get(last, 'data'), 'shutdownType')) === 'routine') return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function testWorkspaceMissing(workspace, wsType) {
  const p = psStr(workspace);
  if (!p) return false;
  if (wsType && psStr(wsType) !== 'worktree') return false;
  try {
    if (testPath(p)) return false;
    const parsed = path.win32.parse(p.replace(/\//g, '\\'));
    const root = parsed.root || path.parse(p).root;
    if (!root || !testPath(root)) return false;
    return true;
  } catch {
    return false;
  }
}

export function testWorkspaceUsable(workspace, wsType) {
  const p = psStr(workspace);
  if (!p) return true;
  if (wsType && psStr(wsType) !== 'worktree') return true;
  try {
    if (!testPath(p)) return !testWorkspaceMissing(p, wsType);
    if (testPath(joinPath(p, '.git'))) return true;
    return false;
  } catch {
    return true;
  }
}

function getIsoDate(value) {
  if (!psTruthy(value)) return null;
  try { return (value instanceof PsDate ? value : parseDateTime(psStr(value))).toLocalTime(); } catch { return null; }
}

function testResumeIsAfterPause(row, journalFacts) {
  if (!row || !journalFacts) return false;
  const pausedAt = getIsoDate(has(row, 'paused_at') ? get(row, 'paused_at') : null);
  if (!pausedAt) return false;
  const seenAt = getIsoDate(has(row, 'unanswered_user_message_at') ? get(row, 'unanswered_user_message_at') : null);
  if (seenAt && seenAt.compare(pausedAt) > 0) return true;
  try {
    const journalPath = get(journalFacts, 'Path');
    if (journalPath && testPath(journalPath)) {
      const written = PsDate.fromInstant(fs.statSync(journalPath).mtime.getTime(), 'Local');
      if (written.compare(pausedAt) > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function testUserPaused(row, journalFacts) {
  if (!row) return false;
  if (lowerInvariant(psStr(get(row, 'status_by'))) !== 'user') return false;
  if (!ciContains(PausedStatus, lowerInvariant(psStr(get(row, 'status'))))) return false;
  if (journalFacts && get(journalFacts, 'HasTrailingHuman') && testResumeIsAfterPause(row, journalFacts)) return false;
  return true;
}

export function getSessionVerdict(ctx, sess, row, journalFacts, sessionProcessDead = null) {
  if (testUserPaused(row, journalFacts)) return 'paused';
  if (!sess) return 'create';
  if (psStr(get(sess, 'state')) === 'dead') return 'replace';
  let dead = sessionProcessDead;
  if (dead === null || dead === undefined) dead = testSessionProcessDead(ctx, psStr(get(sess, 'session_id')));
  if (dead) return 'replace';
  if (!testWorkspaceUsable(psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type')))) return 'replace';
  return 'reuse';
}

export function getDispatchInput(st, facts) {
  const inputState = {
    journal: psStr(get(facts, 'FullHash')),
    status: psStr(get(st, 'status')),
    status_by: psStr(get(st, 'status_by')),
    plan_id: psStr(get(st, 'plan_id')),
    version: psStr(get(st, 'version')),
    session_id: psStr(get(get(st, 'session'), 'session_id')),
    poll: convertToIsoText(get(get(st, 'poll'), 'next_due')),
    recheck: convertToIsoText(get(get(st, 'recheck'), 'next_due')),
    comments: [...new Set(asArray(get(get(st, 'doc'), 'pending_ids')).map(psStr))].sort(),
  };
  const payload = toJson(inputState, { depth: 4, compress: true }).text;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function getScanRows(ctx) {
  const activities = getSessionActivities(ctx);
  const agentModel = getAgentModelSettings(ctx);
  const snooze = Board.getSnoozeMap(ctx);
  const board = Board.getBoardMap(ctx);
  const completed = Board.getCompletedBoardIds(ctx);
  const boardLines = testPath(ctx.p.PlannerBoard) ? psSplit(readJournalText(ctx.p.PlannerBoard), '\\r?\\n') : [];
  const prioRank = Board.getPrioritiesRank(boardLines);
  const journals = testPath(ctx.p.JournalDir)
    ? fs.readdirSync(ctx.p.JournalDir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^task-.*\.md$/i.test(d.name) && /^task-\d+$/i.test(d.name.replace(/\.md$/i, '')))
      .map((d) => path.join(ctx.p.JournalDir, d.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: 'accent' }))
    : [];
  let rows = [];
  for (const f of journals) {
    const facts = getJournalFacts(f);
    const st = readState(ctx, facts.Id);
    let poll = null;
    let recheck = null;
    let statusBy = 'agent';
    let aboveSentinelReply = false;
    let unansweredAt = null;
    let changed; let reopened; let status;
    if (st) {
      changed = facts.FullHash !== psStr(get(st, 'processed_file_hash'));
      reopened = changed && facts.HasTrailingUser;
      status = psStr(get(st, 'status'));
      if (has(st, 'poll')) poll = get(st, 'poll');
      if (has(st, 'recheck')) recheck = get(st, 'recheck');
      if (has(st, 'status_by') && get(st, 'status_by')) statusBy = lowerInvariant(psStr(get(st, 'status_by')));
      if (has(st, 'unanswered_user_message_at') && get(st, 'unanswered_user_message_at')) unansweredAt = psStr(get(st, 'unanswered_user_message_at'));
      if (facts.NewestHumanAbove) {
        let turnDay = null;
        if (has(st, 'last_turn_at') && get(st, 'last_turn_at')) {
          try { turnDay = parseDateTime(psStr(get(st, 'last_turn_at'))).date; } catch { turnDay = null; }
        }
        if (turnDay && facts.NewestHumanAbove.compare(turnDay) > 0) {
          reopened = true;
          aboveSentinelReply = true;
        }
      }
    } else {
      changed = true;
      reopened = facts.HasTrailingUser;
      status = facts.HasAgentBlock ? 'unknown' : 'none';
    }
    const snoozeUntil = Object.prototype.hasOwnProperty.call(snooze, facts.Id) ? snooze[facts.Id] : null;
    const isSnoozed = !!snoozeUntil;
    const b = board[facts.Id];
    const section = b ? b.section : 'other';
    const urgency = b ? b.urgency : '';
    const workPriority = b ? b.work_priority : null;
    const boardPos = b ? b.board_pos : 999999;
    const boardLinked = b ? asArray(b.linked) : [];
    const pRank = Object.prototype.hasOwnProperty.call(prioRank, facts.Id) ? prioRank[facts.Id] : 999999;
    const docFacts = Doc.getDocState(st, f, facts.Content);
    const sessFacts = Sessions.getSessionState(st);
    const sessionProcessDead = !!Sessions.testSessionProcessDead(ctx, psStr(get(sessFacts, 'session_id')));
    const activity = activities !== null && sessFacts ? psStr(activities[psStr(get(sessFacts, 'session_id'))]) : null;
    rows.push({
      id: facts.Id,
      dispatch_input: Sessions.getDispatchInput(st, facts),
      status,
      changed,
      reopened,
      has_agent_block: facts.HasAgentBlock,
      tracked: !!st,
      snoozed: isSnoozed,
      snooze_until: snoozeUntil,
      section,
      urgency,
      on_board: !!b,
      user_completed: !!completed[facts.Id],
      status_by: statusBy,
      work_priority: workPriority,
      board_pos: boardPos,
      linked: [...boardLinked],
      priorities_rank: pRank,
      due_poll: !!(testPollDue(poll) && !isSnoozed),
      poll_cadence: poll ? psStr(get(poll, 'cadence')) : null,
      due_recheck: !!(testPollDue(recheck) && !isSnoozed),
      recheck_cadence: recheck ? psStr(get(recheck, 'cadence')) : null,
      recheck_kind: recheck ? psStr(get(recheck, 'kind')) : null,
      consent_ok: !!get(facts.Consent, 'consent_ok'),
      consent_reason: psStr(get(facts.Consent, 'reason')),
      has_open_ask: !!facts.HasOpenAsk,
      reopened_closed: false,
      unanswered_user: !!(facts.HasTrailingHuman || aboveSentinelReply),
      unanswered_user_where: facts.HasTrailingHuman ? 'below-turn' : aboveSentinelReply ? 'above-sentinel' : '',
      unanswered_user_at: unansweredAt,
      awaiting_reply: !!(facts.HasAgentBlock && facts.HasBlockingAsk && !facts.HasTrailingUser),
      ask_source: psStr(facts.AskSource),
      ask_declared: psStr(facts.AskDeclared) ? psStr(facts.AskDeclared) : null,
      last_turn_at: st && has(st, 'last_turn_at') ? psStr(get(st, 'last_turn_at')) : null,
      doc_id: get(docFacts, 'doc') ? psStr(get(get(docFacts, 'doc'), 'doc_id')) : null,
      doc_bound: !!(get(docFacts, 'doc') && psStr(get(get(docFacts, 'doc'), 'doc_id'))),
      doc_source: get(docFacts, 'source'),
      doc_new_comments: get(docFacts, 'doc') ? asArray(get(get(docFacts, 'doc'), 'pending_ids')).length : 0,
      doc_observed_at: get(docFacts, 'doc') && psStr(get(get(docFacts, 'doc'), 'observed_at')) ? psStr(get(get(docFacts, 'doc'), 'observed_at')) : null,
      doc_channel: Doc.getDocChannelState(get(docFacts, 'doc')),
      session_id: sessFacts ? psStr(get(sessFacts, 'session_id')) : null,
      session_activity: activity,
      dispatch_skip_reason: activity === 'busy' ? 'busy_from_earlier_run'
        : activities !== null && sessFacts && activity !== 'idle' ? 'session_status_unknown' : null,
      session_state: sessFacts ? psStr(get(sessFacts, 'state')) : null,
      session_verdict: Sessions.getSessionVerdict(ctx, sessFacts, st, facts, sessionProcessDead),
      model: agentModel.model,
      model_source: agentModel.source,
      session_workspace: sessFacts && psStr(get(sessFacts, 'workspace')) ? psStr(get(sessFacts, 'workspace')) : null,
      session_workspace_missing: !!Sessions.testWorkspaceMissing(psStr(get(sessFacts, 'workspace')), psStr(get(sessFacts, 'workspace_type'))),
      session_process_dead: sessionProcessDead,
      replacements_24h: Sessions.getReplacements24h(st),
      session_paused: !!Pause.testUserPaused(st, facts),
      paused_at: st && has(st, 'paused_at') && get(st, 'paused_at') ? psStr(get(st, 'paused_at')) : null,
      exhaustion: st && has(st, 'today_exhausted') ? get(st, 'today_exhausted') : null,
    });
  }

  const seenScanIds = {};
  for (const r of rows) seenScanIds[psStr(r.id)] = true;
  for (const bid of Object.keys(board)) {
    if (Object.prototype.hasOwnProperty.call(seenScanIds, psStr(bid))) continue;
    const b = board[bid];
    const boardState = readState(ctx, bid);
    rows.push({
      id: psStr(bid),
      status: 'none',
      changed: true,
      reopened: false,
      has_agent_block: false,
      has_journal: false,
      tracked: false,
      snoozed: false,
      snooze_until: null,
      section: psStr(b.section),
      urgency: psStr(b.urgency),
      on_board: true,
      user_completed: false,
      status_by: 'agent',
      work_priority: b.work_priority,
      board_pos: get(b, 'pos'),
      linked: asArray(b.linked),
      priorities_rank: {},
      due_poll: false,
      poll_cadence: null,
      unanswered_user: false,
      unanswered_user_where: '',
      session_paused: false,
      replacements_24h: Sessions.getReplacements24h(boardState),
      paused_at: null,
      exhaustion: null,
      no_journal_reason: 'on the board, no journal file yet - create one before working it (#534)',
    });
  }

  for (const r of rows) if (!Object.prototype.hasOwnProperty.call(r, 'has_journal')) setMember(r, 'has_journal', true);
  for (const r of rows) {
    if (!Object.prototype.hasOwnProperty.call(r, 'doc_observed_at')) setMember(r, 'doc_observed_at', null);
    if (!Object.prototype.hasOwnProperty.call(r, 'doc_channel')) setMember(r, 'doc_channel', null);
  }
  for (const r of rows) setMember(r, 'reopened_closed', !!testReopenedClosed(r));

  rows = rows.sort(compareRows);

  const todayHash = Board.getTodaySectionHash(ctx);
  const verdicts = {};
  for (const r of rows) if (r.section === 'today') verdicts[psStr(r.id)] = getTodayGateVerdict(ctx, r, todayHash);
  const todayHolding = Object.values(verdicts).filter((v) => v.holds).length;
  let order = 0;
  for (const r of rows) {
    order++;
    let eligible = false;
    if (!r.snoozed) {
      if (testReopenedClosed(r)) eligible = false;
      else if (r.reopened) eligible = true;
      else if (testUnansweredUser(r)) eligible = true;
      else if (r.section === 'today') eligible = testWorkable(r);
      else if (todayHolding === 0) eligible = testWorkable(r);
    }
    const v = verdicts[psStr(r.id)];
    setMember(r, 'order', order);
    setMember(r, 'eligible', eligible);
    const planReview = !!(r.status === 'proposed' && r.status_by === 'agent'
      && r.on_board && !r.snoozed && !r.session_paused && !r.reopened && !r.unanswered_user
      && (r.section === 'today' || todayHolding === 0));
    setMember(r, 'plan_review_due', planReview);
    setMember(r, 'holds_today_gate', !!(v !== undefined && v !== null && v.holds));
    setMember(r, 'today_release_reason', v !== undefined && v !== null ? psStr(v.reason) : null);
    if (r.section === 'today') {
      setMember(r, 'gate_backstop_hours', Number(ctx.BackstopHours));
      setMember(r, 'gate_strict', !!ctx.GateStrict);
      setMember(r, 'gate_backstop_source', psStr(ctx.BackstopSource));
      setMember(r, 'gate_strict_source', psStr(ctx.GateStrictSource));
    }
  }
  return rows;
}

function scalarRank(x) {
  if (typeof x === 'number') return x;
  if (x === null || x === undefined) return 999999;
  if (typeof x === 'object') return 999999;
  const n = Number(x);
  return Number.isFinite(n) ? n : psStr(x);
}

function compareValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = psStr(a);
  const sb = psStr(b);
  return sa.localeCompare(sb, 'en-US', { sensitivity: 'base' });
}

function compareRows(a, b) {
  const keys = [
    (r) => (r.reopened || testUnansweredUser(r)) ? 0 : 1,
    (r) => getSectionRank(r.section),
    (r) => getPriorityRank(r.work_priority),
    (r) => getUrgencyRank(r.urgency),
    (r) => scalarRank(r.priorities_rank),
    (r) => scalarRank(r.board_pos),
    (r) => Number(psStr(r.id)),
  ];
  for (const fn of keys) {
    const d = compareValue(fn(a), fn(b));
    if (d !== 0) return d;
  }
  return 0;
}

export function cmdScan(ctx) {
  const start = performance.now();
  const rows = getScanRows(ctx);
  const seconds = Math.round(((performance.now() - start) / 1000) * 100) / 100;
  const full = toJson(rows, { depth: 8 }).text;

  if (ctx.p.ScanOutFile) {
    const dir = splitParent(ctx.p.ScanOutFile);
    if (dir && !testPath(dir)) ensureDir(dir);
    const payload = ctx.p.Compact ? toJson(newCompactScan(rows, seconds), { depth: 8 }).text : full;
    writeAllTextUtf8(ctx.p.ScanOutFile, payload);
    ctx.emitJson(newScanSummary(rows, seconds, ctx.p.ScanOutFile), { depth: 4 });
    return;
  }

  if (ctx.p.Compact) { ctx.emitJson(newCompactScan(rows, seconds), { depth: 8 }); return; }
  ctx.out(full);
}

export function newScanSummary(rows, seconds, outFile = '') {
  return {
    scan_seconds: seconds,
    rows_total: asArray(rows).length,
    rows_eligible: asArray(rows).filter((r) => r.eligible).length,
    rows_reopened: asArray(rows).filter((r) => r.reopened).length,
    rows_unanswered: asArray(rows).filter((r) => r.unanswered_user).length,
    rows_due_poll: asArray(rows).filter((r) => r.due_poll).length,
    rows_no_journal: asArray(rows).filter((r) => !r.has_journal).length,
    today_holding: asArray(rows).filter((r) => r.holds_today_gate).length,
    out_file: outFile ? outFile : null,
  };
}

export const CompactFields = [
  'id', 'order', 'eligible', 'section', 'status', 'status_by', 'changed', 'reopened',
  'reopened_closed', 'unanswered_user', 'unanswered_user_where', 'snoozed', 'snooze_until',
  'due_poll', 'poll_cadence', 'due_recheck', 'recheck_kind', 'has_journal', 'has_agent_block',
  'tracked', 'work_priority', 'urgency', 'board_pos', 'priorities_rank', 'linked',
  'holds_today_gate', 'today_release_reason', 'has_open_ask', 'awaiting_reply', 'consent_ok',
  'doc_id', 'doc_new_comments', 'doc_channel', 'session_id', 'session_verdict', 'session_paused',
  'session_activity', 'dispatch_skip_reason',
  'session_process_dead', 'replacements_24h',
  'session_workspace_missing',
  'plan_review_due', 'dispatch_input', 'no_journal_reason',
];

export function testCompactRowNeeded(r) {
  if (r.eligible) return true;
  if (r.dispatch_skip_reason) return true;
  if (r.plan_review_due) return true;
  if (r.holds_today_gate) return true;
  if (r.reopened_closed) return true;
  if (r.unanswered_user) return true;
  if ((Number(r.replacements_24h) || 0) > 0) return true;
  if (r.due_poll || r.due_recheck) return true;
  if (Object.prototype.hasOwnProperty.call(r, 'has_journal') && !r.has_journal) return true;
  return false;
}

export function newCompactScan(rows, seconds) {
  const kept = [];
  for (const r of asArray(rows)) {
    if (!testCompactRowNeeded(r)) continue;
    const o = {};
    for (const f of CompactFields) {
      if (Object.prototype.hasOwnProperty.call(r, f)) o[f] = r[f];
    }
    kept.push(o);
  }
  const summary = newScanSummary(rows, seconds, null);
  summary.rows_returned = kept.length;
  summary.rows_omitted = asArray(rows).length - kept.length;
  summary.omitted_reason = 'ineligible, not holding the Today gate, quiet, and nothing due - use -OutFile for the full worklist';
  return { summary, rows: kept };
}
