import { describe, it, expect } from 'vitest'
import {
  createBridge,
  blockingAsk,
  terminalStatus,
  formatDocLink,
} from './bridge.js'
import { emptyState } from './state.js'

// #424 — once a task has a catch-up doc, its topic holds ONE message: the link.
//
// The acceptance criteria from the issue, each with its own test below:
//   * a task worked on three consecutive runs has ONE link message, not three
//   * deleting the link message and re-running restores exactly one
//   * a blocking ask still reaches Telegram as a short line
//
// The fourth property is not in the issue's list but is the one that decides whether the
// feature works at all: a NON-blocking ask must post nothing. The agent ends nearly every turn
// with a courtesy offer, so a reader that treats those as blocking rebuilds per-turn posting
// under a different name. That is the same over-broad reading that starved the board in the
// `awaiting_reply` gate, and it is asserted here in both directions.

const DOC_ID = 'DOC_ABC123'
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`

function journal({ id = 42, needs = 'none', status = 'In-progress', doc = true, body = 'work' } = {}) {
  return [
    `# Task ${id}: Demo`,
    doc ? `<!-- doc-meta docId=${DOC_ID} docUrl=${DOC_URL} -->` : '',
    '',
    '---',
    '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
    '',
    '## \u{1F319} Overnight Agent',
    '',
    '<!-- from: overnight-agent -->',
    '',
    `**Status:** ${status} \u00B7 2026-09-03`,
    '',
    body,
    '',
    `**Needs from you:** ${needs}`,
    '',
  ].join('\n')
}

function makeHarness(files) {
  const store = { ...files }
  const sent = []
  const edits = []
  const pinned = []
  let topicSeq = 0
  let messageSeq = 0
  // The set of message ids Telegram still knows about. Deleting from here is how a test
  // simulates the user removing the link message.
  const live = new Set()
  let editError = null

  const client = {
    async createForumTopic({ name }) {
      const id = ++topicSeq
      return { message_thread_id: id, name }
    },
    async sendMessage(m) {
      sent.push(m)
      const id = ++messageSeq
      live.add(id)
      return { message_id: id }
    },
    async editMessageText({ messageId, text }) {
      edits.push({ messageId, text })
      if (editError) throw new Error(editError)
      if (!live.has(messageId)) throw new Error('Bad Request: message to edit not found')
      // Telegram's answer when the text is byte-identical to what is already there. This is
      // the healthy steady state, and it arrives as an ERROR — which is exactly why the probe
      // must read the message rather than just catching.
      throw new Error('Bad Request: message is not modified')
    },
    async pinChatMessage({ messageId }) {
      pinned.push(messageId)
    },
    async deleteMessage() {
      return true
    },
    async closeForumTopic() {},
    async reopenForumTopic() {},
    async getUpdates() {
      return []
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
      return ''
    },
    async readBoard() {
      return ''
    },
    async readSyncRecords() {
      return []
    },
  }

  return {
    store,
    sent,
    edits,
    pinned,
    client,
    io,
    config: { chatId: '-100', taskAllowlist: [] },
    deleteMessageFromTelegram: (id) => live.delete(id),
    failEditWith: (msg) => {
      editError = msg
    },
  }
}

describe('#424 — the catch-up link replaces the per-turn post', () => {
  it('posts the link once and then stays quiet across three runs', async () => {
    const h = makeHarness({ 42: journal() })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain(DOC_URL)

    // Two further runs, each with a NEW turn — the case that used to post a fresh, oversized
    // message every wake. The doc changed; the link did not.
    h.store['42'] = journal({ body: 'more work' })
    await bridge.syncUp()
    h.store['42'] = journal({ body: 'even more work' })
    await bridge.syncUp()

    expect(h.sent).toHaveLength(1)
    expect(state.tasks['42'].docLinkMessageId).toBe(1)
    expect(state.tasks['42'].docLinkDocId).toBe(DOC_ID)
  })

  it('restores exactly one link message when the user deletes it', async () => {
    const h = makeHarness({ 42: journal() })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    // The user deletes the link. Nothing about the journal changes — which is the point: a
    // check gated on a new turn would never notice, and the task would go silent forever.
    h.deleteMessageFromTelegram(1)
    await bridge.syncUp()

    expect(h.sent).toHaveLength(2)
    expect(state.tasks['42'].docLinkMessageId).toBe(2)

    // ...and exactly one. A restore that re-armed the repost path would post again next run.
    await bridge.syncUp()
    expect(h.sent).toHaveLength(2)
  })

  it('does NOT repost when the existence probe is inconclusive', async () => {
    // A network blip or a permissions error is not evidence of deletion. Guessing "gone" would
    // post a duplicate link every time the API had a bad minute — turning a transient fault
    // into permanent visible clutter, which is worse than the silence it is guarding against.
    const h = makeHarness({ 42: journal() })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    h.failEditWith('Bad Gateway')
    h.store['42'] = journal({ body: 'changed' })
    await bridge.syncUp()

    expect(h.sent).toHaveLength(1)
    expect(state.tasks['42'].docLinkMessageId).toBe(1)
  })

  it('sends a short line for a blocking ask, once', async () => {
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    // The link, plus one short notice.
    expect(h.sent).toHaveLength(2)
    const notice = h.sent[1].text
    expect(notice).toContain('the API key for the staging box')
    expect(notice.length).toBeLessThan(400)

    // The same unresolved ask on the next run must not be repeated: an exception that fires
    // nightly is the behaviour this issue removes.
    h.store['42'] = journal({ needs: 'the API key for the staging box', body: 'still waiting' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(2)
  })

  it('says NOTHING for a dismissive ask, however it is phrased', async () => {
    // This is the property that decides whether the feature works. Every one of these is the
    // agent stating it is NOT blocked.
    for (const needs of ['none', 'nothing blocking', 'nothing — say the word and I will pick it up', 'no']) {
      const h = makeHarness({ 42: journal({ needs }) })
      const state = emptyState()
      const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })
      await bridge.syncUp()
      expect(h.sent, `"${needs}" must not post a notice`).toHaveLength(1)
    }
  })

  it('announces a terminal state, and re-announces a returning ask', async () => {
    const h = makeHarness({ 42: journal({ status: 'Done', needs: 'none' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].text).toContain('Done')

    // The ask is resolved, so the remembered notice is cleared...
    h.store['42'] = journal({ status: 'In-progress', needs: 'none' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(2)

    // ...and the SAME ask returning later is announced again rather than swallowed as
    // "already said". A hash that was never cleared would lose the second occurrence.
    h.store['42'] = journal({ status: 'Done', needs: 'none' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(3)
  })

  it('replaces the link when the task is rebound to a different doc', async () => {
    const h = makeHarness({ 42: journal() })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    // A stale message pointing at a document that is no longer this task's is a second, WRONG
    // pointer. It must be replaced rather than edited in place.
    h.store['42'] = h.store['42'].replace(DOC_ID, 'DOC_NEW999').replace(DOC_ID, 'DOC_NEW999')
    await bridge.syncUp()

    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].text).toContain('DOC_NEW999')
    expect(state.tasks['42'].docLinkDocId).toBe('DOC_NEW999')
  })

  it('leaves tasks without a doc on the existing per-turn path', async () => {
    // The feature is opt-in per task, by the presence of #423's binding. A task with no doc
    // must behave exactly as before, or this becomes a silent global change.
    const h = makeHarness({ 42: journal({ doc: false }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).not.toContain('Catch-up doc')
    expect(state.tasks['42'].docLinkMessageId).toBeUndefined()
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1])
  })
})

describe('#424 — the readers', () => {
  it('blockingAsk reads the last Needs from you, and only when it blocks', () => {
    expect(blockingAsk('**Needs from you:** a decision on X')).toBe('a decision on X')
    expect(blockingAsk('**Needs from you:** none')).toBe('')
    expect(blockingAsk('**Needs from you:** nothing blocking. Two things you may want to weigh in on')).toBe('')
    expect(blockingAsk('no ask here')).toBe('')
    // Last one wins: a turn quoting an earlier ask must not resurrect it.
    expect(blockingAsk('**Needs from you:** old\n\n**Needs from you:** none')).toBe('')
  })

  it('terminalStatus recognises the states worth one line', () => {
    expect(terminalStatus('**Status:** Done \u00B7 2026-09-03')).toBe('done')
    expect(terminalStatus('**Status:** Blocked \u00B7 waiting')).toBe('blocked')
    expect(terminalStatus('**Status:** Cancelled')).toBe('abandoned')
    expect(terminalStatus('**Status:** In-progress \u00B7 plan v2')).toBe('')
    expect(terminalStatus('no status')).toBe('')
  })

  it('formatDocLink is deterministic, which is what makes the probe work', () => {
    // The probe re-sends this text and reads Telegram's "not modified" as proof of life. Any
    // varying token (a timestamp, a counter) would make every probe a real edit and destroy
    // the signal it depends on.
    const a = formatDocLink(42, 'Demo', DOC_URL)
    const b = formatDocLink(42, 'Demo', DOC_URL)
    expect(a).toBe(b)
    expect(a).toContain(DOC_URL)
    expect(a.length).toBeLessThan(600)
  })

  it('the real client exposes the two calls this feature needs', async () => {
    // Guarding a call with `typeof client.x === 'function'` is safe, but on its own it lets the
    // feature ship permanently inert: the guard passes, nothing happens, and no test notices.
    // That is how a "best-effort" pin becomes a no-effort pin. Assert the real client has them.
    const { createTelegramClient } = await import('./telegramClient.js')
    const client = createTelegramClient({ token: 'x:y' })
    expect(typeof client.editMessageText).toBe('function')
    expect(typeof client.pinChatMessage).toBe('function')
  })
})
