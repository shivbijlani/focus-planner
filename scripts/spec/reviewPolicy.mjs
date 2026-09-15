import { createHash } from 'node:crypto'
import { readabilityFindings, checkTechnicalPageLink } from './readability.mjs'

export const DAY_MS = 24 * 60 * 60 * 1000
export const NAVIGATION = [
  'Start here', 'Plan your day', 'Let the agent help', 'Your data and devices',
  'Read and reply anywhere', 'Help and known limits', 'Optional reference',
]

export function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function pagesHash(pages) {
  return hash(JSON.stringify(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b))))
}

export function initialState() {
  return { schema: 1, revision: 0, lastProposalAt: null, acceptedInput: null, pending: null }
}

export function checkState(state) {
  if (!state || state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Object.hasOwn(state, 'pending') || !Object.hasOwn(state, 'acceptedInput')) {
    throw new Error('Invalid wiki review state; refusing to reset the daily limit')
  }
  if ((state.revision > 0 && state.lastProposalAt === null) ||
      (state.lastProposalAt !== null && !Number.isFinite(Date.parse(state.lastProposalAt)))) {
    throw new Error('Invalid lastProposalAt; refusing to reset the daily limit')
  }
  if (state.pending && (state.pending.revision !== state.revision ||
      !['presenting', 'review', 'approved', 'source-written'].includes(state.pending.status))) {
    throw new Error('Invalid pending review state')
  }
}

export function canPropose(state, { now, inputHash, allowProposal }) {
  checkState(state)
  if (!Number.isFinite(now)) throw new Error('Invalid review clock')
  if (state.pending) return { allowed: false, reason: 'A frozen revision is already pending' }
  if (!allowProposal) return { allowed: false, reason: 'Approval-only invocation' }
  if (state.lastProposalAt && now - Date.parse(state.lastProposalAt) < DAY_MS) {
    return { allowed: false, reason: 'The rolling 24-hour review limit has not elapsed' }
  }
  if (state.acceptedInput === inputHash) return { allowed: false, reason: 'No new documentation inputs' }
  return { allowed: true, reason: 'Daily review eligible' }
}

export function findApproval(comments, pending, approverEmail, now) {
  if (!pending.review) return null
  const expected = pending.review.approvalText
  const floor = Date.parse(pending.review.presentedAt)
  if (!Number.isFinite(floor)) throw new Error('Missing review presentation timestamp')
  for (const comment of comments) {
    if (comment.deleted || comment.resolved) continue
    for (const entry of [comment, ...(comment.replies ?? [])]) {
      const created = Date.parse(entry.createdTime)
      if (entry.deleted || !entry.id || !Number.isFinite(created) || created < floor || created > now) continue
      if (entry.author?.emailAddress?.toLowerCase() !== approverEmail.toLowerCase()) continue
      // An edited old comment is not a fresh approval. A human can post a new one.
      if (entry.modifiedTime && entry.modifiedTime !== entry.createdTime) continue
      if (pending.approval && entry.id !== pending.approval.commentId) continue
      if (entry.content?.trim() === expected) {
        return { commentId: entry.id, email: entry.author.emailAddress, createdAt: entry.createdTime }
      }
    }
  }
  return null
}

export function assertSnapshot(pending, pages) {
  if (pagesHash(pages) !== pending.contentHash) throw new Error('Frozen wiki snapshot has changed')
}

export function assertSource(pending, currentPages, policyHash) {
  if (policyHash !== pending.policyHash) throw new Error('Documentation policy changed; approval cannot be reused')
  const current = pagesHash(currentPages)
  if (current !== pending.baseContentHash && current !== pending.contentHash) {
    throw new Error('Accepted documentation changed during review; refusing to overwrite it')
  }
}

function anchors(text) {
  const result = new Set()
  const counts = new Map()
  const prose = text.replace(/^```[\s\S]*?^```\s*$/gm, '')
  for (const match of prose.matchAll(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1].toLowerCase().replace(/<[^>]*>/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-')
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    result.add(count ? `${base}-${count}` : base)
  }
  for (const match of prose.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g)) result.add(match[1])
  return result
}

export function validatePages(pages, baseline = {}) {
  const problems = []
  if (!Object.keys(pages).length) problems.push('No wiki pages')
  for (const name of Object.keys(baseline)) {
    if (!(name in pages)) problems.push(`Topic deletion requires a separate decision: ${name}`)
  }
  for (const [name, text] of Object.entries(pages)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\.md$/.test(name) || /^readme\.md$/i.test(name)) {
      problems.push(`Invalid wiki page name: ${name}`)
      continue
    }
    if (typeof text !== 'string' || !text.trim()) {
      problems.push(`Empty wiki page: ${name}`)
      continue
    }
    if (/\[\s*wiki\s+(?:review|publication)\s+\d+\b/i.test(text)) {
      problems.push(`${name}: reserved review markers are not page content`)
    }
    problems.push(...readabilityFindings(name, text).map(f => `${name}: ${f.kind}: ${f.detail}`))
    const mainText = text.replace(/<details>[\s\S]*?<\/details>/g, '')
      .replace(/\]\(https:\/\/[^)]+\)/g, ']')
    if (/(?:src|packages|plugins|scripts)\/[\w./-]+\.(?:js|jsx|mjs|ts|tsx|ps1)\b/.test(mainText)) {
      problems.push(`${name}: implementation paths on the main reading path`)
    }
    if (/\b(?:module count|principal modules|public exports|module graph)\b/i.test(mainText)) {
      problems.push(`${name}: implementation inventory on the main reading path`)
    }
    if ((text.match(/<details>/g) ?? []).length !== (text.match(/<\/details>/g) ?? []).length) {
      problems.push(`${name}: unbalanced technical detail blocks`)
    }
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1]
      const wiki = /^https:\/\/github\.com\/[^/]+\/[^/]+\/wiki\/([^#?]+)(?:#.*)?$/.exec(target)
      const local = !/^[a-z]+:/i.test(target)
      if (local || wiki) {
        const page = target.startsWith('#') ? name.replace(/\.md$/, '') :
          decodeURIComponent((wiki?.[1] ?? target).split('#')[0]).replace(/\.md$/, '')
        if (!(page + '.md' in pages)) problems.push(`${name}: missing linked page ${page}`)
        const fragment = target.split('#')[1]
        if (fragment && pages[page + '.md'] &&
            !anchors(pages[page + '.md']).has(decodeURIComponent(fragment))) {
          problems.push(`${name}: missing linked heading ${page}#${fragment}`)
        }
      } else if (!target.startsWith('https://')) {
        problems.push(`${name}: unsupported link ${target}`)
      }
    }
  }
  for (const label of NAVIGATION) {
    if (!pages['Home.md']?.includes(label)) problems.push(`Home.md: missing reader navigation "${label}"`)
  }
  for (const name of ['Prioritisation.md', 'Reliability.md']) {
    if (!pages[name] || !pages['Home.md']?.includes(name.replace('.md', ''))) {
      problems.push(`Agent priorities and long-running reliability must remain reachable: ${name}`)
    }
  }
  problems.push(...checkTechnicalPageLink(new Map(Object.entries(pages))).map(f => `${f.page}: ${f.kind}`))
  if (problems.length) throw new Error(problems.join('\n'))
}
