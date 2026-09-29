import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const RUN_CADENCE_MINUTES = 30;
export const MISSED_SLOT_THRESHOLD = 2;

export function gapHeadline(gap) {
  return `⚠ GAP: no runs from ${gap.from} to ${gap.to} (${gap.missedSlots} slots)`;
}

export function readRunLedger(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`invalid run ledger JSON on line ${index + 1}`);
    }
  });
}

export function detectRunGap(previous, startedAt, cadenceMinutes = RUN_CADENCE_MINUTES) {
  if (!previous?.startedAt) return null;
  const fromMs = Date.parse(previous.startedAt);
  const toMs = Date.parse(startedAt);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    throw new Error('run ledger timestamps must be valid and increasing');
  }
  const cadenceMs = cadenceMinutes * 60 * 1000;
  const missedSlots = Math.max(0, Math.floor((toMs - fromMs) / cadenceMs) - 1);
  if (missedSlots <= MISSED_SLOT_THRESHOLD) return null;
  return { from: previous.startedAt, to: startedAt, missedSlots };
}

export function recordRunStart(file, {
  now = new Date(),
  trigger = process.env.OA_RUN_TRIGGER || process.env.COPILOT_WORKFLOW_TRIGGER || null,
  runId = process.env.OA_RUN_ID || process.env.COPILOT_AGENT_SESSION_ID || randomUUID(),
  cadenceMinutes = RUN_CADENCE_MINUTES,
} = {}) {
  const entries = readRunLedger(file);
  const startedAt = now.toISOString();
  const gap = detectRunGap(entries.at(-1), startedAt, cadenceMinutes);
  const entry = { startedAt, trigger, runId };
  if (gap) entry.gap = gap;
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function gapForAlert(entry, previousGap) {
  if (entry.gap) {
    return {
      ...entry.gap,
      runId: entry.runId,
      headline: gapHeadline(entry.gap),
      alertedAt: null,
    };
  }
  return previousGap?.alertedAt ? null : previousGap ?? null;
}
