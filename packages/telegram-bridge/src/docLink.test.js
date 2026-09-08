import { describe, it, expect } from 'vitest'
import {
  createBridge,
  blockingAsk,
  retractedAsk,
  terminalStatus,
  formatDocLink,
} from './bridge.js'
import { emptyState, bumpReplyCount } from './state.js'

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

function journal({
  id = 42,
  needs = 'none',
  status = 'In-progress',
  doc = true,
  body = 'work',
  // #588 — has a wake actually WRITTEN the bound doc? A real doc-bound turn always names the
  // doc, because `write-turn.ps1`'s G10 refuses one that does not, so "written" is the honest
  // default for every fixture describing a task that has been worked. `written: false` is the
  // freshly-bound placeholder: the marker exists, but nothing has referenced the doc yet.
  written = true,
} = {}) {
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
    doc && written ? `Catch-up doc: ${DOC_URL}` : '',
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
  let rateLimitEdits = 0
  let rateLimitRetryAfter = 30
  let rateLimitTarget = null
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
      // #586 — a 429 exactly as telegramClient.js surfaces it, consumed one call at a time so a
      // test can say "rate limited twice, then fine" and watch the retry actually happen.
      if (rateLimitEdits > 0 && (rateLimitTarget === null || rateLimitTarget === messageId)) {
        rateLimitEdits -= 1
        const err = new Error(
          `Telegram editMessageText failed: Too Many Requests: retry after ${rateLimitRetryAfter}`,
        )
        err.isRateLimit = true
        err.errorCode = 429
        err.retryAfter = rateLimitRetryAfter
        throw err
      }
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
    // #586 — the next `n` edits answer 429. `n = Infinity` is a sustained rate limit, which is
    // how a test reaches the exhausted-budget path. `target` narrows it to one message id,
    // which matters whenever a run edits more than one message: without it the probe swallows
    // the 429 meant for the notice, and the test quietly asserts about the wrong call.
    rateLimitNextEdits: (n, retryAfter = 30, target = null) => {
      rateLimitEdits = n
      rateLimitRetryAfter = retryAfter
      rateLimitTarget = target
    },
    failDeleteWith: (msg) => {
      deleteError = msg
    },
    sendWithoutMessageIds: () => {
      dropSendIds = true
    },
  }
}

// #620 — the ask now rides in the pointer, so most assertions are about the pointer's CURRENT
// text rather than about a second message. The probe re-sends the pointer every run, so the
// last edit aimed at it is its live text; before any edit, that is what was originally sent.
function latestPointer(h, state) {
  const id = state.tasks['42'].docLinkMessageId
  const lastEdit = h.edits.filter((e) => e.messageId === id).pop()
  return lastEdit ? lastEdit.text : h.sent[0].text
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

  it('carries a blocking ask in the POINTER, adding no second message', async () => {
    // #620. The ask used to arrive as its own permanent message. That exception was justified
    // as rare; a census of the live board found it standing in 59 of 76 bound topics — 78%. An
    // exception that holds in 78% of cases is the rule, and the rule was "one message per task".
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    // ONE message. This is the whole point of the issue.
    expect(h.sent).toHaveLength(1)
    const pointer = h.sent[0].text
    expect(pointer).toContain('the API key for the staging box')
    expect(pointer).toContain('Catch-up doc')

    // The same unresolved ask on the next run must not be repeated: an exception that fires
    // nightly is the behaviour this issue removes.
    h.store['42'] = journal({ needs: 'the API key for the staging box', body: 'still waiting' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
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

  it('announces a terminal state, and re-announces a returning ask — all in the one message', async () => {
    const h = makeHarness({ 42: journal({ status: 'Done', needs: 'none' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('Done')

    // The terminal state passes...
    h.store['42'] = journal({ status: 'In-progress', needs: 'none' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    expect(latestPointer(h, state)).not.toContain('Done')

    // ...and the SAME state returning later is shown again rather than swallowed as "already
    // said". A hash that was never cleared would lose the second occurrence.
    h.store['42'] = journal({ status: 'Done', needs: 'none' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    expect(latestPointer(h, state)).toContain('Done')
  })

  it('UPDATES the pointer in place when the ask changes, instead of stacking a second one', async () => {
    // Shiv, on the catch-up doc: "Task 468 telegram has recent message postings. I expected it
    // to update or delete the last one." Hashing alone made "say it once" true per ASK and false
    // per TOPIC — three runs with three slightly different asks left three messages, rebuilding
    // the stack through the only path still allowed to post.
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    const linkId = state.tasks['42'].docLinkMessageId

    h.store['42'] = journal({ needs: 'the API key for the PROD box' })
    await bridge.syncUp()

    // Nothing new was sent...
    expect(h.sent).toHaveLength(1)
    // ...and the one message now carries the new ask.
    const rewrite = h.edits.filter((e) => e.messageId === linkId).pop()
    expect(rewrite.text).toContain('the API key for the PROD box')
    expect(rewrite.text).not.toContain('staging box')
    // The id is retained, so the run after this can update it again rather than starting a
    // fresh stack from a forgotten pointer.
    expect(state.tasks['42'].docLinkMessageId).toBe(linkId)
  })

  it('restores the ask with the pointer when the carrier is gone', async () => {
    // The ask carries information that exists nowhere else in the topic, so losing the pointer
    // must not silently lose the ask with it. The link probe already restores a deleted
    // pointer; #620 makes that path responsible for the ask too.
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    h.deleteMessageFromTelegram(state.tasks['42'].docLinkMessageId)

    h.store['42'] = journal({ needs: 'the API key for the PROD box' })
    await bridge.syncUp()

    // Exactly one replacement, carrying the live ask — not a bare link with the ask dropped.
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].text).toContain('the API key for the PROD box')
    expect(h.sent[1].text).toContain('Catch-up doc')
  })

  it('leaves a STRUCK-THROUGH trace when the ask resolves, rather than erasing it', async () => {
    // #620's one deliberate behaviour change, and the objection that had to be answered before
    // the ask could move into a permanent message. The old separate notice was never rewritten
    // on resolve — "he may have read it and acted on it, and rewriting it afterwards would
    // change history under him". Once the ask lives in an always-current pointer, resolving it
    // MUST rewrite that pointer, and the naive version makes an unread ask vanish silently
    // between two glances — the mirror of #515.
    //
    // The answer is to keep the words and strike them: visibly resolved, never silently absent.
    // History is annotated, not rewritten, which is the argument the retraction path already
    // makes.
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    h.store['42'] = journal({ needs: 'none' })
    await bridge.syncUp()

    expect(h.sent).toHaveLength(1)
    const after = latestPointer(h, state)
    // The words he was asked are STILL THERE...
    expect(after).toContain('the API key for the staging box')
    // ...visibly struck and marked resolved.
    expect(after).toContain('<s>')
    expect(after).toContain('resolved')
    expect(after).not.toContain('Waiting on you')
  })

  // #515 — RETRACTION. A resolved ask is left alone; a retracted one is corrected in place.
  // The two are opposite treatments of the same state transition, and the tests below assert
  // both directions so neither can be widened into the other by accident.

  it('CORRECTS the pointer in place when the turn retracts an ask that was never satisfiable', async () => {
    // Measured live on task 468: a notice asked for "one word" to authorise clearing two
    // messages, when `delete_data` sits on the agent-gate floor and the floor overrides even a
    // human approve. No word could have satisfied it. Leaving that standing is what rewrites
    // history — it leaves a demand nobody can meet.
    const h = makeHarness({ 42: journal({ needs: 'one word to clear messages 2810 and 2811' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    expect(state.tasks['42'].docLinkAsk).toBe('one word to clear messages 2810 and 2811')

    h.store['42'] = journal({
      needs: 'none',
      body: 'work\n\n**Retracts:** no word could clear them; deleting is floor-blocked.',
    })
    await bridge.syncUp()

    // Nothing was ADDED to the topic — a retraction must not grow the stack it is cleaning up.
    expect(h.sent).toHaveLength(1)

    const rewrite = latestPointer(h, state)
    // The ORIGINAL ASK IS STILL LEGIBLE. This is the property that makes editing safe at all:
    // he can still see exactly what he was asked, so nothing is rewritten under him.
    expect(rewrite).toContain('one word to clear messages 2810 and 2811')
    // ...and it is now visibly withdrawn, with the reason.
    expect(rewrite).toContain('<s>')
    expect(rewrite).toContain('Withdrawn')
    expect(rewrite).toContain('deleting is floor-blocked')

    // The ask itself is forgotten afterwards, exactly as on the resolve path — a retraction is
    // a one-shot correction, not a licence to keep rewriting the reason forever.
    expect(state.tasks['42'].docLinkAsk).toBeUndefined()
  })

  it('leaves a merely RESOLVED ask struck, not withdrawn — retraction must not widen into resolution', async () => {
    // The regression guard for the distinction this fix must not trade away. A turn that simply
    // stops asking has NOT established that the ask was unsatisfiable, so it reads as resolved.
    // Only an explicit retraction may say the ask could never have been met.
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    h.store['42'] = journal({ needs: 'none' })
    await bridge.syncUp()

    const after = latestPointer(h, state)
    expect(after).toContain('resolved')
    expect(after).not.toContain('Withdrawn')
    expect(state.tasks['42'].docLinkAsk).toBeUndefined()
  })

  it('does not post a NEW message when a retraction arrives', async () => {
    // Task 468's message 2862 is exactly this case: the resolve path already forgot the id
    // before this fix existed. The retraction cannot reach it, and must not compensate by
    // posting a fresh message — that would add a line to say something no longer matters.
    const h = makeHarness({ 42: journal({ needs: 'one word to clear 2810 and 2811' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    h.store['42'] = journal({
      needs: 'none',
      body: 'work\n\n**Retracts:** it could never have been satisfied.',
    })
    await bridge.syncUp()

    expect(h.sent).toHaveLength(1)
  })

  it('shows a retracted-then-returning ask in the same message', async () => {
    const h = makeHarness({ 42: journal({ needs: 'the staging key' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    h.store['42'] = journal({ needs: 'none', body: 'work\n\n**Retracts:** wrong ask.' })
    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    h.store['42'] = journal({ needs: 'the staging key' })
    await bridge.syncUp()
    // Still one message, and it is asking again rather than showing the stale withdrawal.
    expect(h.sent).toHaveLength(1)
    const after = latestPointer(h, state)
    expect(after).toContain('Waiting on you')
    expect(after).toContain('the staging key')
    expect(after).not.toContain('Withdrawn')
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

// #586 — THE PROBE THAT STOPPED PROBING.
//
// #424's guarantee is that the link's existence is VERIFIED, never assumed. The probe was an
// `editMessageText` outside the #172 rate-limit retry, so a 429 fell into the generic catch and
// returned "present" without waiting. Harmless while few tasks were bound; once 61 were, the
// probes spent the whole ~20/min group budget rate-limiting themselves, every probe past the
// limit assumed present, and genuine calls later in the run were refused a budget the probes
// had already drained. Nothing in the output changed, because a probe that ran and found the
// message and a probe that gave up were the same bare `true`.
//
// These tests are written to fail on that code. "Did not repost" is NOT the assertion — the
// buggy version passes that perfectly. What separates the two is whether the wait was honoured
// and whether the run can still tell the difference afterwards.
// #620 — RETIRING THE MESSAGES THE OLD DESIGN LEFT BEHIND.
//
// The fix above stops NEW topics reaching two messages. It does nothing for the 59 that are
// already there, and those are the ones Shiv is actually looking at. Retirement is the second
// half, and it is the half that can do damage: it deletes.
describe('#620 — retiring the legacy notice message', () => {
  // A topic as the old design left it: a pointer, plus a separate notice message the bridge
  // still remembers.
  async function withLegacyNotice(overrides = {}) {
    const h = makeHarness({ 42: journal(overrides) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })
    await bridge.syncUp()
    const legacyId = 99
    h.registerLive(legacyId)
    state.tasks['42'].docLinkNoticeMessageId = legacyId
    return { h, state, bridge, legacyId }
  }

  it('does NOT delete on first sight — it records the reply count and decides next run', async () => {
    // The dangerous case is a notice he has already answered. Old state never recorded the
    // reply count at post time, so on first sight "has he replied to this?" is not merely
    // unknown, it is unreconstructable — and the wrong guess deletes his conversation. So the
    // first sight measures and the second decides. Two cheap runs beat one irreversible guess.
    const { h, state, bridge, legacyId } = await withLegacyNotice()

    await bridge.syncUp()
    expect(h.deleted).not.toContain(legacyId)
    expect(state.tasks['42'].docLinkNoticeReplyCount).toBe(0)
    expect(state.tasks['42'].docLinkNoticeMessageId).toBe(legacyId)

    // Second run, nothing landed in between: now it may go.
    await bridge.syncUp()
    expect(h.deleted).toContain(legacyId)
  })

  it('NEVER removes a notice a reply landed against between the two sightings', async () => {
    // The freeze that #483 established, kept for the same reason: a message he answered is his
    // side of a conversation, not a superseded draft, however redundant its text has become.
    const { h, state, bridge, legacyId } = await withLegacyNotice()

    await bridge.syncUp()
    expect(state.tasks['42'].docLinkNoticeReplyCount).toBe(0)

    bumpReplyCount(state, '42')
    await bridge.syncUp()

    expect(h.deleted).not.toContain(legacyId)
    // And the id is KEPT, not forgotten. Forgetting it would make the next run believe there
    // was never a notice, leaving the topic at two messages forever with nothing recording why.
    expect(state.tasks['42'].docLinkNoticeMessageId).toBe(legacyId)
  })

  it('collapses the notice in place when Telegram refuses the delete', async () => {
    // A bot may only delete its own messages for 48h unless it is an admin, so refusal is the
    // expected case on exactly the old topics this is meant to clean up — not an edge case.
    // An edit needs no such permission and removes nothing, so the topic still converges on one
    // message that means anything.
    const { h, state, bridge, legacyId } = await withLegacyNotice()
    h.refuseDeleteOf(legacyId)

    await bridge.syncUp()
    await bridge.syncUp()

    expect(h.deleted).not.toContain(legacyId)
    const collapsed = h.edits.filter((e) => e.messageId === legacyId).pop()
    expect(collapsed).toBeTruthy()
    expect(collapsed.text).toContain(DOC_URL)
    expect(state.tasks['42'].docLinkNoticeHash).toBeUndefined()
  })

  it('converges a legacy two-message topic on ONE message, which is the whole point', async () => {
    // The acceptance criterion stated as Shiv states it, rather than as a mechanism: after the
    // bridge has run twice over an old topic, one message is left standing and it is the
    // pointer — carrying the ask that used to need its own message.
    const { h, state, bridge, legacyId } = await withLegacyNotice({
      needs: 'the API key for the staging box',
    })

    await bridge.syncUp()
    await bridge.syncUp()

    // Nothing new was ever sent to reach this state.
    expect(h.sent).toHaveLength(1)
    expect(h.deleted).toContain(legacyId)
    const pointer = latestPointer(h, state)
    expect(pointer).toContain('the API key for the staging box')
    expect(pointer).toContain(DOC_URL)
  })
})

describe('#586 — rate limits are a pause, not an answer', () => {
  // Never actually wait, but record what was asked for: "honours retry_after" is the criterion.
  const withFakeSleep = async (fn) => {
    const waits = []
    globalThis.__telegramBridgeSleep = (ms) => {
      waits.push(ms)
      return Promise.resolve()
    }
    try {
      return await fn(waits)
    } finally {
      delete globalThis.__telegramBridgeSleep
    }
  }

  it('WAITS and re-probes instead of assuming present, and records that it actually looked', async () => {
    const h = makeHarness({ 42: journal() })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)

    await withFakeSleep(async (waits) => {
      h.edits.length = 0
      h.rateLimitNextEdits(2, 30)
      await bridge.syncUp()

      // Telegram said "wait 30", so the bridge waited 30 — twice — rather than firing again
      // immediately. The evidence on the real run showed retry_after DECREASING (34s then 28s)
      // across the pass, which is only possible if nobody was waiting at all.
      expect(waits).toEqual([30000, 30000])
      // Three attempts: two refused, one answered. The old code attempted exactly once.
      expect(h.edits).toHaveLength(3)
    })

    // ...and it did not repost. This assertion ALSO passes on the broken code, which is
    // precisely why it cannot be the only one.
    expect(h.sent).toHaveLength(1)
    // The distinguishing fact: the link was OBSERVED. The old code had no way to say this,
    // because an observation and a guess left identical traces.
    expect(state.tasks['42'].docLinkVerifiedAt).toBeGreaterThan(0)
  })

  it('degrades to assume-present only when the retry budget is spent — and REPORTS it', async () => {
    // The fail direction is still correct: a rate limit is not evidence of deletion, and
    // guessing "gone" would post a duplicate link every bad minute. What changes is that the
    // guess stops being invisible. An unverified link and a healthy one used to be the same
    // output, so #424's promise could lapse entirely without a single line of logging changing.
    const h = makeHarness({ 42: journal() })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    const verifiedAtLink = state.tasks['42'].docLinkVerifiedAt
    expect(verifiedAtLink).toBeGreaterThan(0)

    const up = await withFakeSleep(async () => {
      h.rateLimitNextEdits(Infinity)
      h.store['42'] = journal({ body: 'changed' })
      return bridge.syncUp()
    })

    expect(h.sent).toHaveLength(1)
    expect(state.tasks['42'].docLinkMessageId).toBe(1)
    // Named as a defect in the run's own result, not buried in a log line.
    expect(up.linkUnverified).toEqual(['42'])
    // And the clock did NOT move. Letting an assumption count as verification would send the
    // link we know least about to the back of the probe queue on the strength of a guess.
    expect(state.tasks['42'].docLinkVerifiedAt).toBe(verifiedAtLink)
  })

  it('does not stack a SECOND message when the edit carrying the ask is rate limited', async () => {
    // Shiv's actual complaint, reached by this path: "Every time I look at the app, I expect to
    // see a single telegram message per task. Instead there's multiple stacked messages."
    //
    // The ask must fall through to a fresh send when an edit genuinely fails — losing a
    // blocking ask is worse than one duplicate line (#170). But a 429 is not a failure, it is a
    // wait, and treating it as one made the duplicate the call that SUCCEEDS: the retry on the
    // send path waits out the limit the edit refused to wait out. The stack is manufactured by
    // the code written to prevent it.
    const h = makeHarness({ 42: journal({ needs: 'the API key for the staging box' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
    const linkId = state.tasks['42'].docLinkMessageId

    await withFakeSleep(async (waits) => {
      h.store['42'] = journal({ needs: 'the API key for the PROD box' })
      h.rateLimitNextEdits(1, 12, linkId)
      await bridge.syncUp()
      expect(waits).toEqual([12000])
    })

    // Still one message, not two.
    expect(h.sent).toHaveLength(1)
    expect(state.tasks['42'].docLinkMessageId).toBe(linkId)
    const rewrite = h.edits.filter((e) => e.messageId === linkId).pop()
    expect(rewrite.text).toContain('the API key for the PROD box')
  })
})

// #586 — VERIFICATION BECOMES ROLLING.
//
// Retrying alone fixes correctness and makes the run worse: 61 probes each honouring a 30s wait
// is half an hour of a run spent confirming that nothing changed. The probe is an edit with
// byte-identical text whose expected answer is "not modified" — it is the cheapest possible
// call to skip and the most expensive possible call to make 61 times.
//
// So a bounded number are probed per run, least-recently-verified first. Every link is still
// checked within a bounded number of runs, which is weaker than "every link every run" on paper
// and stronger in fact, because that promise was being kept zero percent of the time.
describe('#586 — the probe budget', () => {
  const five = () =>
    makeHarness({ 41: journal(), 42: journal(), 43: journal(), 44: journal(), 45: journal() })

  it('probes only the budget, oldest first, and leaves the rest for later runs', async () => {
    const h = five()
    h.config.docLinkProbeBudget = 2
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(5)

    // Hand-set the clock so the ORDER under test is the one being asserted, not whatever five
    // sends in the same millisecond happened to produce.
    const ages = { 41: 500, 42: 100, 43: 400, 44: 200, 45: 300 }
    for (const [id, at] of Object.entries(ages)) state.tasks[id].docLinkVerifiedAt = at
    const linkIds = Object.fromEntries(
      Object.keys(ages).map((id) => [id, state.tasks[id].docLinkMessageId]),
    )

    h.edits.length = 0
    const up = await bridge.syncUp()

    // The two stalest, and nothing else.
    const probed = h.edits.map((e) => e.messageId).sort()
    expect(probed).toEqual([linkIds[42], linkIds[44]].sort())
    // The other three are DEFERRED — a different state from unverified, and reported apart from
    // it. Collapsing the two would rebuild the exact defect this issue is about: two unlike
    // situations producing one indistinguishable output.
    expect(up.linkProbeDeferred.sort()).toEqual(['41', '43', '45'])
    expect(up.linkUnverified).toEqual([])
    // Nothing was reposted for the deferred ones. A skipped probe must never read as "gone".
    expect(h.sent).toHaveLength(5)
  })

  it('gives a NEVER-verified link the budget before any link with evidence behind it', async () => {
    const h = five()
    h.config.docLinkProbeBudget = 1
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    for (const id of ['41', '42', '43', '44', '45']) state.tasks[id].docLinkVerifiedAt = 900
    delete state.tasks['44'].docLinkVerifiedAt
    const target = state.tasks['44'].docLinkMessageId

    h.edits.length = 0
    await bridge.syncUp()

    expect(h.edits.map((e) => e.messageId)).toEqual([target])
  })

  it('never lets a spent budget stop a task from GETTING its link', async () => {
    // The budget gates verifying a link, never sending one. A newly bound task must reach the
    // user's phone on the run it is bound, regardless of how many older links are queued —
    // otherwise a bounded probe becomes an unbounded silence, which is the #346 shape this
    // whole feature exists to close.
    const h = five()
    h.config.docLinkProbeBudget = 1
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(5)

    h.store['99'] = journal()
    await bridge.syncUp()

    expect(h.sent).toHaveLength(6)
    expect(h.sent[5].text).toContain('Catch-up doc')
    expect(state.tasks['99'].docLinkMessageId).toBe(6)
    // ...and a send is first-hand evidence, so it starts the clock rather than jumping the
    // queue next run to re-confirm what Telegram was just watched accepting.
    expect(state.tasks['99'].docLinkVerifiedAt).toBeGreaterThan(0)
  })

  it('probes EVERYTHING when the budget is switched off, which is the pre-#586 behaviour', async () => {
    const h = five()
    h.config.docLinkProbeBudget = 0
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    h.edits.length = 0
    const up = await bridge.syncUp()

    expect(h.edits).toHaveLength(5)
    expect(up.linkProbeDeferred).toEqual([])
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

describe('#483 follow-up — the freeze is decided once, not re-derived forever', () => {
  // The freeze reads `lastPostedReplyCount !== replyCount`, and the ONLY writer of
  // `lastPostedReplyCount` is `setLastPostedContext` on the turn-posting path. Link mode
  // `continue`s before reaching it. So once a task is doc-bound the captured half never moves
  // again while `replyCount` keeps climbing -- and it climbs because the link and the notice
  // are there to be replied to. Recomputed every run, the answer flips to "frozen" on the
  // first reply after binding and can never flip back, since the only thing that clears it is
  // a turn post #424 exists to prevent.
  //
  // Measured live on 2026-09-07, task #228: bound (docLinkMessageId 2865), replyCount 4 vs
  // lastPostedReplyCount 2, two pre-binding messages that could never collapse.
  function bound(state, { ids = [1001, 1002], replyCount = 0, postedAt = 0, verdict, h } = {}) {
    state.tasks['42'] = {
      topicId: 7,
      lastPostedMessageIds: ids,
      lastPostedReplyCount: postedAt,
      replyCount,
      ...(typeof verdict === 'boolean' ? { preBindSpokeSince: verdict } : {}),
    }
    if (h) for (const id of ids) h.registerLive(id)
    return state
  }

  it('records the verdict on the first link-mode pass', async () => {
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h })
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    // Not merely absent-and-therefore-falsy: the field must be a real `false`, because
    // `undefined` is the "not yet asked" state and takes the recompute branch.
    expect(state.tasks['42'].preBindSpokeSince).toBe(false)
  })

  it('does NOT re-freeze when a reply lands after binding — the defect', async () => {
    // The regression this exists for. A reply to the doc link or the notice moves `replyCount`
    // far away from the pinned `lastPostedReplyCount`, so the recomputed predicate says
    // "frozen" — yet the messages under judgement were already ruled safe at binding. Under
    // the old code this test collapses nothing.
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h, replyCount: 5, postedAt: 0, verdict: false })
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const res = await bridge.syncUp()

    expect(res.collapsed).toEqual([{ taskId: '42', messageIds: [1001, 1002] }])
    expect(h.deleted).toEqual([])
    expect(state.tasks['42'].lastPostedMessageIds).toBeUndefined()
  })

  it('keeps a recorded freeze frozen even when the counters later agree', async () => {
    // The safety direction, and it must be just as sticky. If a reply DID land before binding,
    // no later arithmetic may unfreeze those messages — including counters that happen to
    // line up again.
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h, replyCount: 0, postedAt: 0, verdict: true })
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    expect(h.edits.filter((e) => e.messageId === 1001)).toEqual([])
    expect(h.deleted).toEqual([])
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1001, 1002])
  })

  it('freezes a task that was ALREADY bound when this shipped, and says so once', async () => {
    // #228's shape: no recorded verdict, and the counters disagree. `replyCount` records no
    // message ids, so whether those replies landed before or after the link went out is not
    // recoverable — take the conservative branch and never rewrite a message he may have
    // answered. Shiv's instruction was "fix the build so you don't make more stacking", not
    // "go back and fix prior mistakes".
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h, replyCount: 4, postedAt: 2 })
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    expect(state.tasks['42'].preBindSpokeSince).toBe(true)
    expect(h.edits.filter((e) => e.messageId === 1001)).toEqual([])
    expect(state.tasks['42'].lastPostedMessageIds).toEqual([1001, 1002])
  })

  it('still honours a reply that landed before binding, when nothing is recorded yet', async () => {
    // Do not regress the original guard: the recompute branch is still the one that decides,
    // and it must decide the same way it always did.
    const h = makeHarness({ 42: journal() })
    const state = bound(emptyState(), { h, replyCount: 1, postedAt: 0 })
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()

    expect(state.tasks['42'].preBindSpokeSince).toBe(true)
    expect(h.edits.filter((e) => e.messageId === 1001)).toEqual([])
  })
})

describe('#588 — the link points at a WRITTEN doc, not merely a bound one', () => {
  // `ensure-catchup-doc` creates a placeholder and binds it; the body arrives on the task's
  // first wake AFTER that. Posting off the binding meant a task bound during a run had its
  // link pushed in that same run — measured 2026-09-07, four of five links pointed at "this
  // has not been written yet". Under #424 that link is the wake's ENTIRE message, so a stub
  // link is strictly worse than silence.

  it('posts nothing while the doc is bound but unwritten, then exactly one link once written', async () => {
    const h = makeHarness({ 42: journal({ written: false }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const first = await bridge.syncUp()
    expect(h.sent).toHaveLength(0)
    // No message, and no topic either: there is nothing to say yet, so the run leaves no trace
    // in the chat at all.
    expect(state.tasks['42']).toBeUndefined()
    // The probe budget is not spent on a link that was never posted.
    expect(h.edits).toHaveLength(0)
    // Deferral is REPORTED. A withheld link and a link that was never due are the same silence
    // from outside, and that equivalence is the defect class this whole area exists to remove.
    expect(first.linkDeferredUnwritten).toEqual(['42'])

    // The wake lands and writes the doc; the journal now names it, which G10 guarantees.
    h.store['42'] = journal({ written: true, body: 'the wake wrote the doc' })
    const second = await bridge.syncUp()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain(DOC_URL)
    expect(second.linkDeferredUnwritten).toEqual([])
    expect(state.tasks['42'].docLinkMessageId).toBe(1)

    // #424 is unchanged by the gate: still once, not once per run.
    await bridge.syncUp()
    expect(h.sent).toHaveLength(1)
  })

  it('does not treat the binding marker itself as evidence the doc was written', async () => {
    // The marker names the doc by definition. Counting it would make every bound task look
    // written and restore the exact behaviour being removed — so this is the load-bearing
    // half of the signal, asserted on its own rather than left implicit in the test above.
    const content = journal({ written: false })
    expect(content).toContain(DOC_ID)

    const h = makeHarness({ 42: content })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(0)
  })

  it('withholds the short notice too, rather than pointing an ask at a placeholder', async () => {
    // The notice carries the doc url as well. Letting it through would spend the topic's one
    // message on a link to an empty document while claiming to be the exception that matters.
    const h = makeHarness({ 42: journal({ written: false, needs: 'a decision from you' }) })
    const state = emptyState()
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    await bridge.syncUp()
    expect(h.sent).toHaveLength(0)
  })

  it('leaves a link that is already posted alone', async () => {
    // Forward-only. The fix corrects the build that produces stub links; it does not go back
    // and retract messages he has already seen. A task whose link predates this gate keeps it
    // and keeps being maintained by the #586 probe.
    const h = makeHarness({ 42: journal({ written: false }) })
    const state = emptyState()
    state.tasks = {
      42: { topicId: 7, docLinkMessageId: 1001, docLinkDocId: DOC_ID },
    }
    h.registerLive(1001)
    const bridge = createBridge({ client: h.client, config: h.config, state, io: h.io })

    const out = await bridge.syncUp()
    expect(out.linkDeferredUnwritten).toEqual([])
    expect(h.deleted).toEqual([])
    expect(state.tasks['42'].docLinkMessageId).toBe(1001)
  })
})
