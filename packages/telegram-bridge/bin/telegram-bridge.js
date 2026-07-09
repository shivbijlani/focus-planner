#!/usr/bin/env node
// CLI for the Focus Planner <-> Telegram bridge.
//
//   node bin/telegram-bridge.js whoami       # verify the token / print bot info
//   node bin/telegram-bridge.js sync-up      # post agent turns -> topics
//   node bin/telegram-bridge.js sync-down    # fold replies -> journals
//   node bin/telegram-bridge.js once         # sync-up then sync-down (default)
//   node bin/telegram-bridge.js watch [secs] # loop `once` every N seconds
//
// Config comes from env (see packages/telegram-bridge/README.md):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, [PLANNER_PATH],
//   [TELEGRAM_BRIDGE_TASKS], [TELEGRAM_BRIDGE_STATE_DIR]

import path from 'path'
import { fileURLToPath } from 'url'
import { loadConfig, assertRunnable } from '../src/config.js'
import { createTelegramClient } from '../src/telegramClient.js'
import { createFsIo } from '../src/io.js'
import { createBridge } from '../src/bridge.js'
import { loadState, saveState } from '../src/state.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

const log = (msg) => console.log(`[telegram-bridge] ${msg}`)

async function build() {
  const config = assertRunnable(await loadConfig({ repoRoot: REPO_ROOT }))
  const client = createTelegramClient({ token: config.token })
  const io = createFsIo({ journalDir: config.journalDir })
  const state = await loadState(config.stateDir)
  const bridge = createBridge({ client, config, state, io, logger: log })
  return { config, client, state, bridge }
}

async function runOnce() {
  const { config, state, bridge } = await build()
  const { up, down } = await bridge.syncOnce()
  await saveState(config.stateDir, state)
  log(
    `up: posted ${up.posted.length}, new topics ${up.created.length}; ` +
      `down: folded ${down.folded.length} repl${down.folded.length === 1 ? 'y' : 'ies'}`,
  )
  return { up, down }
}

async function main() {
  const [cmd = 'once', arg] = process.argv.slice(2)

  switch (cmd) {
    case 'whoami': {
      const { client } = await build()
      const me = await client.getMe()
      log(`@${me.username} (${me.first_name}), id ${me.id}`)
      break
    }
    case 'sync-up': {
      const { config, state, bridge } = await build()
      const up = await bridge.syncUp()
      await saveState(config.stateDir, state)
      log(`posted ${up.posted.length}, new topics ${up.created.length}`)
      break
    }
    case 'sync-down': {
      const { config, state, bridge } = await build()
      const down = await bridge.syncDown()
      await saveState(config.stateDir, state)
      log(`folded ${down.folded.length}`)
      break
    }
    case 'once':
      await runOnce()
      break
    case 'watch': {
      const secs = Math.max(10, Number(arg) || 60)
      log(`watching every ${secs}s (Ctrl+C to stop)`)
      for (;;) {
        try {
          await runOnce()
        } catch (err) {
          log(`error: ${err.message}`)
        }
        await new Promise((r) => setTimeout(r, secs * 1000))
      }
    }
    default:
      console.error(`Unknown command: ${cmd}`)
      process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`[telegram-bridge] fatal: ${err.message}`)
  process.exitCode = 1
})
