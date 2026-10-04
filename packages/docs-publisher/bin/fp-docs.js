#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DocsPublisherError, lintDraft, publish, readStatus } from '../src/index.js'

const USAGE = `fp-docs — publish and inspect Focus Planner Docs

Usage:
  fp-docs publish --task N --draft FILE --summary TEXT [--base-rev R] [--force] [--adopt-external-edit] [--check-links]
  fp-docs lint --draft FILE [--check-links]
  fp-docs status --task N [--json]
`

function argumentsOf(argv) {
  const positional = []
  const flags = new Map()
  const takesValue = new Set(['--task', '--draft', '--summary', '--base-rev'])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') return { help: true }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    if (!['--task', '--draft', '--summary', '--base-rev', '--force', '--adopt-external-edit', '--check-links', '--json'].includes(arg)) {
      throw new DocsPublisherError('D09 data', `unknown option ${arg}`, 'run fp-docs --help for supported options')
    }
    if (flags.has(arg)) throw new DocsPublisherError('D09 data', `option ${arg} was supplied more than once`)
    if (takesValue.has(arg)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new DocsPublisherError('D09 data', `${arg} requires a value`)
      flags.set(arg, value)
    } else flags.set(arg, true)
  }
  return { positional, flags }
}

function need(flags, name) {
  const value = flags.get(name)
  if (value == null) throw new DocsPublisherError('D09 data', `${name} is required`)
  return value
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new DocsPublisherError('D09 data', `${label} must be a canonical positive integer`)
  }
  return Number(value)
}

async function main(argv = process.argv.slice(2)) {
  const { positional = [], flags = new Map(), help } = argumentsOf(argv)
  if (help) {
    console.log(USAGE.trim())
    return 0
  }
  const command = positional[0]
  if (!['publish', 'lint', 'status'].includes(command) || positional.length !== 1) {
    throw new DocsPublisherError('D09 data', `unknown command or unexpected argument: ${positional.join(' ') || '(none)'}`, 'run fp-docs --help')
  }
  const options = {
    publish: new Set(['--task', '--draft', '--summary', '--base-rev', '--force', '--adopt-external-edit', '--check-links']),
    lint: new Set(['--draft', '--check-links']),
    status: new Set(['--task', '--json']),
  }[command]
  for (const option of flags.keys()) {
    if (!options.has(option)) throw new DocsPublisherError('D09 data', `${option} is not supported by ${command}`)
  }
  const root = process.env.PLANNER_PATH
  if (!root) throw new DocsPublisherError('D09 data', 'PLANNER_PATH is not set', 'set it to the planner data folder')
  if (command === 'lint') {
    const draftPath = path.resolve(need(flags, '--draft'))
    const result = await lintDraft({
      draft: await fs.readFile(draftPath),
      root,
      checkLinks: flags.has('--check-links'),
    })
    console.log(`Valid draft: ${result.title}`)
    return 0
  }
  if (command === 'publish') {
    const task = positiveInteger(need(flags, '--task'), '--task')
    const draftPath = path.resolve(need(flags, '--draft'))
    const baseRev = flags.get('--base-rev') == null ? null : positiveInteger(flags.get('--base-rev'), '--base-rev')
    const result = await publish({
      root,
      task,
      draft: await fs.readFile(draftPath),
      summary: need(flags, '--summary'),
      baseRev,
      force: flags.has('--force'),
      adoptExternalEdit: flags.has('--adopt-external-edit'),
      checkLinks: flags.has('--check-links'),
    })
    console.log(`Published ${result.id} revision ${result.rev}`)
    return 0
  }

  const status = await readStatus({ root, task: positiveInteger(need(flags, '--task'), '--task') })
  if (flags.has('--json')) {
    console.log(JSON.stringify(status, null, 2))
  } else {
    console.log(`Task ${status.task}: ${status.journal.words} visible words (threshold: ${status.threshold})`)
    console.log(status.primary ? `Primary: ${status.primary.id} revision ${status.primary.rev}` : 'Primary: none')
    for (const doc of status.linkedDocs) console.log(`Linked: ${doc.id} revision ${doc.rev} (${doc.state})`)
    console.log(`Open comments: ${status.openCount}`)
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
