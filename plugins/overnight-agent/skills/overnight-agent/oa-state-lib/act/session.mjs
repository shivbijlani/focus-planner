// session.mjs -- Cmd-Session and dispatch guard for per-task sessions (#404).
import fs from 'node:fs';
import { joinPath } from '../core/context.mjs';
import { readAllText, testPath, isFile } from '../core/fsx.mjs';
import { fromJson } from '../core/psjson.mjs';
import { get, has, asArray, psStr, psTruthy, setMember, isNullOrWhiteSpace, lowerInvariant, toInt, rxMatches, netTrim } from '../core/net.mjs';
import { readState, writeState, nowIso } from '../collect/state.mjs';
import { getJournalFacts, getAgentEndIndex, getNewestAgentTurn, getFenceMaskedText } from '../collect/journal.mjs';
import { getDocMetaFromJournal } from '../collect/doc.mjs';
import { getDocCommentConsent } from '../plan/consent.mjs';
import { readApprovalChannels, getApprovalOffReason } from '../plan/gate.mjs';
import { getAgentModelSettings } from '../collect/settings.mjs';
import {
  assertChatWorkspace,
  convertToIsoText,
  getKickoffContinuation,
  getSessionLineage,
  getSessionState,
  getSessionVerdict,
  getTaskRoleLine,
  newSessionObject,
  testSamePath,
  testSessionProcessAlive,
  testSessionProcessDead,
  testWorkspaceMissing,
} from '../collect/sessions.mjs';
import { testUserPaused } from '../plan/pause.mjs';
import { getScanRows } from '../plan/scan.mjs';

export function assertTaskDispatch(ctx, st, sess, facts) {
  const requires = asArray(ctx.p.RequiresTools);
  if (requires.length) {
    if (!testPath(ctx.p.CapabilitiesPath)) {
      throw new Error('session_capabilities_missing: run the critical-tool preflight before dispatch');
    }
    const capabilities = fromJson(readAllText(ctx.p.CapabilitiesPath));
    const checkedAt = Date.parse(psStr(get(capabilities, 'checkedAt')));
    if (psStr(get(capabilities, 'schema')) !== 'oa-capabilities/1'
        || Number.isNaN(checkedAt)
        || (Date.now() - checkedAt) / 60000 > 60) {
      throw new Error('session_capabilities_stale: rerun the critical-tool preflight');
    }
    const tools = get(capabilities, 'tools');
    for (const name of requires) {
      const tool = get(tools, psStr(name));
      if (!tool) throw new Error(`session_capability_unknown: '${psStr(name)}' was not probed`);
      if (psStr(get(tool, 'status')) !== 'ok') throw new Error(`blocked: ${psStr(name)} down`);
    }
  }

  if (testUserPaused(st, facts)) {
    throw new Error(`session_user_paused: task ${psStr(get(st, 'id'))} was paused by the user (status ${psStr(get(st, 'status'))}, `
      + 'status_by user). Do not dispatch it. Only he clears a pause: he replies in the journal '
      + 'below the newest turn, or a run records his decision with `-StatusBy user`.');
  }
  if (getSessionVerdict(ctx, sess, st, facts) !== 'reuse') {
    throw new Error('session_not_dispatchable: resolve the saved session first; paused tasks cannot be woken');
  }
  if (ctx.p.ForDispatch && isNullOrWhiteSpace(ctx.p.DispatchInput)) {
    throw new Error('session_input_required: -ForDispatch requires the exact dispatch_input from scan');
  }
  const row = getScanRows(ctx).find((r) => psStr(get(r, 'id')) === psStr(get(st, 'id')));
  if (row && psStr(get(row, 'dispatch_skip_reason'))) {
    throw new Error(`${psStr(get(row, 'dispatch_skip_reason'))}: bound session ${psStr(get(sess, 'session_id'))} cannot be dispatched`);
  }
  if (!row || (!get(row, 'eligible') && !(ctx.p.PlanDispatch && get(row, 'plan_review_due'))) || get(row, 'session_paused')) {
    throw new Error('session_not_eligible: follow the current Today-first worklist and user pauses');
  }
  if (ctx.p.PlanDispatch && !get(row, 'plan_review_due')) {
    throw new Error('session_plan_not_reviewable: -PlanDispatch only applies to an agent-authored proposal');
  }
  if (ctx.p.DispatchInput && ctx.p.DispatchInput !== psStr(get(row, 'dispatch_input'))) {
    throw new Error('session_input_changed: the prepared task brief is stale');
  }
  if (ctx.p.Force && !(get(row, 'unanswered_user') || toInt(get(row, 'doc_new_comments')) > 0)) {
    throw new Error('session_collect_evidence_required: fold the human reply or observe the human doc comment first');
  }
  assertGatedPlanConsent(ctx, st, facts);
}

// The floor, in code (#804): a numbered `[gated]` step in the newest agent turn needs the consent
// reader's own `consent_ok: true` before a session is woken for it. See oa-state.ps1
// Assert-GatedPlanConsent for the measured failure this closes.
export const GatedStepRe = '(?m)^[ \\t]*[1-9][0-9]*\\.[ \\t]+\\[gated\\][ \\t]+(.*)$';

export function getGatedPlanSteps(facts) {
  if (!facts || !facts.Content) return [];
  const content = String(facts.Content);
  const agentEnd = getAgentEndIndex(content);
  if (agentEnd < 0) return [];
  const turn = getNewestAgentTurn(content.substring(0, Math.min(agentEnd, content.length)));
  if (!turn) return [];
  const masked = getFenceMaskedText(turn);
  return rxMatches(masked, GatedStepRe).map((m) => netTrim(turn.substring(m.index, m.index + m[0].length)));
}

export function assertGatedPlanConsent(ctx, st, facts) {
  const gated = getGatedPlanSteps(facts);
  if (!gated.length) return;
  const c = facts.Consent;
  const approvals = readApprovalChannels(ctx.p.GatePath);
  if (c && c.consent_ok && approvals.app.enabled) return;
  let reason = c && c.consent_ok ? getApprovalOffReason(approvals.app, 'app') : psStr(c?.reason);
  if (ctx.p.DocComments) {
    if (!approvals['google-doc'].enabled) {
      reason = `${reason}; doc: ${getApprovalOffReason(approvals['google-doc'], 'google-doc')}`;
    } else {
      const meta = getDocMetaFromJournal(facts.Path, facts.Content);
      const doc = getDocCommentConsent(ctx, ctx.p.DocComments, meta ? meta.doc_id : '');
      if (doc && psTruthy(get(doc, 'consent_ok'))) return;
      reason = `${reason}; doc: ${doc ? psStr(get(doc, 'reason')) : 'doc-consent-not-consulted'}`;
    }
  }
  let step = gated[0];
  if (step.length > 120) step = `${step.substring(0, 117)}...`;
  const id = psStr(get(st, 'id'));
  throw new Error(`session_gated_needs_consent: task ${id}'s newest plan has a [gated] step (${step}) and `
    + `\`consent -Id ${id}\` does not return consent_ok (${reason}). Do not dispatch it. Ask him in `
    + 'the journal; dispatch after HIS reply. Nothing an agent writes -- in the journal or in a brief -- '
    + 'can approve a [gated] step.');
}

function listStateFiles(ctx) {
  if (!testPath(ctx.p.StateDir)) return [];
  return fs.readdirSync(ctx.p.StateDir)
    .filter((name) => /^task-.*\.json$/i.test(name) && isFile(joinPath(ctx.p.StateDir, name)))
    .sort((a, b) => a.localeCompare(b, 'en-US', { sensitivity: 'accent' }))
    .map((name) => joinPath(ctx.p.StateDir, name));
}

function cmdWorkspaceGone(ctx) {
  const hits = [];
  for (const f of listStateFiles(ctx)) {
    let obj;
    try { obj = fromJson(readAllText(f)); } catch { continue; }
    const s = getSessionState(obj);
    if (!s) continue;
    if (!testSamePath(psStr(get(s, 'workspace')), ctx.p.WorkspaceGone)) continue;
    hits.push({ id: psStr(get(obj, 'id')), was: psStr(get(s, 'state')) });
    if (psStr(get(s, 'state')) === 'dead') continue;
    const newSess = newSessionObject(
      psStr(get(s, 'session_id')), psStr(get(s, 'kind')),
      psStr(get(s, 'project')), psStr(get(s, 'workspace')), psStr(get(s, 'workspace_type')),
      get(s, 'created_at'), get(s, 'last_woken_at'), 'dead',
      psStr(get(s, 'prior_session_id')), get(s, 'replaced_at'), getSessionLineage(s),
    );
    setMember(obj, 'session', newSess);
    setMember(obj, 'updated', nowIso());
    writeState(ctx, obj);
  }
  ctx.emitJson({
    workspace: ctx.p.WorkspaceGone,
    marked_dead: hits.filter((h) => h.was !== 'dead').length,
    already_dead: hits.filter((h) => h.was === 'dead').length,
    tasks: hits.map((h) => h.id),
  }, { depth: 4 });
}

function ensureState(ctx) {
  let st = readState(ctx, ctx.p.Id);
  if (!st) {
    st = {
      id: ctx.p.Id, status: 'unknown', version: 0, plan_id: '',
      processed_file_hash: '', has_agent_block: false, seeded: false, updated: null,
    };
  }
  return st;
}

function getPauseFacts(ctx) {
  try {
    const jpath = joinPath(ctx.p.JournalDir, `task-${ctx.p.Id}.md`);
    if (testPath(jpath)) return getJournalFacts(jpath);
  } catch {
    return null;
  }
  return null;
}

function invalidKindMessage(kind) {
  return `session_kind_invalid: '${kind}' is not a supported task session kind; pass `
    + '-SessionKind chat for a non-code task or -SessionKind code with its worktree';
}

export function cmdSession(ctx) {
  const agentModel = getAgentModelSettings(ctx);
  if (ctx.p.ForDispatch && !ctx.p.SessionsStatusFile) {
    throw new Error('session_status_required: -ForDispatch requires a fresh get_sessions_status snapshot');
  }
  if (ctx.p.PlanDispatch && (!ctx.p.ForDispatch || ctx.p.Force)) {
    throw new Error('session_plan_dispatch_flags: -PlanDispatch requires -ForDispatch and cannot use -Force');
  }
  if ((ctx.p.CheckDispatch || ctx.p.ForDispatch)
      && (!ctx.p.Id || (ctx.p.CheckDispatch && ctx.p.ForDispatch) || ctx.p.SessionId
        || ctx.p.SessionDead || ctx.p.SessionRelease || ctx.p.WorkspaceGone)) {
    throw new Error('session_dispatch_flags_conflict: use -Id with exactly one dispatch-check flag');
  }

  if (ctx.p.WorkspaceGone) return cmdWorkspaceGone(ctx);
  if (!ctx.p.Id) throw new Error('session requires -Id (or -WorkspaceGone for teardown)');

  const st = ensureState(ctx);
  let sess = getSessionState(st);
  const pauseFacts = getPauseFacts(ctx);
  let dirty = false;
  let released = false;

  if (ctx.p.CheckDispatch || ctx.p.ForDispatch) assertTaskDispatch(ctx, st, sess, pauseFacts);

  if (ctx.p.SessionRelease) {
    sess = null;
    setMember(st, 'session', null);
    setMember(st, 'updated', nowIso());
    writeState(ctx, st);
    released = true;
  } else if (ctx.p.SessionDead) {
    if (!sess) throw new Error(`session_not_bound: task ${ctx.p.Id} has no session to mark dead`);
    if (testSessionProcessAlive(ctx, psStr(get(sess, 'session_id')))) {
      throw new Error(`session_still_alive: task ${ctx.p.Id} has a live session host; do not replace it for silence`);
    }
    sess = newSessionObject(
      psStr(get(sess, 'session_id')), psStr(get(sess, 'kind')),
      psStr(get(sess, 'project')), psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type')),
      get(sess, 'created_at'), get(sess, 'last_woken_at'), 'dead',
      psStr(get(sess, 'prior_session_id')), get(sess, 'replaced_at'), getSessionLineage(sess),
    );
    dirty = true;
  } else if (ctx.p.SessionId) {
    let prior = '';
    let lineage = getSessionLineage(sess);
    const oldSessionId = psStr(get(sess, 'session_id'));
    if (sess && oldSessionId !== ctx.p.SessionId && lineage.some((x) => lowerInvariant(x) === lowerInvariant(ctx.p.SessionId))) {
      throw new Error(`session_bind_backwards: task ${ctx.p.Id} already retired session ${ctx.p.SessionId} `
        + `(lineage: ${lineage.join(' -> ')}); refusing to re-bind it over ${oldSessionId}. `
        + 'A replacement must be a session this task has never used. If the current binding is '
        + 'genuinely finished, release it with -SessionRelease and bind a new session.');
    }
    if (sess && oldSessionId !== ctx.p.SessionId) {
      if (psStr(get(sess, 'state')) !== 'dead' && !ctx.p.Force) {
        throw new Error(`session_bind_conflict: task ${ctx.p.Id} is already bound to LIVE session ${oldSessionId}; `
          + `refusing to bind ${ctx.p.SessionId} over it. Wake the bound session instead. If it genuinely `
          + 'cannot be woken, record that with -SessionDead first -- that is the replacement path, '
          + 'and it is what carries the continuation into the new session.');
      }
      prior = oldSessionId;
      if (!lineage.some((x) => lowerInvariant(x) === lowerInvariant(prior))) lineage = [...lineage, prior];
    } else if (sess) {
      prior = psStr(get(sess, 'prior_session_id'));
    }

    const kind = ctx.p.SessionKind || (sess ? psStr(get(sess, 'kind')) : 'chat');
    if (!['code', 'chat'].includes(kind)) throw new Error(invalidKindMessage(kind));
    const project = ctx.p.SessionProject || (sess ? psStr(get(sess, 'project')) : '');
    const workspace = ctx.p.SessionWorkspace || (sess ? psStr(get(sess, 'workspace')) : '');
    const wsType = ctx.p.WorkspaceType || (sess && psStr(get(sess, 'workspace_type')) ? psStr(get(sess, 'workspace_type')) : kind === 'chat' ? 'folder' : 'worktree');
    if (kind === 'chat') assertChatWorkspace(ctx, project, workspace, wsType);

    if (kind === 'code') {
      if (!project) {
        throw new Error('session_project_required: a code task must name the repository project its session '
          + 'belongs to (-SessionProject). Omitting it inherits the RUN session\'s project, which is '
          + 'how a "per-task session" ends up sharing the run session workspace with no git repo in it.');
      }
      if (!workspace) {
        throw new Error('session_workspace_required: a code task must name its own workspace '
          + '(-SessionWorkspace) -- a worktree or branch checkout, not a shared folder.');
      }
      if (wsType === 'folder') {
        throw new Error("session_workspace_type: a code task cannot use a 'folder' workspace; "
          + 'use worktree (preferred) or branch.');
      }
      const runWs = ctx.p.RunWorkspace || ctx.cwd || process.cwd();
      if (runWs && testSamePath(workspace, runWs)) {
        throw new Error(`session_workspace_inherited: workspace '${workspace}' is the RUN session's own `
          + 'workspace. One task, one workspace -- sharing one deadlocks the sessions and reproduces '
          + 'the very isolation failure #404 exists to prevent.');
      }
    }

    const created = sess && oldSessionId === ctx.p.SessionId && psTruthy(get(sess, 'created_at')) ? get(sess, 'created_at') : nowIso();
    const replacedAt = prior && oldSessionId !== ctx.p.SessionId ? nowIso() : sess ? get(sess, 'replaced_at') : '';
    if (prior) {
      let history = [];
      if (has(st, 'session_replacements') && psTruthy(get(st, 'session_replacements'))) history = asArray(get(st, 'session_replacements'));
      else if (sess && psStr(get(sess, 'prior_session_id')) && psStr(get(sess, 'replaced_at'))) {
        history = [{ session_id: psStr(get(sess, 'prior_session_id')), at: convertToIsoText(get(sess, 'replaced_at')) }];
      }
      if (oldSessionId !== ctx.p.SessionId) {
        history.push({ session_id: prior, at: replacedAt });
        setMember(st, 'session_replacements', history);
      }
    }
    const lastWoken = sess && oldSessionId === ctx.p.SessionId ? get(sess, 'last_woken_at') : '';
    sess = newSessionObject(ctx.p.SessionId, kind, project, workspace, wsType, created, lastWoken,
      'live', prior, replacedAt, lineage);
    dirty = true;
  }

  if (ctx.p.ForDispatch) {
    if (!sess) throw new Error(`session_not_bound: task ${ctx.p.Id} has no session to wake`);
    if (testUserPaused(st, pauseFacts)) throw new Error('session_user_paused: cannot stamp a wake for a paused task');
    sess = newSessionObject(
      psStr(get(sess, 'session_id')), psStr(get(sess, 'kind')),
      psStr(get(sess, 'project')), psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type')),
      get(sess, 'created_at'), nowIso(), 'live',
      psStr(get(sess, 'prior_session_id')), get(sess, 'replaced_at'), getSessionLineage(sess),
    );
    dirty = true;
  }

  if (dirty) {
    setMember(st, 'session', sess);
    setMember(st, 'updated', nowIso());
    writeState(ctx, st);
  }

  const sessionProcessDead = !!testSessionProcessDead(ctx, psStr(get(sess, 'session_id')));
  const verdict = getSessionVerdict(ctx, sess, st, pauseFacts, sessionProcessDead);
  ctx.emitJson({
    id: ctx.p.Id,
    model: agentModel.model,
    model_source: agentModel.source,
    bound: !!sess,
    session_id: sess ? psStr(get(sess, 'session_id')) : null,
    verdict,
    dispatch_authorised: !!ctx.p.ForDispatch,
    dispatch_eligible: !!(ctx.p.CheckDispatch || ctx.p.ForDispatch),
    state: sess ? psStr(get(sess, 'state')) : null,
    kind: sess ? psStr(get(sess, 'kind')) : null,
    project: sess && psStr(get(sess, 'project')) ? psStr(get(sess, 'project')) : null,
    workspace: sess && psStr(get(sess, 'workspace')) ? psStr(get(sess, 'workspace')) : null,
    workspace_type: sess ? psStr(get(sess, 'workspace_type')) : null,
    workspace_missing: !!testWorkspaceMissing(psStr(get(sess, 'workspace')), psStr(get(sess, 'workspace_type'))),
    process_dead: sessionProcessDead,
    prior_session_id: sess && psStr(get(sess, 'prior_session_id')) ? psStr(get(sess, 'prior_session_id')) : null,
    prior_session_ids: getSessionLineage(sess),
    created_at: sess ? convertToIsoText(get(sess, 'created_at')) : null,
    last_woken_at: sess && psTruthy(get(sess, 'last_woken_at')) ? convertToIsoText(get(sess, 'last_woken_at')) : null,
    released: !!released,
    paused_by_user: !!testUserPaused(st, pauseFacts),
    paused_at: st && has(st, 'paused_at') && psTruthy(get(st, 'paused_at')) ? convertToIsoText(get(st, 'paused_at')) : null,
    role_line: getTaskRoleLine(ctx.p.Id),
    kickoff_continuation: verdict === 'replace' ? getKickoffContinuation(ctx.p.Id, psStr(get(sess, 'session_id'))) : null,
    teardown_command: sess && psStr(get(sess, 'workspace_type')) === 'worktree' && psStr(get(sess, 'workspace'))
      ? `pwsh -NoProfile -File scripts/remove-worktree.ps1 -Path "${psStr(get(sess, 'workspace'))}"`
      : null,
    concurrency: toInt(ctx.ConcurrencyLimit),
    concurrency_source: psStr(ctx.ConcurrencySource),
  }, { depth: 8 });
}
