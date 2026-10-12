import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { publish } from '../../packages/docs-publisher/src/index.js'

const repo = process.cwd()
export const DELIVERY_DRAFT = '# Task 9450: Synthetic delivery\n\n**Status: Delivery is Friday.**\n\n## What this is, with no prior context\n\nA synthetic delivery plan, not a real purchase or appointment.\n\n## Why it matters\n\nThe reader needs a delivery date.\n\n## What changed / what was done\n\nThe delivery date is Friday.\n\n## Evidence\n\nSee the [supporting notes](doc:new:notes).\n\n## Where it stands\n\nReview the delivery date.\n'
export const DENY_TOOLS = [
  'shell(git push)', 'shell(gh)', 'shell(curl)', 'shell(Invoke-WebRequest)', 'shell(Invoke-RestMethod)',
  'web_fetch', 'web_search', 'task', 'create_session', 'send_session_message',
]

export async function createAgentFixture() {
  const parent = process.env.DOCS_ACCEPTANCE_ROOT || path.join(os.tmpdir(), 'docs-acceptance')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, 'cycle-'))
  const source = path.join(root, 'repo')
  await fs.cp(repo, source, { recursive: true, filter: (filename) => {
    const relative = path.relative(repo, filename)
    return !relative.split(path.sep).some((part) => ['.git', 'node_modules', 'dist', 'test-results', 'playwright-report'].includes(part))
      && !relative.startsWith(path.join('plugins', 'overnight-agent', 'tests'))
      && !/\.(?:test|spec)\.[cm]?jsx?$/.test(filename)
      && !relative.startsWith('e2e')
  } })
  const home = path.join(root, 'home')
  const planner = path.join(home, 'OneDrive', 'Apps', 'Focus Planner')
  const oa = path.join(home, 'AppData', 'Local', 'overnight-agent')
  const copilotHome = path.join(home, '.copilot')
  for (const folder of [path.join(planner, 'journal'), path.join(oa, 'state'), path.join(oa, 'task-chats'),
    copilotHome, path.join(root, 'tmp'), path.join(home, 'AppData', 'Roaming')]) {
    await fs.mkdir(folder, { recursive: true })
  }
  const identityPath = path.join(os.homedir(), '.copilot', 'config.json').replace(/'/g, "''")
  const identityResult = spawnSync('pwsh', ['-NoProfile', '-Command',
    `$config = Get-Content -LiteralPath '${identityPath}' -Raw | ConvertFrom-Json; @{ lastLoggedInUser = $config.lastLoggedInUser; loggedInUsers = $config.loggedInUsers } | ConvertTo-Json -Depth 20 -Compress`],
  { encoding: 'utf8', windowsHide: true })
  if (identityResult.status !== 0) throw new Error(`Cannot read Copilot login identity: ${identityResult.stderr}`)
  const identity = JSON.parse(identityResult.stdout)
  const config = Object.fromEntries(['lastLoggedInUser', 'loggedInUsers'].filter((key) => key in identity).map((key) => [key, identity[key]]))
  await fs.writeFile(path.join(copilotHome, 'config.json'), JSON.stringify(config))
  await fs.writeFile(path.join(copilotHome, 'mcp-config.json'), '{"mcpServers":{}}')
  const plan = '## Today\n\n| ID | 🎯 | Task | Priority | Added | Linked ID |\n|---|---|---|---|---|---|\n| 9450 | 🟡 | Synthetic delivery | P0 | 2026-10-12 | |\n\n## Deferred\n\n| ID | 🎯 | Task | Priority | Added | Wake | Linked ID |\n|---|---|---|---|---|---|---|\n'
  await fs.writeFile(path.join(planner, 'planner.md'), plan)
  await fs.writeFile(path.join(planner, 'planner-completed.md'), '')
  await fs.writeFile(path.join(planner, 'agent-gate.md'), '# Agent gate\n\n## Do not gate\n\n- Reversible local document edits.\n\n## Always ask\n\n- Spend money or delete data.\n')
  await fs.writeFile(path.join(planner, 'user-settings.md'), '# Settings\n\n| Setting | Value |\n|---|---|\n| Catch-up doc threshold | 1500 |\n| Agent inbox | off |\n| Telegram | off |\n')
  await fs.writeFile(path.join(planner, 'journal', 'task-9450.md'), '# Task 9450: Synthetic delivery\n\nThe native catch-up and supporting notes describe a synthetic parcel. Wait for the next submitted document review; do not purchase or schedule anything.\n')
  await fs.writeFile(path.join(planner, 'journal', 'task-9450-briefing.md'), '# Synthetic Markdown briefing\n\nKeep this independent file unchanged.\n')
  const first = await publish({ root: planner, task: 9450, draft: DELIVERY_DRAFT, force: true, summary: 'Synthetic initial document',
    linked: [{ alias: 'notes', draft: '# Supporting delivery notes\n\nThe parcel weighs 2 kg.\n' }] })
  const sessionId = randomUUID()
  const env = { ...process.env,
    OA_SANDBOX_ROOT: root, OVERNIGHT_AGENT_HOME: oa, WRITE_TURN_OA_HOME: oa,
    OVERNIGHT_AGENT_PLANNER_DIR: planner, OVERNIGHT_AGENT_SETTINGS: path.join(planner, 'user-settings.md'),
    COPILOT_HOME: copilotHome, COPILOT_AGENT_SESSION_ID: sessionId, FOCUS_PLANNER_REPO: source,
    PLANNER_PATH: planner, USERPROFILE: home, HOME: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'),
    OneDrive: path.join(home, 'OneDrive'), OneDriveConsumer: path.join(home, 'OneDrive'), OneDriveCommercial: path.join(home, 'OneDrive'),
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), GH_HOST: 'oa-sandbox.invalid',
    GH_CONFIG_DIR: path.join(root, 'gh-config'), COPILOT_GH_HOST: 'github.com',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gh-config', 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', OA_RUN_TRIGGER: 'sandbox',
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'TELEGRAM_BOT_TOKEN']) delete env[key]
  const skill = path.join(source, 'plugins', 'overnight-agent', 'skills', 'overnight-agent')
  const invokeState = (...args) => {
    const result = spawnSync(process.execPath, [path.join(skill, 'oa-state.mjs'), ...args], { env, cwd: root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(result.stderr)
    return JSON.parse(result.stdout)
  }
  invokeState('mark', '-Id', '9450', '-Status', 'blocked')
  const statePath = path.join(oa, 'state', 'task-9450.json')
  const state = JSON.parse((await fs.readFile(statePath, 'utf8')).replace(/^\uFEFF/, ''))
  // This is a synthetic session binding, not consent or a dispatch stamp.
  state.session = { session_id: sessionId, kind: 'chat', project: randomUUID(), workspace: path.join(oa, 'task-chats'),
    workspace_type: 'folder', created_at: new Date().toISOString(), last_woken_at: '', state: 'live',
    prior_session_ids: [], prior_session_id: '', replaced_at: '' }
  await fs.writeFile(statePath, JSON.stringify(state))
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  const diff = spawnSync('git', ['diff', 'HEAD'], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).stdout
  const manifest = { buildSha: sha, diffSha256: createHash('sha256').update(diff).digest('hex'), fixtureRoot: root,
    planner, source, sessionId, model: 'claude-sonnet-5', primary: first.id, supporting: first.linked[0].id,
    transport: 'Browser IndexedDB provider; harness mirrors submitted review and published files between its store and the isolated local planner.' }
  await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify(manifest, null, 2))
  return { ...manifest, root, env, invokeState, skill, copilotHome }
}

export async function fixtureFiles(fixture) {
  const files = {}
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(filename)
      else if (!entry.name.startsWith('.')) files[path.relative(fixture.planner, filename).replace(/\\/g, '/')] = await fs.readFile(filename, 'utf8')
    }
  }
  await walk(fixture.planner)
  return files
}

export async function runReviewAgent(fixture, cycle) {
  const artifact = path.join(fixture.root, `cycle-${cycle}`)
  await fs.mkdir(artifact, { recursive: true })
  const scan = fixture.invokeState('scan', '-Compact')
  await fs.writeFile(path.join(artifact, 'scan-before.json'), JSON.stringify(scan, null, 2))
  const row = scan.rows.find((item) => item.id === '9450')
  if (!row?.eligible || !row.docs_review_submitted?.length) throw new Error('No eligible submitted review to invoke')
  const prompt = `You are the task session for planner task #9450. Do this task only. Do not run /overnight-agent or coordinate other sessions.
Read ${path.join(fixture.source, 'plugins', 'overnight-agent', 'skills', 'docs-publish', 'SKILL.md')} and follow the native Docs turn procedure.
Consume the submitted user review on this synthetic task from the configured planner, do the requested reversible document work, acknowledge the batch, publish the revision with dispositions, append its short journal pointer, and mark blocked when this review's work is finished (waiting for the next review, not a task closure).
This is an isolated sandbox. All data and tools are inside ${fixture.root}; no external work or live automation is authorized. Do not run tests or inspect test files.
Preserve the original comments, unrelated document text, supporting links, and the separate Markdown briefing. Do not directly write published Docs files or reviews; use fp-docs from ${path.join(fixture.source, 'packages', 'docs-publisher', 'bin', 'fp-docs.js')}.
Submitted batches from scan: ${JSON.stringify(row.docs_review_submitted)}.
Use node ${path.join(fixture.skill, 'write-turn.mjs')} and node ${path.join(fixture.skill, 'oa-state.mjs')} to finish the turn.`
  await fs.writeFile(path.join(artifact, 'prompt.txt'), prompt)
  const args = ['-C', fixture.root, '--plugin-dir', path.join(fixture.source, 'plugins', 'overnight-agent'),
    '-p', prompt, '--model', fixture.model, '--session-id', fixture.sessionId, '--allow-all-tools', '--no-ask-user',
    '--disable-builtin-mcps', '--no-custom-instructions', '--no-auto-update', '--no-remote',
    '--max-ai-credits', '200', '--output-format', 'json', '--share', path.join(artifact, 'transcript.md'),
    '--log-dir', path.join(artifact, 'logs'), '--usage-output-file', path.join(artifact, 'usage.json')]
  for (const tool of DENY_TOOLS) args.push('--deny-tool', tool)
  let stdout = '', stderr = ''
  const child = spawn('copilot', args, { cwd: fixture.root, env: fixture.env, windowsHide: true })
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill(), 8 * 60 * 1000)
  let code
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  } finally { clearTimeout(timer) }
  await fs.writeFile(path.join(artifact, 'stdout.jsonl'), stdout)
  await fs.writeFile(path.join(artifact, 'stderr.log'), stderr)
  const events = path.join(fixture.copilotHome, 'session-state', fixture.sessionId, 'events.jsonl')
  await fs.copyFile(events, path.join(artifact, 'events.jsonl'))
  const analyze = path.join(repo, 'plugins', 'overnight-agent', 'tests', 'e2e', 'lib', 'analyze-events.mjs')
  const argv = [analyze, '--events', events, '--sandbox', fixture.root, '--skill', fixture.skill,
    '--live', repo, '--out', path.join(artifact, 'analysis.json')]
  for (const tool of DENY_TOOLS) argv.push('--deny', tool)
  const analyzed = spawnSync(process.execPath, argv, { encoding: 'utf8' })
  if (analyzed.status !== 0) throw new Error(analyzed.stderr)
  if (code !== 0) throw new Error(`Real agent exited ${code}: ${stderr}; evidence ${artifact}`)
  return { artifact, analysis: JSON.parse(await fs.readFile(path.join(artifact, 'analysis.json'), 'utf8')) }
}
