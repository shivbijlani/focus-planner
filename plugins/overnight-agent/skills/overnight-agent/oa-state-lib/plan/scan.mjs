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
    (r) => Board.getSectionRank(r.section),
    (r) => Board.getPriorityRank(r.work_priority),
    (r) => Board.getUrgencyRank(r.urgency),
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
