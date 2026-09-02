import { describe, it, expect } from 'vitest'
import { createBridge, hashTurn } from './bridge.js'
import { emptyState, setUserEngaged } from './state.js'
import { FROM_ME, TURN_END, latestAgentTurn } from './journal.js'

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
  let messageSeq = 0
  const created = []
  const closed = []
  const reopened = []
  const deleted = []
  let deleteFails = false
  let completedBoard = ''
  let activeBoard = ''
  let syncRecords = []
  let updatesQueue = []

  const client = {
    async createForumTopic({ name }) {
      const id = ++topicSeq
      created.push({ id, name })
      return { message_thread_id: id, name }
    },
    async sendMessage(m) {
      sent.push(m)
      // Real Telegram returns the Message, and #205's collapse depends on the
      // message_id in it. A harness that returned undefined would make the
      // feature untestable while every assertion still passed.
      return { message_id: ++messageSeq }
    },
    async deleteMessage({ messageId }) {
      if (deleteFails) throw new Error('message to delete not found')
      deleted.push(messageId)
      return true
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
    async readBoard() {
      return activeBoard
    },
    async readSyncRecords() {
      return syncRecords
    },
  }

  const config = { chatId: '-100', taskAllowlist: [] }
  return {
    store,
    sent,
    created,
    closed,
    reopened,
    deleted,
    client,
    io,
    config,
    failDeletes: () => {
      deleteFails = true
    },
    setCompletedBoard: (md) => {
      completedBoard = md
    },
    setActiveBoard: (md) => {
      activeBoard = md
    },
    setSyncRecords: (records) => {
      syncRecords = records
    },
    queueUpdates: (u) => {
      updatesQueue = u
    },
  }
}

describe('collapsing superseded turns (#205)', () => {
  const secondTurn = AGENT_JOURNAL.replace('do the thing', 'do the other thing')

  it('deletes the previous unanswered turn instead of stacking a second one', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    const firstId = state.tasks['42'].lastPostedMessageIds
    expect(firstId).toEqual([1])

    // A new turn arrives with no reply from the user in between.
    h.store['42'] = secondTurn
    await bridge.syncUp()

    expect(h.sent).toHaveLength(2)
    // The superseded message is gone, so the topic holds ONE current message.
    expect(h.deleted).toEqual([1])
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([2])
  })

  it('NEVER deletes a turn the user has replied to', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1])

    // The user has spoken since. That turn is now frozen history, not a draft.
    setUserEngaged(state, '42', true)
    h.store['42'] = secondTurn
    await bridge.syncUp()

    expect(h.sent).toHaveLength(2)
    expect(h.deleted).toEqual([])
  })

  it('posts before deleting, and a failed delete never costs the new turn', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    h.failDeletes()
    h.store['42'] = secondTurn
    await bridge.syncUp()

    // Degrades to the OLD stacking behaviour -- never to a lost message.
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].text).toContain('do the other thing')
    expect(h.deleted).toEqual([])
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([2])
  })
})

// The collapse guard used to ask `userEngaged`, which is CONSUMED by the next
// post and therefore reports "a turn went out since your message" rather than
// "a turn ANSWERED your message". run-telegram-mirror.ps1 runs sync-down and
// sync-up in one invocation, so a reply folded seconds earlier was marked
// answered by a turn written before it existed -- and the next pass deleted
// that turn. The boundary is now a monotonic fold count that nothing consumes.
describe('collapse boundary is a fold count, not an answered flag (#278)', () => {
  const secondTurn = AGENT_JOURNAL.replace('do the thing', 'do the other thing')
  const thirdTurn = AGENT_JOURNAL.replace('do the thing', 'do a third thing')

  const reply = (text) => [
    {
      update_id: 900,
      message: { message_thread_id: 1, message_id: 77, text, from: { is_bot: false } },
    },
  ]

  it('does not mark a folded reply answered with a turn posted in the same pass', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    // Establish the topic so the reply can be routed to it, exactly as live.
    await bridge.syncUp()
    const foldSeqBefore = state.tasks['42'].foldSeq ?? 0

    // One invocation of the mirror: sync-down folds, then sync-up posts a turn
    // the agent had already written before the reply arrived.
    h.queueUpdates(reply('what about the video?'))
    await bridge.syncDown()
    expect(state.tasks['42'].foldSeq).toBe(foldSeqBefore + 1)

    h.store['42'] = secondTurn
    await bridge.syncUp()

    // The debt is settled -- that half of `userEngaged` is still correct -- but
    // the boundary is NOT: nothing consumed the fold count.
    expect(state.tasks['42'].userEngaged).toBe(false)
    expect(state.tasks['42'].foldSeq).toBe(foldSeqBefore + 1)
  })

  it('does not collapse a turn posted in the same pass as a fold', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp() // turn 1, message id 1

    h.queueUpdates(reply('what about the video?'))
    await bridge.syncDown()

    h.store['42'] = secondTurn
    await bridge.syncUp() // turn 2, message id 2 -- authored before the reply
    expect(h.deleted).toEqual([]) // turn 1 is above his reply: frozen

    h.store['42'] = thirdTurn
    await bridge.syncUp() // turn 3, message id 3

    // The old guard deleted message 2 here, because posting turn 2 had consumed
    // `userEngaged`. Turn 2 could not have answered a reply that arrived after
    // it was written, so it stays.
    expect(h.sent).toHaveLength(3)
    expect(h.deleted).toEqual([])
  })

  it('resumes collapsing on the turn after the boundary', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp() // 1
    h.queueUpdates(reply('ping'))
    await bridge.syncDown()
    h.store['42'] = secondTurn
    await bridge.syncUp() // 2 -- frozen at the boundary
    h.store['42'] = thirdTurn
    await bridge.syncUp() // 3 -- clear boundary again, so remembered
    expect(h.deleted).toEqual([])

    h.store['42'] = AGENT_JOURNAL.replace('do the thing', 'do a fourth thing')
    await bridge.syncUp() // 4 supersedes 3

    expect(h.deleted).toEqual([3])
  })

  // Observation 2 on the issue: the same task collapsed on one pass and stacked
  // on the next, with no reply in between, because the answer depended on
  // whether a fold had landed in the same invocation. Two stored numbers cannot
  // drift like that.
  it('collapses deterministically across consecutive turns with no fold between', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp() // 1
    for (const [index, text] of ['second', 'third', 'fourth'].entries()) {
      h.store['42'] = AGENT_JOURNAL.replace('do the thing', `do the ${text} thing`)
      await bridge.syncUp()
      // Every pass collapses exactly its predecessor -- no run is a special case.
      expect(h.deleted).toEqual([1, 2, 3].slice(0, index + 1))
    }
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([4])
  })

  // The losslessness rule from user-settings.md: collapsing may only remove a
  // turn the replacement supersedes. Live, it removed a turn carrying a YouTube
  // link that the next turn never repeated.
  it('keeps a turn whose content the replacement does not carry forward', async () => {
    const withLink = AGENT_JOURNAL.replace(
      'do the thing',
      'watched https://www.youtube.com/watch?v=abc123',
    )
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    h.queueUpdates(reply('anything good on it?'))
    await bridge.syncDown()

    // The turn holding the link was written before the reply, so it goes out
    // unchanged and is not an answer to anything.
    h.store['42'] = withLink
    await bridge.syncUp()
    const linkMessage = h.sent.findIndex((m) => m.text.includes('youtube.com'))
    expect(linkMessage).toBeGreaterThan(-1)

    // A later turn that says nothing about the video must not take it away.
    h.store['42'] = secondTurn
    await bridge.syncUp()

    expect(h.deleted).not.toContain(linkMessage + 1)
    expect(h.deleted).toEqual([])
  })

  // State written before `lastPostedFoldSeq` existed has ids but no stamp. One
  // skipped collapse is stacking; one wrong delete is unrecoverable.
  it('declines to collapse ids carried over from state without a fold stamp', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    state.tasks['42'] = {
      topicId: 1,
      name: '#42',
      lastPostedHash: 'stale',
      lastPostedMessageIds: [2511],
    }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.deleted).toEqual([])

    // ...and heals on the very next pass, once a stamp exists.
    h.store['42'] = secondTurn
    await bridge.syncUp()
    expect(h.deleted).toEqual([1])
  })
})

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

describe('syncUp does not disturb tasks the user has already closed', () => {
  const COMPLETED = `| # | 🎯 | Task | WP | Date |\n|---|---|---|---|---|\n| 42 | ✅ | done | - | 2026-08-02 |\n`

  // The regression this guards: a maintenance edit to an OLD closed journal
  // (reformatting a marker so the digest can parse it) changes the parsed turn,
  // which used to be the only thing gating a post. The bot is a group admin, so
  // Telegram let it post into the closed topic and the finished task resurfaced.
  it('suppresses a post when the task is on the completed board', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: 'stale', archived: true }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncUp()
    expect(res.posted).toEqual([])
    expect(res.suppressed).toEqual(['42'])
    expect(h.sent).toHaveLength(0)
  })

  it('remembers the suppressed turn without recording it as posted', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: 'stale', archived: true }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    // The declined hash is remembered separately, so re-runs stay quiet...
    expect(state.tasks['42'].suppressedHash).toBe(hashTurn(latestAgentTurn(AGENT_JOURNAL)))
    // ...but it is NOT passed off as delivered. Marking an unsent turn as sent
    // is what made the loss permanent (#186): the unchanged-turn check reads
    // `lastPostedHash` first, so an absorbed turn could never be sent later.
    expect(state.tasks['42'].lastPostedHash).toBe('stale')

    const again = await bridge.syncUp()
    expect(again.posted).toEqual([])
    expect(again.suppressed).toEqual(['42'])
    expect(h.sent).toHaveLength(0)
  })

  // The other half of that contract: a task that genuinely LEAVES the completed
  // board is live again, and the turn it was owed must actually arrive.
  it('delivers the pending turn if the task is later reopened', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: 'stale', archived: true }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    expect((await bridge.syncUp()).suppressed).toEqual(['42'])

    // A fresh bridge = the next run, which re-reads the boards (the read is
    // memoised for the lifetime of one run, by design).
    h.setCompletedBoard('')
    const next = createBridge({ client: h.client, config: h.config, state, io: h.io })
    const again = await next.syncUp()
    expect(again.posted).toEqual(['42'])
    expect(h.sent).toHaveLength(1)
  })

  it('never creates a forum topic for a completed task', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncUp()
    expect(h.created).toHaveLength(0)
    expect(res.suppressed).toEqual(['42'])
    expect(h.store['42']).not.toContain('<!-- tg-meta')
  })

  it('still posts for an OPEN task', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard('') // not completed
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncUp()
    expect(res.posted).toEqual(['42'])
    expect(res.suppressed).toEqual([])
  })

  // The guard must not swallow a real conversation: if the user asks something
  // in a closed task's topic, they are owed the answer.
  it('answers a closed task once the user has replied in it', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: 'stale', archived: true }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    h.queueUpdates([
      {
        update_id: 900,
        message: { message_thread_id: 7, message_id: 3, text: 'why did this run?', from: { is_bot: false } },
      },
    ])
    await bridge.syncDown()
    expect(state.tasks['42'].userEngaged).toBe(true)

    const res = await bridge.syncUp()
    expect(res.posted).toEqual(['42'])
    expect(h.sent).toHaveLength(1)
  })

  it('goes quiet again after answering, so one reply buys one answer', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    const state = emptyState()
    state.tasks['42'] = {
      topicId: 7,
      name: '#42',
      lastPostedHash: 'stale',
      archived: true,
      userEngaged: true,
    }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(state.tasks['42'].userEngaged).toBe(false)

    // The agent writes to the closed journal again, unprompted: stay silent.
    h.store['42'] = `${AGENT_JOURNAL}\nanother unprompted edit\n`
    const second = await bridge.syncUp()
    expect(second.posted).toEqual([])
    expect(second.suppressed).toEqual(['42'])
  })

  it('posts normally when the completed board cannot be read', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    delete h.io.readCompletedBoard
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncUp()
    expect(res.posted).toEqual(['42'])
  })
})

// A row can sit on planner.md and planner-completed.md at the SAME time — the
// planner's sync layer produces exactly that, and five live tasks were in it.
// Treating "on the completed board" as "finished" therefore silenced tasks the
// user was actively working, and because the guard absorbed the turn hash into
// `lastPostedHash` the turn could never be delivered afterwards. (#186)
describe('syncUp dual-board tasks (active board wins)', () => {
  const COMPLETED = `| # | 🎯 | Task | WP | Date |\n|---|---|---|---|---|\n| 42 | ✅ | done | - | 2026-08-02 |\n`
  const ACTIVE = `## Today\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|---|---|---|---|---|---|\n| 42 | 🔴 | Demo | P0 | 2026-08-02 |  |\n`

  it('posts a task listed on BOTH boards instead of suppressing it', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    h.setActiveBoard(ACTIVE)
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncUp()
    expect(res.posted).toEqual(['42'])
    expect(res.suppressed).toEqual([])
  })

  it('still suppresses a task that is ONLY on the completed board (#170 holds)', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    h.setActiveBoard(`## Today\n\n| ID | 🎯 | Task | Work Priority | Added |\n|---|---|---|---|---|\n| 99 | 🟡 | other | P2 | 2026-08-02 |\n`)
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncUp()
    expect(res.posted).toEqual([])
    expect(res.suppressed).toEqual(['42'])
  })

  // The permanence half of the bug: suppression used to write the declined hash
  // into `lastPostedHash`, and the unchanged-turn check reads that field FIRST.
  it('does not record a suppressed turn as posted', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(state.tasks['42'].lastPostedHash).toBeFalsy()
    expect(state.tasks['42'].suppressedHash).toBe(hashTurn(latestAgentTurn(AGENT_JOURNAL)))
  })

  it('delivers the pending turn once the task becomes eligible', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    expect((await bridge.syncUp()).suppressed).toEqual(['42'])

    // The user replies in the topic — syncDown sets this. The SAME turn, never
    // edited since, must now go out rather than being skipped as unchanged.
    state.tasks['42'].userEngaged = true
    const second = await bridge.syncUp()
    expect(second.posted).toEqual(['42'])
    expect(state.tasks['42'].suppressedHash).toBeFalsy()
  })

  it('falls back to completed-only when the active board is empty or unreadable', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    h.setCompletedBoard(COMPLETED)
    delete h.io.readBoard
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    expect((await bridge.syncUp()).suppressed).toEqual(['42'])
  })

  it('recover-suppressed releases only dual-board tasks whose turn was absorbed', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL, 99: AGENT_JOURNAL.replace('Task 42', 'Task 99') })
    h.setCompletedBoard(
      `| # | 🎯 | Task | WP | Date |\n|---|---|---|---|---|\n| 42 | ✅ | done | - | 2026-08-02 |\n| 99 | ✅ | done | - | 2026-08-02 |\n`,
    )
    h.setActiveBoard(ACTIVE) // only 42 is still live
    const state = emptyState()
    // Both look "posted" because the OLD guard absorbed their hashes.
    state.tasks['42'] = { topicId: 7, lastPostedHash: hashTurn(latestAgentTurn(h.store['42'])) }
    state.tasks['99'] = { topicId: 8, lastPostedHash: hashTurn(latestAgentTurn(h.store['99'])) }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.recoverSuppressed()
    expect(res.released).toEqual(['42'])
    expect(state.tasks['99'].lastPostedHash).toBeTruthy() // genuinely completed: untouched

    // And the released turn actually reaches its EXISTING topic — no new one.
    const up = await bridge.syncUp()
    expect(up.posted).toEqual(['42'])
    expect(up.created).toEqual([])
    expect(h.sent.at(-1).messageThreadId).toBe(7)
  })
})

describe('syncArchive (mirror completed board -> closed topics)', () => {
  const COMPLETED = `| # | 🎯 | Task | WP | Date |\n|---|---|---|---|---|\n| 42 | ✅ | done | - | 2026-08-02 |\n`
  const DELETED = JSON.stringify({
    version: 1,
    entries: { 42: { clock: 1787621820553, deleted: true, fp: -1 } },
  })

  // A task DELETED in the app leaves both boards, so the completed board can
  // never mention it again. Before this, `shouldArchive` was completed-only and
  // its topic stayed open forever: 65 such topics had piled up in the live
  // forum, and #434 (deleted 2026-08-24) was still there four days later.
  it('closes the topic of a task the user deleted in the app', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard('') // deleted, so it is on NEITHER board
    h.setSyncRecords([DELETED])
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual(['42'])
    expect(h.closed).toEqual([7])
    expect(state.tasks['42'].archived).toBe(true)
  })

  // THE bug that made a manual close useless: with completed-only logic, a
  // topic closed by hand looked like "archived but shouldn't be", so the very
  // next run reopened it.
  it('does not reopen a deleted task that is already closed', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', archived: true }
    h.setCompletedBoard('')
    h.setSyncRecords([DELETED])
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.reopened).toEqual([])
    expect(h.reopened).toHaveLength(0)
    expect(state.tasks['42'].archived).toBe(true)
  })

  it('unions the two sync records, so a tombstone in either counts', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    state.tasks['43'] = { topicId: 8, name: '#43' }
    h.setCompletedBoard('')
    h.setSyncRecords([
      JSON.stringify({ entries: { 42: { deleted: true } } }),
      JSON.stringify({ entries: { 43: { deleted: true } } }),
    ])
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived.sort()).toEqual(['42', '43'])
    expect(h.closed.sort()).toEqual([7, 8])
  })

  // The safety property: a live task must never lose its topic because a sync
  // file was unreadable, half-written, or simply says deleted:false.
  it('never closes a live task when the sync record is junk or says not-deleted', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard('')
    h.setSyncRecords(['{"entries":{"42":{"deleted":fal', JSON.stringify({ entries: { 42: { deleted: false } } })])
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual([])
    expect(h.closed).toHaveLength(0)
    expect(state.tasks['42'].archived).toBeUndefined()
  })

  // REGRESSION (found live 2026-08-29): `readSyncRecords` returns EVERY planner
  // sync record, and a task that is live on the ACTIVE board is legitimately
  // absent from `planner-completed.md` — so that board's record tombstones it
  // as `deleted: true`. Unioning both records loses which board the tombstone
  // came from, so "not a row in the completed file" was read as "the user
  // deleted this task" and `|| isDeleted` bypassed the active-wins rule
  // entirely. Measured on the live planner: 37 active-board tasks carried such
  // a tombstone and 33 had their topic closed underneath them, including #276
  // on the Today board.
  it('never closes a live active-board task tombstoned by the COMPLETED record', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard('') // not completed...
    h.setActiveBoard(
      `## Today\n\n| ID | 🎯 | Task | Work Priority | Added |\n|---|---|---|---|---|\n| 42 | 🔴 | live | P0 | 2026-08-02 |\n`,
    ) // ...it is LIVE on the board
    h.setSyncRecords([DELETED]) // completed-board record says deleted:true
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual([])
    expect(h.closed).toHaveLength(0)
  })

  // The recovery half: the topics already closed by the bug must come back on
  // the next run, otherwise the fix only stops new damage and leaves the 33
  // live tasks silently muted forever.
  it('reopens an active-board task that a completed-record tombstone had closed', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', archived: true }
    h.setCompletedBoard('')
    h.setActiveBoard(
      `## Today\n\n| ID | 🎯 | Task | Work Priority | Added |\n|---|---|---|---|---|\n| 42 | 🔴 | live | P0 | 2026-08-02 |\n`,
    )
    h.setSyncRecords([DELETED])
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.reopened).toEqual(['42'])
    expect(h.reopened).toEqual([7])
    expect(state.tasks['42'].archived).toBe(false)
  })

  // The genuine deletion (#434) must still be archived: a task the user really
  // deleted leaves BOTH boards, so the active-board rescue cannot reach it.
  it('still closes a genuinely deleted task, which is on neither board', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard('')
    h.setActiveBoard(
      `## Today\n\n| ID | 🎯 | Task | Work Priority | Added |\n|---|---|---|---|---|\n| 99 | 🟡 | other | P2 | 2026-08-02 |\n`,
    )
    h.setSyncRecords([DELETED])
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual(['42'])
    expect(h.closed).toEqual([7])
  })

  it('still works against an io that has no readSyncRecords (back-compat)', async () => {
    const h = makeHarness({})
    delete h.io.readSyncRecords
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard(COMPLETED)
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual(['42'])
    expect(h.closed).toEqual([7])
  })

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

  // Closing a dual-board task's topic would collapse the thread the user is
  // still talking in, so the same active-wins rule applies here. (#186)
  it('leaves a dual-board task’s topic open', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42' }
    h.setCompletedBoard(COMPLETED)
    h.setActiveBoard(
      `## Today\n\n| ID | 🎯 | Task | Work Priority | Added |\n|---|---|---|---|---|\n| 42 | 🔴 | Demo | P0 | 2026-08-02 |\n`,
    )
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.archived).toEqual([])
    expect(h.closed).toEqual([])
  })

  it('reopens a topic when the task returns to the active board', async () => {
    const h = makeHarness({})
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', archived: true }
    h.setCompletedBoard(COMPLETED)
    h.setActiveBoard(
      `## Today\n\n| ID | 🎯 | Task | Work Priority | Added |\n|---|---|---|---|---|\n| 42 | 🔴 | Demo | P0 | 2026-08-02 |\n`,
    )
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncArchive()
    expect(res.reopened).toEqual(['42'])
    expect(h.reopened).toEqual([7])
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

  // A journal whose newest agent entry is malformed - the `<!-- from:
  // overnight-agent -->` marker written ABOVE its `## <date>` heading - parses
  // to an empty turn. The task must still reach the queue via its block.
  it('falls back to the block when the newest turn is unparseable', async () => {
    const malformed = `# Task 42: Demo

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** In-progress \u00B7 plan v2 \u00B7 2026-08-01

**Needs from you:** just approve and I will open the PR.

<!-- from: overnight-agent -->

## 2026-08-02

A later turn whose marker sits above its date heading, so it parses as empty.
`
    const h = makeHarness({ 42: malformed })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncDigest()
    expect(res.count).toBe(1)
    expect(h.sent[0].text).toContain('just approve')
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

    // A turn this long is now SPLIT rather than truncated (#210), so assert the
    // tag-balance guarantee on EVERY part, not just the first.
    expect(h.sent.length).toBeGreaterThanOrEqual(1)
    for (const { text } of h.sent) {
      expect(text.length).toBeLessThanOrEqual(4096)
      expect(firstNestingError(text)).toBeNull()
      // It must still be a real HTML message, not silently degraded to plain text.
      expect(text).toContain('<b>')
      // And it must not end mid-tag.
      expect(text).not.toMatch(/<[^>]*$/)
    }
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

// GH #210: a turn over the 4096 cap used to be TRUNCATED to a prefix. Because an
// agent turn puts its ask at the END, truncation deleted exactly the part the
// reader is supposed to act on. Measured across 239 live journals: 55 turns
// truncated, 33 of them with the ask silently removed.
describe('long turns keep their ask (#210)', () => {
  const ASK = '**Needs from you:** one word — `merge 198` to ship the journal-reply fix.'
  const CALL = '**Your call:** reply below in plain English.'

  // ~7.5k chars of body, then the ask in the final ~200 chars — the exact shape
  // of the live victims (#437, #432, #462...).
  function longJournal(taskId, bodyLines = 90) {
    const body = Array.from(
      { length: bodyLines },
      (_, i) => `- **finding ${i}** about \`thing ${i}\` with a reasonably long trailing clause here`,
    ).join('\n')
    return `# Task ${taskId}: Long turn

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## \u{1F319} Overnight Agent

**Status:** Proposed \u00B7 plan v1 \u00B7 2026-08-27

${body}

${ASK}

${CALL}
`
  }

  async function send(journal, taskId = '55') {
    const h = makeHarness({ [taskId]: journal })
    const bridge = createBridge({
      client: h.client,
      config: h.config,
      state: emptyState(),
      io: h.io,
    })
    await bridge.syncUp()
    return h
  }

  it('delivers the ask even when the turn is far longer than one message', async () => {
    const h = await send(longJournal(55))

    // It must have been split, not squeezed into one truncated message.
    expect(h.sent.length).toBeGreaterThan(1)

    const all = h.sent.map((m) => m.text).join('\n')
    // THE regression: before the fix this assertion fails — the ask was the part
    // thrown away.
    expect(all).toContain('Needs from you')
    expect(all).toContain('merge 198')
    expect(all).toContain('Your call')
  })

  it('keeps every part within the cap, balanced, and in the same topic', async () => {
    const h = await send(longJournal(55))

    for (const m of h.sent) {
      expect(m.text.length).toBeLessThanOrEqual(4096)
      expect(m.parseMode).toBe('HTML')
      expect(m.messageThreadId).toBe(1)
      expect(m.text).not.toMatch(/<[^>]*$/)
    }
    // Parts are numbered so the reader can tell there is more than one.
    expect(h.sent[0].text).toContain('(1/')
  })

  it('keeps the ask even on a turn too long to send in full, and marks it trimmed', async () => {
    // 400 lines blows past MAX_PARTS, so the body must be trimmed — but the ask
    // still has to arrive.
    const h = await send(longJournal(56, 400), '56')

    const all = h.sent.map((m) => m.text).join('\n')
    expect(all).toContain('Needs from you')
    expect(all).toContain('merge 198')
    // The reader is told text was left behind rather than being shown a message
    // that just stops mid-sentence.
    expect(all).toContain('Trimmed for Telegram')
    // And the volume stays bounded.
    expect(h.sent.length).toBeLessThanOrEqual(3)
  })

  it('does not repost a split turn on a second run (dedupe covers the whole turn)', async () => {
    const journal = longJournal(55)
    const h = makeHarness({ 55: journal })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    const firstCount = h.sent.length
    expect(firstCount).toBeGreaterThan(1)

    const second = await bridge.syncUp()
    expect(second.posted).toEqual([])
    expect(h.sent).toHaveLength(firstCount)
    expect(h.created).toHaveLength(1)
  })

  it('a short turn is still a single message (no gratuitous splitting)', async () => {
    const h = await send(AGENT_JOURNAL, '42')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).not.toContain('(1/')
  })
})

describe('turn-end stamp does not re-post an already-delivered turn', () => {
  // Live mechanism: syncUp posts the turn, then `oa-state.ps1 mark` appends the
  // stamp. Under the old parse that changed hashTurn(), so the NEXT syncUp saw
  // a "new" turn and sent a duplicate. Measured at 90/90 of the open-board
  // journals a mark would touch.
  it('stays silent after mark stamps the journal', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    // What `mark` does: append the stamp at EOF.
    h.store['42'] = `${h.store['42'].replace(/\s+$/, '')}\n\n${TURN_END}\n`

    const second = await bridge.syncUp()
    expect(second.posted).toEqual([])
    expect(h.sent).toHaveLength(1)
  })

  it('never renders the raw stamp into the message the user reads', async () => {
    const h = makeHarness({ 42: `${AGENT_JOURNAL.replace(/\s+$/, '')}\n\n${TURN_END}\n` })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).not.toContain('turn-end')
    expect(h.sent[0].text).toContain('do the thing')
  })
})

describe('rebaseline-turn-end migration', () => {
  const STAMPED = `${AGENT_JOURNAL.replace(/\s+$/, '')}\n\n${TURN_END}\n`

  function legacyHashOf(journal) {
    return hashTurn(latestAgentTurn(journal, { includeTurnEnd: true }))
  }

  it('absorbs the parse change so the fix itself sends no duplicates', async () => {
    const h = makeHarness({ 42: STAMPED })
    const state = emptyState()
    // State as it exists in the wild: hashed under the OLD, stamp-swallowing parse.
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: legacyHashOf(STAMPED) }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.rebaselineTurnEnd()
    expect(res.migrated).toEqual(['42'])
    expect(h.sent).toHaveLength(0) // migration never posts

    const up = await bridge.syncUp()
    expect(up.posted).toEqual([])
    expect(h.sent).toHaveLength(0)
  })

  it('is idempotent', async () => {
    const h = makeHarness({ 42: STAMPED })
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: legacyHashOf(STAMPED) }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.rebaselineTurnEnd()
    const again = await bridge.rebaselineTurnEnd()
    expect(again.migrated).toEqual([])
  })

  it('leaves a genuinely new turn pending, so a real post is never absorbed', async () => {
    const h = makeHarness({ 42: STAMPED })
    const state = emptyState()
    // Stored hash matches neither parse: the journal moved on since it was posted.
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: 'something-older' }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.rebaselineTurnEnd()
    expect(res.migrated).toEqual([])
    expect(res.pending).toEqual(['42'])

    const up = await bridge.syncUp()
    expect(up.posted).toEqual(['42'])
  })

  it('ignores tasks with no stamp in their turn', async () => {
    const h = makeHarness({ 42: AGENT_JOURNAL })
    const state = emptyState()
    state.tasks['42'] = { topicId: 7, name: '#42', lastPostedHash: legacyHashOf(AGENT_JOURNAL) }
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.rebaselineTurnEnd()
    expect(res.migrated).toEqual([])
    expect(res.unchanged).toEqual(['42'])
  })

  it('does not touch a task that was never posted', async () => {
    const h = makeHarness({ 42: STAMPED })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.rebaselineTurnEnd()
    expect(res.migrated).toEqual([])
    expect(res.unchanged).toEqual([])
    expect(res.pending).toEqual([])
  })
})
