// sessions.mjs -- per-task session binding readers and verdicts (#404).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { joinPath, expandEnv } from '../core/context.mjs';
import { readAllText, readJournalText, testPath, isFile, isDir } from '../core/fsx.mjs';
import { fromJson, toJson } from '../core/psjson.mjs';
import { PsDate, parseDateTime } from '../core/psdate.mjs';
import { get, has, asArray, psStr, psTruthy, lowerInvariant, ciContains, psIsMatch, rx } from '../core/net.mjs';
import { getSettingRow } from './settings.mjs';
import { testUserPaused } from '../plan/pause.mjs';

export function convertToIsoText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof PsDate) return value.format('yyyy-MM-ddTHH:mm:ssK');
  const s = psStr(value);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  try { return parseDateTime(s).format('yyyy-MM-ddTHH:mm:ssK'); } catch { return s; }
}

export function newSessionObject(sessionIdValue, kind, project, workspace, wsType, createdAt, lastWokenAt, sessionState, priorSessionId, replacedAt, priorSessionIds) {
  return {
    session_id: sessionIdValue ?? '',
    kind: kind ?? '',
    project: project ?? '',
    workspace: workspace ?? '',
    workspace_type: wsType ?? '',
    created_at: convertToIsoText(createdAt),
    last_woken_at: convertToIsoText(lastWokenAt),
    state: sessionState ?? '',
    prior_session_id: priorSessionId ?? '',
    prior_session_ids: asArray(priorSessionIds).map(psStr).filter((x) => x),
    replaced_at: convertToIsoText(replacedAt),
  };
}

export function getSessionLineage(sess) {
  if (!sess) return [];
  const ids = [];
  if (has(sess, 'prior_session_ids') && psTruthy(get(sess, 'prior_session_ids'))) {
    for (const id of asArray(get(sess, 'prior_session_ids')).map(psStr).filter((x) => x)) ids.push(id);
  }
  const prior = psStr(get(sess, 'prior_session_id'));
  if (prior && !ciContains(ids, prior)) ids.push(prior);
  return ids;
}

export function testSamePath(a, b) {
  if (!a || !b) return false;
  const norm = (v) => String(v).replace(/\//g, '\\').replace(/\\+$/g, '');
  return lowerInvariant(norm(a)) === lowerInvariant(norm(b));
}

function winFull(p) {
  return path.win32.resolve(expandEnv(p));
}

export function testPathWithin(p, root) {
  if (!p || !root) return false;
  const full = winFull(p).replace(/[\\/]+$/g, '');
  const base = winFull(root).replace(/[\\/]+$/g, '');
  return lowerInvariant(full) === lowerInvariant(base) || lowerInvariant(full).startsWith(lowerInvariant(base + '\\'));
}

export function assertChatWorkspace(ctx, project, workspace, wsType) {
  const settingsPath = ctx.userSettingsPath();
  const setting = settingsPath && testPath(settingsPath) ? getSettingRow(readJournalText(settingsPath), 'Non-code task project') : '';
  if (!setting) throw new Error('session_chat_project_required: configure Non-code task project in user-settings.md before binding a non-code session');
  const idPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  const m = rx(setting, `^(${idPattern})(?=\\s|$)`);
  const configured = m ? m[1] : '';
  if (!new RegExp(`^${idPattern}$`).test(configured)) {
    throw new Error(`session_chat_project_invalid: Non-code task project must be a project id, got '${setting}'`);
  }
  if (!process.env.LOCALAPPDATA && !process.env.OVERNIGHT_AGENT_HOME) {
    throw new Error('session_chat_home_required: LOCALAPPDATA is required for Non-code task project');
  }
  const chatHome = process.env.OVERNIGHT_AGENT_HOME
    ? joinPath(process.env.OVERNIGHT_AGENT_HOME, 'task-chats')
    : joinPath(process.env.LOCALAPPDATA, 'overnight-agent\\task-chats');
  if (!project || project !== configured || !workspace || wsType !== 'folder') {
    throw new Error('session_chat_scope: bind the configured Non-code task project with its folder workspace (-SessionProject, -SessionWorkspace, -WorkspaceType folder)');
  }
  const oneDriveRoots = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial];
  if (process.env.USERPROFILE) oneDriveRoots.push(joinPath(process.env.USERPROFILE, 'OneDrive'));
  for (const root of oneDriveRoots) {
    if (root && testPathWithin(workspace, root)) throw new Error('session_chat_onedrive: Non-code task project must be outside OneDrive');
  }
  let folder = winFull(workspace);
  for (;;) {
    const parent = path.win32.dirname(folder);
    if (process.env.USERPROFILE && lowerInvariant(parent) === lowerInvariant(winFull(process.env.USERPROFILE)) && psIsMatch(path.win32.basename(folder), '^OneDrive')) {
      throw new Error('session_chat_onedrive: Non-code task project must be outside OneDrive');
    }
    if (isFile(joinPath(folder, '.git'))) throw new Error('session_chat_worktree: Non-code task project cannot be inside a code worktree');
    if (!parent || parent === folder) break;
    folder = parent;
  }
  if (!testSamePath(winFull(workspace), winFull(chatHome))) {
    throw new Error('session_chat_home: Non-code task project must use %LOCALAPPDATA%\\overnight-agent\\task-chats');
  }
}

export function getSessionState(st) {
  const sess = get(st, 'session');
  if (st && has(st, 'session') && sess && psStr(get(sess, 'session_id'))) return sess;
  return null;
}

function eventInstantMs(v) {
  if (v === null || v === undefined) return null;
  const s = psStr(v);
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return parsed;
  try { return parseDateTime(s).instantMs(); } catch { return null; }
}

export function getReplacements24h(st) {
  if (!st) return 0;
  let events = [];
  if (has(st, 'session_replacements') && psTruthy(get(st, 'session_replacements'))) {
    events = asArray(get(st, 'session_replacements'));
  } else if (get(st, 'session') && psStr(get(get(st, 'session'), 'prior_session_id')) && psStr(get(get(st, 'session'), 'replaced_at'))) {
    events = [{ at: get(get(st, 'session'), 'replaced_at') }];
  }
  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;
  let count = 0;
  for (const event of events) {
    const at = eventInstantMs(get(event, 'at'));
    if (at !== null && at >= since && at <= now) count++;
  }
  return count;
}

function validSessionId(sessionId) {
  const s = psStr(sessionId);
  return !!s && !/[\\/]/.test(s) && s !== '.' && s !== '..';
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sessionLockFiles(dir) {
  return fs.readdirSync(dir).filter((name) => /^inuse\..*\.lock$/i.test(name) && isFile(joinPath(dir, name)));
}

export function testSessionProcessDead(ctx, sessionId) {
  try { return !!testSessionProcessDeadCore(ctx, sessionId); } catch { return false; }
}

export function testSessionProcessAlive(ctx, sessionId) {
  if (!validSessionId(sessionId)) return false;
  try {
    const sessionDir = joinPath(ctx.p.SessionStateDir, psStr(sessionId));
    if (!isDir(sessionDir)) return false;
    for (const name of sessionLockFiles(sessionDir)) {
      const m = /^inuse\.(\d+)\.lock$/i.exec(name);
      if (!m) continue;
      const pidValue = Number(m[1]);
      if (!Number.isInteger(pidValue) || pidValue <= 0) continue;
      if (processAlive(pidValue)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function testSessionProcessDeadCore(ctx, sessionId) {
  if (!validSessionId(sessionId)) return false;
  const sessionDir = joinPath(ctx.p.SessionStateDir, psStr(sessionId));
  if (!isDir(sessionDir)) return false;
  const locks = sessionLockFiles(sessionDir);
  if (locks.length === 0) return false;
  for (const name of locks) {
    const m = /^inuse\.(\d+)\.lock$/i.exec(name);
    if (!m) return false;
    const pidValue = Number(m[1]);
    if (!Number.isInteger(pidValue) || pidValue <= 0) return false;
    if (processAlive(pidValue)) return false;
  }
  const eventsPath = joinPath(sessionDir, 'events.jsonl');
  if (!isFile(eventsPath)) return false;
  const staleBefore = Date.now() - 15 * 60 * 1000;
  if (fs.statSync(eventsPath).mtimeMs > staleBefore) return false;
  const text = readAllText(eventsPath);
  const lines = text.split(/\r?\n/);
  while (lines.length && lines.at(-1) === '') lines.pop();
  const lastEvent = fromJson(lines.at(-1) ?? '');
  if (psStr(get(lastEvent, 'type')) === 'session.shutdown' && psStr(get(get(lastEvent, 'data'), 'shutdownType')) === 'routine') {
    return false;
  }
  return true;
}

export function testWorkspaceMissing(p, wsType) {
  if (!p) return false;
  if (wsType && wsType !== 'worktree') return false;
  try {
    if (testPath(p)) return false;
    const root = path.win32.parse(expandEnv(p)).root;
    if (!root) return false;
    if (!testPath(root)) return false;
    return true;
  } catch {
    return false;
  }
}

export function testWorkspaceUsable(p, wsType) {
  if (!p) return true;
  if (wsType && wsType !== 'worktree') return true;
  try {
    if (!testPath(p)) return !testWorkspaceMissing(p, wsType);
    if (testPath(joinPath(p, '.git'))) return true;
    return false;
  } catch {
    return true;
  }
}

export function getSessionVerdict(ctx, sess, row, journalFacts, sessionProcessDead = null) {
  if (testUserPaused(row, journalFacts)) return 'paused';
  if (!sess) return 'create';
  if (psStr(get(sess, 'state')) === 'dead') return 'replace';
  let processDead = sessionProcessDead;
  if (processDead === null || processDead === undefined) processDead = testSessionProcessDead(ctx, psStr(get(sess, 'session_id')));
  if (processDead) return 'replace';
  if (!testWorkspaceUsable(psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type')))) return 'replace';
  return 'reuse';
}

function sortedUniqueStrings(values) {
  const arr = asArray(values).map(psStr).filter((x) => x);
  arr.sort((a, b) => lowerInvariant(a).localeCompare(lowerInvariant(b), 'en-US') || a.localeCompare(b, 'en-US'));
  const out = [];
  for (const v of arr) if (!out.some((x) => lowerInvariant(x) === lowerInvariant(v))) out.push(v);
  return out;
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
    comments: sortedUniqueStrings(get(get(st, 'doc'), 'pending_ids')),
  };
  const text = toJson(inputState, { depth: 4, compress: true }).text;
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function getKickoffContinuation(taskId, priorId) {
  return `This session continues work on planner task #${taskId}. The previous session for this task `
    + `(${priorId}) could not be woken, so this one replaces it -- you are not starting from scratch. `
    + 'Read the task journal for what has already been done before doing anything new.';
}

export function getTaskRoleLine(taskId) {
  return `You are the task session for planner task #${taskId}. Do this task only. Do not run `
    + '`/overnight-agent` or load the overnight-agent skill, and do not dispatch, create or wake '
    + 'other sessions.';
}
