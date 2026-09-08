import { describe, expect, it } from 'vitest'
import {
  checkTechnicalPageLink,
  formatTechnicalDetails,
  readabilityFindings,
} from './readability.mjs'

const code = ['```json', '{"status":"ready"}', '```'].join('\n')

describe('spec readability formatting', () => {
  it('wraps an exposed technical example in a collapsible coloured callout', () => {
    const formatted = formatTechnicalDetails(`Plain-language behavior.\n\n${code}`, 'Behaviour.md')

    expect(formatted).toContain('<details>')
    expect(formatted).toContain('<summary><strong>Show technical detail</strong></summary>')
    expect(formatted).toContain('> [!NOTE]')
    expect(formatted.indexOf('> [!NOTE]')).toBeLessThan(formatted.indexOf('<details>'))
    expect(formatted).toContain(code)
    expect(readabilityFindings('Behaviour.md', formatted)).toEqual([])
  })

  it('wraps tilde and longer-backtick fences rather than letting valid Markdown bypass the gate', () => {
    for (const fence of ['~~~~json\n{\"status\":\"ready\"}\n~~~~', '````json\n{\"status\":\"ready\"}\n````']) {
      const formatted = formatTechnicalDetails(fence, 'Behaviour.md')
      expect(formatted).toContain('<details>')
      expect(readabilityFindings('Behaviour.md', formatted)).toEqual([])
    }
  })

  it('wraps exposed module-path tables', () => {
    const table = [
      '| Module | Responsibility |',
      '| --- | --- |',
      '| `src/App.jsx` | Board shell |',
    ].join('\n')
    const formatted = formatTechnicalDetails(table, 'Domain-app.md')
    expect(formatted).toContain('<details>')
    expect(formatted).toContain(table)
    expect(readabilityFindings('Domain-app.md', formatted)).toEqual([])
  })

  it('does not fire on plain prose', () => {
    const prose = 'People can plan their day without understanding how files are parsed.'
    expect(formatTechnicalDetails(prose, 'Home.md')).toBe(prose)
    expect(readabilityFindings('Home.md', prose)).toEqual([])
  })

  it('does not nest or duplicate an existing compliant detail block', () => {
    const formatted = [
      '> [!IMPORTANT]',
      '> **Technical detail: invariant.** Optional depth.',
      '',
      '<details>',
      '<summary>Show technical detail</summary>',
      '',
      code,
      '',
      '</details>',
    ].join('\n')
    expect(formatTechnicalDetails(formatted, 'Data-Formats.md')).toBe(formatted)
    expect(readabilityFindings('Data-Formats.md', formatted)).toEqual([])
  })

  it('does not let a second detail block borrow the first block’s alert', () => {
    const malformed = [
      '> [!NOTE]',
      '> **Technical detail: first.** Optional depth.',
      '',
      '<details>',
      '<summary>First</summary>',
      '',
      code,
      '',
      '</details>',
      '',
      '<details>',
      '<summary>Second</summary>',
      '',
      code,
      '',
      '</details>',
    ].join('\n')
    expect(readabilityFindings('Data-Formats.md', malformed)).toContainEqual(
      expect.objectContaining({ kind: 'uncoloured-technical-detail' }),
    )
  })
})

describe('technical architecture document', () => {
  it('allows architecture diagrams but rejects implementation code', () => {
    const diagram = ['```mermaid', 'flowchart LR', '  Human --> Planner', '```'].join('\n')
    expect(readabilityFindings('Technical-Architecture.md', diagram)).toEqual([])
    expect(readabilityFindings('Technical-Architecture.md', code)).toContainEqual(
      expect.objectContaining({ kind: 'technical-doc-code' }),
    )
    expect(readabilityFindings('Technical-Architecture.md', '~~~json\n{}\n~~~')).toContainEqual(
      expect.objectContaining({ kind: 'technical-doc-code' }),
    )
  })

  it('requires the technical document to be linked from the main index', () => {
    const pages = new Map([
      ['Home.md', '# Product'],
      ['Technical-Architecture.md', '# Technical Architecture'],
    ])
    expect(checkTechnicalPageLink(pages)).toContainEqual(
      expect.objectContaining({ kind: 'unlinked-technical-doc' }),
    )
    pages.set('Home.md', '[Technical Architecture](Technical-Architecture)')
    expect(checkTechnicalPageLink(pages)).toEqual([])
  })
})
