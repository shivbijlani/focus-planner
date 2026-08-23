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

  // Regression: replies to a cross-task digest arrive in General, which carries
  // no message_thread_id. These used to be dropped on the floor while looking
  // delivered to the user.
  it('routes a General-thread reply to the tasks it names', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL, 77: AGENT_JOURNAL.replace('42', '77') })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    h.queueUpdates([
      {
        update_id: 200,
        message: {
          message_id: 9,
          text: 'merge 42; go on 77',
          from: { is_bot: false },
        },
      },
    ])

    const res = await bridge.syncDown()
    expect(res.folded.map((f) => f.taskId).sort()).toEqual(['42', '77'])
    expect(h.store['42']).toContain('merge 42')
    expect(h.store['77']).toContain('go on 77')
    expect(state.updateOffset).toBe(201)
  })

  it('acknowledges an off-topic reply so the user knows it registered', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    h.queueUpdates([
      { update_id: 300, message: { message_id: 11, text: 'merge 42', from: { is_bot: false } } },
    ])

    await bridge.syncDown()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('#42')
    expect(h.sent[0].replyToMessageId).toBe(11)
  })

  it('does not acknowledge a reply posted inside a task topic', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    h.queueUpdates([
      {
        update_id: 400,
        message: { message_id: 12, message_thread_id: 7, text: 'ship it', from: { is_bot: false } },
      },
    ])

    await bridge.syncDown()
    expect(h.sent).toHaveLength(0)
    expect(h.store['42']).toContain('ship it')
  })

  it('reports an unroutable reply instead of silently discarding it', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    h.queueUpdates([
      { update_id: 500, message: { message_id: 13, text: 'merge all', from: { is_bot: false } } },
    ])

    const res = await bridge.syncDown()
    expect(res.folded).toHaveLength(0)
    expect(res.unrouted).toHaveLength(1)
    expect(res.unrouted[0].text).toBe('merge all')
    expect(h.sent).toHaveLength(0)
  })

  it('keeps folding when one named task has no journal yet', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    // 77 is a known ID only if a journal exists; simulate a listed-but-unreadable
    // journal by listing it while reads return undefined.
    h.io.listJournals = async () => [{ taskId: '42' }, { taskId: '77' }]

    h.queueUpdates([
      {
        update_id: 600,
        message: { message_id: 14, text: 'merge 42; go on 77', from: { is_bot: false } },
      },
    ])

    const res = await bridge.syncDown()
    expect(res.folded.map((f) => f.taskId)).toEqual(['42'])
    expect(res.unrouted).toHaveLength(1)
    expect(h.store['42']).toContain('merge 42')
  })

  it('survives a failed acknowledgement without losing the folded reply', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    h.client.sendMessage = async () => {
      throw new Error('429 Too Many Requests')
    }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    h.queueUpdates([
      { update_id: 700, message: { message_id: 15, text: 'merge 42', from: { is_bot: false } } },
    ])

    const res = await bridge.syncDown()
    expect(res.folded).toHaveLength(1)
    expect(h.store['42']).toContain('merge 42')
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

// The digest's privacy warning tells the user his plain typed messages are
// never delivered and that he must reply-to-bot. That is FALSE for a bot that
// is a group administrator — Telegram delivers everything to an admin bot even
// with privacy mode on, while `getMe` still reports
// `can_read_all_group_messages: false`. Printing it anyway put friction on the
// user's primary channel, so admin status has to win over the flag.
describe('syncDigest privacy warning', () => {
  const ASK_JOURNAL = `# Task 42: Demo

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Proposed \u00B7 plan v1 \u00B7 2026-07-08

**Needs from you:** one word - merge 150.
`

  const WARNING = 'Bot privacy mode is ON'

  const run = async (getChatMember) => {
    const h = makeHarness({ 42: ASK_JOURNAL })
    h.client.getMe = async () => ({
      username: 'test_bot',
      id: 1,
      can_read_all_group_messages: false,
    })
    if (getChatMember) h.client.getChatMember = getChatMember
    const bridge = createBridge({
      client: h.client,
      config: h.config,
      state: emptyState(),
      io: h.io,
    })
    await bridge.syncDigest()
    return h.sent[0].text || h.sent[0].markdown || JSON.stringify(h.sent[0])
  }

  it('omits the warning when the bot is a group administrator', async () => {
    const text = await run(async () => ({ status: 'administrator' }))
    expect(text).not.toContain(WARNING)
  })

  it('omits the warning when the bot is the group creator', async () => {
    const text = await run(async () => ({ status: 'creator' }))
    expect(text).not.toContain(WARNING)
  })

  it('keeps the warning when the bot is only a member', async () => {
    const text = await run(async () => ({ status: 'member' }))
    expect(text).toContain(WARNING)
  })

  it('falls back to the flag when membership cannot be read', async () => {
    const text = await run(async () => {
      throw new Error('forbidden')
    })
    expect(text).toContain(WARNING)
  })
})

// The digest is the only message that leaves a task topic. Posting it to
// General is what made the group noisy enough to be switched off wholesale —
// which then cost the user the only consolidated view of the approval queue.
// These cover the middle option: keep the digest, give it its own topic.
describe('syncDigest destination', () => {
  const ASK_JOURNAL = `# Task 42: Demo

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Proposed \u00B7 plan v1 \u00B7 2026-07-08

**Needs from you:** one word - merge 150.
`

  it('posts to the General thread when no topic is configured', async () => {
    const h = makeHarness({ 42: ASK_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.posted).toBe(true)
    expect(res.threadId).toBe(null)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].messageThreadId).toBeUndefined()
    // No topic should be created for the General-thread default.
    expect(h.created).toHaveLength(0)
  })

  it('posts into an existing topic when configured with a numeric id', async () => {
    const h = makeHarness({ 42: ASK_JOURNAL })
    h.config.digestTopic = '77'
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.threadId).toBe(77)
    expect(h.sent[0].messageThreadId).toBe(77)
    // A numeric id names a topic that already exists - never create one.
    expect(h.created).toHaveLength(0)
  })

  it('creates a named topic once and reuses it on later runs', async () => {
    const h = makeHarness({ 42: ASK_JOURNAL })
    h.config.digestTopic = 'Waiting on you'
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const first = await bridge.syncDigest()
    expect(h.created).toEqual([{ id: 1, name: 'Waiting on you' }])
    expect(first.threadId).toBe(1)
    expect(state.digestTopicId).toBe(1)
    expect(state.digestTopicName).toBe('Waiting on you')

    // Force a repost: the queue is unchanged, so only `force` gets us here.
    // The topic must be reused, not recreated - otherwise the group collects a
    // new "Waiting on you" topic every single night.
    const second = await bridge.syncDigest({ force: true })
    expect(h.created).toHaveLength(1)
    expect(second.threadId).toBe(1)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].messageThreadId).toBe(1)
  })

  it('resolves a fresh topic when the configured name changes', async () => {
    const h = makeHarness({ 42: ASK_JOURNAL })
    h.config.digestTopic = 'Waiting on you'
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })
    await bridge.syncDigest()
    expect(state.digestTopicId).toBe(1)

    h.config.digestTopic = 'Approvals'
    const renamed = createBridge({ client: h.client, config: h.config, state, io: h.io })
    const res = await renamed.syncDigest({ force: true })
    expect(res.threadId).toBe(2)
    expect(state.digestTopicName).toBe('Approvals')
    expect(h.created).toEqual([
      { id: 1, name: 'Waiting on you' },
      { id: 2, name: 'Approvals' },
    ])
  })

  it('does not create a topic when the queue is unchanged', async () => {
    const h = makeHarness({ 42: ASK_JOURNAL })
    h.config.digestTopic = 'Waiting on you'
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncDigest()
    expect(h.created).toHaveLength(1)

    // Second run, nothing changed: it must short-circuit BEFORE resolving the
    // destination, so a quiet night has no side effects at all.
    const quiet = await bridge.syncDigest()
    expect(quiet.posted).toBe(false)
    expect(h.created).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
  })

  it('keeps the thread id on the plain-text retry path', async () => {
    const h = makeHarness({ 42: ASK_JOURNAL })
    h.config.digestTopic = '77'
    let first = true
    h.client.sendMessage = async (m) => {
      if (first) {
        first = false
        throw new Error('bad entity')
      }
      h.sent.push(m)
    }
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncDigest()
    // The HTML attempt failed; the fallback must still land in the topic
    // rather than silently falling back to General.
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].messageThreadId).toBe(77)
    expect(h.sent[0].parseMode).toBeUndefined()
  })

  it('a reply inside the digest topic still routes by task id', async () => {
    const h = makeHarness({ 42: ASK_JOURNAL })
    h.config.digestTopic = 'Waiting on you'
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })
    await bridge.syncDigest()

    // The digest topic is NOT a task topic, so a reply in it must fall through
    // to by-task-id routing exactly as a General reply does.
    h.queueUpdates([
      {
        update_id: 1,
        message: { message_id: 9, message_thread_id: 1, text: '#42 approve', from: { id: 5 } },
      },
    ])
    const down = await bridge.syncDown()
    // routeReply folds the segment in verbatim by design, so the id prefix
    // stays; what matters here is that it reached task 42 at all.
    expect(down.folded).toEqual([{ taskId: '42', text: '#42 approve' }])
    expect(h.store['42']).toContain(FROM_ME)
  })
})

// A journal whose agent block holds a real, still-open ask, but whose NEWEST
// agent turn is a later chat reply about something else - so it carries no ask
// marker of its own. Before the fallback this task vanished from the digest
// entirely (measured live: 38 tasks in this exact shape).
const DEMOTED_JOURNAL = `# Task 42: Demo

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** In-progress \u00B7 plan v1 \u00B7 2026-08-01

**Needs from you:** one word - merge 120.

## 2026-08-23

<!-- from: me -->
Unrelated new task: buy a mattress.

<!-- from: overnight-agent -->
Created that as #438 and cross-linked it. Nothing outstanding on my side here.
`

// A freshly proposed plan written with SKILL.md's own block template: it needs
// no extra information, so `Needs from you:` is "none" and the actual ask - the
// approve/revise/skip decision - lives only on the `Your call:` line.
const TEMPLATE_PROPOSAL = `# Task 42: Demo

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Proposed \u00B7 plan v1 \u00B7 2026-08-01

### Proposed plan (v1)
1. Do the thing.

**Needs from you:** none.

**Your call:** just reply below in plain English - "approve", "revise: ...", or "skip".
`

describe('syncDigest agent-block fallback', () => {  it('surfaces an ask from the agent block when the newest turn has none', async () => {
    const h = makeHarness({ 42: DEMOTED_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.posted).toBe(true)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('#42')
    expect(h.sent[0].text).toContain('merge 120')
  })

  it('does NOT revive a finished task into the queue', async () => {
    // Same shape, but the block is terminal. A done task must stay gone even
    // though its block still contains the historical marker.
    const done = DEMOTED_JOURNAL.replace(
      '**Status:** In-progress \u00B7 plan v1 \u00B7 2026-08-01',
      '**Status:** Done \u00B7 plan v1 \u00B7 2026-08-01',
    )
    const h = makeHarness({ 42: done })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.count).toBe(0)
    expect(h.sent[0].text).not.toContain('merge 120')
  })

  // SKILL.md's block template closes a proposed plan with `**Needs from you:**
  // none` + `**Your call:** ...`. Measured live, that combination made every
  // such plan invisible in the approval queue - the ask the user is meant to
  // answer was the ONLY thing the digest could not see.
  it('surfaces a proposed plan whose only ask is the "Your call" hand-back', async () => {
    const h = makeHarness({ 42: TEMPLATE_PROPOSAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.count).toBe(1)
    expect(h.sent[0].text).toContain('#42')
  })

  it('does NOT let boilerplate revive a finished task', async () => {
    // Identical turn, terminal block. The `Your call:` line survives verbatim
    // into closed turns, so on its own it must never reopen the queue entry.
    const done = TEMPLATE_PROPOSAL.replace(
      '**Status:** Proposed \u00B7 plan v1 \u00B7 2026-08-01',
      '**Status:** Done \u00B7 plan v1 \u00B7 2026-08-01',
    )
    const h = makeHarness({ 42: done })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.count).toBe(0)
  })

  it('still prefers the newest turn when that turn HAS an ask', async () => {    // The fallback must never override a fresher ask - otherwise it would
    // resurrect exactly the stale asks digest.js warns about.
    const fresher = DEMOTED_JOURNAL.replace(
      'Created that as #438 and cross-linked it. Nothing outstanding on my side here.',
      '**Needs from you:** the newer question instead.',
    )
    const h = makeHarness({ 42: fresher })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncDigest()
    expect(h.sent[0].text).toContain('the newer question instead')
    expect(h.sent[0].text).not.toContain('merge 120')
  })

  it('ignores a block whose ask is explicitly "none"', async () => {
    const none = DEMOTED_JOURNAL.replace(
      '**Needs from you:** one word - merge 120.',
      '**Needs from you:** none',
    )
    const h = makeHarness({ 42: none })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.count).toBe(0)
  })
})
