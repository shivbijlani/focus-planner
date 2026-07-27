import { describe, it, expect } from 'vitest'
import { mdToTelegramHtml, escapeHtml } from './telegramFormat.js'

describe('escapeHtml', () => {
  it('escapes the three HTML-significant characters', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })
})

describe('mdToTelegramHtml', () => {
  it('returns empty string for empty input', () => {
    expect(mdToTelegramHtml('')).toBe('')
    expect(mdToTelegramHtml(null)).toBe('')
  })

  it('converts bold and italic', () => {
    expect(mdToTelegramHtml('**Status:** proposed')).toBe('<b>Status:</b> proposed')
    expect(mdToTelegramHtml('a *word* here')).toBe('a <i>word</i> here')
    expect(mdToTelegramHtml('__strong__')).toBe('<b>strong</b>')
  })

  it('does not leave literal asterisks for bold', () => {
    const out = mdToTelegramHtml('**bold**')
    expect(out).not.toContain('*')
    expect(out).toBe('<b>bold</b>')
  })

  it('renders inline code and escapes its contents', () => {
    expect(mdToTelegramHtml('run `a < b` now')).toBe('run <code>a &lt; b</code> now')
  })

  it('renders fenced code blocks as <pre>, even when unterminated', () => {
    expect(mdToTelegramHtml('```\nx=1\n```')).toBe('<pre>x=1</pre>')
    // truncated / no closing fence still closes the tag
    expect(mdToTelegramHtml('```\nx=1')).toBe('<pre>x=1</pre>')
  })

  it('turns headings into a bold line', () => {
    expect(mdToTelegramHtml('### Proposed plan (v1)')).toBe('<b>Proposed plan (v1)</b>')
  })

  it('turns bullets into • and keeps numbered items', () => {
    expect(mdToTelegramHtml('- one\n- two')).toBe('\u2022 one\n\u2022 two')
    expect(mdToTelegramHtml('1. first\n2. second')).toBe('1. first\n2. second')
  })

  it('links: real schemes become anchors, relative links become plain text', () => {
    expect(mdToTelegramHtml('see [docs](https://x.io/a)')).toBe(
      'see <a href="https://x.io/a">docs</a>',
    )
    expect(mdToTelegramHtml('see [spec](./task-363-design-spec.md)')).toBe('see spec')
  })

  it('escapes stray HTML-significant characters in prose', () => {
    expect(mdToTelegramHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d')
  })

  it('drops horizontal rules', () => {
    expect(mdToTelegramHtml('above\n---\nbelow')).toBe('above\nbelow')
  })

  it('wraps blockquotes', () => {
    expect(mdToTelegramHtml('> quoted line')).toBe('<blockquote>quoted line</blockquote>')
  })

  it('renders a markdown table as an aligned monospace <pre> grid', () => {
    const md = ['| Item | Source |', '|---|---|', '| Red loafers | **You** |', '| Slides | Agent |'].join(
      '\n',
    )
    const out = mdToTelegramHtml(md)
    expect(out).toBe(
      '<pre>Item         Source\n-----------  ------\nRed loafers  You\nSlides       Agent</pre>',
    )
    // no literal markdown pipes/asterisks leak through
    expect(out).not.toContain('|')
    expect(out).not.toContain('**')
  })

  it('handles tables without outer pipes and colon-aligned separators', () => {
    const md = ['a | b', ':--- | ---:', '1 | 2'].join('\n')
    const out = mdToTelegramHtml(md)
    expect(out).toBe('<pre>a  b\n-  -\n1  2</pre>')
  })

  it('does not treat a lone piped line (no separator) as a table', () => {
    expect(mdToTelegramHtml('a | b | c')).toBe('a | b | c')
  })

})
