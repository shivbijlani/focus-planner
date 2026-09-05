import { describe, it, expect } from 'vitest'
import {
  createBridge,
  blockingAsk,
  retractedAsk,
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
  // What each live message currently SAYS. Needed so a genuine edit can succeed: Telegram only
  // answers "not modified" when the new text is byte-identical, and a harness that throws that
  // unconditionally can never exercise a successful in-place update.
  const bodies = new Map()
  let editError = null
  // #483 — what the bridge actually removed, and the ids Telegram refuses to let it remove
  // (older than the 48h window, or already gone).
  const deleted = []
  const undeletable = new Set()
  const uneditable = new Set()
  let deleteError = null
  let dropSendIds = false

  const client = {
    async createForumTopic({ name }) {
      const id = ++topicSeq
      return { message_thread_id: id, name }
    },
    async sendMessage(m) {
      sent.push(m)
      const id = ++messageSeq
      live.add(id)
      bodies.set(id, m.text)
      // Simulates a send whose result the bridge cannot read a message id from, so `liveId`
      // stays null and the replacement is unconfirmed.
      return dropSendIds ? {} : { message_id: id }
    },
    async editMessageText({ messageId, text }) {
      edits.push({ messageId, text })
      if (editError) throw new Error(editError)
      if (uneditable.has(messageId)) throw new Error("Bad Request: message can't be edited")
      if (!live.has(messageId)) throw new Error('Bad Request: message to edit not found')
      // Telegram's answer when the text is byte-identical to what is already there. This is
      // the healthy steady state, and it arrives as an ERROR — which is exactly why the probe
      // must read the message rather than just catching.
      if (bodies.get(messageId) === text) throw new Error('Bad Request: message is not modified')
      bodies.set(messageId, text)
      return { message_id: messageId }
    },
    async pinChatMessage({ messageId }) {
      pinned.push(messageId)
    },
    async deleteMessage({ messageId }) {
      if (deleteError) throw new Error(deleteError)
      if (undeletable.has(messageId)) throw new Error("Bad Request: message can't be deleted")
      deleted.push(messageId)
      live.delete(messageId)
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
    deleted,
    client,
    io,
    config: { chatId: '-100', taskAllowlist: [], collapseBoundTurns: true },
    deleteMessageFromTelegram: (id) => live.delete(id),
    // Pre-existing messages a test did not send through this harness (e.g. turns posted before
    // the topic was bound). Telegram knows them, so an edit must be able to reach them.
    registerLive: (id) => live.add(id),
    refuseDeleteOf: (id) => undeletable.add(id),
    refuseEditOf: (id) => uneditable.add(id),
    failEditWith: (msg) => {
      editError = msg
    },
    failDeleteWith: (msg) => {
      deleteError = msg
    },
    sendWithoutMessageIds: () => {
      dropSendIds = true
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

  it('UPDATES the notice in place when the ask changes, instead of stacking a second one', async () => {
    // Shiv, on the catch-up doc: "Task 468 telegram has recent message postings. I expected it
    // to update or delete the last one." Hashing alone made "say it once" true per ASK and false
    // per TOPIC — three runs with three slightly different asks left three messages, rebuilding
    // the stack through the only path still allowed to post.
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(2) // link + first notice
    const noticeId = state.tasks['42'].docLinkNoticeMessageId
    expect(noticeId).toBe(2)

    h.store['42'] = journal({ needs: 'the API key for the PROD box' })
    await bridge.syncUp()

    // Nothing new was sent...
    expect(h.sent).toHaveLength(2)
    // ...the existing notice now carries the new ask...
    const rewrite = h.edits.filter((e) => e.messageId === noticeId).pop()
    expect(rewrite.text).toContain('the API key for the PROD box')
    // ...and the id is retained, so the run after this one can update it again rather than
    // starting a fresh stack from a forgotten pointer.
    expect(state.tasks['42'].docLinkNoticeMessageId).toBe(noticeId)
  })

  it('posts a fresh notice when the one it meant to update is gone', async () => {
    // The opposite fail direction from the link probe, on purpose: a notice carries information
    // that exists nowhere else in the topic, so an unconfirmed edit must never be taken as
    // delivered. One duplicate line is cheaper than silently losing a blocking ask.
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    const noticeId = state.tasks['42'].docLinkNoticeMessageId
    h.deleteMessageFromTelegram(noticeId)

    h.store['42'] = journal({ needs: 'the API key for the PROD box' })
    await bridge.syncUp()

    expect(h.sent).toHaveLength(3)
    expect(h.sent[2].text).toContain('the API key for the PROD box')
    expect(state.tasks['42'].docLinkNoticeMessageId).toBe(3)
  })

  it('forgets the notice id when the ask is resolved, so a returning ask is a NEW message', async () => {
    // He has already read and acted on the old line. Editing it later would rewrite history
    // under him — which is why the id is cleared with the hash rather than kept for reuse.
    const h = makeHarness({ 42: journal({ status: 'Done', needs: 'none' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(state.tasks['42'].docLinkNoticeMessageId).toBe(2)

    h.store['42'] = journal({ status: 'In-progress', needs: 'none' })
    await bridge.syncUp()
    expect(state.tasks['42'].docLinkNoticeMessageId).toBeUndefined()

    h.store['42'] = journal({ status: 'Done', needs: 'none' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(3)
    expect(state.tasks['42'].docLinkNoticeMessageId).toBe(3)
  })

  // #515 — RETRACTION. A resolved ask is left alone; a retracted one is corrected in place.
  // The two are opposite treatments of the same state transition, and the tests below assert
  // both directions so neither can be widened into the other by accident.

  it('CORRECTS the notice in place when the turn retracts an ask that was never satisfiable', async () => {
    // Measured live on task 468: a notice asked for "one word" to authorise clearing two
    // messages, when `delete_data` sits on the agent-gate floor and the floor overrides even a
    // human approve. No word could have satisfied it. Leaving that standing is what rewrites
    // history — it leaves a demand nobody can meet.
    const h = makeHarness({ 42: journal({ needs: 'one word to clear messages 2810 and 2811' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    const noticeId = state.tasks['42'].docLinkNoticeMessageId
    expect(noticeId).toBe(2)
    expect(state.tasks['42'].docLinkNoticeAsk).toBe('one word to clear messages 2810 and 2811')

    h.store['42'] = journal({
      needs: 'none',
      body: 'work\n\n**Retracts:** no word could clear them; deleting is floor-blocked.',
    })
    await bridge.syncUp()

    // Nothing was ADDED to the topic — a retraction must not grow the stack it is cleaning up.
    expect(h.sent).toHaveLength(2)

    const rewrite = h.edits.filter((e) => e.messageId === noticeId).pop()
    // The ORIGINAL ASK IS STILL LEGIBLE. This is the property that makes editing safe at all:
    // he can still see exactly what he was asked, so nothing is rewritten under him.
    expect(rewrite.text).toContain('one word to clear messages 2810 and 2811')
    // ...and it is now visibly withdrawn, with the reason.
    expect(rewrite.text).toContain('<s>')
    expect(rewrite.text).toContain('Withdrawn')
    expect(rewrite.text).toContain('deleting is floor-blocked')

    // The id is STILL forgotten afterwards, exactly as on the resolve path — a retraction is a
    // one-shot correction, not a licence to keep editing the message forever.
    expect(state.tasks['42'].docLinkNoticeMessageId).toBeUndefined()
    expect(state.tasks['42'].docLinkNoticeAsk).toBeUndefined()
  })

  it('leaves a merely RESOLVED ask untouched — retraction must not widen into resolution', async () => {
    // The regression guard for the deliberate behaviour this fix must not trade away. A turn
    // that simply stops asking has NOT established that the ask was unsatisfiable, so the
    // message stays exactly as he last read it.
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    const noticeId = state.tasks['42'].docLinkNoticeMessageId
    const editsBefore = h.edits.filter((e) => e.messageId === noticeId).length

    h.store['42'] = journal({ needs: 'none' })
    await bridge.syncUp()

    expect(h.edits.filter((e) => e.messageId === noticeId)).toHaveLength(editsBefore)
    expect(state.tasks['42'].docLinkNoticeMessageId).toBeUndefined()
  })

  it('does not post a NEW message when a retraction has no notice left to reach', async () => {
    // Task 468's message 2862 is exactly this case: the resolve path already forgot the id
    // before this fix existed. The retraction cannot reach it, and must not compensate by
    // posting a fresh message — that would add a line to say something no longer matters.
    const h = makeHarness({ 42: journal({ needs: 'one word to clear 2810 and 2811' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(2)
    // Simulate pre-fix state: the hash survives, the id was dropped.
    state.tasks['42'].docLinkNoticeMessageId = undefined

    h.store['42'] = journal({
      needs: 'none',
      body: 'work\n\n**Retracts:** it could never have been satisfied.',
    })
    await bridge.syncUp()

    expect(h.sent).toHaveLength(2)
    expect(state.tasks['42'].docLinkNoticeHash).toBeUndefined()
  })

  it('announces a retracted-then-returning ask as a NEW message', async () => {
    const h = makeHarness({ 42: journal({ needs: 'the staging key' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(2)

    h.store['42'] = journal({ needs: 'none', body: 'work\n\n**Retracts:** wrong ask.' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(2)

    h.store['42'] = journal({ needs: 'the staging key' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(3)
  })

  it('never INFERS a retraction: a dismissive or absent Retracts line is not one', () => {
    expect(retractedAsk('**Retracts:** the ask was impossible')).toBe('the ask was impossible')
    expect(retractedAsk('Retracts: none')).toBe('')
    expect(retractedAsk('**Needs from you:** the key')).toBe('')
    expect(retractedAsk('')).toBe('')
    expect(retractedAsk(null)).toBe('')
  })

  it('reads a reason that BEGINS with "no" — a retraction is prose, not an ask', () => {
    // Regression guard for a bug that shipped a silently dead feature with every other test
    // green. The ask filter is prefix-anchored (`/^(none|nothing|no|...)\b/`) because
    // "Needs from you: nothing needed" must not block. Applied to a retraction it swallowed
    // the most natural sentence there is — the live one from task 468 begins "no word could
    // clear them". A reason is free prose; only a BARE dismissive token means "no retraction".
    expect(retractedAsk('**Retracts:** no word could clear them; deleting is floor-blocked.')).toBe(
      'no word could clear them; deleting is floor-blocked.',
    )
    expect(retractedAsk('**Retracts:** nothing he says could have satisfied it')).toBe(
      'nothing he says could have satisfied it',
    )
    // ...while the bare tokens still read as absent.
    expect(retractedAsk('Retracts: nothing')).toBe('')
    expect(retractedAsk('Retracts: n/a')).toBe('')
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

// #483 — the turns a task posted BEFORE it was bound to a doc.
//
// Link mode returns before the turn path runs, and the collapse that removes a superseded
// message lives on that turn path -- it only ever fires as a side effect of posting the next
// turn. A doc-bound task never posts another turn, so those messages are unreachable: the one
// thing that would tidy them is the very post the feature exists to prevent. That is why Shiv's
// topic still showed a stack after every part of #424 shipped and was working.
//
// The load-bearing property here is NOT the deletion. It is that the deletion does not happen
// on the bridge's own authority: these are messages in the user's thread, Telegram has no undo,
// and link mode cannot prove the removal is lossless (the replacement is a document this
// process never reads). So OFF reports, ON acts, and a replied-to message is never touched by
// either.
describe('#483 — pre-binding turns above the doc link', () => {
  function bound(state, { ids = [1001, 1002], replyCount = 0, postedAt = 0, links = [], h } = {}) {
    state.tasks['42'] = {
      topicId: 7,
      lastPostedMessageIds: ids,
      lastPostedReplyCount: postedAt,
      replyCount,
      ...(links.length ? { lastPostedLinks: links } : {}),
    }
    // These were posted before the topic was bound, so Telegram knows them even though this
    // harness never sent them. Without this an edit reports "message to edit not found".
    if (h) for (const id of ids) h.registerLive(id)
    return state
  }

  it('COLLAPSES them by default, and still deletes NOTHING', async () => {
    // The default changed with this feature, and the reason is the whole point of it. Before,
    // the only action available was deletion, which sits on the agent-gate floor ("Outcome can
    // result in permanent data loss") and outranks even Shiv's explicit approval — so the
    // action branch could never legitimately fire and the messages stayed put. Editing is not
    // deletion: the turn's text is still in the journal this message was copied from.
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h })
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncUp()

    // Nothing was removed...
    expect(h.deleted).toEqual([])
    // ...and nothing new was posted: the thread does not grow to clean itself up.
    expect(h.sent.filter((m) => m.text.includes('an earlier update'))).toHaveLength(0)
    // ...both messages now point at the doc, in place.
    expect(h.edits.filter((e) => e.messageId === 1001).pop().text).toContain('Catch-up doc')
    expect(h.edits.filter((e) => e.messageId === 1002).pop().text).toContain('an earlier update')
    expect(res.collapsed).toEqual([{ taskId: '42', messageIds: [1001, 1002] }])
    // Forgotten only once collapsed, so a later run does not edit them again.
    expect(state.tasks['42'].lastPostedMessageIds).toBeUndefined()
  })

  it('reports and does nothing at all when collapsing is switched off', async () => {
    // The old default, kept reachable: TELEGRAM_BRIDGE_COLLAPSE_BOUND=off.
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState())
    const bridge = createBridge({
      client: h.client,
      config: { ...h.config, collapseBoundTurns: false },
      state,
      io: h.io,
    })

    const res = await bridge.syncUp()

    expect(h.deleted).toEqual([])
    expect(h.edits.filter((e) => e.messageId === 1001)).toEqual([])
    expect(res.tidyPending).toEqual([{ taskId: '42', messageIds: [1001, 1002] }])
    // Still remembered, because nothing else records them: forgetting here would strand them.
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1001, 1002])
  })

  it('carries the links the collapsed message held, since a pointer would drop them', async () => {
    // The turn's prose survives in the journal and the doc, but a URL that only ever appeared
    // in this Telegram message would be gone from his phone entirely.
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h, links: ['https://example.com/build/9'] })
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    expect(h.edits.filter((e) => e.messageId === 1001).pop().text).toContain(
      'https://example.com/build/9',
    )
  })

  it('NEVER collapses a message the user has replied to', async () => {
    // The same freeze as deletion, for the same reason: a message he answered is a
    // conversation, not a superseded draft.
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h, replyCount: 1, postedAt: 0 })
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    expect(h.edits.filter((e) => e.messageId === 1001)).toEqual([])
    expect(h.deleted).toEqual([])
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1001, 1002])
  })

  it('keeps the survivors when only some collapses succeed', async () => {
    // A message past Telegram's edit window must not be forgotten just because its neighbour
    // was collapsed — nothing else records it, so forgetting it strands it permanently.
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h })
    h.refuseEditOf(1001)
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1001])
  })

  it('removes them once told it may, and forgets them', async () => {
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState())
    const bridge = createBridge({
      client: h.client,
      config: { ...h.config, tidyBoundTopics: true },
      state,
      io: h.io,
    })

    const res = await bridge.syncUp()

    expect(h.deleted).toEqual([1001, 1002])
    expect(res.tidied).toEqual([{ taskId: '42', messageIds: [1001, 1002] }])
    expect(res.tidyPending).toEqual([])
    expect(state.tasks['42'].lastPostedMessageIds).toBeUndefined()
  })

  it('NEVER removes a message the user has replied to, even when enabled', async () => {
    const h = makeHarness({ 42: journal() })
    // A reply landed after those ids went out: 0 at post time, 1 now.
    const state = bound(emptyState(), { h, replyCount: 1, postedAt: 0 })
    const bridge = createBridge({
      client: h.client,
      config: { ...h.config, tidyBoundTopics: true },
      state,
      io: h.io,
    })

    await bridge.syncUp()

    expect(h.deleted).toEqual([])
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1001, 1002])
  })

  it('never deletes the doc link or the notice, even if state lists them as turns', async () => {
    const h = makeHarness({ 42: journal({ needs: 'the API key for the PROD box' }) })
    const state = bound(emptyState())
    const bridge = createBridge({
      client: h.client,
      config: { ...h.config, tidyBoundTopics: true },
      state,
      io: h.io,
    })

    // First run posts the link (id 1) and the notice (id 2), and tidies the stranded pair.
    await bridge.syncUp()
    const linkId = state.tasks['42'].docLinkMessageId
    const noticeId = state.tasks['42'].docLinkNoticeMessageId
    expect(h.deleted).toEqual([1001, 1002])

    // Now corrupt state so the live link and notice look like superseded turns. Nothing should
    // delete the message the user is meant to read, or the ask that exists nowhere else.
    state.tasks['42'].lastPostedMessageIds = [linkId, noticeId]
    h.deleted.length = 0
    await bridge.syncUp()

    expect(h.deleted).toEqual([])
    expect(state.tasks['42'].docLinkMessageId).toBe(linkId)
  })

  it('keeps the survivors when only some deletes succeed', async () => {
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { ids: [1001, 1002, 1003] })
    h.refuseDeleteOf(1002)
    const bridge = createBridge({
      client: h.client,
      config: { ...h.config, tidyBoundTopics: true },
      state,
      io: h.io,
    })

    const res = await bridge.syncUp()

    expect(h.deleted).toEqual([1001, 1003])
    expect(res.tidied).toEqual([{ taskId: '42', messageIds: [1001, 1003] }])
    // 1002 is still up there, so it must still be recorded -- a blanket clear would lose the
    // only record that it exists and no later run could retry it.
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1002])
  })

  it('deletes nothing while the replacement link is unconfirmed', async () => {
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState())
    h.sendWithoutMessageIds()
    const bridge = createBridge({
      client: h.client,
      config: { ...h.config, tidyBoundTopics: true },
      state,
      io: h.io,
    })

    await bridge.syncUp()

    // Same ordering rule as the turn path: a failed delete is cosmetic, but deleting before the
    // replacement is confirmed can leave the topic holding neither.
    expect(h.deleted).toEqual([])
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1001, 1002])
  })
})
