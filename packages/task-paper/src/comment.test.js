// The comment channel (#286, second half).
//
// The assertions that matter here are not "does a textarea exist". They are the two
// properties the design rests on, both of which fail SILENTLY if they break:
//
//   1. The embedded writer is the app's writer, byte-for-byte. If it drifts, the page
//      keeps working and keeps saying "Saved" while producing bytes the consent reader
//      attributes differently -- a typed approval that reads as silence (#325).
//   2. Rendering stays deterministic. #400's whole safety argument for regenerating
//      237 papers nightly is that unchanged input produces byte-identical output. A
//      clock, a nonce or a random id in the comment script would silently destroy it.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import {
  SHARED_WRITER_PATH,
  readSharedWriter,
  assertEmbedsSharedWriterVerbatim,
  buildCommentScript,
  commentSectionHtml,
  journalFilename,
} from './comment.js'
import { renderPaper } from './render.js'
import { buildPaper } from './paper.js'
import { appendJournalMessage } from '../../../src/journalChat.js'

const JOURNAL = `# Task 42: A task

- framing

## 2026-09-01

<!-- from: me -->
do the thing

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## 🌙 Overnight Agent — did the thing

<!-- from: overnight-agent -->

**Status:** In-progress · 2026-09-02

### Where it stands

Done.

**Needs from you:** none

<!-- /overnight-agent turn-end -->
`

const writer = readSharedWriter()
const paper = buildPaper(JOURNAL, { taskId: '42' })
const withComments = renderPaper(paper, { writerSource: writer })

describe('the shared writer is embedded, not reimplemented', () => {
  it('reads the app source verbatim', () => {
    expect(writer).toBe(fs.readFileSync(SHARED_WRITER_PATH, 'utf8'))
    expect(writer).toContain('export function appendJournalMessage')
  })

  // THE DRIFT GUARD. #325's expensive failure was two writers disagreeing about who
  // wrote something. This holds the paper's copy byte-identical to the app's, so the
  // two cannot diverge without a red test.
  it('embeds it byte-for-byte in the rendered page', () => {
    expect(assertEmbedsSharedWriterVerbatim(withComments, writer)).toBe(true)
  })

  it('refuses a source that would break out of the script element', () => {
    const fake = { readFileSync: () => 'const a = "</script>"' }
    expect(() => readSharedWriter(fake, '/x/journalChat.js')).toThrow(/<\/script/)
  })

  // The page must be able to write to its OWN journal and nothing else, so the
  // filename is baked in rather than derived at run time from anything mutable.
  it('bakes in only this task\u2019s journal filename', () => {
    const script = buildCommentScript(writer, { taskId: '42' })
    expect(script).toContain('const OA_JOURNAL_FILE = "task-42.md"')
    expect(journalFilename('42')).toBe('task-42.md')
  })

  it('is an inline module so no network fetch is needed from file://', () => {
    expect(withComments).toContain('<script type="module">')
    expect(withComments).not.toMatch(/<script[^>]+\bsrc=/i)
  })
})

describe('the comment lands in the journal, so nothing new has to be detected', () => {
  // The channel's entire correctness claim: what the page writes is what the app
  // writes. If this holds, `oa-state.ps1 scan` reports `reopened` and `consent`
  // attributes it, with no new code on either side.
  it('produces the same bytes the app produces', () => {
    const out = appendJournalMessage(JOURNAL, 'please also do the other thing', '2026-09-02')
    expect(out.startsWith(JOURNAL.replace(/\s+$/, ''))).toBe(true)
    expect(out).toContain('<!-- from: me -->')
    expect(out).toContain('please also do the other thing')
  })

  it('appends after the turn-end stamp, which is what makes it reopen the task', () => {
    const out = appendJournalMessage(JOURNAL, 'approve', '2026-09-02')
    expect(out.indexOf('approve')).toBeGreaterThan(out.indexOf('<!-- /overnight-agent turn-end -->'))
  })
})

describe('rendering stays deterministic', () => {
  it('produces byte-identical output for identical input', () => {
    expect(renderPaper(buildPaper(JOURNAL, { taskId: '42' }), { writerSource: writer })).toBe(withComments)
  })

  // Scoped to the CONTROLLER, not the whole script. The embedded writer's own
  // `localISODate(d = new Date())` reads the clock *in the browser at save time*,
  // which is exactly right -- a comment should be dated the day it is written. What
  // must not exist is a clock in the code that is BAKED INTO the file, because that
  // would make every one of the 237 papers rewrite nightly and destroy the only
  // signal that matters (#400): whether the task actually moved.
  it('carries no clock, nonce or random id in the generated controller', () => {
    const script = buildCommentScript(writer, { taskId: '42' })
    const controller = script.slice(script.indexOf('// --- END src/journalChat.js ---'))
    expect(controller).not.toMatch(/Date\.now\(\)|Math\.random|new Date\(\)|crypto\.randomUUID/)
  })

  it('is the generated bytes, not the runtime, that must be fixed', () => {
    const a = buildCommentScript(writer, { taskId: '42' })
    const b = buildCommentScript(writer, { taskId: '42' })
    expect(a).toBe(b)
  })
})

describe('the feature is additive', () => {
  it('renders a read-only paper when no writer source is supplied', () => {
    const plain = renderPaper(paper)
    expect(plain).not.toContain('oa-comment-text')
    expect(plain).not.toContain('<script')
    expect(plain).toContain('edits made here are not read')
  })

  it('does not claim edits are unread once the box exists', () => {
    expect(withComments).not.toContain('edits made here are not read')
    expect(withComments).toContain('saved into the journal rather than into this page')
  })

  it('omits the box for a paper with no task id, since it could not target a file', () => {
    const anon = renderPaper(buildPaper(JOURNAL), { writerSource: writer })
    expect(anon).not.toContain('oa-comment-text')
  })
})

describe('the box degrades rather than lying', () => {
  it('offers a copy fallback and names the file to paste into', () => {
    const html = commentSectionHtml({ taskId: '42' })
    expect(html).toContain('oa-comment-copy')
    expect(html).toContain('<code>task-42.md</code>')
    expect(html).toContain('hidden')
  })

  it('disables saving when the browser cannot write files', () => {
    expect(withComments).toContain('const OA_CAN_WRITE = ')
    expect(withComments).toMatch(/if \(!OA_CAN_WRITE\) \{\s*\n\s*els\.save\.disabled = true/)
    expect(withComments).toContain('els.fallback.hidden = false')
  })

  // A comment is worth losing; a journal is not. `createWritable` truncates, so a
  // short string would destroy the file rather than fail.
  it('refuses to write anything that is not a clean append', () => {
    expect(withComments).toContain("code: 'not-an-append'")
    expect(withComments).toMatch(/if \(!after\.startsWith\(trimmed\) \|\| after\.length <= trimmed\.length\)/)
  })

  it('reads the file back rather than trusting the write', () => {
    expect(withComments).toContain("code: 'verify-failed'")
  })
})
