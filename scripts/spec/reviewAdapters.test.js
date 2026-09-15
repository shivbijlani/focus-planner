import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGitHubReview } from './reviewGitHub.mjs'
import { createWikiPublisher, mirrorPages } from './reviewWiki.mjs'
import { initialState, hash, pagesHash } from './reviewPolicy.mjs'

const ROOT = 'https://api.github.com/repos/owner/repo'
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
})
const blob = content => ({ encoding: 'base64', content: Buffer.from(content).toString('base64') })
function github(routes) {
  const calls = []
  const fetchImpl = vi.fn(async (url, options) => {
    const route = `${options.method} ${url.slice(ROOT.length)}`
    calls.push({ route, body: options.body && JSON.parse(options.body), options })
    if (!(route in routes)) throw new Error(`Unexpected route ${route}`)
    const value = routes[route]
    return typeof value === 'function' ? value(calls.at(-1)) : response(value)
  })
  return { ...createGitHubReview({ repo: 'owner/repo', token: 'test-token', fetchImpl }), calls }
}
function sourceRoutes() {
  return {
    'GET /git/ref/heads/main': { object: { sha: 'main-sha' } },
    'GET /git/trees/main-sha?recursive=1': { tree: [
      { path: 'docs/wiki-maintenance-policy.md', type: 'blob', mode: '100644', sha: 'policy' },
      { path: 'docs/spec/Home.md', type: 'blob', mode: '100644', sha: 'home' },
      { path: 'docs/spec/README.md', type: 'blob', mode: '100644', sha: 'readme' },
    ] },
    'GET /git/blobs/policy': blob('Approved policy'),
    'GET /git/blobs/home': blob('# Current\n'),
    'GET /issues?state=all&sort=updated&direction=desc&per_page=100&page=1': [],
  }
}
describe('GitHub durable store and source acceptance', () => {
  it('initializes only a genuinely absent state branch', async () => {
    const h = github({ 'GET /git/ref/heads/spec/review-state': () => response({}, 404) })
    expect(await h.store.load()).toEqual({ sha: null, state: initialState() })
  })
  it('does not treat an authorization failure as an empty daily gate', async () => {
    const h = github({ 'GET /git/ref/heads/spec/review-state': () => response({}, 403) })
    await expect(h.store.load()).rejects.toThrow('HTTP 403')
  })
  it.each([
    { tree: [], truncated: true },
    { tree: [] },
    { tree: [{ path: 'state.json', sha: 'state' }] },
  ])('fails closed on corrupt or incomplete state %j', async value => {
    const h = github({
      'GET /git/ref/heads/spec/review-state': { object: { sha: 'state-sha' } },
      'GET /git/trees/state-sha?recursive=1': value,
      'GET /git/blobs/state': blob('{"schema":2}'),
    })
    await expect(h.store.load()).rejects.toThrow()
  })
  it('writes immutable page content using a non-force optimistic ref update', async () => {
    const h = github({
      'GET /git/commits/old': { tree: { sha: 'base-tree' } },
      'POST /git/trees': { sha: 'new-tree' },
      'POST /git/commits': { sha: 'new-commit' },
      'PATCH /git/refs/heads/spec/review-state': { object: { sha: 'new-commit' } },
    })
    expect(await h.store.save(initialState(), { 'Home.md': '# Page\n' }, 'old')).toBe('new-commit')
    expect(h.calls.find(c => c.route === 'POST /git/trees').body).toEqual({
      base_tree: 'base-tree',
      tree: [
        { path: 'state.json', mode: '100644', type: 'blob', content: JSON.stringify(initialState(), null, 2) + '\n' },
        { path: 'pages/Home.md', mode: '100644', type: 'blob', content: '# Page\n' },
      ],
    })
    expect(h.calls.at(-1).body).toEqual({ sha: 'new-commit', force: false })
  })
  it('surfaces a competing writer rather than forcing over it', async () => {
    const h = github({
      'GET /git/commits/old': { tree: { sha: 'base-tree' } },
      'POST /git/trees': { sha: 'new-tree' },
      'POST /git/commits': { sha: 'new-commit' },
      'PATCH /git/refs/heads/spec/review-state': () => response({}, 422),
    })
    await expect(h.store.save(initialState(), {}, 'old')).rejects.toThrow('HTTP 422')
    expect(h.calls.filter(c => c.route.startsWith('PATCH'))).toHaveLength(1)
  })
  it('collects all issue pages and excludes README from published content', async () => {
    const routes = sourceRoutes()
    routes['GET /issues?state=all&sort=updated&direction=desc&per_page=100&page=1'] =
      Array.from({ length: 100 }, (_, number) => ({ number, state: 'open', updated_at: 'yesterday' }))
    routes['GET /issues?state=all&sort=updated&direction=desc&per_page=100&page=2'] =
      [{ number: 101, state: 'open', updated_at: 'today' }]
    const h = github(routes)
    const first = await h.repository.source()
    expect(first.pages).toEqual({ 'Home.md': '# Current\n' })
    routes['GET /issues?state=all&sort=updated&direction=desc&per_page=100&page=2'][0].updated_at = 'tomorrow'
    expect((await h.repository.source()).inputHash).not.toBe(first.inputHash)
  })
  it('refuses symlink and nested source pages', async () => {
    for (const entry of [
      { path: 'docs/spec/Home.md', type: 'blob', mode: '120000', sha: 'home' },
      { path: 'docs/spec/nested/Home.md', type: 'blob', mode: '100644', sha: 'home' },
    ]) {
      const routes = sourceRoutes()
      routes['GET /git/trees/main-sha?recursive=1'].tree[1] = entry
      await expect(github(routes).repository.source()).rejects.toThrow('Unsafe page')
    }
  })
  it('cannot write source without exact approved content', async () => {
    const h = github({})
    await expect(h.repository.accept({ contentHash: pagesHash({}) }, {})).rejects.toThrow('Approved snapshot')
    expect(h.calls).toHaveLength(0)
  })
  it('accepts an already written snapshot idempotently without making another commit', async () => {
    const h = github(sourceRoutes())
    const pages = { 'Home.md': '# Current\n' }
    expect(await h.repository.accept({
      approval: { commentId: 'approval' }, policyHash: hash('Approved policy'), contentHash: pagesHash(pages),
    }, pages)).toBe('main-sha')
    expect(h.calls.every(c => c.route.startsWith('GET'))).toBe(true)
  })
  it('honors branch protection failures', async () => {
    const routes = sourceRoutes()
    Object.assign(routes, {
      'GET /git/commits/main-sha': { tree: { sha: 'base-tree' } },
      'POST /git/trees': { sha: 'new-tree' },
      'POST /git/commits': { sha: 'accepted' },
      'PATCH /git/refs/heads/main': () => response({}, 422),
    })
    const h = github(routes)
    const pages = { 'Home.md': '# Approved\n' }
    await expect(h.repository.accept({
      approval: { commentId: 'approval' }, revision: 1, snapshotSha: 'snapshot',
      policyHash: hash('Approved policy'), contentHash: pagesHash(pages),
      baseContentHash: pagesHash({ 'Home.md': '# Current\n' }),
    }, pages)).rejects.toThrow('HTTP 422')
    expect(h.calls.at(-1).body.force).toBe(false)
  })
})

const directories = []
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-test-'))
  directories.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true })
})
describe('wiki exact-byte mirroring', () => {
  it('publishes to a real local git remote, verifies bytes, and retries without a new commit', async () => {
    const dir = temporary()
    const remote = join(dir, 'remote.git')
    const seed = join(dir, 'seed')
    const git = (args, cwd = dir) => execFileSync('git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git(['init', '--bare', '--initial-branch=main', remote])
    git(['clone', remote, seed])
    writeFileSync(join(seed, 'Home.md'), '# Before\n')
    git(['add', 'Home.md'], seed)
    git(['commit', '-m', 'seed'], seed)
    git(['push', 'origin', 'main'], seed)
    const publisher = createWikiPublisher({
      repo: 'owner/repo', token: 'fake-token',
      execFile: (command, args, options) => execFileSync(command,
        args.map(a => a === 'https://github.com/owner/repo.wiki.git' ? remote : a), options),
    })
    const pages = { 'Home.md': '# Approved \u2014 exact\r\n\r\nNew text.\n' }
    const pending = { revision: 1, snapshotSha: 'snapshot', contentHash: pagesHash(pages) }
    try {
      await publisher.preflight()
      const first = await publisher.publish(pages, pending)
      await publisher.verify(pages, first)
      expect((await publisher.publish(pages, pending)).sha).toBe(first.sha)
      const bytes = execFileSync('git', ['--git-dir', remote, 'show', `${first.sha}:Home.md`])
      expect(bytes).toEqual(Buffer.from(pages['Home.md'], 'utf8'))
      git(['pull', '--ff-only'], seed)
      writeFileSync(join(seed, 'Home.md'), '# Concurrent edit\n')
      git(['commit', '-am', 'concurrent'], seed)
      git(['push', 'origin', 'main'], seed)
      await expect(publisher.verify(pages, first)).rejects.toThrow('changed before remote verification')
    } finally {
      publisher.cleanup()
    }
  }, 30_000)
  it('preserves Unicode, line endings and final newline bytes', () => {
    const dir = temporary()
    const page = '# Your planner \u2014 readable\r\n\r\nExact text.\n'
    mirrorPages(dir, { 'Home.md': page })
    expect(readFileSync(join(dir, 'Home.md'))).toEqual(Buffer.from(page, 'utf8'))
  })
  it('refuses deleting existing wiki topics', () => {
    const dir = temporary()
    writeFileSync(join(dir, 'Keep.md'), 'Keep this')
    expect(() => mirrorPages(dir, { 'Home.md': 'New' })).toThrow('refusing deletion')
    expect(readFileSync(join(dir, 'Keep.md'), 'utf8')).toBe('Keep this')
  })
  it.each(['../Outside.md', 'nested/Page.md', '_Sidebar.md', 'C:\\outside.md'])('refuses unsafe name %s', name => {
    expect(() => mirrorPages(temporary(), { [name]: 'bad' })).toThrow('Unsafe wiki filename')
  })
  it('refuses a symlink target without modifying its destination', () => {
    const dir = temporary()
    const target = join(dir, 'destination')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'untouched')
    symlinkSync(target, join(dir, 'Home.md'), 'junction')
    expect(() => mirrorPages(dir, { 'Home.md': 'bad' })).toThrow('symlink')
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('untouched')
  })
  it('missing credentials are a visible failure', async () => {
    const publisher = createWikiPublisher({ repo: 'owner/repo' })
    try {
      await expect(publisher.preflight()).rejects.toThrow('WIKI_TOKEN missing')
    } finally {
      publisher.cleanup()
    }
  })
})
