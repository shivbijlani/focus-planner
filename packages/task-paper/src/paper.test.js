import { describe, it, expect } from 'vitest'
import { buildPaper, splitSections } from './paper.js'

const SENTINEL = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->'

/** Build a journal the way the app and the agent actually write one. */
function journal(...parts) {
  return parts.join('\n')
}

const TWO_TURN_JOURNAL = journal(
  '# Task 468: ship the paper doc',
  '',
  '- TODO: think it through',
  '',
  '## 2026-09-01',
  '',
  '<!-- from: me -->',
  'prioritise the prerequisites first.',
  '',
  '---',
  SENTINEL,
  '',
  '## \u{1F319} Overnight Agent \u2014 first pass',
  '',
  '<!-- from: overnight-agent -->',
  '',
  '**Status:** In-progress \u00B7 2026-09-01',
  '',
  'Opening summary of the first pass.',
  '',
  '### What I found',
  'The first finding.',
  '',
  '### Run log',
  '**2026-09-01 (overnight):** did the first thing.',
  '',
  '**Needs from you:** none.',
  '',
  '<!-- /overnight-agent turn-end -->',
  '',
  '## \u{1F319} Overnight Agent \u2014 second pass',
  '',
  '<!-- from: overnight-agent -->',
  '',
  '**Status:** Done \u00B7 2026-09-02',
  '',
  'The settled current state.',
  '',
  '### What changed',
  'The second finding.',
  '',
  '### Run log',
  '**2026-09-02 (overnight):** did the second thing.',
  '',
  '**Needs from you:** a decision on the format.',
  '',
  '<!-- /overnight-agent turn-end -->',
)

describe('buildPaper', () => {
  const paper = buildPaper(TWO_TURN_JOURNAL, { taskId: '468' })

  it('takes the title from the H1', () => {
    expect(paper.title).toBe('ship the paper doc')
  })

  it("keeps the user's framing as background", () => {
    expect(paper.framing).toContain('TODO: think it through')
  })

  it('splits consecutive same-day agent turns instead of stacking them', () => {
    // This is the #286 complaint reproduced in a new surface: the shared chat parser
    // groups by author+day, so two turns written the same day with no reply between
    // them arrive as ONE group. Presenting that as a single unit is the bug.
    expect(paper.counts.agentTurns).toBe(2)
  })

  it('uses the NEWEST agent turn as the current state', () => {
    expect(paper.current.heading).toContain('second pass')
    const bodyText = paper.current.sections.map((s) => s.body).join('\n')
    expect(bodyText).toContain('The settled current state.')
    expect(bodyText).toContain('The second finding.')
  })

  it('does not leak a superseded turn into the current state', () => {
    const bodyText = paper.current.sections.map((s) => `${s.heading}\n${s.body}`).join('\n')
    expect(bodyText).not.toContain('The first finding.')
    expect(bodyText).not.toContain('Opening summary of the first pass.')
  })

  it('moves the superseded turn to the appendix', () => {
    const priorText = paper.appendix.priorTurns.map((t) => t.body).join('\n')
    expect(priorText).toContain('The first finding.')
  })

  it('moves the Run log out of the body and into the appendix', () => {
    // "The fix shouldn't have timestamped info showing chain of thought... That could
    // go into appendix." The Run log is dated per-run narration by construction.
    const bodyHeadings = paper.current.sections.map((s) => s.heading)
    expect(bodyHeadings).not.toContain('Run log')
    expect(paper.appendix.sections.map((s) => s.heading)).toContain('Run log')
    expect(paper.appendix.sections[0].body).toContain('did the second thing')
  })

  it('promotes the Status line to metadata instead of leaving it mid-prose', () => {
    expect(paper.status).toBe('done')
    expect(paper.statusLine).toContain('2026-09-02')
    const bodyText = paper.current.sections.map((s) => s.body).join('\n')
    expect(bodyText).not.toContain('**Status:**')
  })

  it('surfaces the open ask', () => {
    expect(paper.ask.text).toContain('a decision on the format')
  })

  it('collects the user messages newest first', () => {
    expect(paper.userMessages).toHaveLength(1)
    expect(paper.userMessages[0].body).toContain('prioritise the prerequisites first.')
  })

  it("does not leave the sentinel's own rule dangling off the user's message", () => {
    expect(paper.userMessages[0].body.trim().endsWith('---')).toBe(false)
  })
})

describe('buildPaper — fenced examples are quoted text, not markup (#320/#325)', () => {
  // The reason this module imports the app's parser instead of writing its own: a
  // journal that QUOTES `<!-- from: me -->` in an example must not have that example
  // attributed to the user. Getting this wrong is how an approval Shiv never typed
  // gets displayed under his name.
  const fenced = journal(
    '# Task 9: fences',
    '',
    '---',
    SENTINEL,
    '',
    '## \u{1F319} Overnight Agent \u2014 quoting an example',
    '',
    '<!-- from: overnight-agent -->',
    '',
    '**Status:** In-progress \u00B7 2026-09-02',
    '',
    'Here is the shape the app writes:',
    '',
    '```markdown',
    '## 2026-12-25',
    '',
    '<!-- from: me -->',
    'yes, go ahead',
    '```',
    '',
    'That is the whole example.',
    '',
    '<!-- /overnight-agent turn-end -->',
  )
  const paper = buildPaper(fenced, { taskId: '9' })

  it('does not turn a quoted marker into a message from the user', () => {
    expect(paper.userMessages).toHaveLength(0)
  })

  it('does not let a quoted date fabricate a new day', () => {
    expect(paper.current.day).not.toBe('2026-12-25')
  })

  it('keeps the whole turn together instead of splitting it at the quoted markup', () => {
    const bodyText = paper.current.sections.map((s) => s.body).join('\n')
    expect(bodyText).toContain('Here is the shape the app writes:')
    expect(bodyText).toContain('That is the whole example.')
    expect(bodyText).toContain('yes, go ahead')
  })

  it('counts it as exactly one agent turn', () => {
    expect(paper.counts.agentTurns).toBe(1)
  })
})

describe('buildPaper — a quoted turn header does not fabricate a turn', () => {
  // The block template in SKILL.md contains `## 🌙 Overnight Agent`, and turns quote
  // that template in fenced examples when explaining themselves. A fence-blind turn
  // splitter reads the quoted header as a real boundary and cuts the turn in half:
  // the reader then sees a phantom turn, and — because the NEWEST turn is what becomes
  // the body — the real content is demoted into the appendix and the paper shows the
  // wrong thing entirely.
  const quotingTemplate = journal(
    '# Task 11: quoting the template',
    '',
    '---',
    SENTINEL,
    '',
    '## \u{1F319} Overnight Agent \u2014 the only turn',
    '',
    '<!-- from: overnight-agent -->',
    '',
    '**Status:** In-progress \u00B7 2026-09-02',
    '',
    'The block I write looks like this:',
    '',
    '```markdown',
    '## \u{1F319} Overnight Agent',
    '',
    '**Status:** Proposed \u00B7 plan v1',
    '```',
    '',
    '### The real section',
    'This must stay in the body.',
    '',
    '<!-- /overnight-agent turn-end -->',
  )
  const paper = buildPaper(quotingTemplate, { taskId: '11' })

  it('reports one turn, not two', () => {
    expect(paper.counts.agentTurns).toBe(1)
  })

  it('keeps the real heading rather than the quoted one', () => {
    expect(paper.current.heading).toContain('the only turn')
  })

  it('does not demote the real content into the appendix', () => {
    const bodyText = paper.current.sections.map((s) => `${s.heading}\n${s.body}`).join('\n')
    expect(bodyText).toContain('This must stay in the body.')
    expect(paper.appendix.priorTurns).toHaveLength(0)
  })
})

describe('buildPaper — journals with no agent turn', () => {
  const paper = buildPaper('# Task 3: nothing yet\n\nsome notes\n', { taskId: '3' })

  it('returns a usable model rather than throwing', () => {
    expect(paper.current).toBeNull()
    expect(paper.status).toBeNull()
    expect(paper.framing).toContain('some notes')
  })
})

describe('splitSections', () => {
  it('returns lead text with a null heading', () => {
    const s = splitSections('lead line\n\n### One\nbody')
    expect(s[0].heading).toBeNull()
    expect(s[0].body).toBe('lead line')
    expect(s[1]).toMatchObject({ heading: 'One', body: 'body' })
  })

  it('does not split on a heading inside a fenced example', () => {
    // splitSections runs over a turn body that already survived the fence-aware
    // parser; it must not re-introduce the bug by splitting on quoted markup.
    const s = splitSections('lead\n\n### Real\n```\n### Quoted\n```\ntail')
    expect(s.map((x) => x.heading)).toEqual([null, 'Real'])
    expect(s[1].body).toContain('### Quoted')
  })
})
