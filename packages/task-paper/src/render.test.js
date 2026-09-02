import { describe, it, expect } from 'vitest'
import { buildPaper } from './paper.js'
import { renderPaper, slugify } from './render.js'

const SENTINEL = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->'

const JOURNAL = [
  '# Task 468: ship the paper doc',
  '',
  'Framing note from Shiv.',
  '',
  '## 2026-08-11',
  '',
  '<!-- from: me -->',
  'prioritise the prerequisites.',
  '',
  '---',
  SENTINEL,
  '',
  '## \u{1F319} Overnight Agent \u2014 first pass',
  '',
  '<!-- from: overnight-agent -->',
  '',
  '**Status:** In-progress \u00B7 2026-08-11',
  '',
  'Older summary.',
  '',
  '### Run log',
  '**2026-08-11:** first thing.',
  '',
  '<!-- /overnight-agent turn-end -->',
  '',
  '## \u{1F319} Overnight Agent \u2014 second pass',
  '',
  '<!-- from: overnight-agent -->',
  '',
  '**Status:** In-progress \u00B7 2026-08-12',
  '',
  'The settled current state.',
  '',
  '### What changed',
  'A [link](https://example.com/pr/1) and `code`.',
  '',
  '### Why it is safe',
  'Second section body.',
  '',
  '### Deeper detail',
  'Third section body.',
  '',
  '### Run log',
  '**2026-08-12:** second thing.',
  '',
  '**Needs from you:** a decision on the format.',
  '',
  '<!-- /overnight-agent turn-end -->',
].join('\n')

const paper = buildPaper(JOURNAL, { taskId: '468' })
const html = renderPaper(paper, { journalHref: '../task-468.md' })

// NOTE: every assertion below reads the RAW HTML SOURCE, never rendered text.
// Recorded on #286: `innerText` omits content inside collapsed `<details>`, and
// collapse-by-default is the point of this format, so a text-based check reports a
// correct document as broken. That is the dangerous direction, because the natural
// reaction is to "fix" a document that was already right.

describe('renderPaper — document shape', () => {
  it('is a complete, standalone HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta name="viewport"')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it('needs no network: no external stylesheet, script or font', () => {
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(?:css|js|woff2?)/)
  })

  it('puts the task id and title in the title element', () => {
    expect(html).toContain('<title>Task #468 \u2014 ship the paper doc</title>')
  })

  it('shows the status as a badge', () => {
    expect(html).toContain('class="badge">In progress</span>')
  })
})

describe('renderPaper — collapsible sections', () => {
  it('renders each section of the current turn as a <details>', () => {
    const count = (html.match(/<details/g) || []).length
    expect(count).toBeGreaterThanOrEqual(3)
  })

  it('opens the first two sections and collapses the rest', () => {
    // Collapse-by-default for everything hides the answer behind a click, which is
    // the opposite of the goal; opening everything is just the journal again.
    expect(html).toContain('<summary>What changed</summary>')
    const whatChanged = html.indexOf('<summary>What changed</summary>')
    const deeper = html.indexOf('<summary>Deeper detail</summary>')
    expect(html.slice(0, whatChanged)).toMatch(/<details open>\s*$/)
    expect(html.slice(0, deeper)).toMatch(/<details>\s*$/)
  })

  it('gives each section a stable anchor so a comment can cite it', () => {
    expect(html).toContain('id="what-changed"')
    expect(html).toContain('id="why-it-is-safe"')
  })
})

describe('renderPaper — the ask is above the fold', () => {
  it('renders the open ask near the top, before the sections', () => {
    // In the journal the ask is the last line of the last turn, which is exactly
    // where it gets missed.
    const ask = html.indexOf('What I need from you')
    const sections = html.indexOf('Where it stands')
    expect(ask).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(sections)
    expect(html).toContain('a decision on the format')
  })

  it('omits the ask block entirely when nothing is needed', () => {
    const quiet = buildPaper(JOURNAL.replace('**Needs from you:** a decision on the format.', '**Needs from you:** none.'), { taskId: '468' })
    expect(renderPaper(quiet)).not.toContain('What I need from you')
  })
})

describe('renderPaper — history is present but out of the way', () => {
  it('keeps the superseded turn in the appendix, not the body', () => {
    const appendix = html.indexOf('>Appendix<')
    const older = html.indexOf('Older summary.')
    expect(appendix).toBeGreaterThan(-1)
    expect(older).toBeGreaterThan(appendix)
  })

  it('puts the Run log in the appendix', () => {
    const appendix = html.indexOf('>Appendix<')
    expect(html.indexOf('second thing.')).toBeGreaterThan(appendix)
  })

  it('collapses the appendix by default', () => {
    const idx = html.indexOf('<summary>Run log')
    expect(html.slice(0, idx)).toMatch(/<details>\s*$/)
  })
})

describe('renderPaper — the user is the instruction channel', () => {
  it("shows everything the user has said, expanded", () => {
    expect(html).toContain('Your instructions')
    expect(html).toContain('prioritise the prerequisites.')
  })

  it('says where to leave an instruction, since the page itself is regenerated', () => {
    expect(html).toContain('reply in the journal or in Telegram')
  })
})

describe('renderPaper — safety and determinism', () => {
  it('escapes HTML that appears in journal prose', () => {
    const nasty = buildPaper(
      `# Task 1: x\n\n---\n${SENTINEL}\n\n## \u{1F319} Overnight Agent\n\n<!-- from: overnight-agent -->\n\n**Status:** Done\n\n<img src=x onerror=alert(1)>\n`,
      { taskId: '1' },
    )
    const out = renderPaper(nasty)
    expect(out).not.toContain('<img src=x onerror')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('produces byte-identical output for identical input', () => {
    // This is what makes "regenerate every run" safe. A clock in the output would
    // rewrite every file on every run and destroy the only signal that matters --
    // whether the task actually moved.
    expect(renderPaper(buildPaper(JOURNAL, { taskId: '468' }), { journalHref: '../task-468.md' }))
      .toBe(html)
  })

  it('contains no generation timestamp', () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(html).not.toContain(today)
  })

  it('links back to the journal as the source of truth', () => {
    expect(html).toContain('href="../task-468.md"')
  })

  it('dates the page from what the turn says about itself, not the last date header', () => {
    // A journal only carries a `## <date>` header when the USER writes one, so an
    // agent turn appended under an older header would otherwise be reported under
    // that older date -- understating how current the page is.
    expect(html).toContain('updated 2026-08-12')
    expect(html).not.toContain('updated 2026-08-11')
  })
})

describe('renderPaper — a task with no agent turn yet', () => {
  it('renders the framing rather than an empty page', () => {
    const out = renderPaper(buildPaper('# Task 7: nothing yet\n\nJust notes.\n', { taskId: '7' }))
    expect(out).toContain('No agent turn has been written')
    expect(out).toContain('Just notes.')
  })
})

describe('slugify', () => {
  it.each([
    ['What changed', 'what-changed'],
    ['Why it is safe?', 'why-it-is-safe'],
    ['  ', 'section'],
    ['\u{1F319} Overnight', 'overnight'],
  ])('%s -> %s', (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })
})
