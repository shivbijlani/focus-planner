#!/usr/bin/env node
// Differential fuzz for the #404 session readers/verdicts and user-pause helpers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPsHost, asJson, diff } from './fn-diff.mjs';
import { buildContext } from '../../skills/overnight-agent/oa-state-lib/core/context.mjs';
import { fromJson } from '../../skills/overnight-agent/oa-state-lib/core/psjson.mjs';
import {
  convertToIsoText, newSessionObject, getSessionLineage, testSamePath, testPathWithin,
  assertChatWorkspace, getSessionState, getReplacements24h, testSessionProcessDead,
  testSessionProcessAlive, testSessionProcessDeadCore, testWorkspaceMissing, testWorkspaceUsable,
  getSessionVerdict, getDispatchInput, getKickoffContinuation, getTaskRoleLine,
} from '../../skills/overnight-agent/oa-state-lib/collect/sessions.mjs';
import { testUserPaused, testResumeIsAfterPause, getIsoDate } from '../../skills/overnight-agent/oa-state-lib/plan/pause.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const scratch = path.join(here, '.scratch-session-diff');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []));
const N = Number(args.n ?? 200);
let seed = Number(args.seed ?? 404);
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const isoAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const psShape = (v) => fromJson(JSON.stringify(v ?? null));

function resetDir(p) {
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
}

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function touchOld(p, minutesAgo = 30) {
  const d = new Date(Date.now() - minutesAgo * 60000);
  fs.utimesSync(p, d, d);
}

function makeCtx(root) {
  const params = {
    StateDir: path.join(root, 'state'),
    SessionStateDir: path.join(root, 'sessions'),
    JournalDir: path.join(root, 'journal'),
    UserSettings: path.join(root, 'user-settings.md'),
  };
  const ctx = buildContext(params, new Set(Object.keys(params)));
  return ctx;
}

function randomSession(id = '11111111-1111-4111-8111-111111111111') {
  const prior = pick(['', '22222222-2222-4222-8222-222222222222']);
  return {
    session_id: id,
    kind: pick(['code', 'chat']),
    project: pick(['focus-planner', 'example/repo', '']),
    workspace: pick(['C:\\repo\\wt-a', 'C:/repo/wt-a', '']),
    workspace_type: pick(['worktree', 'folder', 'branch']),
    created_at: pick([isoAgo(1500), '09/03/2026 15:16:45', null]),
    last_woken_at: pick([isoAgo(90), '', null]),
    state: pick(['live', 'dead']),
    prior_session_id: prior,
    prior_session_ids: prior
      ? ['00000000-0000-4000-8000-000000000000', prior]
      : ['00000000-0000-4000-8000-000000000000', '99999999-9999-4999-8999-999999999999'],
    replaced_at: prior ? isoAgo(60) : null,
  };
}

function randomState(sess) {
  return {
    id: String(100 + Math.floor(rnd() * 900)),
    status: pick(['in-progress', 'blocked', 'proposed', 'done', 'skip']),
    status_by: pick(['agent', 'user', '']),
    plan_id: pick(['t1-v1', '', 'plan-x']),
    version: pick([0, 1, 2, '3']),
    session: sess,
    poll: { next_due: pick([isoAgo(10), '', null]) },
    recheck: { next_due: pick([isoAgo(20), '', null]) },
    doc: { pending_ids: pick([['b', 'a', 'a'], [], ['C', 'c', 'a']]) },
    session_replacements: [{ session_id: 'old', at: isoAgo(30) }, { session_id: 'older', at: isoAgo(60 * 26) }],
    updated: isoAgo(5),
  };
}

function setupSessionDir(ctx, sessionId, shape) {
  const d = path.join(ctx.p.SessionStateDir, sessionId);
  fs.mkdirSync(d, { recursive: true });
  if (shape === 'none') return;
  const pid = shape === 'live' ? process.pid : 99999999;
  write(path.join(d, `inuse.${pid}.lock`), '');
  const events = path.join(d, 'events.jsonl');
  if (shape === 'routine') write(events, JSON.stringify({ type: 'session.shutdown', data: { shutdownType: 'routine' } }) + '\n');
  else write(events, JSON.stringify({ type: 'assistant.message', data: { ok: true } }) + '\n');
  touchOld(events, shape === 'recent' ? 1 : 30);
}

async function main() {
  resetDir(scratch);
  const ctx = makeCtx(scratch);
  fs.mkdirSync(ctx.p.StateDir, { recursive: true });
  fs.mkdirSync(ctx.p.SessionStateDir, { recursive: true });
  fs.mkdirSync(ctx.p.JournalDir, { recursive: true });
  write(ctx.p.UserSettings, '| Setting | Value |\n|---|---|\n| Non-code task project | `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee` |\n');
  const ps = await createPsHost({ params: ctx.p, cwd: repoRoot });
  let ran = 0;
  async function check(name, psName, nodeFn, args = [], { allowError = false } = {}) {
    const rawArgs = args.map(psShape);
    const pr = await ps.callRaw(psName, rawArgs);
    let nr;
    try { nr = { ok: true, value: asJson(nodeFn(...rawArgs)) }; } catch (e) { nr = { ok: false, error: e.message }; }
    const shapedPs = pr.ok ? { ok: true, value: pr.value } : { ok: false, error: pr.error };
    const d = diff(shapedPs, nr);
    ran++;
    if (d && !(allowError && !shapedPs.ok && !nr.ok && shapedPs.error === nr.error)) {
      throw new Error(`${name}/${psName} difference: ${d}`);
    }
  }

  try {
  for (let i = 0; i < N; i++) {
    fs.rmSync(ctx.p.SessionStateDir, { recursive: true, force: true });
    fs.mkdirSync(ctx.p.SessionStateDir, { recursive: true });
    const sess = randomSession();
    const st = randomState(sess);
    const facts = {
      FullHash: cryptoHash(`journal-${i}-${rnd()}`),
      HasTrailingHuman: pick([true, false]),
      Path: path.join(ctx.p.JournalDir, `task-${i}.md`),
    };
    write(facts.Path, 'journal\n');
    if (pick([true, false])) touchOld(facts.Path, 1); else touchOld(facts.Path, 120);
    const pausedRow = {
      ...st,
      status: pick(['blocked', 'proposed', 'in-progress']),
      status_by: pick(['user', 'agent']),
      paused_at: pick([isoAgo(90), isoAgo(1), null, 'not a date']),
      unanswered_user_message_at: pick([isoAgo(30), isoAgo(120), null]),
    };

    await check('convert iso null', 'ConvertTo-IsoText', convertToIsoText, [pick([null, '', isoAgo(5), '09/03/2026 15:16:45', 'not a date'])]);
    await check('new session', 'New-SessionObject', newSessionObject, [
      sess.session_id, sess.kind, sess.project, sess.workspace, sess.workspace_type,
      sess.created_at, sess.last_woken_at, sess.state, sess.prior_session_id, sess.replaced_at, sess.prior_session_ids,
    ]);
    await check('lineage', 'Get-SessionLineage', getSessionLineage, [sess]);
    await check('same path', 'Test-SamePath', testSamePath, [pick(['C:\\A\\B\\', 'C:/A/B', '', null]), pick(['c:\\a\\b', 'D:\\A\\B', '', null])]);
    await check('path within', 'Test-PathWithin', testPathWithin, [pick(['C:\\A\\B\\C', 'C:/A/B', '%LOCALAPPDATA%\\x']), pick(['C:\\A\\B', 'C:\\Other', '%LOCALAPPDATA%'])]);
    await check('session state', 'Get-SessionState', getSessionState, [st]);
    await check('replacements', 'Get-Replacements24h', getReplacements24h, [st]);
    await check('workspace missing', 'Test-WorkspaceMissing', testWorkspaceMissing, [pick([path.join(scratch, 'missing'), path.join(scratch, 'exists')]), pick(['worktree', 'folder', ''])]);
    fs.mkdirSync(path.join(scratch, 'exists'), { recursive: true });
    if (pick([true, false])) write(path.join(scratch, 'exists', '.git'), 'gitdir: x');
    await check('workspace usable', 'Test-WorkspaceUsable', testWorkspaceUsable, [path.join(scratch, 'exists'), 'worktree']);
    await check('paused', 'Test-UserPaused', testUserPaused, [pausedRow, facts]);
    await check('resume', 'Test-ResumeIsAfterPause', testResumeIsAfterPause, [pausedRow, facts]);
    await check('iso date', 'Get-IsoDate', getIsoDate, [pick([isoAgo(1), '09/03/2026 15:16:45', 'bad', null])]);
    await check('verdict', 'Get-SessionVerdict', (a, b, c, d) => getSessionVerdict(ctx, a, b, c, d), [sess, pausedRow, facts, pick([true, false])]);
    await check('dispatch input', 'Get-DispatchInput', getDispatchInput, [st, facts]);
    await check('kickoff', 'Get-KickoffContinuation', getKickoffContinuation, [st.id, sess.session_id]);
    await check('role line', 'Get-TaskRoleLine', getTaskRoleLine, [st.id]);

    const shape = pick(['none', 'live', 'dead', 'routine', 'recent']);
    const sid = `33333333-3333-4333-8333-${String(i).padStart(12, '0').slice(0, 12)}`;
    setupSessionDir(ctx, sid, shape);
    await check('process dead', 'Test-SessionProcessDead', (x) => testSessionProcessDead(ctx, x), [sid]);
    await check('process alive', 'Test-SessionProcessAlive', (x) => testSessionProcessAlive(ctx, x), [sid]);
    await check('process dead core', 'Test-SessionProcessDeadCore', (x) => testSessionProcessDeadCore(ctx, x), [sid]);

    await check('assert chat valid', 'Assert-ChatWorkspace', (a, b, c) => assertChatWorkspace(ctx, a, b, c), ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', path.join(process.env.LOCALAPPDATA || process.env.OVERNIGHT_AGENT_HOME || 'C:\\Users\\x\\AppData\\Local', 'overnight-agent\\task-chats'), 'folder'], { allowError: true });
  }
  } finally {
    await ps.close();
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`session-diff: ${N} inputs, ${ran} comparisons, 0 differences`);
}

function cryptoHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

main().catch((e) => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
