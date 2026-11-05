#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { OPERATIONS, VERSION } from '../src/operations.js'
import { ToolError, safeError } from '../src/errors.js'
import { planTool, runTool } from '../src/plan.js'
import { graphClient } from '../src/graph.js'
import { deviceAuth, environmentAuth } from '../src/auth.js'
import { protocol } from '../src/protocol.js'

const HELP = `planner ${VERSION} - Focus Planner agent tools (Node 22+)

  planner plan < request.json        Tokenless: {"tool","arguments","snapshots"} -> read/write plan
  planner mcp --broker               Stdio MCP exposing planner_plan (tokenless; for Muse)
  planner mcp [--device-code]        Stdio MCP with direct Graph access
  planner <tool> [--device-code] < arguments.json
                                     One-shot direct call; tools: ${Object.keys(OPERATIONS).join(', ')}

Direct mode signs in with --device-code or reads PLANNER_ACCESS_TOKEN from the
runtime environment (never from arguments). Output is JSON on stdout; errors are
JSON on stderr with exit code 1.`

async function readStdin() {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 6_000_000) throw new ToolError('INVALID_INPUT', 'Input exceeds 6 MB.')
  }
  return JSON.parse(input)
}

async function main() {
  const [command, ...flags] = process.argv.slice(2)
  if (command === '--version') return void console.log(VERSION)
  if (!command || command === '--help' || command === 'help') return void console.log(HELP)
  if (flags.some(f => !['--device-code', '--broker'].includes(f))) throw new ToolError('INVALID_INPUT', 'Unsupported flag.')
  const broker = flags.includes('--broker')
  if (broker && (command !== 'mcp' || flags.includes('--device-code'))) throw new ToolError('INVALID_INPUT', 'Use "mcp --broker" without other flags.')
  if (command === 'plan') {
    if (flags.length) throw new ToolError('INVALID_INPUT', 'plan takes no flags.')
    return void process.stdout.write(`${JSON.stringify(await planTool(await readStdin()))}\n`)
  }
  if (command !== 'mcp' && !Object.hasOwn(OPERATIONS, command)) throw new ToolError('INVALID_INPUT', 'Unknown command. Run "planner --help".')
  const client = broker ? null : graphClient({ getAccessToken: flags.includes('--device-code') ? await deviceAuth() : environmentAuth() })
  if (command === 'mcp') {
    const handle = protocol({ brokerMode: broker, client })
    // Sequential dispatch: one change at a time per process.
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      let response
      try { response = await handle(JSON.parse(line)) } catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } } }
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
    }
    return
  }
  process.stdout.write(`${JSON.stringify(await runTool(client, { tool: command, arguments: await readStdin() }))}\n`)
}

main().catch((error) => {
  const reported = error instanceof SyntaxError ? new ToolError('INVALID_INPUT', 'Input must be valid JSON.') : error
  process.stderr.write(`${JSON.stringify(safeError(reported))}\n`)
  process.exitCode = 1
})
