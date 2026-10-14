// state.mjs -- the per-task state store (%LOCALAPPDATA%\overnight-agent\state\task-<id>.json) and
// the timer objects kept in it (oa-state.ps1: State-Path .. Test-PollDue, Ensure-StateDir).
//
// A state file is read with ConvertFrom-Json, so (PowerShell 7) every ISO date-time in it comes
// back as a DateTime (PsDate) -- and is written back by ConvertTo-Json in the Kind it was read
// in. Writes are atomic, depth 12, UTF-8 WITH a BOM (Write-JsonAtomic).
import { joinPath } from '../core/context.mjs';
import { readAllText, testPath, writeJsonAtomic, ensureDir } from '../core/fsx.mjs';
import { fromJson } from '../core/psjson.mjs';
import { PsDate, parseDateTime } from '../core/psdate.mjs';
import { get, psStr, psTruthy, lowerInvariant, netTrim } from '../core/net.mjs';

export function ensureStateDir(ctx) { ensureDir(ctx.p.StateDir); }

export const statePath = (ctx, id) => joinPath(ctx.p.StateDir, `task-${id}.json`);

export function readState(ctx, id) {
  const p = statePath(ctx, id);
  if (testPath(p)) return fromJson(readAllText(p));
  return null;
}

export function writeState(ctx, obj) {
  ensureStateDir(ctx);
  writeJsonAtomic(statePath(ctx, psStr(get(obj, 'id'))), obj);
}

// Now-Iso: (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
export const nowIso = () => PsDate.now().format('yyyy-MM-ddTHH:mm:ssK');

// Parse-PollMinutes: hourly|daily|weekly|<N>h|<N>d|<N>m (case-insensitive) -> minutes.
export function parsePollMinutes(spec) {
  const s = lowerInvariant(netTrim(String(spec ?? '')));
  let m;
  if (/^hourly$/i.test(s)) return 60;
  if (/^daily$/i.test(s)) return 1440;
  if (/^weekly$/i.test(s)) return 10080;
  if ((m = /^(\d+)[\t\n\v\f\r \x85\p{Z}]*h$/iu.exec(s))) return Number(m[1]) * 60;
  if ((m = /^(\d+)[\t\n\v\f\r \x85\p{Z}]*d$/iu.exec(s))) return Number(m[1]) * 1440;
  if ((m = /^(\d+)[\t\n\v\f\r \x85\p{Z}]*m$/iu.exec(s))) return Number(m[1]);
  throw new Error(`invalid cadence '${spec}' (use hourly|daily|weekly|<N>h|<N>d|<N>m)`);
}

export function newPollObject(cadence, minutes, lastPolled, nextDue) {
  return {
    cadence: cadence ?? '',
    interval_minutes: minutes,
    last_polled: lastPolled ?? '',
    next_due: nextDue.format('yyyy-MM-ddTHH:mm:ssK'),
  };
}

export function newRecheckObject(cadence, minutes, kind, lastRechecked, nextDue) {
  return {
    cadence: cadence ?? '',
    interval_minutes: minutes,
    kind: kind ?? '',
    last_rechecked: lastRechecked ?? '',
    next_due: nextDue.format('yyyy-MM-ddTHH:mm:ssK'),
  };
}

// Test-PollDue: a poll with no next_due (freshly armed / malformed) is due now.
export function testPollDue(poll) {
  if (!psTruthy(poll)) return false;
  const nd = get(poll, 'next_due');
  if (!psTruthy(nd)) return true;
  try { return parseDateTime(nd instanceof PsDate ? nd : psStr(nd)).compare(PsDate.now()) <= 0; } catch { return true; }
}
