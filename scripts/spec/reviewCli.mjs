import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitHubReview } from './reviewGitHub.mjs'
import { createGoogleReview } from './googleReview.mjs'
import { createWikiPublisher } from './reviewWiki.mjs'
import { prepareReview, stageReview, publishApproved } from './reviewCycle.mjs'
import { validatePages } from './reviewPolicy.mjs'

const command = process.argv[2]
const repo = process.env.GITHUB_REPOSITORY
const { store, repository } = createGitHubReview({ repo, token: process.env.GH_TOKEN })
const google = createGoogleReview({
  repo, clientId: process.env.WIKI_GOOGLE_CLIENT_ID, clientSecret: process.env.WIKI_GOOGLE_CLIENT_SECRET,
  refreshToken: process.env.WIKI_GOOGLE_REFRESH_TOKEN, documentId: process.env.WIKI_REVIEW_DOC_ID,
  approverEmail: process.env.WIKI_APPROVER_EMAIL,
})
const ticketFile = '.wiki-review-ticket.json'

async function checkLinks(pages) {
  const targets = new Set()
  for (const text of Object.values(pages)) {
    for (const match of text.matchAll(/\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)) {
      const url = new URL(match[1])
      if (url.hostname !== 'github.com' || url.username || url.password) {
        throw new Error(`Unsupported external evidence host: ${url.hostname}; review the link manually`)
      }
      if (url.pathname.startsWith(`/${repo}/wiki/`)) continue // validated against the frozen page set
      if (url.hash) throw new Error(`External fragment needs manual verification: ${url.href}; link the page instead`)
      url.hash = ''
      targets.add(url.href)
    }
  }
  for (const url of targets) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
    await response.arrayBuffer()
    if (!response.ok || response.url.replace(/\/$/, '') !== url.replace(/\/$/, '')) {
      throw new Error(`Evidence link failed or redirected: ${url}`)
    }
  }
}

try {
  if (command === 'prepare') {
    const result = await prepareReview({
      store, google, source: await repository.source(),
      allowProposal: process.env.WIKI_ALLOW_PROPOSAL === 'true',
    })
    writeFileSync(ticketFile, JSON.stringify(result, null, 2))
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `generate=${result.allowed}\n`)
    console.log(result.reason)
  } else if (command === 'stage') {
    const pages = Object.fromEntries(readdirSync('docs/spec').filter(n => n.endsWith('.md') && n !== 'README.md')
      .map(n => [n, readFileSync(join('docs/spec', n), 'utf8')]))
    validatePages(pages, {}, repo)
    await checkLinks(pages)
    const result = await stageReview({
      store, google, ticket: JSON.parse(readFileSync(ticketFile, 'utf8')),
      source: await repository.source(), pages,
    })
    console.log(`Wiki review: ${result.pending?.status ?? result.status}`)
  } else if (command === 'publish') {
    repository.verify = async (_pending, pages) => {
      validatePages(pages, {}, repo)
      await checkLinks(pages)
    }
    const wiki = createWikiPublisher({ repo, token: process.env.WIKI_TOKEN })
    try {
      const result = await publishApproved({
        store, google, repository, wiki, approverEmail: process.env.WIKI_APPROVER_EMAIL,
      })
      console.log(JSON.stringify(result))
    } finally {
      wiki.cleanup()
    }
  } else {
    throw new Error('Usage: node scripts/spec/reviewCli.mjs prepare|stage|publish')
  }
} catch (error) {
  console.error(`[wiki-review] ${error.message}`)
  process.exitCode = 1
}
