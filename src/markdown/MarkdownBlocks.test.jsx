import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownBlocks } from './MarkdownBlocks.jsx'
import { renderJournalLines } from './markdownRender.jsx'

// A journal exercising every construct the renderer supports.
const JOURNAL = [
  'Plain **bold** and *italic* and `code` and _under_ text.',
  '## A subhead',
  '- bullet one with [a link](https://example.com)',
  '- [ ] open todo',
  '- [x] done todo',
  '- TODO: legacy todo',
  '- DONE: legacy done',
  '1. numbered',
  '',
  '> quoted **line**',
  '> second',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | [j](journal/task-1.md) |',
  '',
  '---',
  '![img](https://example.com/x.png)',
  '```js',
  'const x = 1',
  '```',
]

const html = (lines, opts) => renderToStaticMarkup(<MarkdownBlocks lines={lines} options={opts} />)

describe('MarkdownBlocks (journal renderer, extracted from App.jsx)', () => {
  it('renders the journal subset exactly as before (no options)', () => {
    expect(html(JOURNAL)).toMatchSnapshot()
  })

  it('journal mode renders fences as paragraphs (unchanged legacy behaviour)', () => {
    expect(html(['```', 'x', '```'])).toBe('<p class="jc-p">```</p><p class="jc-p">x</p><p class="jc-p">```</p>')
  })

  it('numbers toggleable items in file order via ctx', () => {
    const ctx = { n: 0 }
    renderJournalLines(['- [ ] a', '- TODO: b', 'text', '- DONE: c'], () => {}, () => {}, ctx)
    expect(ctx.n).toBe(3)
  })

  it('docs mode renders fenced code literally', () => {
    expect(html(['```md', '## not a heading', '```', 'after'], { fences: true }))
      .toBe('<pre class="jc-pre" data-lang="md"><code>## not a heading</code></pre><p class="jc-p">after</p>')
  })

  it('docs mode lets a link handler take over doc: links', () => {
    const linkHandler = (href, label, key) => href.startsWith('doc:') ? <a key={key} data-doc={href.slice(4)}>{label}</a> : null
    expect(html(['See [brief](doc:d-aaaaaa) and [web](https://x.y)'], { linkHandler }))
      .toBe('<p class="jc-p">See <a data-doc="d-aaaaaa">brief</a> and <a href="https://x.y" target="_blank" rel="noopener noreferrer" class="external-link">web</a></p>')
  })
})
