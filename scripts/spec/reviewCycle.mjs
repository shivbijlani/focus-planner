import {
  assertSnapshot, assertSource, canPropose, checkState, findApproval, hash, initialState, pagesHash, validatePages,
} from './reviewPolicy.mjs'

// Store saves use optimistic commits. No external write is treated as complete until
// its receipt is durable; retries verify and reuse the same frozen revision.
export async function prepareReview({ store, google, source, allowProposal, now = Date.now() }) {
  const loaded = await store.load()
  const state = loaded.state ?? initialState()
  checkState(state)
  await google.read()
  if (state.pending?.status === 'presenting') await presentPending({ store, google, loaded, now })
  const verdict = canPropose(state, { now, inputHash: source.inputHash, allowProposal })
  return { ...verdict, stateSha: loaded.sha, source }
}

async function presentPending({ store, google, loaded }) {
  let { state, sha } = loaded
  let pending = state.pending
  if (!pending.snapshotSha) {
    pending = { ...pending, snapshotSha: sha }
    state = { ...state, pending }
    sha = await store.save(state, null, sha)
  }
  const pages = await store.pages(pending.snapshotSha)
  assertSnapshot(pending, pages)
  const review = await google.present({
    revision: pending.revision, snapshotSha: pending.snapshotSha, contentHash: pending.contentHash,
    pages, summary: pending.summary, createdAt: pending.createdAt,
  })
  state = { ...state, pending: { ...pending, review, status: 'review' } }
  await store.save(state, null, sha)
  return state
}

export async function stageReview({ store, google, ticket, source, pages, now = Date.now() }) {
  if (!ticket.allowed) throw new Error('Generation was not authorized by the daily gate')
  const loaded = await store.load()
  if (loaded.sha !== ticket.stateSha) throw new Error('Review state changed during generation')
  if (source.sha !== ticket.source.sha || source.policyHash !== ticket.source.policyHash ||
      source.inputHash !== ticket.source.inputHash) throw new Error('Source changed during generation')
  const state = loaded.state ?? initialState()
  const verdict = canPropose(state, { now, inputHash: source.inputHash, allowProposal: true })
  if (!verdict.allowed) throw new Error(verdict.reason)
  validatePages(pages, source.pages)
  const contentHash = pagesHash(pages)
  if (contentHash === pagesHash(source.pages)) {
    await store.save({ ...state, acceptedInput: source.inputHash }, null, loaded.sha)
    return { status: 'unchanged' }
  }
  const changed = Object.keys(pages).filter(name => pages[name] !== source.pages[name])
  const createdAt = new Date(now).toISOString()
  const pending = {
    revision: state.revision + 1, status: 'presenting', createdAt,
    baseSha: source.sha, baseContentHash: pagesHash(source.pages),
    inputHash: source.inputHash, policyHash: source.policyHash, contentHash,
    summary: changed.map(name => {
      const before = source.pages[name] ?? ''
      const after = pages[name]
      const readerParagraphs = text => text.replace(/<details>[\s\S]*?<\/details>/g, '')
        .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '')
        .replace(/^\|.*$/gm, '')
        .split(/\r?\n\r?\n/)
        .filter(p => !/\b(?:module count|principal modules|public exports|module graph)\b/i.test(p) &&
          !/(?:src|packages|plugins|scripts)\/[\w./-]+/.test(p))
      const beforeParagraphs = readerParagraphs(before)
      const afterParagraphs = readerParagraphs(after)
      const removed = beforeParagraphs.filter(p => p.trim() && !afterParagraphs.includes(p)).join('\n\n')
      const added = afterParagraphs.filter(p => p.trim() && !beforeParagraphs.includes(p)).join('\n\n')
      const excerpt = text => text.length > 700 ? text.slice(0, 700) + ' [excerpt; full page linked below]' : text
      return `${name}: ${name in source.pages ? 'revised' : 'new'}.\nBefore: ${excerpt(removed) || '(no changed reading-level excerpt)'}\nProposed: ${excerpt(added) || '(reference-only or removed wording; see full preview)'}`
    }).join('\n\n') + (source.decisions ? `\n\n${source.decisions}` : ''),
    snapshotSha: null,
  }
  if (/\[\s*wiki\s+(?:review|publication)\s+\d+\b/i.test(pending.summary)) {
    throw new Error('Review summary contains reserved markers; no revision was reserved')
  }
  const next = { ...state, revision: pending.revision, lastProposalAt: createdAt, pending }
  const sha = await store.save(next, pages, loaded.sha)
  return presentPending({ store, google, loaded: { state: next, sha } })
}

export async function publishApproved({ store, google, repository, wiki, approverEmail, now = Date.now() }) {
  let { state, sha } = await store.load()
  if (state) checkState(state)
  if (!state?.pending) return { status: 'nothing-pending' }
  let pending = state.pending
  if (pending.status === 'presenting') return { status: 'awaiting-presentation' }
  const observation = await google.read()
  await google.verifyReview({ revision: pending.revision, reviewTextHash: pending.review.reviewTextHash })
  const approval = findApproval(observation.comments, pending, approverEmail, now)
  if (!approval) return { status: 'awaiting-human-approval' }
  if (pending.approval && pending.approval.commentId !== approval.commentId) {
    throw new Error('Approval identity changed while publication was pending')
  }
  const pages = await store.pages(pending.snapshotSha)
  assertSnapshot(pending, pages)
  const source = await repository.source()
  assertSource(pending, source.pages, source.policyHash)
  validatePages(pages, source.pages)
  await wiki.preflight()
  // Validate the snapshot, not freshly generated model output or a floating branch.
  await repository.verify(pending, pages)
  if (!pending.approval) {
    pending = { ...pending, approval, status: 'approved' }
    state = { ...state, pending }
    sha = await store.save(state, null, sha)
  }
  const acceptedSha = await repository.accept(pending, pages)
  if (pending.status !== 'source-written') {
    pending = { ...pending, status: 'source-written', acceptedSha }
    state = { ...state, pending }
    sha = await store.save(state, null, sha)
  }
  // Re-read the approval and review immediately before the public write.
  const latest = await google.read()
  const stillApproved = findApproval(latest.comments, pending, approverEmail, now)
  if (stillApproved?.commentId !== approval.commentId) throw new Error('Approval was withdrawn before publication')
  await google.verifyReview({ revision: pending.revision, reviewTextHash: pending.review.reviewTextHash })
  const receipt = await wiki.publish(pages, pending)
  await wiki.verify(pages, receipt)
  const published = pending.publication ?? {
    revision: pending.revision, contentHash: pending.contentHash, snapshotSha: pending.snapshotSha,
    acceptedSha, wikiSha: receipt.sha, approval, publishedAt: new Date(now).toISOString(),
  }
  if (published.wikiSha !== receipt.sha) throw new Error('Wiki changed after verification; receipt cannot be reused')
  if (!pending.publication) {
    pending = { ...pending, publication: published }
    state = { ...state, pending }
    sha = await store.save(state, null, sha)
  }
  await google.recordPublication(published)
  await store.save({ ...state, acceptedInput: pending.inputHash, pending: null, published }, null, sha)
  return { status: 'published', ...published }
}

export function inputHash(tree, issues, policy) {
  return hash(JSON.stringify({
    files: tree.filter(e => e.type === 'blob' && !e.path.startsWith('docs/spec/'))
      .map(e => [e.path, e.sha]).sort(([a], [b]) => a.localeCompare(b)),
    issues: issues.map(i => [i.number, i.state, i.updated_at]).sort((a, b) => a[0] - b[0]),
    policy,
  }))
}
