export const JOURNAL_EXISTENCE = {
  UNKNOWN: 'unknown',
  EXISTS: 'exists',
  ABSENT: 'absent',
}

export function journalStateFromResult(result) {
  if (result?.exists) {
    return {
      existence: JOURNAL_EXISTENCE.EXISTS,
      path: result.path,
      contentStatus: 'ready',
    }
  }
  return {
    existence: JOURNAL_EXISTENCE.ABSENT,
    path: null,
    contentStatus: 'not-applicable',
  }
}

export function journalStateFromError(error, previous = {}) {
  const existence = error?.journal?.exists || previous.existence === JOURNAL_EXISTENCE.EXISTS
    ? JOURNAL_EXISTENCE.EXISTS
    : JOURNAL_EXISTENCE.UNKNOWN
  return {
    existence,
    path: error?.journal?.path ?? (existence === JOURNAL_EXISTENCE.EXISTS ? previous.path : null),
    contentStatus: 'error',
  }
}

export function canCreateJournal(existence) {
  return existence === JOURNAL_EXISTENCE.ABSENT
}
