import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyReview, serializeReview, submitDrafts } from '../../docs-core/src/index.js'
import { publish } from './publisher.js'

const repo = process.cwd()
const skill = path.join(repo, 'plugins', 'overnight-agent', 'skills', 'overnight-agent')
const publisher = path.join(repo, 'packages', 'docs-publisher', 'bin', 'fp-docs.js')
const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

const primaryDraft = '# Task 9450: Synthetic delivery\n\n**Status: Delivery is Friday.**\n\n## What this is, with no prior context\n\nA delivery plan.\n\n## Why it matters\n\nWe need a delivery date.\n\n## What changed / what was done\n\nThe delivery date is Friday.\n\n## Evidence\n\nSee [notes](https://example.com/notes).\n\n## Where it stands\n\nReview the date.\n'

async function fixture({ gate = true, words = 1500 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-node-loop-'))
  roots.push(root)
  const planner = path.join(root, 'planner')
  const home = path.join(root, 'oa')
  await fs.mkdir(path.join(planner, 'journal'), { recursive: true })
  await fs.mkdir(path.join(home, 'state'), { recursive: true })
  await fs.mkdir(path.join(root, 'copilot', 'session-state'), { recursive: true })
  await fs.writeFile(path.join(planner, 'journal', 'task-9450.md'), Array(words).fill('word').join(' '))
  await fs.writeFile(path.join(planner, 'planner.md'), '## Today\n\n| ID | 🎯 | Task | Priority | Added | Linked ID |\n|---|---|---|---|---|---|\n| 9450 | 🟡 | Delivery | P0 | 2026-10-12 | |\n')
  await fs.writeFile(path.join(planner, 'planner-completed.md'), '')
  const env = { ...process.env, OVERNIGHT_AGENT_HOME: home, WRITE_TURN_OA_HOME: home,
    OVERNIGHT_AGENT_PLANNER_DIR: planner, PLANNER_PATH: planner, FOCUS_PLANNER_REPO: repo,
    COPILOT_HOME: path.join(root, 'copilot'), COPILOT_AGENT_SESSION_ID: 'synthetic-task-session',
    USERPROFILE: root, LOCALAPPDATA: path.join(root, 'local'), OA_SANDBOX_ROOT: '',
  }
  if (gate) {
    await fs.mkdir(path.join(planner, 'docs'), { recursive: true })
    await fs.writeFile(path.join(planner, 'docs', 'index.json'), '{"version":1,"tasks":{},"docs":{}}')
  }
  const call = (file, args) => spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8', windowsHide: true })
  const state = (...args) => {
    const result = call(path.join(skill, 'oa-state.mjs'), args)
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  const row = () => state('scan').find((item) => item.id === '9450')
  const turn = async (line, ask = 'none') => {
    const body = path.join(root, 'turn.md')
    await fs.writeFile(body, `## 🌙 2026-10-12\n<!-- from: overnight-agent -->\n${line}\n`)
    return call(path.join(skill, 'write-turn.mjs'), ['-Id', '9450', '-BodyFile', body, '-Ask', ask, '-Json'])
  }
  return { root, planner, home, env, call, state, row, turn }
}

async function submit(planner, id, { commentId = 'c_delivery', quote = 'Delivery is Friday.', now = Date.now() } = {}) {
  const review = submitDrafts(emptyReview(), [{ id: commentId, anchor: { block: 'b1', quote, offset: 0 },
    intent: 'do-more', body: 'Change delivery to Monday.' }], { rev: 1, now }).review
  await fs.writeFile(path.join(planner, 'docs', id, 'review.json'), serializeReview(review))
  return { review, reviewId: Object.keys(review.reviews)[0] }
}

describe('native Docs Node loop', { timeout: 30000 }, () => {
  it('scans 464 journals with one publisher invocation and one registry read', async () => {
    const f = await fixture()
    await publish({ root: f.planner, task: 9450, draft: primaryDraft, summary: 'Initial' })
    await Promise.all(Array.from({ length: 463 }, (_, i) =>
      fs.writeFile(path.join(f.planner, 'journal', `task-${9451 + i}.md`), 'A short synthetic journal.\n')))
    const counter = path.join(f.root, 'counts.jsonl')
    const preload = path.join(f.root, 'count.mjs')
    await fs.writeFile(counter, '')
    await fs.writeFile(preload, `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const record = (type) => fs.appendFileSync(process.env.SCAN_COUNT_FILE, JSON.stringify({ type }) + '\\n');
const spawn = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (args?.some((arg) => /fp-docs\\.js$/.test(arg))) record('publisher');
  return spawn.call(this, command, args, options);
};
const read = fs.promises.readFile;
fs.promises.readFile = function(filename, ...rest) {
  if (String(filename).split(String.fromCharCode(92)).join('/').endsWith('/docs/index.json')) record('registry');
  return read.call(this, filename, ...rest);
};
syncBuiltinESMExports();
`)
    f.env.NODE_OPTIONS = `--import=${pathToFileURL(preload)}`
    f.env.SCAN_COUNT_FILE = counter
    const rows = f.state('scan')
    expect(rows).toHaveLength(464)
    expect(rows.find((item) => item.id === '9450')).toHaveProperty('docs_primary')
    expect(rows.every((item) => !item.docs_error)).toBe(true)
    const calls = (await fs.readFile(counter, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(calls.filter((item) => item.type === 'publisher')).toHaveLength(1)
    expect(calls.filter((item) => item.type === 'registry')).toHaveLength(1)
  })

  it('records inclusive threshold at turn end and wakes the next turn once', async () => {
    const f = await fixture({ words: 1499 })
    expect(f.row().docs_primary_due).toBe(false)
    f.state('mark', '-Id', '9450', '-Status', 'blocked')
    expect(f.row().docs_primary_due).toBe(false)
    await fs.appendFile(path.join(f.planner, 'journal', 'task-9450.md'), ' word')
    expect(f.row().docs_primary_due).toBe(false)
    f.state('mark', '-Id', '9450')
    expect(f.row()).toMatchObject({ docs_primary_due: true, eligible: true })
    const result = await publish({ root: f.planner, task: 9450, draft: primaryDraft, summary: 'Initial' })
    f.state('mark', '-Id', '9450')
    expect(f.row()).toMatchObject({ docs_primary: result.id, docs_primary_due: false })
  })

  it('does not add Docs behavior to a planner without the index gate', async () => {
    const f = await fixture({ gate: false })
    f.state('mark', '-Id', '9450', '-Status', 'blocked')
    expect(f.row()).not.toHaveProperty('docs_primary')
    expect(f.row()).not.toHaveProperty('docs_primary_due')
    const state = JSON.parse((await fs.readFile(path.join(f.home, 'state', 'task-9450.json'), 'utf8')).replace(/^\uFEFF/, ''))
    expect(state).not.toHaveProperty('docs_threshold_reached_at')
  })

  it('wakes parked primary and linked reviews, keeps acknowledged unfinished work, then goes quiet', async () => {
    const f = await fixture()
    const first = await publish({ root: f.planner, task: 9450, draft: primaryDraft.replace('Review the date.', 'Review the [date](doc:new:notes).'),
      summary: 'Initial', linked: [{ alias: 'notes', draft: '# Notes\n\nDelivery is Friday.\n' }] })
    f.state('mark', '-Id', '9450', '-Status', 'blocked')
    const batch = await submit(f.planner, first.linked[0].id)
    const wake = f.row()
    expect(wake).toMatchObject({ eligible: true, docs_review_signal: 'docs_review_submitted',
      docs_review_submitted: [{ doc: first.linked[0].id, review: batch.reviewId }] })
    let result = f.call(publisher, ['ack', '--task', '9450', '--doc', first.linked[0].id, '--review', batch.reviewId])
    expect(result.status, result.stderr).toBe(0)
    expect(f.row()).toMatchObject({ docs_work_pending: true, eligible: true, docs_review_submitted: [] })
    result = f.call(publisher, ['ack', '--task', '9450', '--doc', first.linked[0].id, '--review', batch.reviewId])
    expect(JSON.parse(result.stdout).acknowledged).toBe(false)
    await publish({ root: f.planner, task: 9450, draft: primaryDraft.replace('Review the date.', `Review the [date](doc:${first.linked[0].id}).`),
      summary: 'Monday delivery', baseRev: 1, linked: [{ id: first.linked[0].id, baseRev: 1, draft: '# Notes\n\nDelivery is Monday.\n' }],
      dispositions: [{ doc: first.linked[0].id, id: 'c_delivery', status: 'done', blocks: ['@1'] }] })
    f.state('mark', '-Id', '9450')
    expect(f.row()).toMatchObject({ docs_work_pending: false, eligible: false, docs_review_submitted: [] })
    expect(f.row().dispatch_input).not.toBe(wake.dispatch_input)
  })

  it('reports corrupt transport explicitly rather than quiet/empty, including compact scans', async () => {
    const f = await fixture()
    const first = await publish({ root: f.planner, task: 9450, draft: primaryDraft, summary: 'Initial' })
    await fs.writeFile(path.join(f.planner, 'docs', first.id, 'review.json'), '{')
    const row = f.state('scan', '-Compact').rows.find((item) => item.id === '9450')
    expect(row).toMatchObject({ eligible: false, plan_review_due: false })
    expect(row.docs_error).toMatch(/docs_review_read_failed.*not valid JSON/)
    expect(row).not.toHaveProperty('docs_review_submitted')
    const turn = await f.turn(`[Catch-up](doc:${first.id}). **Needs from you:** None.`)
    expect(turn.status).toBe(1)
    expect(turn.stderr).toMatch(/docs_read_failed/)
  })

  it('never lets Docs reviews bypass closed, snoozed, paused or session-ownership guards', async () => {
    const f = await fixture()
    const first = await publish({ root: f.planner, task: 9450, draft: primaryDraft, summary: 'Initial' })
    const batch = await submit(f.planner, first.id)
    const args = ['ack', '--task', '9450', '--review', batch.reviewId]
    f.state('mark', '-Id', '9450', '-Status', 'done', '-StatusBy', 'user')
    expect(f.row().eligible).toBe(false)
    expect(f.call(publisher, args).stderr).toMatch(/docs_task_closed/)
    f.state('mark', '-Id', '9450', '-Status', 'blocked', '-StatusBy', 'user')
    expect(f.row().eligible).toBe(false)
    expect(f.call(publisher, args).stderr).toMatch(/docs_task_paused/)
    f.state('mark', '-Id', '9450', '-Status', 'in-progress', '-StatusBy', 'user')
    await fs.writeFile(path.join(f.planner, 'snooze.json'), '{"9450":"2099-01-01"}')
    expect(f.row()).toMatchObject({ eligible: false, snoozed: true })
    expect(f.call(publisher, args).stderr).toMatch(/docs_task_snoozed/)
    await fs.writeFile(path.join(f.planner, 'snooze.json'), '{}')
    const stateFile = path.join(f.home, 'state', 'task-9450.json')
    const state = JSON.parse((await fs.readFile(stateFile, 'utf8')).replace(/^\uFEFF/, ''))
    state.session = { session_id: 'the-bound-owner', prior_session_ids: [] }
    await fs.writeFile(stateFile, JSON.stringify(state))
    expect(f.call(publisher, args).stderr).toMatch(/docs_task_owned/)
    const write = await f.turn(`[Catch-up](doc:${first.id}). **Needs from you:** None.`)
    expect(write.status).toBe(2)
  })

  it('requires a fresh publish and one-line pointer, and treats needs-you as blocking', async () => {
    const f = await fixture()
    const first = await publish({ root: f.planner, task: 9450, draft: primaryDraft, summary: 'Initial' })
    f.state('mark', '-Id', '9450')
    const stale = await f.turn(`[Catch-up](doc:${first.id}). **Needs from you:** None.`)
    expect(JSON.parse(stale.stdout).findings.some((item) => item.guard === 'G26' || item.code === 'G26')).toBe(true)
    const { reviewId } = await submit(f.planner, first.id)
    expect(f.call(publisher, ['ack', '--task', '9450', '--review', reviewId]).status).toBe(0)
    await publish({ root: f.planner, task: 9450, draft: primaryDraft.replace('Review the date.', 'Which delivery day do you want?'),
      summary: 'Ask delivery day', baseRev: 1, dispositions: [{ id: 'c_delivery', status: 'needs-you', blocks: ['@11'] }] })
    const wrongAsk = await f.turn(`[Catch-up](doc:${first.id}). **Needs from you:** None.`)
    expect(wrongAsk.status).toBe(2)
    const long = await f.turn(`[Catch-up](doc:${first.id}).\nFull status here.\n**Needs from you:** Delivery day.`, 'blocking')
    expect(long.status).toBe(2)
    const valid = await f.turn(`**Needs from you:** Which delivery day? See [catch-up](doc:${first.id}).`, 'blocking')
    expect(valid.status, valid.stderr || valid.stdout).toBe(0)
    f.state('mark', '-Id', '9450', '-Status', 'blocked')
    expect(f.row()).toMatchObject({ docs_needs_you: 1, eligible: false, docs_work_pending: false })
  })
})
