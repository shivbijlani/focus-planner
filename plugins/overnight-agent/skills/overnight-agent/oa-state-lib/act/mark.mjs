// mark.mjs -- Add-TurnTerminator, Set-ExhaustionDeclaration, Cmd-Mark.
import { joinPath } from '../core/context.mjs';
import { readJournalText, testPath, writeAllTextUtf8 } from '../core/fsx.mjs';
import { ciEq, get, has, psStr, psTruthy, setMember, toInt, netTrim, psSplit, lowerInvariant } from '../core/net.mjs';
import { PsDate, parseDateTime, tryParseDateTime } from '../core/psdate.mjs';
import { getAgentEndIndex, getFenceMaskedText, getJournalFacts, TurnEndMarker, TurnEndRe } from '../collect/journal.mjs';
import { newPollObject, newRecheckObject, nowIso, parsePollMinutes, readState, writeState } from '../collect/state.mjs';
import { getTodaySectionHash } from '../collect/board.mjs';
import { testUserPaused } from '../plan/pause.mjs';

export function addTurnTerminator(path) {
  let content = readJournalText(path);
  if (content === null || content === undefined) content = '';
  if (content.length === 0) return false;
  const agentEnd = getAgentEndIndex(content);
  if (agentEnd < 0) return false;
  if (agentEnd < content.length) return false;
  const scan = getFenceMaskedText(content);
  const matches = [...(scan.matchAll(new RegExp(TurnEndRe.replace(/^\(\?m\)/, ''), 'gm')))];
  // The real matcher above is JS-native only for speed on this simple literal-ish line; fall back
  // to the canonical .NET translator when native disagrees is unnecessary because TurnEndRe is simple.
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    if (content.substring(last.index).trim() === TurnEndMarker) return false;
  }
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  const out = content.trimEnd() + nl + nl + TurnEndMarker + nl;
  writeAllTextUtf8(path, out);
  return true;
}

function parseDateOrNull(value) {
  if (!psTruthy(value)) return null;
  try { return parseDateTime(psStr(value)); } catch { return null; }
}

function pausedError(ctx, st) {
  return 'task_paused_by_user: task ' + ctx.p.Id + ' was paused by the user' +
    (has(st, 'paused_at') && psTruthy(get(st, 'paused_at')) ? ` at ${psStr(get(st, 'paused_at'))}` : '') +
    ` (status ${psStr(get(st, 'status'))}, status_by user), and the agent may not change its status out of that. ` +
    'Only he clears a pause: either he replies in the journal below the newest turn, or a run ' +
    'records his decision with `-StatusBy user`. Marking it as the agent would erase the ' +
    'instruction as a side effect of reporting work he asked you to stop (#540).';
}

const approvedWorkStatuses = ['in-progress', 'done', 'blocked'];
const userPauseStatuses = ['proposed', 'blocked'];
const approvedWorkStatuses = ['in-progress', 'done', 'blocked'];

function taskSessionOwnsStatusChange(ctx, st) {
  const caller = ctx.p.TurnBy || process.env.COPILOT_AGENT_SESSION_ID || '';
  if (!caller || !st || !has(st, 'session') || !psTruthy(get(st, 'session'))) return false;
  const sess = get(st, 'session');
  const ids = [];
  for (const key of ['session_id', 'prior_session_id']) {
    const v = get(sess, key);
    if (psTruthy(v)) ids.push(psStr(v));
  }
  const prior = get(sess, 'prior_session_ids');
  const arr = Array.isArray(prior) ? prior : (prior === undefined || prior === null ? [] : [prior]);
  for (const v of arr) if (psTruthy(v)) ids.push(psStr(v));
  return ids.some((sid) => ciEq(sid, caller));
}

function approvedWorkMarkError(ctx, st) {
  const caller = ctx.p.TurnBy || process.env.COPILOT_AGENT_SESSION_ID || 'unknown';
  const sess = st && has(st, 'session') && psTruthy(get(st, 'session')) ? get(st, 'session') : null;
  const bound = sess && psTruthy(get(sess, 'session_id')) ? psStr(get(sess, 'session_id')) : 'no bound task session';
  return `approved_task_status_owned_by_task_session: task ${ctx.p.Id} has a pending human approval, ` +
    `but caller '${caller}' is not the bound task session (${bound}). The coordinator must dispatch it ` +
    `with \`oa-state.ps1 session -Id ${ctx.p.Id} -ForDispatch ...\`; the task session owns approved work ` +
    'status changes (in-progress/done/blocked). Unknown callers fail closed.';
}

function taskSessionOwnsStatusChange(ctx, st) {
  const caller = ctx.p.TurnBy || process.env.COPILOT_AGENT_SESSION_ID || '';
  if (!caller || !st || !has(st, 'session') || !psTruthy(get(st, 'session'))) return false;
  const sess = get(st, 'session');
  const ids = [];
  for (const key of ['session_id', 'prior_session_id']) {
    const v = get(sess, key);
    if (psTruthy(v)) ids.push(psStr(v));
  }
  const prior = get(sess, 'prior_session_ids');
  const arr = Array.isArray(prior) ? prior : (prior === undefined || prior === null ? [] : [prior]);
  for (const v of arr) if (psTruthy(v)) ids.push(psStr(v));
  return ids.some((sid) => ciEq(sid, caller));
}

function approvedWorkMarkError(ctx, st) {
  const caller = ctx.p.TurnBy || process.env.COPILOT_AGENT_SESSION_ID || 'unknown';
  const sess = st && has(st, 'session') && psTruthy(get(st, 'session')) ? get(st, 'session') : null;
  const bound = sess && psTruthy(get(sess, 'session_id')) ? psStr(get(sess, 'session_id')) : 'no bound task session';
  return `approved_task_status_owned_by_task_session: task ${ctx.p.Id} has a pending human approval, ` +
    `but caller '${caller}' is not the bound task session (${bound}). The coordinator must dispatch it ` +
    `with \`oa-state.ps1 session -Id ${ctx.p.Id} -ForDispatch ...\`; the task session owns approved work ` +
    'status changes (in-progress/done/blocked). Unknown callers fail closed.';
}

export function setExhaustionDeclaration(ctx) {
  let st = readState(ctx, ctx.p.Id);
  if (ctx.p.ExhaustionClear) {
    if (!st) throw new Error(`task ${ctx.p.Id} has no state to clear`);
    setMember(st, 'today_exhausted', null);
    st.updated = nowIso();
    writeState(ctx, st);
    ctx.emitJson(st, { depth: 6 });
    return;
  }
  if (ctx.p.Status || ctx.p.Version > 0 || ctx.p.PlanId || ctx.p.Poll || ctx.p.PollDone || ctx.p.PollClear ||
      ctx.p.Recheck || ctx.p.RecheckKind || ctx.p.RecheckDone || ctx.p.RecheckClear) {
    throw new Error('-Exhausted is a separate declaration and cannot be combined with -Status/-Version/-PlanId or any timer flag: write the turn first, then declare exhaustion in its own call');
  }
  if (ctx.p.ExhaustionTtlMinutes <= 0) throw new Error(`-Exhausted is disabled (-ExhaustionTtlMinutes is ${ctx.p.ExhaustionTtlMinutes})`);
  const examined = psSplit(ctx.p.Exhausted, '[,;\r\n\t ]+').map((x) => netTrim(x)).filter((x) => x.length > 0);
  if (examined.length === 0) throw new Error("-Exhausted must name what was examined (e.g. -Exhausted 'gh:197,gh:179,gh:139'); an unnamed declaration asserts nothing");
  const lt = st && has(st, 'last_turn_at') ? parseDateOrNull(get(st, 'last_turn_at')) : null;
  if (!lt || PsDate.now().diffMs(lt) / 60000 >= ctx.p.ExhaustionTtlMinutes) {
    throw new Error(`task ${ctx.p.Id} has no turn recorded in the last ${ctx.p.ExhaustionTtlMinutes} minute(s): work the row and mark it this run before declaring it exhausted`);
  }
  setMember(st, 'today_exhausted', { at: nowIso(), examined, note: psStr(ctx.p.ExhaustedNote), today_hash: getTodaySectionHash(ctx) });
  st.updated = nowIso();
  writeState(ctx, st);
  ctx.emitJson(st, { depth: 6 });
}

function nextDueFromLast(last, minutes) {
  if (last) {
    const parsed = tryParseDateTime(psStr(last));
    if (parsed) return parsed.addMinutes(minutes);
  }
  return PsDate.now();
}

export function cmdMark(ctx) {
  if (!ctx.p.Id) throw new Error('mark requires -Id');
  const journalPath = joinPath(ctx.p.JournalDir, `task-${ctx.p.Id}.md`);
  if (!testPath(journalPath)) throw new Error(`no journal at ${journalPath}`);
  if (ctx.p.Exhausted || ctx.p.ExhaustionClear) return setExhaustionDeclaration(ctx);

  addTurnTerminator(journalPath);
  const facts = getJournalFacts(journalPath);
  let st = readState(ctx, ctx.p.Id);
  if (!st) st = { id: ctx.p.Id, status: 'unknown', version: 0, plan_id: '', processed_file_hash: '', has_agent_block: true, seeded: false, updated: null };

  if (ctx.p.Status) {
    if (testUserPaused(st, facts) && lowerInvariant(psStr(ctx.p.StatusBy)) !== 'user') throw new Error(pausedError(ctx, st));
    const status = lowerInvariant(psStr(ctx.p.Status));
    const statusBy = lowerInvariant(psStr(ctx.p.StatusBy));
    const storedStatus = lowerInvariant(psStr(get(st, 'status')));
    const storedStatusBy = lowerInvariant(psStr(get(st, 'status_by')));
    const consent = get(facts, 'Consent');
    if (statusBy !== 'user' && approvedWorkStatuses.includes(status) &&
        !(storedStatusBy === 'user' && userPauseStatuses.includes(storedStatus)) &&
        consent && psTruthy(get(consent, 'consent_ok')) && !taskSessionOwnsStatusChange(ctx, st)) {
      throw new Error(approvedWorkMarkError(ctx, st));
    }
    const wasPaused = testUserPaused(st, facts);
    st.status = ctx.p.Status;
    setMember(st, 'status_by', ctx.p.StatusBy ? lowerInvariant(ctx.p.StatusBy) : 'agent');
    const nowPaused = testUserPaused(st, facts);
    if (nowPaused && !wasPaused) setMember(st, 'paused_at', nowIso());
    else if (!nowPaused) setMember(st, 'paused_at', null);
  }
  if (ctx.p.Version > 0) st.version = ctx.p.Version;
  if (ctx.p.PlanId) st.plan_id = ctx.p.PlanId;

  const existingPoll = has(st, 'poll') ? get(st, 'poll') : null;
  if (ctx.p.PollClear) setMember(st, 'poll', null);
  else if (ctx.p.Poll) {
    const mins = parsePollMinutes(ctx.p.Poll);
    const lastPolled = existingPoll ? psStr(get(existingPoll, 'last_polled')) : '';
    setMember(st, 'poll', newPollObject(netTrim(ctx.p.Poll).toLowerCase(), mins, lastPolled, nextDueFromLast(lastPolled, mins)));
  } else if (ctx.p.PollDone) {
    if (!existingPoll) throw new Error(`task ${ctx.p.Id} has no poll to mark done (arm one with -Poll first)`);
    const mins = toInt(get(existingPoll, 'interval_minutes'));
    setMember(st, 'poll', newPollObject(psStr(get(existingPoll, 'cadence')), mins, nowIso(), PsDate.now().addMinutes(mins)));
  }

  const existingRecheck = has(st, 'recheck') ? get(st, 'recheck') : null;
  if (ctx.p.RecheckClear) setMember(st, 'recheck', null);
  else if (ctx.p.Recheck) {
    const mins = parsePollMinutes(ctx.p.Recheck);
    const kind = ctx.p.RecheckKind ? netTrim(ctx.p.RecheckKind) : existingRecheck ? psStr(get(existingRecheck, 'kind')) : '';
    const last = existingRecheck ? psStr(get(existingRecheck, 'last_rechecked')) : '';
    setMember(st, 'recheck', newRecheckObject(netTrim(ctx.p.Recheck).toLowerCase(), mins, kind, last, nextDueFromLast(last, mins)));
  } else if (ctx.p.RecheckDone) {
    if (!existingRecheck) throw new Error(`task ${ctx.p.Id} has no recheck to mark done (arm one with -Recheck first)`);
    const mins = toInt(get(existingRecheck, 'interval_minutes'));
    const kind = ctx.p.RecheckKind ? netTrim(ctx.p.RecheckKind) : psStr(get(existingRecheck, 'kind'));
    setMember(st, 'recheck', newRecheckObject(psStr(get(existingRecheck, 'cadence')), mins, kind, nowIso(), PsDate.now().addMinutes(mins)));
  } else if (ctx.p.RecheckKind && existingRecheck) {
    setMember(st, 'recheck', newRecheckObject(psStr(get(existingRecheck, 'cadence')), toInt(get(existingRecheck, 'interval_minutes')), netTrim(ctx.p.RecheckKind), psStr(get(existingRecheck, 'last_rechecked')), parseDateTime(psStr(get(existingRecheck, 'next_due')))));
  }

  st.processed_file_hash = get(facts, 'FullHash');
  st.has_agent_block = get(facts, 'HasAgentBlock');
  if (get(facts, 'HasTrailingHuman')) {
    if (!(has(st, 'unanswered_user_message_at') && psTruthy(get(st, 'unanswered_user_message_at')))) setMember(st, 'unanswered_user_message_at', nowIso());
  } else setMember(st, 'unanswered_user_message_at', null);
  st.updated = nowIso();
  const timerOnly = ctx.p.PollDone || ctx.p.PollClear || ctx.p.RecheckDone || ctx.p.RecheckClear || (ctx.p.RecheckKind && !ctx.p.Recheck);
  const isTurn = !(timerOnly && !ctx.p.Status && ctx.p.Version <= 0 && !ctx.p.PlanId);
  if (isTurn) {
    setMember(st, 'last_turn_at', nowIso());
    const by = ctx.p.TurnBy || process.env.COPILOT_AGENT_SESSION_ID || 'unknown';
    setMember(st, 'last_turn_by', by);
  }
  writeState(ctx, st);
  ctx.emitJson(st, { depth: 6 });
}
