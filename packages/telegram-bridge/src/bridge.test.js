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
  }

  const config = { chatId: '-100', taskAllowlist: [] }
  return {
    store,
    sent,
    created,
    client,
    io,
    config,
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
