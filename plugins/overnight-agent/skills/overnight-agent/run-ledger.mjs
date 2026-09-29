import { appendFileSync, readFileSync } from 'node:fs';

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

// The ledger carries two line kinds: run STARTS (#762) and per-run DECISION records (#561).
// Cadence is a property of starts alone, so a decision line appended between two runs must not
// be mistaken for the previous start -- that would make every gap invisible after the first
// decision was recorded, which is the exact failure the gap detector exists to prevent.
export function lastRunStart(entries) {
  return [...entries].reverse().find((entry) => entry?.startedAt) ?? null;
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

// GH #772: this is the ONLY function that appends a run start, and it refuses to guess a runId.
// The old default (`OA_RUN_ID` -> `COPILOT_AGENT_SESSION_ID` -> a fresh `randomUUID()`) meant
// ANY session -- a manual chat, a diagnostics run, anything with an ambient session id or none
// at all -- produced a plausible-looking runId and got a real line in the ledger. There is no
// implicit path: a caller must name the run explicitly, which in practice means only the
// coordinator (see check-critical-tools.mjs's `--run <runId>`) ever reaches this function.
export function recordRunStart(file, {
  now = new Date(),
  trigger = process.env.OA_RUN_TRIGGER || process.env.COPILOT_WORKFLOW_TRIGGER || null,
  runId,
  cadenceMinutes = RUN_CADENCE_MINUTES,
} = {}) {
  if (!runId) throw new Error('recordRunStart requires an explicit runId; there is no ambient fallback (GH #772)');
  const entries = readRunLedger(file);
  const startedAt = now.toISOString();
  const gap = detectRunGap(lastRunStart(entries), startedAt, cadenceMinutes);
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
