import { describe, it, expect } from 'vitest'
import { liveStatus, liveJournalStatus, digestStatus, normaliseStatus, statusStampDate } from './liveStatus.js'

// The shapes below are the ones that actually occur in the live journal corpus.
// Each test names the fault it pins, because every one of these was a real defect
// before it was a test.

const SENTINEL = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->'
const AGENT = '<!-- from: overnight-agent -->'
const USER = '<!-- from: me -->'

/** A journal with a frozen block header and any number of appended turns. */
function journal({ blockStatus, turns = [] }) {
  const head = [
    '# Task 42: Demo',
    '',
    '---',
    SENTINEL,
    '',
    '## \u{1F319} Overnight Agent',
    '',
    blockStatus ? `**Status:** ${blockStatus}` : '',
    '',
  ].join('\n')
  const body = turns
    .map((t) =>
      [
        `## ${t.date}`,
        '',
        t.who === 'user' ? USER : AGENT,
        '',
        t.who === 'user' ? '' : '## \u{1F319} Overnight Agent',
        '',
        t.status ? `**Status:** ${t.status}` : '',
        '',
        t.body || '',
        '',
      ].join('\n'),
    )
    .join('\n')
  return `${head}\n${body}`
}

describe('normaliseStatus — the dialect fault (#202)', () => {
  // The old reader captured `([A-Za-z-]+)`, which stops at a space. `In progress`
  // therefore became the bare token `in` — not a status, but a truthy string, so
  // every `TERMINAL.has(status)` test answered "not terminal" for the wrong reason
  // and looked like it had worked. 18 of drift-sweep's 32 rows were this.
  it('reads the human dialect "In progress" as in-progress, not "in"', () => {
    expect(normaliseStatus('In progress')).toBe('in-progress')
  })

  it('reads the hyphenated dialect too', () => {
    expect(normaliseStatus('In-progress')).toBe('in-progress')
    expect(normaliseStatus('in-progress')).toBe('in-progress')
  })

  it('folds the completion synonyms onto one canonical value', () => {
    expect(normaliseStatus('Done')).toBe('done')
    expect(normaliseStatus('Complete')).toBe('done')
    expect(normaliseStatus('Completed')).toBe('done')
    expect(normaliseStatus('Skipped')).toBe('skip')
  })

  it('drops a trailing em-dash clause rather than failing to parse the line', () => {
    expect(normaliseStatus('Done \u2014 shipped and merged')).toBe('done')
  })

  it('returns null for a phrase that names no status, instead of a partial token', () => {
    expect(normaliseStatus('line corrected 2026-08-25')).toBeNull()
    expect(normaliseStatus('')).toBeNull()
    expect(normaliseStatus(null)).toBeNull()
  })
})

describe('statusStampDate — the date the line asserts about itself', () => {
  it('takes the stamp segment, not the first date mentioned in prose', () => {
    expect(statusStampDate('**Status:** Done \u2014 shipped 2026-07-18 \u00B7 2026-08-22')).toBe('2026-08-22')
  })

  it('takes the stamp segment, not the last date mentioned in prose', () => {
    expect(statusStampDate('**Status:** Done \u00B7 2026-08-23 \u2014 trip completed 2026-08-01')).toBe('2026-08-23')
  })

  it('falls back to the only date on an ordinary one-date line', () => {
    expect(statusStampDate('**Status:** Proposed 2026-08-23')).toBe('2026-08-23')
  })
})

describe('liveStatus — the staleness fault (#202)', () => {
  // This is the defect the issue was filed for. `write-turn.ps1` is append-only by
  // design, so nothing has rewritten a block header since 2026-08-26. The header
  // freezes while the agent's real status moves on in appended turns.
  it('prefers a newer turn over a frozen block header', () => {
    const text = journal({
      blockStatus: 'blocked \u00B7 plan v3 \u00B7 2026-06-19',
      turns: [{ date: '2026-08-27', who: 'agent', status: 'Done \u00B7 2026-08-27', body: 'finished' }],
    })
    expect(liveJournalStatus(text)).toBe('done')
  })

  // The mirror image, and the reason arbitration is by DATE rather than by position.
  // The loop rewrites the BLOCK's Status line every run while a turn only sometimes
  // restates it, so an unconditional turn preference reports a stale turn as live.
  it('prefers a newer block over an older turn', () => {
    const text = journal({
      blockStatus: 'Done \u00B7 2026-08-30',
      turns: [{ date: '2026-08-01', who: 'agent', status: 'in-progress \u00B7 2026-08-01', body: 'working' }],
    })
    expect(liveJournalStatus(text)).toBe('done')
  })

  it('keeps the turn when the two carry the same date', () => {
    const text = journal({
      blockStatus: 'blocked \u00B7 2026-08-27',
      turns: [{ date: '2026-08-27', who: 'agent', status: 'Done \u00B7 2026-08-27', body: 'finished' }],
    })
    expect(liveJournalStatus(text)).toBe('done')
  })

  it('takes the newest of several turns, not the first or the last position', () => {
    const text = journal({
      blockStatus: 'proposed \u00B7 2026-06-01',
      turns: [
        { date: '2026-08-01', who: 'agent', status: 'in-progress \u00B7 2026-08-01', body: 'a' },
        { date: '2026-08-20', who: 'agent', status: 'Done \u00B7 2026-08-20', body: 'b' },
      ],
    })
    expect(liveJournalStatus(text)).toBe('done')
  })

  it('dates an undated turn from the chat header it sits under', () => {
    const text = journal({
      blockStatus: 'blocked \u00B7 2026-06-19',
      turns: [{ date: '2026-08-27', who: 'agent', status: 'Done', body: 'finished' }],
    })
    const r = liveStatus(text)
    expect(r.status).toBe('done')
    expect(r.effDate).toBe('2026-08-27')
  })

  it('reports null, not a partial token, when no status is stated anywhere', () => {
    expect(liveJournalStatus('# Task 9: no block at all')).toBeNull()
    expect(liveJournalStatus('')).toBeNull()
    expect(liveJournalStatus(null)).toBeNull()
  })

  // Falsified rule #1 from the corpus: "take the last Status line in the slice".
  // Some journals follow the real line with an italic prose note that also opens
  // with the word Status, which normalises to nothing.
  it('ignores a prose note that merely opens with the word Status', () => {
    const text = [
      '# Task 42: Demo',
      '',
      '---',
      SENTINEL,
      '',
      '## \u{1F319} Overnight Agent',
      '',
      '**Status:** Done \u00B7 2026-08-25',
      '',
      '*Status line corrected 2026-08-25: an earlier turn said blocked.*',
      '',
    ].join('\n')
    expect(liveJournalStatus(text)).toBe('done')
  })

  // Falsified rule #2: "take the last CANONICAL line" — still position, and position
  // is not time. A rewritten-in-place block can sit ABOVE a historical sub-block.
  it('does not walk the task backwards to an older sub-block below it', () => {
    const text = [
      '# Task 42: Demo',
      '',
      '---',
      SENTINEL,
      '',
      '## \u{1F319} Overnight Agent',
      '',
      '**Status:** Done \u00B7 2026-08-21',
      '',
      '### \u{1F319} Overnight Agent \u2014 2026-07-17',
      '',
      '**Status:** blocked \u00B7 2026-07-17',
      '',
    ].join('\n')
    expect(liveJournalStatus(text)).toBe('done')
  })
})

describe('liveStatus — a user reply ends the agent turn that precedes it', () => {
  it('does not read the user block as part of the agent turn', () => {
    const text = journal({
      blockStatus: 'blocked \u00B7 2026-06-19',
      turns: [
        { date: '2026-08-27', who: 'agent', status: 'Done \u00B7 2026-08-27', body: 'finished' },
        { date: '2026-08-28', who: 'user', body: 'thanks' },
      ],
    })
    expect(liveJournalStatus(text)).toBe('done')
  })
})

describe('digestStatus — the fix may only ever ADD information (#202)', () => {
  // Measured on task 267: a journal that EXPLAINS the marker convention contains the
  // literal sentinel inside backticks, and `lastIndexOf` finds the quote rather than
  // the real block. Its live verdict is null while its header says `done`. Without the
  // fallback this fix would push a finished task back INTO the queue — the exact
  // defect #202 exists to remove.
  const QUOTES_THE_SENTINEL = [
    '# Task 267: Demo',
    '',
    '---',
    SENTINEL,
    '',
    '## \u{1F319} Overnight Agent',
    '',
    '**Status:** done \u00B7 already fixed at HEAD \u00B7 2026-06-15',
    '',
    AGENT,
    '',
    '- **Where it lives:** it scans for a sentinel like `<!-- OVERNIGHT-AGENT ... -->`',
    '  and prepends `<!-- from: me -->` before your text.',
    '',
  ].join('\n')

  it('keeps the header verdict when the live reader finds nothing', () => {
    expect(liveJournalStatus(QUOTES_THE_SENTINEL)).toBeNull()
    expect(digestStatus(QUOTES_THE_SENTINEL, 'done')).toBe('done')
  })

  it('lets the live verdict win over a frozen header', () => {
    const text = journal({
      blockStatus: 'blocked \u00B7 2026-06-19',
      turns: [{ date: '2026-08-27', who: 'agent', status: 'Done \u00B7 2026-08-27', body: 'x' }],
    })
    expect(digestStatus(text, 'blocked')).toBe('done')
  })

  it('lets the live verdict win in the reopening direction too', () => {
    const text = journal({
      blockStatus: 'done \u00B7 2026-06-19',
      turns: [{ date: '2026-08-27', who: 'agent', status: 'In progress \u00B7 2026-08-27', body: 'x' }],
    })
    expect(digestStatus(text, 'done')).toBe('in-progress')
  })

  it('is null only when neither reader knows anything', () => {
    expect(digestStatus('# Task 9: nothing', null)).toBeNull()
    expect(digestStatus('', null)).toBeNull()
  })
})
