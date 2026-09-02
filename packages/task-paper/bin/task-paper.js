#!/usr/bin/env node
// task-paper — generate readable per-task papers from Focus Planner journals (#286).
//
// Additive by construction: it only ever writes `<journal>/paper/task-<id>.html`.
// It never reads, moves or modifies a journal, so removing the `paper/` folder
// reverts the entire feature.

import path from 'node:path'
import fs from 'node:fs'
import { generateAll, generatePaper } from '../src/generate.js'

const USAGE = `
task-paper — readable per-task papers (issue #286)

Usage:
  task-paper generate [--planner <dir>] [--task <id>[,<id>...]] [--out <dir>] [--all-journals]
  task-paper generate --journal <path-to-task-N.md> [--out <dir>]

Options:
  --planner <dir>   Planner folder holding journal\\ (default: $PLANNER_PATH)
  --journal <path>  Generate for a single journal file
  --task <ids>      Comma-separated task ids to limit to
  --out <dir>       Output directory (default: <planner>\\journal\\paper)
  --all-journals    Include journals with no agent turn yet
  --json            Machine-readable output
  -h, --help        This message
`.trim()

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') { args.help = true; continue }
    if (a === '--json') { args.json = true; continue }
    if (a === '--all-journals') { args.allJournals = true; continue }
    if (a.startsWith('--')) { args[a.slice(2)] = argv[++i]; continue }
    args._.push(a)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._[0] === 'help' || (!args._.length && !args.journal)) {
    console.log(USAGE)
    process.exit(args.help || args._[0] === 'help' ? 0 : 1)
  }

  const cmd = args._[0] || 'generate'
  if (cmd !== 'generate') {
    console.error(`Unknown command: ${cmd}\n\n${USAGE}`)
    process.exit(1)
  }

  let results
  if (args.journal) {
    results = [generatePaper(path.resolve(args.journal), { outDir: args.out || null })]
  } else {
    const planner = args.planner || process.env.PLANNER_PATH
    if (!planner) {
      console.error('No planner folder: pass --planner <dir> or set PLANNER_PATH.')
      process.exit(1)
    }
    const journalDir = path.join(planner, 'journal')
    if (!fs.existsSync(journalDir)) {
      console.error(`No journal folder at ${journalDir}`)
      process.exit(1)
    }
    results = generateAll(journalDir, {
      outDir: args.out || null,
      taskIds: args.task ? String(args.task).split(',').map((s) => s.trim()).filter(Boolean) : null,
      onlyWithAgentBlock: !args.allJournals,
    })
  }

  const tally = results.reduce((acc, r) => {
    acc[r.reason] = (acc[r.reason] || 0) + 1
    return acc
  }, {})

  if (args.json) {
    console.log(JSON.stringify({ tally, results }, null, 2))
  } else {
    const summary = Object.entries(tally)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')
    console.log(`[task-paper] ${results.length} journal(s): ${summary || 'nothing to do'}`)
    for (const r of results) {
      if (r.reason === 'error') console.error(`  ! task ${r.taskId}: ${r.error}`)
    }
  }

  process.exit(results.some((r) => r.reason === 'error') ? 1 : 0)
}

main()
