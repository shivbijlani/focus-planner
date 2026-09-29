#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLedger } from '../extensions/coordinator-guard/guard-policy.mjs';

export function verifyCoordinatorGuard(entries, runId = null) {
  const allStarts = entries.filter((entry) => entry?.startedAt && (!runId || entry.runId === runId));
  const starts = runId ? allStarts : allStarts.slice(-1);
  const findings = [];
  if (!starts.length) findings.push(runId ? `${runId}: run start absent` : 'latest coordinator run start absent');
  for (const start of starts) {
    const rows = entries.filter((entry) =>
      entry?.kind === 'coordinator_guard' && entry.runId === start.runId);
    if (!rows.length) findings.push(`${start.runId}: coordinator guard activity absent`);
    const sends = new Set();
    for (const row of rows) {
      if (row.decision === 'pass' && row.toolName === 'send_session_message') {
        if (sends.has(row.targetSessionId)) {
          findings.push(`${start.runId}: duplicate permitted send to ${row.targetSessionId}`);
        }
        sends.add(row.targetSessionId);
      }
      if (row.decision === 'pass' && row.toolName !== 'task_complete' &&
          Date.parse(row.at) >= Date.parse(row.hardEnd)) {
        findings.push(`${start.runId}: ${row.toolName} permitted at/after ${row.hardEnd}`);
      }
    }
  }
  return { ok: findings.length === 0, runs: starts.length, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2] ??
    `${process.env.LOCALAPPDATA}/overnight-agent/run-ledger.jsonl`;
  const runArg = process.argv.indexOf('--run-id');
  const result = verifyCoordinatorGuard(readLedger(file), runArg >= 0 ? process.argv[runArg + 1] : null);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
