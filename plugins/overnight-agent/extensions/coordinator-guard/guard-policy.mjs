import { appendFileSync, readFileSync } from 'node:fs';

const HALF_HOUR_MS = 30 * 60 * 1000;
const HARD_END_LEAD_MS = 60 * 1000;

export function readLedger(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function coordinatorRun(entries, sessionId) {
  return [...entries].reverse().find((entry) =>
    entry?.runId === sessionId && typeof entry.startedAt === 'string') ?? null;
}

export function hardEndFor(startedAt) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) throw new Error(`invalid coordinator start: ${startedAt}`);
  return new Date((Math.floor(started / HALF_HOUR_MS) + 1) * HALF_HOUR_MS - HARD_END_LEAD_MS);
}

export function sleepDurationMs(toolName, toolArgs) {
  if (!/(?:^|[._-])powershell$/i.test(toolName)) return 0;
  const command = typeof toolArgs?.command === 'string' ? toolArgs.command : '';
  const match = command.match(/\bStart-Sleep\b(?<args>[^;\r\n]*)/i);
  if (!match) return 0;
  const args = match.groups.args;
  const read = (name) => args.match(new RegExp(`-${name}\\s+([0-9]+(?:\\.[0-9]+)?)`, 'i'))?.[1];
  const milliseconds = read('Milliseconds');
  const seconds = read('Seconds') ?? args.match(/^\s+([0-9]+(?:\.[0-9]+)?)(?:\s|$)/)?.[1];
  const minutes = read('Minutes');
  if (milliseconds) return Number(milliseconds);
  if (seconds) return Number(seconds) * 1000;
  if (minutes) return Number(minutes) * 60 * 1000;
  return 0;
}

function shortToolName(name) {
  return String(name).split(/[.:/]/).at(-1);
}

function targetSessionId(args) {
  return args?.session_id ?? args?.sessionId ?? null;
}

export function decideToolUse({ entries, sessionId, toolName, toolArgs, now }) {
  const run = coordinatorRun(entries, sessionId);
  if (!run) return { active: false };

  const at = new Date(now);
  const hardEnd = hardEndFor(run.startedAt);
  const tool = shortToolName(toolName);
  const target = targetSessionId(toolArgs);
  let decision = 'pass';
  let reason = null;

  if (at >= hardEnd && tool !== 'task_complete') {
    decision = 'deny';
    reason = `Coordinator hard end was ${hardEnd.toISOString()}. Write the one-line cut-short wrap-up, then call task_complete.`;
  } else {
    const sleepMs = sleepDurationMs(tool, toolArgs);
    if (sleepMs > 0 && at.getTime() + sleepMs >= hardEnd.getTime()) {
      decision = 'deny';
      reason = `This wait would cross the coordinator hard end at ${hardEnd.toISOString()}. Wrap up and call task_complete instead.`;
    } else if (tool === 'send_session_message' && target) {
      const alreadySent = entries.some((entry) =>
        entry?.kind === 'coordinator_guard' &&
        entry.runId === sessionId &&
        entry.toolName === 'send_session_message' &&
        entry.targetSessionId === target &&
        entry.decision === 'pass');
      if (alreadySent) {
        decision = 'deny';
        reason = `This coordinator run already attempted send_session_message for ${target}. One send per target session per run is enforced mechanically.`;
      }
    }
  }

  return {
    active: true,
    decision,
    reason,
    record: {
      kind: 'coordinator_guard',
      runId: sessionId,
      at: at.toISOString(),
      hardEnd: hardEnd.toISOString(),
      toolName: tool,
      ...(target ? { targetSessionId: target } : {}),
      decision,
    },
  };
}

export function appendGuardRecord(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}
