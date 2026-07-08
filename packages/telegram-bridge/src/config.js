// Loads bridge configuration from environment + optional planner-config.json.
// The bot token is NEVER read from a file in the repo — it comes from the
// TELEGRAM_BOT_TOKEN env var, which the launcher populates from the OS
// credential vault (see the package README).

import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const DEFAULT_STATE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'overnight-agent',
  'telegram-bridge',
)

/**
 * Resolve the planner folder the same way server.js does: prefer an explicit
 * env var, then planner-config.json next to the repo root, then the default
 * sibling `../planner` folder.
 */
async function resolvePlannerPath({ env, repoRoot }) {
  if (env.PLANNER_PATH) return env.PLANNER_PATH
  try {
    const raw = await fs.readFile(path.join(repoRoot, 'planner-config.json'), 'utf-8')
    const cfg = JSON.parse(raw)
    if (cfg.plannerPath) return cfg.plannerPath
  } catch {
    // no config file — fall through to default
  }
  return path.join(repoRoot, '..', 'planner')
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.repoRoot] path of the focus-planner repo root
 * @returns {Promise<{token,chatId,plannerPath,journalDir,stateDir,taskAllowlist,replySignatureAsMe}>}
 */
export async function loadConfig({ env = process.env, repoRoot } = {}) {
  const root = repoRoot || path.resolve(process.cwd())
  const token = env.TELEGRAM_BOT_TOKEN || ''
  const chatId = env.TELEGRAM_CHAT_ID || ''
  const plannerPath = await resolvePlannerPath({ env, repoRoot: root })
  const stateDir = env.TELEGRAM_BRIDGE_STATE_DIR || DEFAULT_STATE_DIR

  // Optional comma-separated allowlist of task IDs to mirror. Empty = mirror
  // every task journal that has an agent block.
  const taskAllowlist = (env.TELEGRAM_BRIDGE_TASKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    token,
    chatId,
    plannerPath,
    journalDir: path.join(plannerPath, 'journal'),
    stateDir,
    taskAllowlist,
  }
}

export function assertRunnable(config) {
  const missing = []
  if (!config.token) missing.push('TELEGRAM_BOT_TOKEN')
  if (!config.chatId) missing.push('TELEGRAM_CHAT_ID')
  if (missing.length) {
    throw new Error(
      `Telegram bridge is missing required config: ${missing.join(', ')}. ` +
        'See packages/telegram-bridge/README.md for how to supply them.',
    )
  }
  return config
}
