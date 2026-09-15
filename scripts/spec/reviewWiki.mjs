import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pagesHash } from './reviewPolicy.mjs'

export function mirrorPages(directory, pages) {
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.md') && !(name in pages)) {
      throw new Error(`Wiki has a page absent from the approved snapshot: ${name}; refusing deletion`)
    }
  }
  for (const [name, content] of Object.entries(pages)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\.md$/.test(name)) throw new Error(`Unsafe wiki filename: ${name}`)
    const path = join(directory, name)
    if (readdirSync(directory).includes(name) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing wiki symlink: ${name}`)
    }
    writeFileSync(path, content, 'utf8')
  }
}

export function createWikiPublisher({ repo, token, execFile = execFileSync }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid wiki repository')
  let directory
  let branch
  let root
  function git(args, cwd = directory) {
    if (!token) throw new Error('WIKI_TOKEN missing: publication blocked, not successful')
    try {
      return execFile('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` },
      }).trimEnd()
    } catch (error) {
      throw new Error(`Wiki git ${args[0]} failed (exit ${error.status ?? 'unknown'}); no publication receipt recorded`)
    }
  }
  return {
    async preflight() {
      if (directory) return
      root = mkdtempSync(join(tmpdir(), 'wiki-review-'))
      directory = join(root, 'wiki')
      git(['clone', '--quiet', `https://github.com/${repo}.wiki.git`, directory], root)
      branch = git(['symbolic-ref', '--short', 'HEAD'])
    },
    async publish(pages, pending) {
      mirrorPages(directory, pages)
      git(['add', '--', '*.md'])
      if (git(['diff', '--cached', '--name-only'])) {
        git(['-c', 'user.name=Wiki review publisher', '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
          'commit', '-m', `docs(spec): approved wiki revision ${pending.revision}\n\nSnapshot: ${pending.snapshotSha}\nDigest: ${pending.contentHash}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`])
        git(['push', 'origin', `HEAD:refs/heads/${branch}`])
      }
      return { sha: git(['rev-parse', 'HEAD']), branch }
    },
    async verify(pages, receipt) {
      git(['fetch', '--quiet', 'origin', branch])
      const remoteSha = git(['rev-parse', 'FETCH_HEAD'])
      if (receipt.sha !== remoteSha) throw new Error('Wiki changed before remote verification')
      const actual = {}
      const names = git(['ls-tree', '--name-only', remoteSha]).split('\n').filter(n => n.endsWith('.md'))
      for (const name of names) {
        // Unlike command output, page content must retain its trailing newline.
        const local = readFileSync(join(directory, name), 'utf8')
        const remoteBlob = git(['rev-parse', `${remoteSha}:${name}`])
        const localBlob = git(['hash-object', '--no-filters', join(directory, name)])
        if (remoteBlob !== localBlob) throw new Error(`Wiki remote bytes differ: ${name}`)
        actual[name] = local
      }
      if (pagesHash(actual) !== pagesHash(pages)) throw new Error('Wiki page set differs from approved snapshot')
    },
    cleanup() {
      if (root) rmSync(root, { recursive: true })
      root = undefined
      directory = undefined
    },
  }
}
