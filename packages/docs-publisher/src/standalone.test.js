import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { acquireLock, releaseLock } from './lock.js'
import { publish, acknowledgeReview } from './publisher.js'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-package-isolation-'))
  roots.push(root)
  return root
}

it('packs and installs with only declared docs-core dependency, without the plugin tree', async () => {
  const root = await temporaryRoot()
  const npm = process.env.npm_execpath
  expect(npm, 'Run this suite through npm test so npm_execpath identifies the installer').toBeTruthy()
  for (const name of ['docs-core', 'docs-publisher']) {
    const packed = spawnSync(process.execPath, [npm, 'pack', '--quiet', '--pack-destination', root], {
      cwd: path.resolve('packages', name), encoding: 'utf8', timeout: 60_000,
    })
    expect(packed.status, packed.stderr).toBe(0)
  }
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true, type: 'module',
    dependencies: {
      '@focus/docs-core': 'file:focus-docs-core-0.0.0.tgz',
      '@focus/docs-publisher': 'file:focus-docs-publisher-0.0.0.tgz',
    },
  }))
  const installed = spawnSync(process.execPath, [npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
  })
  expect(installed.status, installed.stderr).toBe(0)
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {publish} from '@focus/docs-publisher'; import {main} from '@focus/docs-publisher/cli'; console.log(typeof publish, typeof main)"], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  })
  expect(imported.status, imported.stderr).toBe(0)
  expect(imported.stdout.trim()).toBe('function function')
  const cli = path.join(root, 'node_modules', '@focus', 'docs-publisher', 'bin', 'fp-docs.js')
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' })
  expect(help.status, help.stderr).toBe(0)
  const refused = spawnSync(process.execPath, [cli, 'publish', '--task', '845', '--draft', 'draft.md', '--summary', 'Fixture'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PLANNER_PATH: root, FP_DOCS_GUARD_MODULE: '' },
  })
  expect(refused.status).toBe(1)
  expect(refused.stderr).toContain('requires assertPath and assertWritable guards')
  await expect(fs.access(path.join(root, '.fp-docs.lock'))).rejects.toThrow()
  const guard = path.join(root, 'guard.mjs')
  await fs.writeFile(guard, "export function assertPath() { throw new Error('isolated deployment path refused') }\nexport function assertWritable() { throw new Error('isolated deployment write refused') }\n")
  const guarded = spawnSync(process.execPath, [cli, 'status', '--task', '845', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PLANNER_PATH: root, FP_DOCS_GUARD_MODULE: guard },
  })
  expect(guarded.status).toBe(1)
  expect(guarded.stderr).toContain('isolated deployment path refused')
  await expect(fs.access(path.join(root, 'plugins'))).rejects.toThrow()
}, 180_000)

it.each([publish, acknowledgeReview])('awaits write-guard refusal inside the lock before touching any Docs files (%s)', async (operation) => {
  const root = await temporaryRoot()
  const before = await fs.readdir(root)
  let guarded = false
  await expect(operation({
    root, task: 845,
    assertWritable: async (context) => {
      expect(context).toEqual({ root, task: 845 })
      expect(await fs.readFile(path.join(root, '.fp-docs.lock'), 'utf8')).toBe(String(process.pid))
      await new Promise((resolve) => setTimeout(resolve, 5))
      guarded = true
      throw new Error('Deployment write refused')
    },
  })).rejects.toThrow('Deployment write refused')
  expect(guarded).toBe(true)
  expect(await fs.readdir(root)).toEqual(before)
})

it('never reclaims a live publisher lock', async () => {
  const root = await temporaryRoot()
  const lockPath = path.join(root, '.fp-docs.lock')
  const lock = acquireLock(lockPath, 1000, { reclaimDeadHolder: true })
  try {
    expect(() => acquireLock(lockPath, 1000, { reclaimDeadHolder: true, timeoutMessage: 'busy publisher' }))
      .toThrow('busy publisher')
    expect(await fs.readFile(lockPath, 'utf8')).toBe(String(process.pid))
  } finally { releaseLock(lock) }
})

it('consumer launcher refuses sandbox escapes without publisher writes', async () => {
  const root = await temporaryRoot()
  const outside = await temporaryRoot()
  const launcher = path.resolve('scripts', 'fp-docs.js')
  const result = spawnSync(process.execPath, [launcher, 'publish', '--task', '845', '--draft', 'missing.md', '--summary', 'Fixture'], {
    encoding: 'utf8', env: { ...process.env, PLANNER_PATH: outside, OA_SANDBOX_ROOT: root },
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/sandbox/i)
  expect(await fs.readdir(outside)).toEqual([])
})
