import { checkState, hash, initialState, pagesHash } from './reviewPolicy.mjs'
import { inputHash } from './reviewCycle.mjs'
import { buildDecisions, findConflicts, renderMarkdown } from './conflicts.mjs'

const STATE_BRANCH = 'spec/review-state'
const POLICY_PATH = 'docs/wiki-maintenance-policy.md'

export function createGitHubReview({ repo, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !token) throw new Error('GitHub repository and token are required')
  const prefix = `https://api.github.com/repos/${repo}`
  async function api(path, method = 'GET', body, absent = false) {
    const response = await fetchImpl(prefix + path, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    if (absent && response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`)
    return response.json()
  }
  async function tree(sha) {
    const result = await api(`/git/trees/${sha}?recursive=1`)
    if (result.truncated) throw new Error('GitHub tree was truncated')
    return result.tree
  }
  async function blob(sha) {
    const value = await api(`/git/blobs/${sha}`)
    if (value.encoding !== 'base64') throw new Error('Unsupported GitHub blob encoding')
    return Buffer.from(value.content, 'base64').toString('utf8')
  }
  async function readPages(sha, directory) {
    const result = {}
    for (const entry of await tree(sha)) {
      if (entry.path.startsWith(directory + '/') && entry.path.endsWith('.md') &&
          entry.path !== directory + '/README.md') {
        if (entry.type !== 'blob' || entry.mode !== '100644') throw new Error(`Unsafe page entry: ${entry.path}`)
        const name = entry.path.slice(directory.length + 1)
        if (!/^[A-Za-z0-9][A-Za-z0-9-]*\.md$/.test(name)) throw new Error(`Unsafe page filename: ${name}`)
        result[name] = await blob(entry.sha)
      }
    }
    return result
  }
  async function commitFiles(files, parent, message) {
    const base = parent ? (await api(`/git/commits/${parent}`)).tree.sha : undefined
    const created = await api('/git/trees', 'POST', {
      ...(base ? { base_tree: base } : {}),
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    })
    return (await api('/git/commits', 'POST', {
      message: `${message}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`,
      tree: created.sha, parents: parent ? [parent] : [],
    })).sha
  }
  async function source() {
    const sha = (await api('/git/ref/heads/main')).object.sha
    const entries = await tree(sha)
    const policyEntry = entries.find(e => e.path === POLICY_PATH)
    if (!policyEntry) throw new Error('Approved documentation policy is missing on main')
    const policy = await blob(policyEntry.sha)
    const issues = []
    for (let page = 1; ; page++) {
      const batch = await api(`/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`)
      issues.push(...batch.filter(i => !i.pull_request))
      if (batch.length < 100) break
    }
    const openIssues = issues.filter(issue => issue.state === 'open')
    const decisions = renderMarkdown(buildDecisions({ commit: sha, issues: openIssues }, findConflicts(openIssues)))
      .replace(/#(\d+)\b/g, (_match, number) => `[#${number}](https://github.com/${repo}/issues/${number})`)
    return { sha, policyHash: hash(policy), inputHash: inputHash(entries, issues, policy), decisions,
      pages: await readPages(sha, 'docs/spec') }
  }
  return {
    api,
    store: {
      async load() {
        const ref = await api(`/git/ref/heads/${STATE_BRANCH}`, 'GET', undefined, true)
        if (!ref) return { sha: null, state: initialState() }
        const entries = await tree(ref.object.sha)
        const stateFile = entries.find(e => e.path === 'state.json')
        if (!stateFile) throw new Error('Wiki state branch exists without state.json')
        const state = JSON.parse(await blob(stateFile.sha))
        checkState(state)
        return { sha: ref.object.sha, state }
      },
      pages: sha => readPages(sha, 'pages'),
      async save(state, pages, expectedSha) {
        checkState(state)
        const files = { 'state.json': JSON.stringify(state, null, 2) + '\n' }
        for (const [name, text] of Object.entries(pages ?? {})) files[`pages/${name}`] = text
        const sha = await commitFiles(files, expectedSha, `docs(review): revision ${state.revision} ${state.pending?.status ?? 'settled'}`)
        if (expectedSha) {
          await api(`/git/refs/heads/${STATE_BRANCH}`, 'PATCH', { sha, force: false })
        } else {
          await api('/git/refs', 'POST', { ref: `refs/heads/${STATE_BRANCH}`, sha })
        }
        return sha
      },
    },
    repository: {
      source,
      async accept(pending, pages) {
        if (!pending.approval || pagesHash(pages) !== pending.contentHash) {
          throw new Error('Approved snapshot required before accepting source')
        }
        const latest = await source()
        if (latest.policyHash !== pending.policyHash) throw new Error('Policy changed before source write')
        const current = pagesHash(latest.pages)
        if (current === pending.contentHash) return latest.sha
        if (current !== pending.baseContentHash) throw new Error('Source changed before acceptance')
        const files = Object.fromEntries(Object.entries(pages).map(([name, content]) => [`docs/spec/${name}`, content]))
        const sha = await commitFiles(files, latest.sha,
          `docs(spec): approved wiki revision ${pending.revision}\n\nSnapshot: ${pending.snapshotSha}\nDigest: ${pending.contentHash}\nApproval: ${pending.approval.commentId}`)
        await api('/git/refs/heads/main', 'PATCH', { sha, force: false })
        const readback = await readPages((await api('/git/ref/heads/main')).object.sha, 'docs/spec')
        if (pagesHash(readback) !== pending.contentHash) throw new Error('Accepted source readback does not match approval')
        return sha
      },
    },
  }
}
