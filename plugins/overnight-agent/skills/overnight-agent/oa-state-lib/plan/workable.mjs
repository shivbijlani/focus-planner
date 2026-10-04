// workable.mjs -- task workability, Today-gate, exhaustion, and session-status snapshot readers.
import { readAllText, testPath } from '../core/fsx.mjs';
import { fromJson } from '../core/psjson.mjs';
import { PsDate, parseDateTime } from '../core/psdate.mjs';
import { asArray, ciContains, get, has, lowerInvariant, psStr, psTruthy } from '../core/net.mjs';
import { ClosedStatus, NonWorkableStatus } from './status.mjs';

export function testUserClosed(row) {
  if (!ciContains(ClosedStatus, lowerInvariant(psStr(get(row, 'status'))))) return false;
  if (psTruthy(get(row, 'user_completed'))) return true;
  if (lowerInvariant(psStr(get(row, 'status_by'))) === 'user') return true;
  if (!psTruthy(get(row, 'on_board'))) return true;
  return false;
}

export function testReopenedClosed(row) {
  return !!(psTruthy(get(row, 'reopened')) && testUserClosed(row));
}

export function testUnansweredUser(row) {
  return !!(psTruthy(get(row, 'unanswered_user')) && !testUserClosed(row));
}

export function testWorkable(row) {
  if (psTruthy(get(row, 'snoozed'))) return false;
  if (testReopenedClosed(row)) return false;
  if (psTruthy(get(row, 'reopened'))) return true;
  if (testUnansweredUser(row)) return true;
  if (lowerInvariant(psStr(get(row, 'status'))) === 'proposed'
      && lowerInvariant(psStr(get(row, 'status_by'))) === 'agent') return true;
  if (psTruthy(get(row, 'awaiting_reply')) && !psTruthy(get(row, 'due_poll')) && !psTruthy(get(row, 'due_recheck'))) return false;
  if (psTruthy(get(row, 'due_recheck')) && lowerInvariant(psStr(get(row, 'status'))) === 'blocked') return true;
  return !ciContains(NonWorkableStatus, lowerInvariant(psStr(get(row, 'status'))));
}

export function getTodayGateVerdict(ctx, row, todayHash) {
  if (!testWorkable(row)) return { holds: false, reason: 'not_workable' };
  if (psTruthy(get(row, 'reopened'))) return { holds: true, reason: 'holding:reopened' };
  if (testUnansweredUser(row)) return { holds: true, reason: 'holding:unanswered_user' };
  if (ctx.GateStrict) return { holds: true, reason: 'holding:strict' };

  const claim = testExhaustionClaim(ctx, get(row, 'exhaustion'), row, todayHash);
  if (claim === 'declared_exhausted') return { holds: false, reason: 'declared_exhausted' };

  if ((ctx.BackstopHours ?? 0) > 0 && psTruthy(get(row, 'last_turn_at'))) {
    try {
      const t = parseDateTime(psStr(get(row, 'last_turn_at')));
      if (PsDate.now().diffMs(t) / 3600000 >= ctx.BackstopHours) {
        return { holds: false, reason: 'stale_turn_backstop' };
      }
    } catch {
      // Unparseable is not evidence of staleness; keep holding below.
    }
  }

  return { holds: true, reason: claim };
}

export function testExhaustionClaim(ctx, ex, row, todayHash) {
  if ((ctx.p?.ExhaustionTtlMinutes ?? 0) <= 0) return 'holding:declaration_disabled';
  if (!psTruthy(ex)) return 'holding:no_declaration';
  let examined = [];
  if (has(ex, 'examined') && psTruthy(get(ex, 'examined'))) examined = asArray(get(ex, 'examined'));
  if (examined.length === 0) return 'holding:declaration_named_nothing';

  let at;
  try { at = parseDateTime(psStr(get(ex, 'at'))); } catch { return 'holding:declaration_unparseable'; }
  if (PsDate.now().diffMs(at) / 60000 >= ctx.p.ExhaustionTtlMinutes) return 'holding:exhaustion_expired';

  if (psStr(get(ex, 'today_hash')) !== todayHash) return 'holding:exhaustion_stale_board';

  if (psTruthy(get(row, 'last_turn_at'))) {
    try {
      const lt = parseDateTime(psStr(get(row, 'last_turn_at')));
      if (lt.compare(at) > 0) return 'holding:exhaustion_superseded';
    } catch {
      // Unparseable last_turn_at cannot refute the declaration.
    }
  }

  return 'declared_exhausted';
}

export function getSessionActivities(ctx) {
  const file = ctx.p.SessionsStatusFile;
  if (!file) return null;
  if (!testPath(file)) throw new Error(`session_status_missing: ${file}`);
  let snapshot;
  try {
    snapshot = fromJson(readAllText(file));
  } catch (e) {
    throw new Error(`session_status_invalid: cannot read get_sessions_status snapshot: ${e?.message ?? e}`);
  }
  if (!has(snapshot, 'sessions') || get(snapshot, 'sessions') === null) {
    throw new Error('session_status_invalid: get_sessions_status snapshot must contain sessions');
  }
  const activities = {};
  for (const session of asArray(get(snapshot, 'sessions'))) {
    const sid = psStr(get(session, 'id'));
    if (!sid || Object.prototype.hasOwnProperty.call(activities, sid)) {
      throw new Error('session_status_invalid: session IDs must be nonempty and unique');
    }
    activities[sid] = psStr(get(get(session, 'activity'), 'status'));
  }
  return activities;
}
