#!/usr/bin/env node
// Read-only live audit for #804 part 2. It copies the live planner/state into TEMP, then asks
// the real consent reader against reconstructed pre-turn journals. The live folders are never
// written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', '..', 'skills', 'overnight-agent');
const OA_STATE = path.join(SKILL, 'oa-state.mjs');
const { main: oaMain, makeOutput } = await import(pathToFileURL(OA_STATE).href);

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
  return true;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function stateSessionIds(stateDir, id) {
  const st = readJson(path.join(stateDir, `task-${id}.json`));
  const s = st?.session;
  const ids = [];
  for (const k of ['session_id', 'prior_session_id']) if (s?.[k]) ids.push(String(s[k]));
  if (Array.isArray(s?.prior_session_ids)) for (const sid of s.prior_session_ids) if (sid) ids.push(String(sid));
  return { ids, liveBound: !!(s?.session_id && (!s.state || String(s.state).toLowerCase() === 'live')) };
}

function consent(journalDir, stateDir, plannerDir, id) {
  let captured = '';
  const code = oaMain([
    'consent', '-Id', id,
    '-JournalDir', journalDir,
    '-StateDir', stateDir,
    '-PlannerBoard', path.join(plannerDir, 'planner.md'),
    '-PlannerCompleted', path.join(plannerDir, 'planner-completed.md'),
    '-SnoozeStore', path.join(plannerDir, 'snooze.json'),
    '-GatePath', path.join(plannerDir, 'agent-gate.md'),
    '-UserSettings', path.join(plannerDir, 'user-settings.md'),
  ], makeOutput((s) => { captured += s; }));
  if (code !== 0) return { consent_ok: false, reason: `engine-error:${captured.trim()}` };
  try { return JSON.parse(captured.trim()); } catch { return { consent_ok: false, reason: 'engine-unparseable' }; }
}

function turnStarts(text) {
  const starts = [];
  // A managed turn heading names the agent OR carries the moon: `## 🌙 Back to the original drainage fix`
  // and `## 2026-08-23 — 🌙 Overnight Agent reply` are both turns. Either form alone misses some.
  const re = /^##[^\r\n]*(?:\u{1F319}|Overnight Agent)[^\r\n]*/gmiu;
  for (const m of text.matchAll(re)) starts.push(m.index);
  starts.push(text.length);
  return starts;
}

function classifyTurn(body) {
  const status = /\*\*Status:\*\*\s*([^\r\n]+)/i.exec(body)?.[1] ?? '';
  const outcome = /\b(Result|Deliverable|Run log)\b/i.test(body) || /\b(done|in progress|in-progress|blocked)\b/i.test(status);
  return outcome ? 'real_violation' : 'false_refusal';
}

const livePlanner = arg('--planner', path.join(process.env.USERPROFILE ?? os.homedir(), 'OneDrive', 'Apps', 'Focus Planner'));
const liveState = arg('--state', path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'overnight-agent', 'state'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-804-audit-'));
const planner = path.join(root, 'planner');
const state = path.join(root, 'state');
const journal = path.join(planner, 'journal');

try {
  copyDir(livePlanner, planner);
  copyDir(liveState, state);
  const tempJournal = path.join(root, 'replay-journal');
  fs.mkdirSync(tempJournal, { recursive: true });

  const result = {
    livePlanner,
    liveState,
    copiedTo: root,
    agentTurns: 0,
    coordinatorTurns: 0,
    refused: 0,
    realViolations: 0,
    falseRefusals: 0,
    refusedTaskCounts: {},
    examples: { realViolations: [], falseRefusals: [] },
    currentPendingApprovalNoLiveSession: 0,
    currentPendingApprovalNoLiveSessionExamples: [],
  };

  for (const name of fs.readdirSync(journal).filter((n) => /^task-\d+\.md$/i.test(n)).sort()) {
    const id = /^task-(\d+)\.md$/i.exec(name)[1];
    const p = path.join(journal, name);
    const text = fs.readFileSync(p, 'utf8');
    const starts = turnStarts(text);
    const { ids } = stateSessionIds(state, id);
    for (let i = 0; i < starts.length - 1; i++) {
      const body = text.slice(starts[i], starts[i + 1]);
      if (!/<!--\s*from:\s*overnight-agent\s*-->/i.test(body)) continue;
      result.agentTurns++;
      const stamp = /<!--\s*oa-by\s*:\s*session=([^\s>]+)[^>]*-->/i.exec(body);
      const writer = stamp ? stamp[1] : '(unstamped)';
      const isTask = stamp && ids.some((sid) => sid.toLowerCase() === writer.toLowerCase());
      if (isTask) continue;
      result.coordinatorTurns++;
      fs.rmSync(tempJournal, { recursive: true, force: true });
      fs.mkdirSync(tempJournal, { recursive: true });
      fs.writeFileSync(path.join(tempJournal, name), text.slice(0, starts[i]), 'utf8');
      const c = consent(tempJournal, state, planner, id);
      if (!c.consent_ok) continue;
      result.refused++;
      result.refusedTaskCounts[id] = (result.refusedTaskCounts[id] ?? 0) + 1;
      const kind = classifyTurn(body);
      if (kind === 'real_violation') {
        result.realViolations++;
        if (result.examples.realViolations.length < 5) result.examples.realViolations.push({ id, writer, reason: c.reason, heading: body.split(/\r?\n/, 1)[0] });
      } else {
        result.falseRefusals++;
        if (result.examples.falseRefusals.length < 5) result.examples.falseRefusals.push({ id, writer, reason: c.reason, heading: body.split(/\r?\n/, 1)[0] });
      }
    }
  }

  for (const name of fs.readdirSync(journal).filter((n) => /^task-\d+\.md$/i.test(n)).sort()) {
    const id = /^task-(\d+)\.md$/i.exec(name)[1];
    const c = consent(journal, state, planner, id);
    if (!c.consent_ok) continue;
    const sess = stateSessionIds(state, id);
    if (sess.liveBound) continue;
    result.currentPendingApprovalNoLiveSession++;
    if (result.currentPendingApprovalNoLiveSessionExamples.length < 10) {
      result.currentPendingApprovalNoLiveSessionExamples.push({ id, reason: c.reason });
    }
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  if (!process.argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
}
