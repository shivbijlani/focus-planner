// pause.mjs -- user-authored task pauses and the narrow evidence that resumes them (#540/#734).
import fs from 'node:fs';
import { PausedStatus } from './status.mjs';
import { PsDate, tryParseDateTime } from '../core/psdate.mjs';
import { get, psStr, lowerInvariant, ciContains } from '../core/net.mjs';
import { testPath } from '../core/fsx.mjs';

export function testUserPaused(row, journalFacts) {
  if (!row) return false;
  if (lowerInvariant(psStr(get(row, 'status_by'))) !== 'user') return false;
  if (!ciContains(PausedStatus, lowerInvariant(psStr(get(row, 'status'))))) return false;
  if (journalFacts && get(journalFacts, 'HasTrailingHuman') && testResumeIsAfterPause(row, journalFacts)) return false;
  return true;
}

export function testResumeIsAfterPause(row, journalFacts) {
  if (!row || !journalFacts) return false;
  const pausedAt = getIsoDate(get(row, 'paused_at'));
  if (!pausedAt) return false;
  const seenAt = getIsoDate(get(row, 'unanswered_user_message_at'));
  if (seenAt && seenAt.compare(pausedAt) > 0) return true;
  try {
    const p = psStr(get(journalFacts, 'Path'));
    if (p && testPath(p)) {
      const written = PsDate.fromInstant(fs.statSync(p).mtimeMs, 'Local');
      if (written.compare(pausedAt) > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function getIsoDate(value) {
  if (!value) return null;
  if (value instanceof PsDate) return value.toLocalTime();
  const parsed = tryParseDateTime(psStr(value));
  if (!parsed) return null;
  return parsed.toLocalTime();
}
