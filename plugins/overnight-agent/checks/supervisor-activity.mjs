// External, read-only evidence. No completion hook, scheduler pause, or DB writes.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function classifyEvents(text, { now, ownerStartedUtc }) {
  const ownerStarted = Date.parse(ownerStartedUtc);
  if (!Number.isFinite(ownerStarted) || ownerStarted > now) return { state: 'UNKNOWN', reason: 'owner creation time unavailable/invalid' };
  const pending = new Set();
  const toolNames = new Map();
  let turn = false;
  let terminal = false;
  let last = 0;
  let incarnation = false;
  let backgroundUnknown = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { return { state: 'UNKNOWN', reason: 'unreadable/partial event' }; }
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at) || at > now + 1000) return { state: 'UNKNOWN', reason: 'invalid event timestamp' };
    const d = e.data ?? {};
    // An old incarnation's unmatched tools cannot be declared finished by a resume.
    // Ignore its history only after the live owner's start has been independently proven.
    if (at < ownerStarted) continue;
    last = Math.max(last, at);
    if (e.type === 'session.start' || e.type === 'session.resume') incarnation = true;
    if (e.type === 'user.message' || e.type === 'assistant.turn_start') {
      turn = true;
      terminal = false;
    }
    if (e.type === 'assistant.turn_end') { turn = false; terminal = true; }
    const starts = { 'tool.execution_start': d.toolCallId, 'external_tool.requested': d.requestId, 'hook.start': d.hookInvocationId };
    const ends = { 'tool.execution_complete': d.toolCallId, 'external_tool.completed': d.requestId, 'hook.end': d.hookInvocationId };
    if (Object.hasOwn(starts, e.type)) {
      if (!starts[e.type]) return { state: 'UNKNOWN', reason: 'unidentified executing tool' };
      pending.add(starts[e.type]);
      if (e.type === 'tool.execution_start') toolNames.set(d.toolCallId, d.toolName);
    }
    if (Object.hasOwn(ends, e.type)) {
      if (!ends[e.type]) return { state: 'UNKNOWN', reason: 'unidentified completed tool' };
      pending.delete(ends[e.type]);
      // Completion of the tool *invocation* can hand back an outstanding background
      // command. Without a correlated end signal, do not reinterpret it as idle.
      if (e.type === 'tool.execution_complete' && /(?:powershell|task|agent)/i.test(toolNames.get(d.toolCallId) ?? '') &&
          /still running|running in (?:the )?background|Agent started in background/i.test(JSON.stringify(d.result ?? ''))) backgroundUnknown = true;
    }
    // session.task_complete and log silence are deliberately NOT idle signals.
  }
  if (pending.size || turn) return { state: 'BUSY', reason: 'executing turn/tool', outstanding: [...pending], lastEventUtc: last ? new Date(last).toISOString() : null };
  if (backgroundUnknown) return { state: 'UNKNOWN', reason: 'background work completion not proven' };
  if (!incarnation || !terminal || !last) return { state: 'UNKNOWN', reason: 'no current-incarnation terminal turn evidence' };
  // A stable terminal log can be old because the conversation is genuinely idle.
  // Freshness applies to this live DB/process/file observation, not the age of a note.
  return { state: 'IDLE', reason: 'terminal turn, no outstanding tools', lastEventUtc: new Date(last).toISOString() };
}

export function measureActivity({ dbPath, sessionRoot, processes, ownedIds, now, workflowName = 'Overnight Agent' }) {
  const measuredUtc = new Date(now).toISOString();
  const sessions = [];
  const unknown = [];
  let db;
  let newestRun = null;
  let resumed = [];
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const rows = db.prepare('SELECT id, is_running FROM sessions').all();
    const running = new Set(rows.filter(r => r.is_running === 1).map(r => r.id));
    const known = new Map(rows.map(r => [r.id, r]));
    newestRun = db.prepare(`SELECT r.* FROM workflow_runs r JOIN workflows w ON w.id=r.task_id
      WHERE w.name=? ORDER BY r.started_at DESC LIMIT 1`).get(workflowName) ?? null;
    resumed = db.prepare("SELECT id, session_id, started_at, status FROM workflow_runs WHERE trigger='schedule' ORDER BY started_at DESC LIMIT 20").all();
    db.exec('COMMIT');
    const covered = new Set();
    const inventory = new Map(processes.map(p => [p.id, p]));
    for (const dir of fs.readdirSync(sessionRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const folder = path.join(sessionRoot, dir.name);
      const locks = fs.readdirSync(folder).filter(n => /^inuse\.\d+\.lock$/.test(n));
      const owners = locks.map(n => inventory.get(Number(n.split('.')[1]))).filter(Boolean);
      if (!owners.length && !running.has(dir.name)) continue;
      if (owners.length !== 1) {
        sessions.push({ id: dir.name, state: running.has(dir.name) ? 'BUSY' : 'UNKNOWN', reason: 'missing/ambiguous live owner' });
        running.delete(dir.name);
        continue;
      }
      const owner = owners[0];
      // Locks identify a PID, not a process incarnation. Both the exe and a start/resume
      // event newer than that process must agree, otherwise PID reuse is UNKNOWN.
      covered.add(owner.id);
      let evidence;
      try {
        if (!owner.path || path.basename(owner.path).toLowerCase() !== 'copilot.exe') throw new Error('lock PID is not a session host');
        const log = path.join(folder, 'events.jsonl');
        const before = fs.statSync(log);
        if (before.size > 32 * 1024 * 1024) throw new Error('event log exceeds bounded 32 MiB scan');
        evidence = classifyEvents(fs.readFileSync(log, 'utf8'), { now, ownerStartedUtc: owner.startedUtc });
        const after = fs.statSync(log);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) evidence = { state: 'UNKNOWN', reason: 'log changed during observation' };
      } catch (error) { evidence = { state: 'UNKNOWN', reason: error.message }; }
      if (known.get(dir.name)?.is_running === 1 && evidence.state === 'IDLE') evidence = { ...evidence, state: 'UNKNOWN', reason: 'DB executing flag contradicts terminal events' };
      if (known.get(dir.name)?.is_running === 0 && evidence.state === 'BUSY') evidence = { ...evidence, state: 'UNKNOWN', reason: 'DB idle flag contradicts executing events' };
      sessions.push({ id: dir.name, ownerId: owner.id, ...evidence });
      running.delete(dir.name);
    }
    for (const id of running) sessions.push({ id, state: 'BUSY', reason: 'app records executing session without local evidence' });
    for (const p of processes) {
      if (ownedIds.includes(p.id) && path.basename(p.path || '').toLowerCase() === 'copilot.exe' && !covered.has(p.id)) {
        unknown.push(`owned host ${p.id} has no session evidence`);
      }
    }
  } catch (error) { unknown.push(error.message); }
  finally { db?.close(); }
  const state = sessions.some(s => s.state === 'BUSY') ? 'BUSY'
    : unknown.length || sessions.some(s => s.state === 'UNKNOWN') ? 'UNKNOWN' : 'IDLE';
  return { state, measuredUtc, sessions, unknown, newestRun, scheduledRuns: resumed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
    console.log(JSON.stringify(measureActivity(input)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
