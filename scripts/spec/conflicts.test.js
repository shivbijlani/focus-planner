import { describe, it, expect } from 'vitest'
import {
  tokenize,
  sameTarget,
  sentences,
  parseDuration,
  extractDirectives,
  extractSettings,
  extractLifecycle,
  findConflicts,
  citesIssue,
  buildDecisions,
  renderMarkdown,
} from './conflicts.mjs'

const issue = (number, title, body = '') => ({ number, title, body })

describe('tokenize', () => {
  it('drops stopwords and punctuation', () => {
    expect(tokenize('The agent, and the post!')).toEqual(['agent', 'post'])
  })

  it('keeps modal verbs, which the directive rules need', () => {
    // "should" is deliberately NOT a stopword: polarity detection reads it.
    expect(tokenize('should post')).toEqual(['should', 'post'])
  })

  it('singularises plurals so "comments" and "comment" match', () => {
    expect(tokenize('comments')).toEqual(['comment'])
    // ...but leaves short words and double-s words alone.
    expect(tokenize('class')).toEqual(['class'])
  })

  it('returns nothing for empty or stopword-only input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('the and of')).toEqual([])
  })
})

describe('sameTarget', () => {
  it('matches phrases about the same thing', () => {
    expect(sameTarget(tokenize('post a message every turn'), tokenize('post a message on each turn'))).toBe(true)
  })

  it('rejects a single shared token', () => {
    // "agent" alone is not enough to claim two sentences discuss the same rule.
    expect(sameTarget(tokenize('the agent inbox'), tokenize('the agent gate'))).toBe(false)
  })

  it('rejects unrelated phrases', () => {
    expect(sameTarget(tokenize('archive telegram topics'), tokenize('validate email templates'))).toBe(false)
  })

  it('rejects a long sentence that merely contains the short one', () => {
    const short = tokenize('reap stale servers')
    const long = tokenize('reap stale servers before scanning journals, then mirror telegram topics, publish the wiki and regenerate every specification page nightly')
    expect(sameTarget(short, long)).toBe(false)
  })
})

describe('sentences', () => {
  it('splits on newlines and terminators, dropping fragments', () => {
    expect(sentences('First sentence here. Second one here.\nThird line here.')).toEqual([
      'First sentence here.',
      'Second one here.',
      'Third line here.',
    ])
  })
})

describe('parseDuration', () => {
  it('parses bare words', () => {
    expect(parseDuration('runs hourly')).toBe(60)
    expect(parseDuration('runs daily')).toBe(1440)
    expect(parseDuration('runs weekly')).toBe(10080)
  })

  it('parses numeric forms and units', () => {
    expect(parseDuration('every 6h')).toBe(360)
    expect(parseDuration('45 minutes')).toBe(45)
    expect(parseDuration('2 days')).toBe(2880)
  })

  it('returns null when there is no duration', () => {
    expect(parseDuration('no timing here')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })
})

describe('extractDirectives', () => {
  it('reads "should not" as negative, not positive', () => {
    // The ordering bug this guards: "should not archive" contains "should", so a
    // positive-first pass inverts every prohibition in the corpus.
    const [d] = extractDirectives('The bridge should not post a message every turn.')
    expect(d.polarity).toBe('negative')
  })

  it('reads a plain requirement as positive', () => {
    const [d] = extractDirectives('The bridge should post a message every turn.')
    expect(d.polarity).toBe('positive')
  })

  it('recognises never / do not / stop as negative', () => {
    expect(extractDirectives('Never archive the completed topics.')[0].polarity).toBe('negative')
    expect(extractDirectives("Don't archive the completed topics.")[0].polarity).toBe('negative')
    expect(extractDirectives('Stop archiving the completed topics.')[0].polarity).toBe('negative')
  })

  it('ignores a target too short to compare', () => {
    expect(extractDirectives('We must stop.')).toEqual([])
  })

  it('ignores prose with no directive at all', () => {
    expect(extractDirectives('The pipeline runs in CI and uploads an artifact.')).toEqual([])
  })
})

describe('extractSettings', () => {
  it('captures the value and excludes it from the key', () => {
    const [s] = extractSettings('The spec pipeline should run weekly.')
    expect(s.minutes).toBe(10080)
    expect(s.tokens).not.toContain('weekly')
    expect(s.tokens).toContain('pipeline')
  })
})

describe('extractLifecycle', () => {
  it('classifies add and remove', () => {
    expect(extractLifecycle('Add a decisions digest to the workflow.')[0].action).toBe('add')
    expect(extractLifecycle('Remove the decisions digest from the workflow.')[0].action).toBe('remove')
  })

  it('prefers remove when a sentence contains both verbs', () => {
    // "revert the change that added X" is a removal, not an addition.
    expect(extractLifecycle('Revert the commit that added the decisions digest.')[0].action).toBe('remove')
  })
})

describe('findConflicts', () => {
  it('flags opposite requirements about the same behaviour', () => {
    const found = findConflicts([
      issue(1, 'Telegram noise', 'The bridge should not post a message every turn.'),
      issue(2, 'Telegram visibility', 'The bridge should post a message every turn.'),
    ])
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('polarity')
    expect(found[0].issues).toEqual([1, 2])
    expect(found[0].evidence).toHaveLength(2)
  })

  it('flags two different values for the same setting', () => {
    const found = findConflicts([
      issue(10, 'Cadence', 'The spec pipeline should run weekly.'),
      issue(11, 'Cadence', 'The spec pipeline should run every 6h.'),
    ])
    const value = found.find((f) => f.kind === 'value')
    expect(value).toBeTruthy()
    expect(value.evidence.map((e) => e.minutes).sort((a, b) => a - b)).toEqual([360, 10080])
  })

  it('flags add versus remove of the same artifact', () => {
    const found = findConflicts([
      issue(20, 'Digest', 'Add the approval digest to the general thread.'),
      issue(21, 'Digest', 'Remove the approval digest from the general thread.'),
    ])
    expect(found.some((f) => f.kind === 'lifecycle')).toBe(true)
  })

  it('does not flag two issues that merely share a topic', () => {
    // Both are about Telegram and both are positive requirements. Agreeing
    // loudly is not a conflict, and reporting it is how the report gets muted.
    expect(findConflicts([
      issue(30, 'Telegram', 'The bridge should post a message every turn.'),
      issue(31, 'Telegram', 'The bridge should post a message on each turn.'),
    ])).toEqual([])
  })

  it('does not flag opposite requirements about DIFFERENT things', () => {
    expect(findConflicts([
      issue(40, 'A', 'The bridge should archive completed topics.'),
      issue(41, 'B', 'The collector should not validate email templates.'),
    ])).toEqual([])
  })

  it('does not flag the same setting with the same value', () => {
    expect(findConflicts([
      issue(50, 'A', 'The spec pipeline should run every 6h.'),
      issue(51, 'B', 'The spec pipeline should run every 6h.'),
    ])).toEqual([])
  })

  it('reports one finding per pair per kind, not one per restatement', () => {
    const found = findConflicts([
      issue(60, 'Noise', [
        'The bridge should not post a message every turn.',
        'It should not post a message every turn under any circumstance.',
        'Again: never post a message every turn.',
      ].join('\n')),
      issue(61, 'Visibility', 'The bridge should post a message every turn.'),
    ])
    expect(found.filter((f) => f.kind === 'polarity')).toHaveLength(1)
  })

  it('does not flag two issues where one cites the other', () => {
    // Citing the other issue's number is commentary on it, not a competing
    // requirement. This was the only false positive on the live 70-issue corpus.
    expect(findConflicts([
      issue(181, 'CI', 'It does not mean the tests passed.'),
      issue(406, 'CI', '#181 - a green check must mean all tests actually ran.'),
    ])).toEqual([])
  })

  it('still flags an opposite requirement that does NOT cite the other issue', () => {
    // The suppression above must be narrow: a genuine contradiction that simply
    // happens to mention some unrelated issue number stays visible.
    const found = findConflicts([
      issue(181, 'CI', 'It does not mean the tests passed.'),
      issue(406, 'CI', 'See #999. A green check must mean the tests passed.'),
    ])
    expect(found).toHaveLength(1)
  })

  it('does not treat a numeric prefix as a citation', () => {
    // "#1810" must not suppress a finding about #181.
    expect(citesIssue('see #1810 for detail', 181)).toBe(false)
    expect(citesIssue('see #181 for detail', 181)).toBe(true)
  })

  it('is deterministic and order-independent in its output', () => {
    // `gh issue list` does not promise a stable order, so identical facts must
    // still produce byte-identical JSON or the artifact churns every run.
    const a = [
      issue(70, 'A', 'The bridge should not post a message every turn.'),
      issue(71, 'B', 'The bridge should post a message every turn.'),
    ]
    const forward = findConflicts(a)
    const backward = findConflicts([...a].reverse())
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward))
    // ...and the lower issue number leads, in both the summary and the evidence.
    expect(forward[0].summary).toContain('#70 and #71')
    expect(forward[0].evidence.map((e) => e.issue)).toEqual([70, 71])
    expect(backward[0].evidence.map((e) => e.issue)).toEqual([70, 71])
  })

  it('handles empty and malformed input without throwing', () => {
    expect(findConflicts([])).toEqual([])
    expect(findConflicts(undefined)).toEqual([])
    expect(findConflicts([{ number: 1 }])).toEqual([])
  })
})

describe('buildDecisions', () => {
  it('states emptiness explicitly rather than only via an empty array', () => {
    // A consumer must never have to infer "no conflicts" from an array it might
    // simply have failed to read -- that is the shape of the #346 defect.
    const d = buildDecisions({ commit: 'abc', issues: [] }, [])
    expect(d.hasDecisions).toBe(false)
    expect(d.counts.conflicts).toBe(0)
  })

  it('carries the conflicts through as decisions', () => {
    const conflicts = findConflicts([
      issue(1, 'A', 'The bridge should not post a message every turn.'),
      issue(2, 'B', 'The bridge should post a message every turn.'),
    ])
    const d = buildDecisions({ commit: 'abc', issues: [1, 2] }, conflicts)
    expect(d.hasDecisions).toBe(true)
    expect(d.decisions[0].issues).toEqual([1, 2])
  })
})

describe('renderMarkdown', () => {
  it('says so plainly when there is nothing to decide', () => {
    const md = renderMarkdown(buildDecisions({ issues: [] }, []))
    expect(md).toContain('None.')
  })

  it('quotes the evidence with its issue number', () => {
    const conflicts = findConflicts([
      issue(1, 'A', 'The bridge should not post a message every turn.'),
      issue(2, 'B', 'The bridge should post a message every turn.'),
    ])
    const md = renderMarkdown(buildDecisions({ issues: [] }, conflicts))
    expect(md).toContain('#1')
    expect(md).toContain('#2')
    expect(md).toContain('should post a message every turn')
  })
})
