import { describe, it, expect } from 'vitest'
import { renderMarkdown, renderInline, escapeHtml, isSafeUrl } from './markdown.js'

describe('escapeHtml', () => {
  it('escapes every character that can break out of text or an attribute', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('renderInline', () => {
  it('renders bold, italic and strikethrough', () => {
    expect(renderInline('**b** and *i* and ~~s~~')).toBe(
      '<strong>b</strong> and <em>i</em> and <del>s</del>',
    )
  })

  it('treats code spans as literal, so quoted markup is not interpreted', () => {
    // Journals quote markdown constantly. Running emphasis rules over code turns a
    // quoted `**example**` into actual bold and loses the asterisks the author meant.
    expect(renderInline('use `**not bold**` here')).toBe(
      'use <code>**not bold**</code> here',
    )
  })

  it('escapes HTML inside a code span', () => {
    expect(renderInline('`<script>alert(1)</script>`')).toBe(
      '<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>',
    )
  })

  it('renders links and keeps query separators intact', () => {
    expect(renderInline('[x](https://e.com/a?b=1&c=2)')).toBe(
      '<a href="https://e.com/a?b=1&amp;c=2">x</a>',
    )
  })

  it('refuses to make a javascript: URL clickable, but keeps the text', () => {
    // A journal can legitimately quote a dangerous URL while describing a bug. It
    // must remain readable and must not become a link the user can click.
    const out = renderInline('[click](javascript:alert(1))')
    expect(out).not.toContain('<a ')
    expect(out).toContain('javascript:alert(1)')
  })

  it('escapes raw HTML in prose', () => {
    expect(renderInline('a <script>bad()</script> b')).toBe(
      'a &lt;script&gt;bad()&lt;/script&gt; b',
    )
  })
})

describe('isSafeUrl', () => {
  it.each([
    ['https://e.com', true],
    ['http://e.com', true],
    ['mailto:a@b.c', true],
    ['#anchor', true],
    ['../task-1.md', true],
    ['javascript:alert(1)', false],
    ['data:text/html;base64,x', false],
    ['vbscript:x', false],
  ])('%s -> %s', (url, ok) => {
    expect(isSafeUrl(url)).toBe(ok)
  })
})

describe('renderMarkdown', () => {
  it('renders headings and shifts them by headingBase', () => {
    expect(renderMarkdown('### Deep', { headingBase: 1 })).toBe('<h4>Deep</h4>')
    expect(renderMarkdown('# Top')).toBe('<h1>Top</h1>')
  })

  it('caps a shifted heading at h6 rather than emitting an invalid tag', () => {
    expect(renderMarkdown('###### Deep', { headingBase: 2 })).toBe('<h6>Deep</h6>')
  })

  it('keeps fenced code verbatim, including markup that would otherwise parse', () => {
    const md = ['```', '## 2026-12-25', '<!-- from: me -->', '```'].join('\n')
    const out = renderMarkdown(md)
    expect(out).toContain('<pre><code>')
    expect(out).toContain('## 2026-12-25')
    expect(out).toContain('&lt;!-- from: me --&gt;')
    expect(out).not.toContain('<h2>')
  })

  it('labels a fence with its info string', () => {
    expect(renderMarkdown('```powershell\nGet-Item\n```')).toContain('class="language-powershell"')
  })

  it('renders bullet lists', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
  })

  it('renders ordered lists', () => {
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol>\n<li>one</li>\n<li>two</li>\n</ol>')
  })

  it('nests an indented list inside its parent item', () => {
    const out = renderMarkdown('- outer\n  - inner')
    expect(out).toContain('<li>outer<ul>\n<li>inner</li>\n</ul></li>'.replace('<ul>', '\n<ul>'))
  })

  it('renders a table with alignment', () => {
    const md = ['| a | b |', '| --- | ---: |', '| 1 | 2 |'].join('\n')
    const out = renderMarkdown(md)
    expect(out).toContain('<table>')
    expect(out).toContain('<th>a</th>')
    expect(out).toContain('style="text-align:right"')
    expect(out).toContain('<td>1</td>')
  })

  it('renders blockquotes', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>')
  })

  it('renders a horizontal rule', () => {
    expect(renderMarkdown('---')).toBe('<hr>')
  })

  it('groups consecutive lines into one paragraph', () => {
    expect(renderMarkdown('a\nb\n\nc')).toBe('<p>a\nb</p>\n<p>c</p>')
  })
})
