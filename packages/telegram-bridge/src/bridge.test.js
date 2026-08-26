import { describe, it, expect } from 'vitest'
import { createBridge } from './bridge.js'
import { emptyState } from './state.js'
import { FROM_ME } from './journal.js'

const AGENT_JOURNAL = `# Task 42: Demo

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Proposed \u00B7 plan v1 \u00B7 2026-07-08

### Proposed plan (v1)
1. do the thing
`

function makeHarness(files) {
  const store = { ...files }
  const sent = []
  let topicSeq = 0
  const created = []
  const closed = []
  const reopened = []
  let completedBoard = ''
  let updatesQueue = []

  const client = {
    async createForumTopic({ name }) {
      const id = ++topicSeq
      created.push({ id, name })
      return { message_thread_id: id, name }
    },
    async sendMessage(m) {
      sent.push(m)
    },
    async closeForumTopic({ messageThreadId }) {
      closed.push(messageThreadId)
    },
    async reopenForumTopic({ messageThreadId }) {
      reopened.push(messageThreadId)
    },
    async getUpdates() {
      const out = updatesQueue
      updatesQueue = []
      return out
    },
    async getMe() {
      return { username: 'test_bot', id: 1 }
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
      return completedBoard
    },
  }

  const config = { chatId: '-100', taskAllowlist: [] }
  return {
    store,
    sent,
    created,
    closed,
    reopened,
    client,
    io,
    config,
    setCompletedBoard: (md) => {
      completedBoard = md
    },
    queueUpdates: (u) => {
      updatesQueue = u
    },
  }
}

describe('syncUp', () => {
  it('creates a topic and posts the agent turn once, then dedups', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const first = await bridge.syncUp()
    expect(first.created).toEqual(['42'])
    expect(first.posted).toEqual(['42'])
    expect(h.created).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].messageThreadId).toBe(1)
    expect(h.sent[0].text).toContain('do the thing')
    expect(state.tasks['42'].topicId).toBe(1)

    // No journal change -> no new topic, no repost.
    const second = await bridge.syncUp()
    expect(second.created).toEqual([])
    expect(second.posted).toEqual([])
    expect(h.created).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
  })

  it('stamps a tg-meta marker into the journal for deep-linking', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.store['42']).toContain('<!-- tg-meta')
    expect(h.store['42']).toContain('chatId=-100')
    expect(h.store['42']).toContain('threadId=1')

    // Idempotent: a second sync with no change doesn't add a duplicate marker.
    await bridge.syncUp()
    expect(h.store['42'].match(/tg-meta/g)).toHaveLength(1)
  })

  it('skips journals without an agent block', async () => {
    const h = makeHarness({ 99: '# Task 99: bare\njust notes' })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })
    const res = await bridge.syncUp()
    expect(res.posted).toEqual([])
    expect(h.sent).toHaveLength(0)
  })

  it('honors the task allowlist', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL, 43: AGENT_JOURNAL.replace('42', '43') })
    const state = emptyState()
    const config = { ...h.config, taskAllowlist: ['43'] }
    const bridge = createBridge({ client: h.client, config, state, io: h.io })
    const res = await bridge.syncUp()
    expect(res.posted).toEqual(['43'])
  })
})

describe('baseline (natural, no backfill)', () => {
  it('marks existing tasks as already-seen without creating topics or posting', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL, 43: AGENT_JOURNAL.replace('42', '43') })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.baseline()
    expect(res.seen.sort()).toEqual(['42', '43'])
    // No side effects: no topics, no messages, no journal writes.
    expect(h.created).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
    expect(h.store['42']).toBe(AGENT_JOURNAL)
    expect(state.tasks['42'].lastPostedHash).toBeTruthy()
    expect(state.tasks['42'].topicId).toBeUndefined()
  })

  it('after baseline, an unchanged task creates no topic on syncUp', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.baseline()
    const up = await bridge.syncUp()
    expect(up.created).toEqual([])
    expect(up.posted).toEqual([])
    expect(h.created).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
    // No topic means no deep-link marker is stamped either.
    expect(h.store['42']).not.toContain('tg-meta')
  })

  it('after baseline, a NEW agent turn does create the topic and post', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.baseline()
    // The agent writes a fresh turn.
    h.store['42'] = AGENT_JOURNAL + '\n<!-- from: overnight-agent -->\nnew progress today\n'
    const up = await bridge.syncUp()
    expect(up.created).toEqual(['42'])
    expect(up.posted).toEqual(['42'])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('new progress today')
    expect(h.store['42']).toContain('<!-- tg-meta')
  })

  it('does not clobber a task that already has posted history', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    state.tasks['42'] = { topicId: 9, name: '#42', lastPostedHash: 'existing' }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.baseline()
    expect(res.seen).toEqual([])
    expect(res.skipped).toEqual(['42'])
    expect(state.tasks['42'].lastPostedHash).toBe('existing')
  })
})

describe('duplicate-topic prevention', () => {
  it('reuses the topic id from the journal tg-meta marker when state forgot it', async () => {
    // Journal already points at topic 41, but local state has no topicId for it
    // (e.g. state.json was reset). A new agent turn must reuse 41, not create a
    // duplicate topic.
    const journal =
      '# Task 206: Demo\n<!-- tg-meta chatId=-100 threadId=41 -->\n' +
      '---\n<!-- OVERNIGHT-AGENT do not edit this line -->\n\n## \u{1F319} Overnight Agent\n\nfresh turn today\n'
    const h = makeHarness({ 206: journal })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const up = await bridge.syncUp()
    expect(h.created).toHaveLength(0) // no new forum topic created
    expect(up.created).toEqual([]) // adopted, not created
    expect(up.posted).toEqual(['206'])
    expect(h.sent[0].messageThreadId).toBe(41) // posted to the existing topic
    expect(state.tasks['206'].topicId).toBe(41)
  })
})

describe('syncDown', () => {
  it('folds a topic reply into the journal and advances the offset', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    h.queueUpdates([
      {
        update_id: 100,
        message: { message_thread_id: 7, text: 'looks good, ship it', from: { is_bot: false } },
      },
    ])

    const res = await bridge.syncDown()
    expect(res.folded).toHaveLength(1)
    expect(res.folded[0].taskId).toBe('42')
    expect(h.store['42']).toContain(FROM_ME)
    expect(h.store['42']).toContain('looks good, ship it')
    expect(state.updateOffset).toBe(101)
  })

  it('ignores bot messages, unmapped topics, and empty text', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    h.queueUpdates([
      { update_id: 5, message: { message_thread_id: 7, text: 'echo', from: { is_bot: true } } },
      { update_id: 6, message: { message_thread_id: 999, text: 'stray', from: { is_bot: false } } },
      { update_id: 7, message: { message_thread_id: 7, text: '   ', from: { is_bot: false } } },
    ])

    const res = await bridge.syncDown()
    expect(res.folded).toHaveLength(0)
    // Offset still advances past processed updates so we don't re-fetch them.
    expect(state.updateOffset).toBe(8)
    expect(h.store['42']).toBe(AGENT_JOURNAL)
  })
})

describe('syncArchive (mirror completed board -> closed topics)', () => {
  const COMPLETED = `| # | 🎯 | Task | WP | Date |\n|---|---|---|---|---|\n| 42 | ✅ | done | - | 2026-08-02 |\n`

  it('does nothing when archiveCompleted is disabled', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard(COMPLETED)
    const config = { ...h.config, archiveCompleted: false }
    const bridge = createBridge({ client: h.client, config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.skipped).toBe(true)
    expect(res.archived).toEqual([])
    expect(res.reopened).toEqual([])
    expect(h.closed).toHaveLength(0)
    expect(state.tasks['42'].archived).toBeUndefined()
  })

  it('closes the topic of a task that has moved to the completed board', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard(COMPLETED)
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual(['42'])
    expect(h.closed).toEqual([7])
    expect(state.tasks['42'].archived).toBe(true)
  })

  it('is idempotent: an already-archived task is not re-closed', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', archived: true }
    h.setCompletedBoard(COMPLETED)
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual([])
    expect(h.closed).toHaveLength(0)
  })

  it('reopens a topic when its task leaves the completed board', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', archived: true }
    h.setCompletedBoard('') // no longer completed
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.reopened).toEqual(['42'])
    expect(h.reopened).toEqual([7])
    expect(state.tasks['42'].archived).toBe(false)
  })

  it('skips tasks that have no topic and honors the allowlist', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { name: '#42' } // no topicId yet
    state.tasks['43'] = { topicId: 8, name: '#43' }
    h.setCompletedBoard(`${COMPLETED}| 43 | ✅ | done | - | 2026-08-02 |\n`)
    const config = { ...h.config, taskAllowlist: ['99'] } // 43 not allowed
    const bridge = createBridge({ client: h.client, config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual([])
    expect(h.closed).toHaveLength(0)
  })

  it('a per-topic Telegram failure is swallowed and the flag is left unset', async () => {
    const h = makeHarness({})
    h.client.closeForumTopic = async () => {
      throw new Error('not enough rights to manage topics')
    }
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard(COMPLETED)
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual([]) // not recorded as archived
    expect(state.tasks['42'].archived).toBeFalsy() // retried next run
  })

  it('syncOnce runs the archive pass between up and down', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: 'x' }
    h.setCompletedBoard(COMPLETED)
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncOnce()
    expect(res.archived.archived).toEqual(['42'])
    expect(h.closed).toEqual([7])
  })

  it('no-ops safely when io has no readCompletedBoard', async () => {
    const h = makeHarness({})
    delete h.io.readCompletedBoard
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual([])
    expect(res.reopened).toEqual([])
  })
})

describe('formatForTelegram (via syncUp)', () => {
  // Walk the tag stream and report the first structural fault. Counting opens vs
  // closes is not enough: a raw slice can leave counts equal but nesting broken.
  function firstNestingError(html) {
    const stack = []
    const rx = /<(\/?)(b|i|u|s|code|pre|blockquote|a)\b[^>]*>/g
    let m
    while ((m = rx.exec(html))) {
      if (m[1] === '') stack.push({ tag: m[2], at: m.index })
      else {
        const top = stack.pop()
        if (!top) return `stray </${m[2]}> at ${m.index}`
        if (top.tag !== m[2]) return `<${top.tag}> at ${top.at} closed by </${m[2]}>`
      }
    }
    return stack.length ? `unclosed <${stack[stack.length - 1].tag}> at ${stack[stack.length - 1].at}` : null
  }

  // A turn whose MARKDOWN fits the old fixed 400-char allowance but whose HTML does
  // not: every line gains ~30 chars of tags. The old code emitted oversized HTML and
  // then did `msg.slice(0, 4095)`, which lands inside a tag; Telegram rejects the
  // whole message with "Can't find end tag corresponding to start tag b" and the
  // bridge silently downgrades to plain text, losing all formatting.
  // Observed live on task #448 (bodyHtml 4147, msg 4241, cut mid-`<b>`).
  const denseTurn = Array.from(
    { length: 120 },
    (_, i) => `- **bold item ${i}** with \`code ${i}\` and *emph ${i}* trailing words here`,
  ).join('\n')

  const denseJournal = `# Task 77: Dense formatting

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Proposed \u00B7 plan v1 \u00B7 2026-08-25

${denseTurn}
`

  it('never hands Telegram a severed tag, even when tag expansion blows the allowance', async () => {
    const h = makeHarness({ 77: denseJournal })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    expect(h.sent).toHaveLength(1)
    const { text } = h.sent[0]
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(firstNestingError(text)).toBeNull()
    // It must still be a real HTML message, not silently degraded to plain text.
    expect(text).toContain('<b>')
    // And it must not end mid-tag.
    expect(text).not.toMatch(/<[^>]*$/)
  })

  it('still posts short turns whole and unpadded', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    const { text } = h.sent[0]
    expect(text).toContain('do the thing')
    expect(text).not.toContain('\u2026')
    expect(firstNestingError(text)).toBeNull()
  })
})
