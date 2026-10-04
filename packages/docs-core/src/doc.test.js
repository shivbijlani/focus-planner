import { describe, it, expect } from 'vitest'
import {
  assignBlockIds, parseDoc, parseDraftBlocks, parseDocHeader, changedBlockIds, outline, statusLine, blockPlainText,
} from './doc.js'
import { fencedLineMask, visibleLines } from './grammar.js'
import { journalReadLoad } from './readLoad.js'

const DOC = [
  '<!-- docs v1 id=d-7kx2m4 rev=4 published=2026-09-30T21:40:00Z by=overnight-agent -->',
  '# Task 123: Mortgage refinance options',
  '',
  '<!-- @b1 -->',
  '**Status: 2 options ready — tell me which one to lock.**',
  '',
  '<!-- @b2 -->',
  '## Options',
  '',
  '<!-- @b3 -->',
  'See the [Mortgage options brief](doc:d-9a1c0q) for the numbers.',
  '<!-- hidden',
  'metadata -->',
  '',
  '<!-- @b4 -->',
  '```md',
  '<!-- @b99 -->',
  '# not a title',
  '```',
].join('\n')

describe('parseDoc', () => {
  it('reads the header, title and anchored blocks', () => {
    const d = parseDoc(DOC)
    expect(d.header).toEqual({ version: 1, id: 'd-7kx2m4', rev: 4, published: '2026-09-30T21:40:00Z', by: 'overnight-agent' })
    expect(d.title).toBe('Task 123: Mortgage refinance options')
    expect(d.blocks.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'b4'])
    expect(d.blocks[1]).toMatchObject({ kind: 'heading', heading: 'Options', level: 2 })
    expect(d.blocks[2].lines).toEqual(['See the [Mortgage options brief](doc:d-9a1c0q) for the numbers.'])
  })

  it('treats anchors and headings inside fences as literal code', () => {
    const d = parseDoc(DOC)
    expect(d.blocks[3].kind).toBe('code')
    expect(d.blocks[3].lines).toEqual(['```md', '<!-- @b99 -->', '# not a title', '```'])
  })

  it('splits unanchored drafts into renderable blocks', () => {
    const blocks = parseDraftBlocks([
      '# Draft',
      '',
      '**Status: Ready.**',
      '',
      '- first item',
      '- second item',
      '',
      '| first row |',
      '| second row |',
      '',
      '```md',
      '# literal code heading',
      '```',
    ].join('\n'))
    expect(blocks.map((block) => block.kind)).toEqual(['para', 'list', 'list', 'table', 'table', 'code'])
  })

  it('exposes the bold status line', () => {
    expect(parseDoc(DOC).statusLine).toBe('Status: 2 options ready — tell me which one to lock.')
    expect(statusLine([{ kind: 'para', lines: ['plain'] }])).toBeNull()
  })

  it('puts unanchored content in b0 so hand-edited docs still render', () => {
    const d = parseDoc('# T\n\nhello\n\n<!-- @b1 -->\nworld')
    expect(d.blocks.map((b) => [b.id, b.lines])).toEqual([['b0', ['hello']], ['b1', ['world']]])
    expect(parseDocHeader('# T')).toBeNull()
  })

  it('tolerates BOM and CRLF', () => {
    const d = parseDoc('\uFEFF<!-- docs v1 id=d-aaaaaa rev=1 -->\r\n# T\r\n<!-- @b1 -->\r\nx\r\n')
    expect(d.header.id).toBe('d-aaaaaa')
    expect(d.blocks).toHaveLength(1)
  })

  it('parses quoted header attributes and scans malformed long attributes linearly', () => {
    expect(parseDocHeader('<!-- docs v1 id="d-aaaaaa" rev=2 -->')).toMatchObject({ id: 'd-aaaaaa', rev: 2 })
    expect(parseDocHeader(`<!-- docs v1 ${'-'.repeat(20_000)} -->`).id).toBeNull()
  })
})

describe('changes and outline', () => {
  it('flags new and edited blocks only', () => {
    const prev = parseDoc('<!-- @b1 -->\na\n<!-- @b2 -->\nb')
    const cur = parseDoc('<!-- @b1 -->\na\n<!-- @b2 -->\nB\n<!-- @b3 -->\nc')
    expect([...changedBlockIds(cur, prev)]).toEqual(['b2', 'b3'])
  })
  it('lists heading blocks', () => {
    expect(outline(parseDoc(DOC))).toEqual([{ id: 'b2', text: 'Options', level: 2 }])
  })
  it('strips markdown for plain text', () => {
    expect(blockPlainText({ lines: ['- **bold** [x](doc:d-aaaaaa)'] })).toBe('bold x')
    expect(blockPlainText({ lines: ['`code words` [image alt](https://example.com)'] })).toBe('code words image alt')
  })

  it('carries unique exact and similar block ids without reusing retired ids', () => {
    const previous = [
      { id: 'b1', lines: ['The mortgage rate is fixed at five percent.'] },
      { id: 'b2', lines: ['Keep this separate.'] },
    ]
    const { blocks, nextId } = assignBlockIds([
      { lines: ['Keep this separate.'] },
      { lines: ['The mortgage rate is fixed at five percent today.'] },
      { lines: ['A new block.'] },
    ], previous, 3)
    expect(blocks.map((block) => block.id)).toEqual(['b2', 'b1', 'b3'])
    expect(nextId).toBe(4)
  })

  it('does not carry an id across ambiguous duplicate blocks', () => {
    const { blocks } = assignBlockIds([
      { lines: ['An identical paragraph.'] },
      { lines: ['An identical paragraph.'] },
    ], [{ id: 'b1', lines: ['An identical paragraph.'] }], 2)
    expect(blocks.map((block) => block.id)).toEqual(['b2', 'b3'])
  })
})

describe('grammar', () => {
  it('fence mask matches the journal rule', () => {
    expect(fencedLineMask(['a', '```', '## x', '```', 'b'])).toEqual([false, true, true, true, false])
  })
  it('visible lines drop comments including multi-line ones', () => {
    expect(visibleLines('a\n<!-- x\ny -->\nb <!-- z --> c')).toEqual(['a', 'b  c'])
  })
  it('strips an unterminated comment with repeated open markers without rescanning', () => {
    expect(visibleLines(`visible ${'<!--'.repeat(20_000)}`)).toEqual(['visible '])
  })
})

describe('journalReadLoad', () => {
  it('counts visible words only', () => {
    const r = journalReadLoad('# T\n<!-- from: me -->\none two\n<!-- tg-meta chat=1 thread=2 -->\nthree', 3)
    expect(r.words).toBe(5)
    expect(r.reached).toBe(true)
  })
})
