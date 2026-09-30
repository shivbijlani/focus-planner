// @vitest-environment node
// Characterization test for the local Express API (server.js): runs the real
// server as a child process against a temp planner folder and a temp config.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

let child
let base
let tmp
let plannerDir

async function api(method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json() }
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'planner-server-test-'))
  plannerDir = path.join(tmp, 'planner')
  await mkdir(path.join(plannerDir, 'journal'), { recursive: true })
  await writeFile(path.join(plannerDir, 'planner.md'), '## Today\n')
  await writeFile(path.join(plannerDir, 'notes.txt'), 'not markdown')
  await writeFile(path.join(plannerDir, 'journal', 'task-1.md'),
    '# Task 1: T\n\n- [ ] open box\n- [x] done box\n- TODO: todo item\n- DONE: done item\nplain line\n')
  await writeFile(path.join(plannerDir, 'journal', 'task-2.md'), '')
  const configPath = path.join(tmp, 'planner-config.json')
  await writeFile(configPath, JSON.stringify({ plannerPath: plannerDir }))

  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PLANNER_API_PORT: String(port), PLANNER_CONFIG_PATH: configPath },
    stdio: 'ignore',
  })

  // Ready once it answers and has loaded the temp config.
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const { json } = await api('GET', '/api/config')
      if (json.plannerPath === plannerDir) break
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('server.js did not start')
    await new Promise(r => setTimeout(r, 100))
  }
}, 15_000)

afterAll(async () => {
  child?.kill()
  if (tmp) await rm(tmp, { recursive: true, force: true })
})

describe('server.js API', () => {
  it('GET /api/files lists markdown files and folders only', async () => {
    const { status, json } = await api('GET', '/api/files')
    expect(status).toBe(200)
    const norm = (p) => p.replace(/\\/g, '/')
    const names = json.map(i => i.name).sort()
    expect(names).toEqual(['journal', 'planner.md'])
    const journal = json.find(i => i.name === 'journal')
    expect(journal.type).toBe('directory')
    expect(journal.children.map(c => norm(c.path)).sort()).toEqual(['journal/task-1.md', 'journal/task-2.md'])
  })

  it('GET /api/file reads a file, 404s when missing, 400s without a path', async () => {
    expect(await api('GET', '/api/file?path=planner.md')).toEqual({
      status: 200, json: { path: 'planner.md', content: '## Today\n' },
    })
    expect((await api('GET', '/api/file?path=nope.md')).status).toBe(404)
    expect((await api('GET', '/api/file')).status).toBe(400)
  })

  it('PUT /api/file writes to disk and round-trips through GET', async () => {
    const put = await api('PUT', '/api/file?path=planner.md', { content: '## Today\n\n| 1 |\n' })
    expect(put).toEqual({ status: 200, json: { success: true, path: 'planner.md' } })
    expect(await readFile(path.join(plannerDir, 'planner.md'), 'utf-8')).toBe('## Today\n\n| 1 |\n')
    expect((await api('GET', '/api/file?path=planner.md')).json.content).toBe('## Today\n\n| 1 |\n')
    expect((await api('PUT', '/api/file', { content: 'x' })).status).toBe(400)
  })

  it('refuses paths that escape the planner folder', async () => {
    expect((await api('GET', '/api/file?path=../outside.md')).status).toBe(403)
    expect((await api('PUT', '/api/file?path=../escape.md', { content: 'x' })).status).toBe(403)
    await expect(access(path.join(tmp, 'escape.md'))).rejects.toThrow()
  })

  // Broken on main: the guard is a raw string startsWith, so a sibling whose
  // name begins with the planner folder's name is reachable. Refs #790.
  it.skip('refuses sibling paths that share the planner folder prefix (#790)', async () => {
    expect((await api('GET', '/api/file?path=../planner-config.json')).status).toBe(403)
  })

  it('DELETE /api/file removes a file', async () => {
    await writeFile(path.join(plannerDir, 'scratch.md'), 'bye')
    expect((await api('DELETE', '/api/file?path=scratch.md')).json).toEqual({ success: true, path: 'scratch.md' })
    await expect(access(path.join(plannerDir, 'scratch.md'))).rejects.toThrow()
  })

  it('GET /api/todos extracts checkbox and TODO/DONE items', async () => {
    const { status, json } = await api('GET', '/api/todos?path=journal/task-1.md')
    expect(status).toBe(200)
    expect(json.todos).toEqual([
      { done: false, text: 'open box' },
      { done: true, text: 'done box' },
      { done: false, text: 'todo item' },
      { done: true, text: 'done item' },
    ])
    expect(await api('GET', '/api/todos?path=journal/missing.md')).toEqual({
      status: 404, json: { error: 'File not found', todos: [] },
    })
  })

  it('GET /api/journal-exists reports non-empty journals only', async () => {
    expect((await api('GET', '/api/journal-exists?taskId=1')).json).toEqual({ exists: true, path: 'journal/task-1.md' })
    expect((await api('GET', '/api/journal-exists?taskId=2')).json).toEqual({ exists: false })
    expect((await api('GET', '/api/journal-exists?taskId=99')).json).toEqual({ exists: false })
    expect((await api('GET', '/api/journal-exists')).status).toBe(400)
  })
})
