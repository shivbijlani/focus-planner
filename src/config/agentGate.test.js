/**
 * Tests for the agent gate file (#288).
 *
 * The gate's whole value is that the *user* wrote it, so these lean hard on the
 * two properties that protect that: parse/serialize must round-trip exactly,
 * and a save must never destroy a line the app did not author.
 */
import { describe, it, expect } from 'vitest'
import {
  parseAgentGate,
  serializeAgentGate,
  addGateLine,
  removeGateLine,
  scaffoldAgentGate,
  AGENT_GATE_DOC,
  AGENT_GATE_FILE,
  AGENT_GATE_VERSION,
  DEFAULT_REVERSIBLE,
  DEFAULT_ALWAYS_ASK,
} from './agentGate.js'

// In-memory fake provider, mirroring agentsDoc.test.js.
function fakeStore(initial = {}, { throwOnMissing = false } = {}) {
  const files = { ...initial }
  return {
    files,
    read: async (p) => {
      if (!(p in files)) {
        if (throwOnMissing) throw new Error('not found')
        return ''
      }
      return files[p]
    },
    write: async (p, c) => { files[p] = c },
  }
}

describe('AGENT_GATE_DOC content', () => {
  it('embeds the version marker', () => {
    expect(AGENT_GATE_DOC).toContain(`planner-agent-gate v${AGENT_GATE_VERSION}`)
  })

  it('seeds both lists verbatim from the issue', () => {
    const parsed = parseAgentGate(AGENT_GATE_DOC)
    expect(parsed.reversible).toEqual(DEFAULT_REVERSIBLE)
    expect(parsed.alwaysAsk).toEqual(DEFAULT_ALWAYS_ASK)
  })

  it('carries the standing permissions that the live failure needed', () => {
    expect(AGENT_GATE_DOC).toContain('YOLO mode')
    expect(AGENT_GATE_DOC).toContain('publishing a pull request')
  })
})

describe('parseAgentGate', () => {
  it('returns empty lists for missing/blank/garbage input', () => {
    for (const input of [undefined, null, '', '   \n\n', '# Nothing here\n\nprose']) {
      expect(parseAgentGate(input)).toEqual({ reversible: [], alwaysAsk: [] })
    }
  })

  it('reads a file that has only one of the two sections', () => {
    const md = '# Agent gate\n\n## Always ask (safety floor)\n\n- Mass email\n'
    expect(parseAgentGate(md)).toEqual({ reversible: [], alwaysAsk: ['Mass email'] })
  })

  it('parses CRLF input identically to LF', () => {
    const lf = AGENT_GATE_DOC
    const crlf = lf.replace(/\n/g, '\r\n')
    expect(parseAgentGate(crlf)).toEqual(parseAgentGate(lf))
  })

  it('accepts *, + and - bullets and ignores prose between them', () => {
    const md = [
      '## Do not gate these (reversible)',
      '',
      '- dash item',
      'a note the user typed',
      '* star item',
      '+ plus item',
      '',
    ].join('\n')
    expect(parseAgentGate(md).reversible).toEqual(['dash item', 'star item', 'plus item'])
  })

  it('matches reworded headings by keyword', () => {
    const md = '## Reversible\n\n- a\n\n## Safety floor\n\n- b\n'
    expect(parseAgentGate(md)).toEqual({ reversible: ['a'], alwaysAsk: ['b'] })
  })

  it('stops a section at the next same-level heading', () => {
    const md = '## Do not gate these (reversible)\n\n- mine\n\n## Notes\n\n- not a gate rule\n'
    expect(parseAgentGate(md).reversible).toEqual(['mine'])
  })

  it('skips empty bullets', () => {
    expect(parseAgentGate('## Reversible\n\n- \n-\n- real\n').reversible).toEqual(['real'])
  })
})

describe('serializeAgentGate', () => {
  const roundTrip = (md, lists) => parseAgentGate(serializeAgentGate(md, lists))

  it('round-trips the canonical doc unchanged', () => {
    const parsed = parseAgentGate(AGENT_GATE_DOC)
    expect(roundTrip(AGENT_GATE_DOC, parsed)).toEqual(parsed)
  })

  it('round-trips lines full of markdown-special characters', () => {
    const gnarly = [
      '**bold** and _underscores_ and `backticks`',
      'a | pipe | table-ish line',
      '- looks like a nested bullet',
      '# not a heading, just a hash',
      'brackets [link](http://example.com) and <html> & ampersands',
      'trailing backslash \\ and 100% signs',
      '## also not a heading',
    ]
    const out = serializeAgentGate(AGENT_GATE_DOC, { reversible: gnarly, alwaysAsk: [] })
    expect(parseAgentGate(out).reversible).toEqual(gnarly)
  })

  it('seeds from the canonical doc when given a blank file', () => {
    const out = serializeAgentGate('', { reversible: ['only rule'], alwaysAsk: [] })
    expect(out).toContain('# Agent gate')
    expect(out).toContain(`planner-agent-gate v${AGENT_GATE_VERSION}`)
    expect(parseAgentGate(out)).toEqual({ reversible: ['only rule'], alwaysAsk: [] })
  })

  it('normalises CRLF input to a clean LF file', () => {
    const out = serializeAgentGate(AGENT_GATE_DOC.replace(/\n/g, '\r\n'), {
      reversible: ['x'], alwaysAsk: ['y'],
    })
    expect(out).not.toContain('\r')
    expect(parseAgentGate(out)).toEqual({ reversible: ['x'], alwaysAsk: ['y'] })
  })

  it('appends a section the file was missing', () => {
    const md = '# Agent gate\n\n## Do not gate these (reversible)\n\n- a\n'
    const out = serializeAgentGate(md, { reversible: ['a'], alwaysAsk: ['ask me'] })
    expect(out).toContain('## Always ask (safety floor)')
    expect(parseAgentGate(out)).toEqual({ reversible: ['a'], alwaysAsk: ['ask me'] })
  })

  it('writes empty sections when a list is cleared', () => {
    const out = serializeAgentGate(AGENT_GATE_DOC, { reversible: [], alwaysAsk: [] })
    expect(out).toContain('## Do not gate these (reversible)')
    expect(out).toContain('## Always ask (safety floor)')
    expect(parseAgentGate(out)).toEqual({ reversible: [], alwaysAsk: [] })
  })

  it('treats missing/partial list arguments as empty rather than throwing', () => {
    expect(() => serializeAgentGate(AGENT_GATE_DOC, {})).not.toThrow()
    expect(parseAgentGate(serializeAgentGate(AGENT_GATE_DOC, {}))).toEqual({
      reversible: [], alwaysAsk: [],
    })
  })

  it('trims entries and drops blank ones', () => {
    const out = serializeAgentGate(AGENT_GATE_DOC, {
      reversible: ['  padded  ', '', '   '], alwaysAsk: [],
    })
    expect(parseAgentGate(out).reversible).toEqual(['padded'])
  })
})

describe('serializeAgentGate preserves what the app did not write', () => {
  const handWritten = [
    '# My gate, my rules',
    '',
    '<!-- planner-agent-gate v1 -->',
    '<!-- personal note: keep this list short -->',
    '',
    'A preamble paragraph I wrote by hand.',
    '',
    '## Do not gate these (reversible)',
    '',
    'Context: these are all cheap to undo.',
    '',
    '- old rule',
    '',
    '## Always ask (safety floor)',
    '',
    '- ask first',
    '',
    '## My own scratch section',
    '',
    '- something unrelated the app knows nothing about',
    '',
    'Closing thought.',
    '',
  ].join('\n')

  const saved = serializeAgentGate(handWritten, { reversible: ['new rule'], alwaysAsk: ['ask first'] })

  it('keeps the user title, comments and preamble', () => {
    expect(saved).toContain('# My gate, my rules')
    expect(saved).toContain('<!-- personal note: keep this list short -->')
    expect(saved).toContain('A preamble paragraph I wrote by hand.')
  })

  it('keeps prose written inside a managed section', () => {
    expect(saved).toContain('Context: these are all cheap to undo.')
  })

  it('keeps unrelated sections and trailing prose', () => {
    expect(saved).toContain('## My own scratch section')
    expect(saved).toContain('- something unrelated the app knows nothing about')
    expect(saved).toContain('Closing thought.')
  })

  it('still applies the edit', () => {
    expect(parseAgentGate(saved)).toEqual({ reversible: ['new rule'], alwaysAsk: ['ask first'] })
    expect(saved).not.toContain('- old rule')
  })

  it('does not duplicate a section that already exists', () => {
    expect(saved.match(/## Do not gate these/g)).toHaveLength(1)
    expect(saved.match(/## Always ask/g)).toHaveLength(1)
  })

  it('is stable across repeated saves (no drift, no blank-line growth)', () => {
    const again = serializeAgentGate(saved, parseAgentGate(saved))
    expect(again).toBe(saved)
  })

  it('places a list under the section prose when the section had no bullets', () => {
    const md = '## Do not gate these (reversible)\n\nNothing yet.\n'
    const out = serializeAgentGate(md, { reversible: ['first rule'], alwaysAsk: [] })
    expect(out.indexOf('Nothing yet.')).toBeLessThan(out.indexOf('- first rule'))
    expect(parseAgentGate(out).reversible).toEqual(['first rule'])
  })
})

describe('addGateLine / removeGateLine', () => {
  it('appends a trimmed line', () => {
    expect(addGateLine(['a'], '  b  ')).toEqual(['a', 'b'])
  })

  it('ignores blank input (Enter on an empty box)', () => {
    expect(addGateLine(['a'], '')).toEqual(['a'])
    expect(addGateLine(['a'], '   ')).toEqual(['a'])
  })

  it('ignores an exact duplicate', () => {
    expect(addGateLine(['a'], 'a')).toEqual(['a'])
  })

  it('flattens newlines so an entry is always one line', () => {
    expect(addGateLine([], 'one\ntwo\r\nthree')).toEqual(['one two three'])
  })

  it('never mutates the input array', () => {
    const src = ['a']
    addGateLine(src, 'b')
    removeGateLine(src, 0)
    expect(src).toEqual(['a'])
  })

  it('removes by index and no-ops out of range', () => {
    expect(removeGateLine(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(removeGateLine(['a'], 5)).toEqual(['a'])
    expect(removeGateLine(['a'], -1)).toEqual(['a'])
  })

  it('tolerates a non-array list', () => {
    expect(addGateLine(undefined, 'a')).toEqual(['a'])
    expect(removeGateLine(null, 0)).toEqual([])
  })
})

describe('scaffoldAgentGate', () => {
  it('writes the gate when missing (read returns empty)', async () => {
    const s = fakeStore()
    await scaffoldAgentGate(s.read, s.write)
    expect(s.files[AGENT_GATE_FILE]).toBe(AGENT_GATE_DOC)
  })

  it('writes the gate when the provider throws on a missing file', async () => {
    const s = fakeStore({}, { throwOnMissing: true })
    await scaffoldAgentGate(s.read, s.write)
    expect(s.files[AGENT_GATE_FILE]).toBe(AGENT_GATE_DOC)
  })

  it('replaces a whitespace-only file', async () => {
    const s = fakeStore({ [AGENT_GATE_FILE]: '\n  \n' })
    await scaffoldAgentGate(s.read, s.write)
    expect(s.files[AGENT_GATE_FILE]).toBe(AGENT_GATE_DOC)
  })

  it('NEVER overwrites an existing gate — the user owns this file', async () => {
    const mine = '## Reversible\n\n- just this one\n'
    const s = fakeStore({ [AGENT_GATE_FILE]: mine })
    let writes = 0
    await scaffoldAgentGate(s.read, async (p, c) => { writes++; s.files[p] = c })
    expect(writes).toBe(0)
    expect(s.files[AGENT_GATE_FILE]).toBe(mine)
  })

  it('never throws when write fails', async () => {
    const read = async () => ''
    const write = async () => { throw new Error('disk full') }
    await expect(scaffoldAgentGate(read, write)).resolves.toBeUndefined()
  })
})
