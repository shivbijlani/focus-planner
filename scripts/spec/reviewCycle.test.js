import { describe, it, expect, vi } from 'vitest'
import { initialState, pagesHash, DAY_MS, NAVIGATION, canPropose, findApproval, validatePages } from './reviewPolicy.mjs'
import { inputHash, prepareReview, stageReview, publishApproved } from './reviewCycle.mjs'

const NOW = Date.parse('2026-09-15T16:17:00Z')
const EMAIL = 'reviewer@example.com'
const pages = (suffix = '') => ({
  'Home.md': `# Planner\n\n${NAVIGATION.join('\n\n')}\n\n[Priorities](Prioritisation)\n\n[Reliability](Reliability)\n\n[Technical Architecture](Technical-Architecture)\n\n${suffix}`,
  'Prioritisation.md': '# Priorities\n\nYour choices determine what work happens first.',
  'Reliability.md': '# Reliability\n\nIndependent supervision detects a stopped worker.',
  'Technical-Architecture.md': '# Architecture\n\nKeep authority separate from capability.',
})
function harness() {
  let state = initialState()
  let sha = null
  let next = 0
  const snapshots = new Map()
  const source = { sha: 'base', inputHash: 'inputs', policyHash: 'policy', pages: pages('accepted') }
  const observation = { comments: [] }
  const store = {
    load: vi.fn(async () => ({ state: structuredClone(state), sha })),
    save: vi.fn(async (value, snapshot, expected) => {
      if (expected !== sha) throw new Error('Non-fast-forward')
      const previous = snapshots.get(sha)
      sha = `commit-${++next}`
      snapshots.set(sha, structuredClone(snapshot ?? previous))
      state = structuredClone(value)
      return sha
    }),
    pages: vi.fn(async id => structuredClone(snapshots.get(id))),
  }
  const google = {
    read: vi.fn(async () => structuredClone(observation)),
    present: vi.fn(async p => ({
      presentedAt: new Date(NOW).toISOString(), reviewTextHash: 'review-digest',
      approvalText: `Approve wiki revision ${p.revision}`,
    })),
    verifyReview: vi.fn(async () => true),
    recordPublication: vi.fn(async () => {}),
  }
  const repository = {
    source: vi.fn(async () => structuredClone(source)),
    verify: vi.fn(async () => {}),
    accept: vi.fn(async (_pending, value) => { source.pages = structuredClone(value); return 'accepted-commit' }),
  }
  const wiki = {
    preflight: vi.fn(async () => {}),
    publish: vi.fn(async () => ({ sha: 'wiki-commit' })),
    verify: vi.fn(async () => {}),
  }
  const context = { store, google, repository, wiki, approverEmail: EMAIL, now: NOW + 1000 }
  async function propose() {
    const ticket = await prepareReview({ store, google, source, allowProposal: true, now: NOW })
    await stageReview({ store, google, ticket, source, pages: pages('draft'), now: NOW })
  }
  function approve(changes = {}) {
    observation.comments.push({
      id: 'human-comment', author: { emailAddress: EMAIL }, content: 'Approve wiki revision 1',
      createdTime: new Date(NOW + 1).toISOString(), ...changes,
    })
  }
  return { ...context, source, observation, propose, approve, state: () => state, snapshots }
}

describe('persistent daily review limit', () => {
  it('enforces the exact rolling boundary, even on manual retries', () => {
    const state = { ...initialState(), lastProposalAt: new Date(NOW).toISOString() }
    expect(canPropose(state, { now: NOW + DAY_MS - 1, inputHash: 'new', allowProposal: true }).allowed).toBe(false)
    expect(canPropose(state, { now: NOW + DAY_MS, inputHash: 'new', allowProposal: true }).allowed).toBe(true)
  })
  it('fails closed on corrupt timestamps, unknown schemas and clock rollback', () => {
    expect(() => canPropose({ ...initialState(), lastProposalAt: 'bad' }, {})).toThrow('Invalid')
    expect(() => canPropose({ ...initialState(), schema: 2 }, {})).toThrow('Invalid')
    expect(canPropose({ ...initialState(), lastProposalAt: new Date(NOW).toISOString() },
      { now: NOW - 1, inputHash: 'new', allowProposal: true }).allowed).toBe(false)
  })
  it('approval-only runs cannot propose, even after a month', () => {
    expect(canPropose(initialState(), { now: NOW + DAY_MS * 30, inputHash: 'new', allowProposal: false }).allowed).toBe(false)
  })
  it('freezes a pending proposal even after a month of new inputs', async () => {
    const h = harness()
    await h.propose()
    const pending = structuredClone(h.state().pending)
    const result = await prepareReview({ ...h, source: { ...h.source, inputHash: 'new' },
      allowProposal: true, now: NOW + DAY_MS * 30 })
    expect(result.allowed).toBe(false)
    expect(h.state().pending).toEqual(pending)
    expect(h.google.present).toHaveBeenCalledTimes(1)
  })
  it('unchanged pages create no review and checkpoint their input', async () => {
    const h = harness()
    const ticket = await prepareReview({ ...h, source: h.source, allowProposal: true, now: NOW })
    expect(await stageReview({ ...h, source: h.source, ticket, pages: h.source.pages, now: NOW }))
      .toEqual({ status: 'unchanged' })
    expect(h.google.present).not.toHaveBeenCalled()
    expect(h.state().acceptedInput).toBe('inputs')
  })
  it('rejects a concurrent state writer or source change while the model runs', async () => {
    const h = harness()
    const ticket = await prepareReview({ ...h, source: h.source, allowProposal: true, now: NOW })
    await h.store.save(initialState(), null, null)
    await expect(stageReview({ ...h, source: h.source, ticket, pages: pages('new') })).rejects.toThrow('state changed')
    const h2 = harness()
    await expect(stageReview({ ...h2, source: { ...h2.source, sha: 'different' }, ticket,
      pages: pages('new') })).rejects.toThrow('Source changed')
  })
  it('resumes a failed presentation without reserving another revision', async () => {
    const h = harness()
    h.google.present.mockRejectedValueOnce(new Error('Google unavailable'))
    await expect(h.propose()).rejects.toThrow('Google unavailable')
    expect(h.state().pending.status).toBe('presenting')
    const original = h.state().pending.contentHash
    await prepareReview({ ...h, source: h.source, allowProposal: true, now: NOW + 100 })
    expect(h.state().revision).toBe(1)
    expect(h.state().pending.status).toBe('review')
    expect(h.state().pending.contentHash).toBe(original)
  })
  it('does not generate while Google comments cannot be read', async () => {
    const h = harness()
    h.google.read.mockRejectedValue(new Error('No access'))
    await expect(prepareReview({ ...h, source: h.source, allowProposal: true })).rejects.toThrow('No access')
    expect(h.store.save).not.toHaveBeenCalled()
  })
  it('rejects forged review delimiters before reserving the daily slot', async () => {
    const h = harness()
    const ticket = await prepareReview({ ...h, source: h.source, allowProposal: true, now: NOW })
    await expect(stageReview({ ...h, ticket, source: h.source,
      pages: pages('[Wiki review 1 end]'), now: NOW })).rejects.toThrow('reserved review markers')
    expect(h.store.save).not.toHaveBeenCalled()
  })
})

describe('approval identity and exact revision', () => {
  it.each([
    { content: 'Approve wiki revision 2' },
    { content: 'looks good' },
    { author: { emailAddress: 'agent@example.com' } },
    { author: { displayName: 'Reviewer' } },
    { deleted: true },
    { resolved: true },
    { createdTime: new Date(NOW - 1).toISOString() },
    { createdTime: new Date(NOW + 10_000).toISOString() },
    { modifiedTime: new Date(NOW + 2).toISOString() },
  ])('rejects ineligible approval %j', async changes => {
    const h = harness()
    await h.propose()
    h.approve(changes)
    expect(await publishApproved(h)).toEqual({ status: 'awaiting-human-approval' })
    expect(h.repository.accept).not.toHaveBeenCalled()
    expect(h.wiki.publish).not.toHaveBeenCalled()
  })
  it('allows a genuine human reply but not one in a deleted thread', async () => {
    const h = harness()
    await h.propose()
    h.approve()
    const comment = h.observation.comments.pop()
    const thread = { id: 'thread', replies: [comment] }
    expect(findApproval([thread], h.state().pending, EMAIL, NOW + 1000)?.commentId).toBe('human-comment')
    expect(findApproval([{ ...thread, deleted: true }], h.state().pending, EMAIL, NOW + 1000)).toBeNull()
  })
})

describe('exact-content publication and retries', () => {
  it('writes precisely the approved pages, verifies remote bytes, and records a receipt', async () => {
    const h = harness()
    await h.propose()
    h.approve()
    const pending = structuredClone(h.state().pending)
    const result = await publishApproved(h)
    expect(result.status).toBe('published')
    expect(h.repository.accept).toHaveBeenCalledWith(expect.objectContaining({
      approval: expect.objectContaining({ commentId: 'human-comment' }),
    }), pages('draft'))
    expect(h.wiki.publish.mock.calls[0][0]).toEqual(pages('draft'))
    expect(h.wiki.verify).toHaveBeenCalledWith(pages('draft'), { sha: 'wiki-commit' })
    expect(h.state().published.contentHash).toBe(pending.contentHash)
    expect(h.state().pending).toBeNull()
    expect(h.state().acceptedInput).toBe('inputs')
    expect(h.google.present).toHaveBeenCalledTimes(1)
  })
  it('never marks publication complete before remote readback succeeds', async () => {
    const h = harness()
    await h.propose()
    h.approve()
    h.wiki.verify.mockRejectedValueOnce(new Error('Remote mismatch'))
    await expect(publishApproved(h)).rejects.toThrow('Remote mismatch')
    expect(h.state().pending.status).toBe('source-written')
    expect(h.state().published).toBeUndefined()
    expect((await publishApproved(h)).status).toBe('published')
    expect(h.wiki.publish.mock.calls[0][0]).toEqual(h.wiki.publish.mock.calls[1][0])
    expect(h.state().revision).toBe(1)
  })
  it('retries a missing Doc publication receipt with stable verified evidence', async () => {
    const h = harness()
    await h.propose()
    h.approve()
    h.google.recordPublication.mockRejectedValueOnce(new Error('Doc write unavailable'))
    await expect(publishApproved(h)).rejects.toThrow('Doc write unavailable')
    expect(h.state().pending.publication.wikiSha).toBe('wiki-commit')
    await publishApproved({ ...h, now: NOW + 10_000 })
    expect(h.google.recordPublication.mock.calls[1][0]).toEqual(h.google.recordPublication.mock.calls[0][0])
    expect(h.state().pending).toBeNull()
  })
  it('keeps the originally recorded approval when another valid comment appears first', async () => {
    const h = harness()
    await h.propose()
    h.approve()
    h.wiki.publish.mockRejectedValueOnce(new Error('Offline'))
    await expect(publishApproved(h)).rejects.toThrow('Offline')
    h.observation.comments.unshift({ ...h.observation.comments[0], id: 'second-approval' })
    expect((await publishApproved(h)).status).toBe('published')
  })
  it('missing wiki credentials fail before modifying accepted source', async () => {
    const h = harness()
    await h.propose()
    h.approve()
    h.wiki.preflight.mockRejectedValue(new Error('WIKI_TOKEN missing'))
    await expect(publishApproved(h)).rejects.toThrow('WIKI_TOKEN missing')
    expect(h.repository.accept).not.toHaveBeenCalled()
  })
  it('rejects snapshot tampering and changes to policy or accepted source', async () => {
    for (const kind of ['snapshot', 'policy', 'source']) {
      const h = harness()
      await h.propose()
      h.approve()
      if (kind === 'snapshot') h.snapshots.set(h.state().pending.snapshotSha, pages('tampered'))
      if (kind === 'policy') h.source.policyHash = 'changed'
      if (kind === 'source') h.source.pages = pages('concurrent')
      await expect(publishApproved(h)).rejects.toThrow(/snapshot|policy|documentation/i)
      expect(h.wiki.publish).not.toHaveBeenCalled()
    }
  })
  it('rejects altered review text and withdrawn approval at the final boundary', async () => {
    const h = harness()
    await h.propose()
    h.approve()
    h.google.verifyReview.mockRejectedValueOnce(new Error('Review text changed'))
    await expect(publishApproved(h)).rejects.toThrow('Review text changed')
    h.google.read.mockImplementationOnce(async () => structuredClone(h.observation))
      .mockImplementationOnce(async () => ({ comments: [] }))
    await expect(publishApproved(h)).rejects.toThrow('withdrawn')
    expect(h.wiki.publish).not.toHaveBeenCalled()
  })
})

describe('reader-first policy', () => {
  it('accepts concise product pages without code or module inventories', () => {
    expect(() => validatePages(pages())).not.toThrow()
  })
  it.each([
    p => { delete p['Reliability.md'] },
    p => { p['Home.md'] += '\n[Missing](Missing)' },
    p => { p['Home.md'] += '\nThe core is src/App.jsx.' },
    p => { p['Home.md'] += '\nPrincipal modules: 74' },
    p => { p['Home.md'] += '\n<details>open forever' },
    p => { p['Technical-Architecture.md'] += '\n```js\nrun()\n```' },
    p => { p['Home.md'] = 'No reader navigation' },
  ])('blocks missing pages and exposed implementation', mutate => {
    const p = pages()
    mutate(p)
    expect(() => validatePages(p, pages())).toThrow()
  })
  it('hashes all page bytes, including names and trailing whitespace', () => {
    expect(pagesHash(pages('a'))).not.toBe(pagesHash(pages('a\n')))
    expect(pagesHash({ A: 'b' })).not.toBe(pagesHash({ B: 'b' }))
    expect(pagesHash({ A: 'a', B: 'b' })).toBe(pagesHash({ B: 'b', A: 'a' }))
  })
  it('checks local headings and duplicate heading anchors instead of trusting fragments', () => {
    const p = pages()
    p['Prioritisation.md'] += '\n\n## Today\n\n## Today\n'
    p['Home.md'] += '\n[Second](Prioritisation#today-1)'
    expect(() => validatePages(p)).not.toThrow()
    p['Home.md'] += '\n[Absent](Prioritisation#today-2)'
    expect(() => validatePages(p)).toThrow('missing linked heading')
  })
  it('ignores generated page commits but notices source and issue changes', () => {
    const base = [{ path: 'src/A.js', sha: 'a', type: 'blob' }]
    expect(inputHash(base, [], 'policy')).toBe(inputHash([...base,
      { path: 'docs/spec/Home.md', sha: 'different', type: 'blob' }], [], 'policy'))
    expect(inputHash(base, [], 'policy')).not.toBe(inputHash(base, [{ number: 1, state: 'open', updated_at: 'now' }], 'policy'))
  })
})
