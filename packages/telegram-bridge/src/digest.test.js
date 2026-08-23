import { describe, it, expect } from 'vitest'
import { extractAsk, extractAskEntry, buildDigest, hashDigest } from './digest.js'
import { latestAgentTurn } from './journal.js'
import { createBridge } from './bridge.js'
import { emptyState } from './state.js'

describe('extractAsk', () => {
  it('prefers an explicit "Needs from you" over "Next"', () => {
    const turn = [
      '- Next: I will keep monitoring.',
      '',
      '**Needs from you:** one word - `apply 241` or `apply 241 everywhere`.',
    ].join('\n')
    expect(extractAsk(turn)).toBe(
      'one word - `apply 241` or `apply 241 everywhere`.',
    )
  })

  it('falls back to "Next" when there is no formal ask', () => {
    const turn = '- Next: say `merge 150` and I will land it.'
    expect(extractAsk(turn)).toBe('say `merge 150` and I will land it.')
  })

  it('folds continuation lines into a single-line ask', () => {
    const turn = [
      '**Needs from you:**',
      'the front filter label close-up',
      'and the backyard timer photo.',
      '',
      'unrelated trailing prose',
    ].join('\n')
    expect(extractAsk(turn)).toBe(
      'the front filter label close-up and the backyard timer photo.',
    )
  })

  it('handles the "Needs from you - qualifier:" variant the journals use', () => {
    const turn = '**Needs from you - still one line, either route:** reply `go`.'
    expect(extractAsk(turn)).toBe('reply `go`.')
  })

  it('treats "none" / "nothing" as not waiting on the user', () => {
    expect(extractAsk('**Needs from you:** none')).toBeNull()
    expect(extractAsk('**Needs from you:** nothing to read the doc.')).toBeNull()
  })

  // Regression: the dismissive short-circuit used to return null for the WHOLE
  // turn the moment a `Needs from you:` opened with "none"/"nothing" — even
  // when the very same sentence went on to state a real ask. Measured against
  // the live journals, that silently dropped 12 open board tasks (7 on
  // `## Today`) out of the approval queue before any ordering ran.
  it('keeps the real ask that follows a dismissive "none"/"nothing" clause', () => {
    expect(
      extractAsk('**Needs from you:** none - but tell me if you want the outreach draft.'),
    ).toBe('but tell me if you want the outreach draft.')
    expect(
      extractAsk('**Needs from you:** nothing to unblock it. Two optional calls when ready:'),
    ).toBe('Two optional calls when ready:')
    expect(
      extractAsk('**Needs from you:** none for the first pass. A photo of each water source.'),
    ).toBe('A photo of each water source.')
  })

  it('does not mistake the tail of a dismissive clause for an ask', () => {
    expect(extractAsk('**Needs from you:** none.')).toBeNull()
    expect(extractAsk('**Needs from you:** nothing required')).toBeNull()
    expect(extractAsk('**Needs from you:** none needed for now.')).toBeNull()
  })

  // SKILL.md's own block template pairs `**Needs from you:** none` with a
  // `**Your call:**` hand-back, so every freshly proposed plan that needs no
  // extra information carried its ask ONLY on that line - and was invisible.
  it('falls back to the "Your call" hand-back when nothing else asks', () => {
    const turn = [
      '**Needs from you:** none.',
      '',
      '**Your call:** just reply below in plain English - "approve", "revise: ...", or "skip".',
    ].join('\n')
    expect(extractAsk(turn)).toBe(
      'just reply below in plain English - "approve", "revise: ...", or "skip".',
    )
    expect(extractAskEntry(turn).source).toBe('call')
  })

  it('prefers an informative "Next" over the generic "Your call" boilerplate', () => {
    const turn = [
      '**Needs from you:** none.',
      '- Next: your word on either (a) `go POC` or (b) `add the child`.',
      '**Your call:** just reply below in plain English.',
    ].join('\n')
    const entry = extractAskEntry(turn)
    expect(entry.source).toBe('next')
    expect(entry.text).toBe('your word on either (a) `go POC` or (b) `add the child`.')
  })

  it('marks boilerplate-salvaged asks as weak so callers can gate them', () => {
    expect(extractAskEntry('**Needs from you:** none - but confirm the venue.').weak).toBe(true)
    expect(extractAskEntry('**Your call:** reply "approve" or "skip".').weak).toBe(true)
    // A strong, unqualified ask is never weak.
    expect(extractAskEntry('**Needs from you:** the front filter photo.').weak).toBeUndefined()
  })

  it('treats a completed "Next" as not waiting on the user', () => {
    expect(extractAsk('- Next: complete')).toBeNull()
    expect(extractAsk('- Next: done')).toBeNull()
  })

  it('returns null when the turn contains no ask at all', () => {
    expect(extractAsk('just a status update with no ask')).toBeNull()
    expect(extractAsk('')).toBeNull()
    expect(extractAsk(null)).toBeNull()
  })
})

describe('extractAskEntry source', () => {
  it('labels a formal ask as blocking', () => {
    expect(extractAskEntry('**Needs from you:** pick a size').source).toBe('needs')
  })

  it('labels a bare Next line as the weaker fallback', () => {
    // `Next:` can still carry a real user ask; it is just weaker evidence than
    // a formal `Needs from you:` marker, so it is labelled for ranking.
    const e = extractAskEntry('- Next: your one word on the repoint.')
    expect(e.source).toBe('next')
    expect(e.text).toBe('your one word on the repoint.')
  })

  it('drops a Next line that describes the AGENT\u2019s own work', () => {
    // "keep polling on future overnight runs" is something the agent does, not
    // something the user owes. Listing it as an ask trains the user to ignore
    // the digest, so it must not appear at all.
    expect(extractAskEntry('- Next: keep polling on future overnight runs.')).toBeNull()
    expect(extractAskEntry('- Next: continue the sweep next run')).toBeNull()
    expect(extractAskEntry('- Next: monitor the queue')).toBeNull()
  })

  it('treats an imperative hand-back as a blocking ask', () => {
    // Journals routinely close a turn with "**Reply `merge 150`**" instead of
    // re-emitting a Needs-from-you marker. That used to read as NO ask at all,
    // which is how task #433 — a P0 whose entire ask is `merge 150` —
    // disappeared from the live digest completely.
    const e = extractAskEntry('**Reply `merge 150`** (or `merge 150 153` to do both).')
    expect(e.source).toBe('reply')
    expect(e.text).toContain('merge 150')
  })

  it('prefers a formal Needs marker over an imperative hand-back', () => {
    const turn = ['**Needs from you:** pick a size', '', 'Reply `merge 150`'].join('\n')
    expect(extractAskEntry(turn).source).toBe('needs')
  })

  it('prefers an imperative hand-back over a weak Next line', () => {
    const turn = ['- Next: your one word.', '', '**Reply `merge 150`**'].join('\n')
    expect(extractAskEntry(turn).source).toBe('reply')
  })

  it('does not mistake ordinary prose starting with "reply" for an ask', () => {
    expect(extractAskEntry('Replied to the thread and moved on.')).toBeNull()
  })

  it('returns null for no ask', () => {
    expect(extractAskEntry('nothing here')).toBeNull()
  })
})

// The regression this whole module exists to avoid. Journals are
// bottom-appended chat threads, so a whole-file grep for the LAST
// `**Needs from you:**` can return a marker that newer turns already
// invalidated — exactly what happened with task #250 (marker written
// 2026-07-01, superseded 07-07, still acted on). Reading the ask out of
// `latestAgentTurn()` is what keeps the digest honest.
describe('newest-turn-wins (stale marker regression)', () => {
  const JOURNAL = `# Task 250: Insurance

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Blocked

**Needs from you:** just keep an MCP Chrome window open, LastPass will do the rest.

## 2026-07-07

<!-- from: overnight-agent -->
**Needs from you:** a full SSN + driver's-license number, entered live with you present.
`

  it('reads the ask from the newest turn, not the last marker in the file', () => {
    const ask = extractAsk(latestAgentTurn(JOURNAL))
    expect(ask).toContain('SSN')
    expect(ask).not.toContain('LastPass')
  })

  it('a naive whole-file grep would have returned the stale ask', () => {
    // Guard the guard: prove the stale line really is present in the file, so
    // this test fails loudly if someone "simplifies" back to a file-wide scan.
    expect(JOURNAL).toContain('LastPass will do the rest')
    expect(extractAsk(JOURNAL)).not.toContain('SSN')
  })
})

describe('buildDigest', () => {
  const entries = [
    { taskId: '349', title: 'Overnight agent v2', ask: 'say `merge 150`' },
    { taskId: '428', title: 'Neon Rave prep', ask: '`drop it` or `post it`' },
  ]

  it('lists every open ask with its task id and title', () => {
    const md = buildDigest(entries, { date: '2026-08-22' })
    expect(md).toContain('2026-08-22')
    expect(md).toContain('#349')
    expect(md).toContain('Overnight agent v2')
    expect(md).toContain('say `merge 150`')
    expect(md).toContain('#428')
    expect(md).toContain('2 open asks')
  })

  it('omits entries with no ask', () => {
    const md = buildDigest([...entries, { taskId: '999', title: 'Quiet', ask: null }], {
      date: '2026-08-22',
    })
    expect(md).not.toContain('#999')
    expect(md).toContain('2 open asks')
  })

  it('says so plainly when nothing is waiting', () => {
    const md = buildDigest([], { date: '2026-08-22' })
    expect(md).toContain('Nothing is waiting on you')
  })

  it('adds the reply-or-it-is-lost warning only when privacy mode is on', () => {
    expect(buildDigest(entries, { date: '2026-08-22', privacyModeOn: true })).toContain(
      'Reply to this message',
    )
    expect(buildDigest(entries, { date: '2026-08-22' })).not.toContain(
      'Reply to this message',
    )
  })

  it('stays within the Telegram size budget and reports what it dropped', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      taskId: `${i}`,
      title: `Task number ${i} with a reasonably long title`,
      ask: 'a fairly wordy ask that takes up a decent amount of room in the message',
    }))
    const md = buildDigest(many, { date: '2026-08-22', privacyModeOn: true })
    expect(md.length).toBeLessThanOrEqual(4096 - 600)
    expect(md).toMatch(/and \d+ more/)
  })

  it('ranks blocking asks above soft Next: hints, and drops the soft ones first', () => {
    const mixed = [
      { taskId: '1', title: 'Soft', ask: 'keep polling', source: 'next' },
      { taskId: '2', title: 'Blocking', ask: 'pick a size', source: 'needs' },
    ]
    const md = buildDigest(mixed, { date: '2026-08-22' })
    expect(md.indexOf('#2')).toBeLessThan(md.indexOf('#1'))
    // The headline count reflects real asks, not agent-side continuation.
    expect(md).toContain('1 open ask.')
  })

  it('when trimming, keeps blocking asks and sheds the soft ones', () => {
    const blocking = Array.from({ length: 40 }, (_, i) => ({
      taskId: `${900 + i}`,
      title: `Blocking task ${i} with a reasonably long descriptive title`,
      ask: 'a real decision that is genuinely waiting on you and needs an answer',
      source: 'needs',
    }))
    const soft = Array.from({ length: 60 }, (_, i) => ({
      taskId: `${100 + i}`,
      title: `Soft task ${i} with a reasonably long descriptive title`,
      ask: 'keep polling on future overnight runs and do nothing else at all',
      source: 'next',
    }))
    const md = buildDigest([...soft, ...blocking], { date: '2026-08-22' })
    expect(md).toContain('#900')
    // Soft entries are last, so they are the ones that get dropped.
    expect(md).not.toContain('#159')
  })
})

describe('hashDigest', () => {
  it('is stable for identical text and differs otherwise', () => {
    expect(hashDigest('a')).toBe(hashDigest('a'))
    expect(hashDigest('a')).not.toBe(hashDigest('b'))
  })
})

function makeHarness(files, { privacyModeOn = true, board = null } = {}) {
  const store = { ...files }
  const sent = []
  const client = {
    async createForumTopic({ name }) {
      return { message_thread_id: 1, name }
    },
    async sendMessage(m) {
      sent.push(m)
    },
    async closeForumTopic() {},
    async reopenForumTopic() {},
    async getUpdates() {
      return []
    },
    async getMe() {
      return { username: 'test_bot', id: 1, can_read_all_group_messages: !privacyModeOn }
    },
  }
  const io = {
    async listJournals() {
      return Object.keys(store).map((taskId) => ({ taskId, filename: `task-${taskId}.md` }))
    },
    async readJournal(id) {
      return store[id]
    },
    async writeJournal(id, content) {
      store[id] = content
    },
    async readCompletedBoard() {
      return ''
    },
  }
  // Only expose readBoard when a board was supplied, so the "io predates this
  // feature" path stays covered by every other test in this file.
  if (board != null) io.readBoard = async () => board
  return { store, sent, client, io, config: { chatId: '-100', taskAllowlist: [] } }
}

const journalWithAsk = (id, title, ask) => `# Task ${id}: ${title}

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** In-progress

**Needs from you:** ${ask}
`

describe('syncDigest', () => {
  it('posts one message to General (no topic) covering every open ask', async () => {
    const h = makeHarness({
      349: journalWithAsk(349, 'Overnight agent v2', 'say `merge 150`'),
      428: journalWithAsk(428, 'Neon Rave prep', '`drop it` or `post it`'),
    })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.posted).toBe(true)
    expect(res.count).toBe(2)
    expect(h.sent).toHaveLength(1)
    // General thread => no message_thread_id at all.
    expect(h.sent[0].messageThreadId).toBeUndefined()
    expect(h.sent[0].text).toContain('349')
    expect(h.sent[0].text).toContain('428')
  })

  it('does not repost an unchanged queue on the next run', async () => {
    const h = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 150`') })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncDigest()
    expect(h.sent).toHaveLength(1)

    const second = await bridge.syncDigest()
    expect(second.posted).toBe(false)
    expect(h.sent).toHaveLength(1)
  })

  it('reposts once the queue actually changes', async () => {
    const h = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 150`') })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncDigest()
    h.store['428'] = journalWithAsk(428, 'New', '`drop it`')
    const second = await bridge.syncDigest()
    expect(second.posted).toBe(true)
    expect(h.sent).toHaveLength(2)
  })

  it('force reposts even when unchanged', async () => {
    const h = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 150`') })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncDigest()
    const forced = await bridge.syncDigest({ force: true })
    expect(forced.posted).toBe(true)
    expect(h.sent).toHaveLength(2)
  })

  it('respects the task allowlist', async () => {
    const h = makeHarness({
      349: journalWithAsk(349, 'Kept', 'say `merge 150`'),
      428: journalWithAsk(428, 'Excluded', '`drop it`'),
    })
    const state = emptyState()
    const bridge = createBridge({
      client: h.client,
      config: { chatId: '-100', taskAllowlist: ['349'] },
      state,
      io: h.io,
    })

    const res = await bridge.syncDigest()
    expect(res.count).toBe(1)
    expect(h.sent[0].text).not.toContain('428')
  })

  it('skips journals with no agent block', async () => {
    const h = makeHarness({ 349: '# Task 349: No block\n\nsome user notes only\n' })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.count).toBe(0)
  })

  it('falls back to plain text when Telegram rejects the HTML', async () => {
    const h = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 150`') })
    let first = true
    const sent = []
    h.client.sendMessage = async (m) => {
      if (first && m.parseMode === 'HTML') {
        first = false
        throw new Error('bad entity')
      }
      sent.push(m)
    }
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.posted).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].parseMode).toBeUndefined()
  })

  it('still posts when getMe fails, just without the privacy warning', async () => {
    const h = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 150`') })
    h.client.getMe = async () => {
      throw new Error('network down')
    }
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.posted).toBe(true)
    expect(h.sent[0].text).not.toContain('Reply to this message')
  })
})

describe('syncOnce', () => {
  it('includes the digest and never lets it break the rest of the run', async () => {
    const h = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 150`') })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncOnce()
    expect(res.digest.posted).toBe(true)

    // A digest failure must not throw out of syncOnce.
    const h2 = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 151`') })
    const state2 = emptyState()
    const bridge2 = createBridge({ client: h2.client, config: h2.config, state: state2, io: h2.io })
    const originalSend = h2.client.sendMessage
    let calls = 0
    h2.client.sendMessage = async (m) => {
      calls += 1
      // Let syncUp's post through; fail every digest attempt.
      if (m.messageThreadId == null) throw new Error('digest boom')
      return originalSend(m)
    }
    const res2 = await bridge2.syncOnce()
    expect(res2.digest.posted).toBe(false)
    expect(res2.up.posted).toEqual(['349'])
    expect(calls).toBeGreaterThan(0)
  })

  // Regression: the digest is the bridge's only General-thread message. A user
  // who wants a strictly one-topic-per-task group must be able to silence it
  // WITHOUT losing per-task mirroring, so the opt-out has to skip the digest
  // and still post the task turn into its own topic.
  it('skips the digest entirely when digestEnabled is false, but still mirrors tasks', async () => {
    const h = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 150`') })
    const state = emptyState()
    const bridge = createBridge({
      client: h.client,
      config: { ...h.config, digestEnabled: false },
      state,
      io: h.io,
    })

    const res = await bridge.syncOnce()

    expect(res.digest.posted).toBe(false)
    expect(res.digest.skipped).toBe(true)
    // The task turn still goes out...
    expect(res.up.posted).toEqual(['349'])
    // ...and nothing at all was sent to General (no message_thread_id).
    expect(h.sent.filter((m) => m.messageThreadId == null)).toEqual([])
    // The digest hash must stay unwritten, so re-enabling posts a fresh digest
    // rather than silently suppressing the first one as "unchanged".
    expect(state.lastDigestHash).toBeFalsy()
  })

  it('still posts the digest when digestEnabled is true or absent', async () => {
    for (const cfgExtra of [{}, { digestEnabled: true }]) {
      const h = makeHarness({ 349: journalWithAsk(349, 'Demo', 'say `merge 150`') })
      const bridge = createBridge({
        client: h.client,
        config: { ...h.config, ...cfgExtra },
        state: emptyState(),
        io: h.io,
      })
      const res = await bridge.syncOnce()
      expect(res.digest.posted).toBe(true)
    }
  })
})

describe('syncDigest ordering (board-aware)', () => {
  // A realistic slice of planner.md: two P0s at the top of Today, an ordinary
  // Today task, a Deferred task, and NOTHING for 426580 — the malformed
  // six-digit id from #281 that used to win on numeric sort alone.
  const BOARD = `## Today

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 435 | 🔴 | Surrey BC dhol trip | P0 | 2026-08-22 | 392 |
| 433 | 🔴 | Land GH #150 | P0 | 2026-08-22 | 371 |
| 428 | 🟡 | Neon Rave prep | - | 2026-08-18 | 351 |

## Deferred

| ID | 🎯 | Task | Work Priority | Added | Linked ID |
|---|---|------|---------------|-------|-----------|
| 349 | 🟡 | Overnight agent v2 | - | | 192 |
`

  const files = {
    426580: journalWithAsk(426580, 'Stale parade question', 'approve the .ics'),
    349: journalWithAsk(349, 'Overnight agent v2', 'say `merge 150`'),
    428: journalWithAsk(428, 'Neon Rave prep', '`drop it` or `post it`'),
    433: journalWithAsk(433, 'Land GH #150', 'one word — `merge 150`'),
    435: journalWithAsk(435, 'Surrey BC dhol trip', 'pick a day'),
  }

  const orderOf = (text) =>
    text
      .split('\n')
      .filter((l) => l.startsWith('\u2022'))
      .map((l) => /#(\d+)/.exec(l)?.[1])

  it('leads with board urgency and sinks the off-board orphan', async () => {
    const h = makeHarness(files, { board: BOARD })
    const bridge = createBridge({
      client: h.client,
      config: h.config,
      state: emptyState(),
      io: h.io,
    })

    await bridge.syncDigest()
    expect(orderOf(h.sent[0].text)).toEqual([
      '435', // Today + P0
      '433', // Today + P0
      '428', // Today
      '349', // Deferred
      '426580', // not on the board at all
    ])
  })

  it('without a board, still falls back to newest-first', async () => {
    const h = makeHarness(files) // no readBoard on io
    const bridge = createBridge({
      client: h.client,
      config: h.config,
      state: emptyState(),
      io: h.io,
    })

    await bridge.syncDigest()
    expect(orderOf(h.sent[0].text)).toEqual(['426580', '435', '433', '428', '349'])
  })

  it('survives a board that cannot be read', async () => {
    const h = makeHarness(files, { board: BOARD })
    h.io.readBoard = async () => {
      throw new Error('ENOENT')
    }
    const bridge = createBridge({
      client: h.client,
      config: h.config,
      state: emptyState(),
      io: h.io,
    })

    const res = await bridge.syncDigest()
    expect(res.posted).toBe(true)
    expect(orderOf(h.sent[0].text)).toHaveLength(5)
  })

  it('excludes a P0 whose only Next: line is agent-side work', async () => {
    // 435 is a P0, but "keep polling charger availability" is work the AGENT
    // does. Ranking it low was not enough — it should not be listed at all,
    // otherwise the board-first order below would promote agent chatter to the
    // top of the queue. 349 is only Deferred but is a genuine ask.
    const softP0 = `# Task 435: Surrey BC dhol trip

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** In-progress

- Next: keep polling charger availability
`
    const h = makeHarness(
      { 435: softP0, 349: journalWithAsk(349, 'Overnight agent v2', 'say `merge 150`') },
      { board: BOARD },
    )
    const bridge = createBridge({
      client: h.client,
      config: h.config,
      state: emptyState(),
      io: h.io,
    })

    await bridge.syncDigest()
    expect(orderOf(h.sent[0].text)).toEqual(['349'])
  })

  it('ranks a P0 with a genuine Next: ask above an ordinary Today needs ask', async () => {
    // The regression this guards: marker style used to be the PRIMARY sort key,
    // so a 🔴 Today task phrasing its ask as `Next:` sorted below every
    // ordinary `Needs from you:` ask and fell off the size-capped message.
    // Observed live on #356, #434 and #407 one day after board ordering landed.
    const p0WithNext = `# Task 435: Surrey BC dhol trip

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** In-progress

- Next: reply with the day you want to drive.
`
    const h = makeHarness(
      { 435: p0WithNext, 428: journalWithAsk(428, 'Neon rave', 'watch it or drop it') },
      { board: BOARD },
    )
    const bridge = createBridge({
      client: h.client,
      config: h.config,
      state: emptyState(),
      io: h.io,
    })

    await bridge.syncDigest()
    // 435 is Today+P0, 428 is ordinary Today: the board decides, not the marker.
    expect(orderOf(h.sent[0].text)).toEqual(['435', '428'])
  })
})
