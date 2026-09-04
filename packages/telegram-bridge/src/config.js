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
 * @returns {Promise<{token,chatId,plannerPath,journalDir,stateDir,taskAllowlist,archiveCompleted}>}
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

  // Whether to archive (close) a task's forum topic when it lands on the
  // completed board, and reopen it if the task later leaves that board. Default
  // ON once Telegram is set up — only an explicit off/false/0/no in
  // TELEGRAM_BRIDGE_ARCHIVE disables it. The overnight agent maps the
  // "Archive completed topics" user-setting onto this env var (SKILL.md PHASE 3).
  const archiveCompleted = !/^(off|false|0|no)$/i.test(
    (env.TELEGRAM_BRIDGE_ARCHIVE || '').trim(),
  )

  // Whether to post the consolidated "waiting on you" digest. It is the ONLY
  // thing the bridge sends to the group's General thread — every other message
  // goes into its task's own topic. Users who want the group to be strictly
  // one-topic-per-task therefore need a way to silence it without losing the
  // per-task mirroring, so it is gated separately from `archiveCompleted`.
  // Default ON to preserve existing behaviour; only an explicit
  // off/false/0/no in TELEGRAM_BRIDGE_DIGEST disables it.
  const digestEnabled = !/^(off|false|0|no)$/i.test(
    (env.TELEGRAM_BRIDGE_DIGEST || '').trim(),
  )

  // WHERE the digest is posted. Turning the digest off is a blunt instrument:
  // it silences the General thread but also costs you the only consolidated
  // view of the approval queue, which is the one message that says what is
  // actually blocked on you. This gives the middle option — keep the digest,
  // but move it out of General into its own forum topic, so the group stays
  // strictly one-topic-per-subject.
  //
  //   unset/empty  -> General thread (unchanged default)
  //   numeric id   -> post into that existing topic
  //   any name     -> find-or-create a forum topic with that name
  //
  // A name is resolved to a topic id once and remembered in bridge state, so
  // re-runs reuse the same topic instead of creating a new one each night.
  const digestTopic = (env.TELEGRAM_BRIDGE_DIGEST_TOPIC || '').trim()

  // #483 — whether to DELETE the turn messages a task posted before it was bound to a catch-up
  // doc, so its topic converges on the single message #424 specifies.
  //
  // Note the default is OFF, which is the opposite of every other flag in this file, and the
  // asymmetry is deliberate rather than an oversight. The others change what the bridge SAYS;
  // this one permanently removes messages from the user's own thread, and Telegram offers no
  // undo. Worse, link mode cannot establish that the removal is lossless the way the turn path
  // can: there the replacement is another turn, so "does the new text still carry the old
  // links?" is a question about two strings this process holds. Here the replacement is a
  // document the bridge never reads, so the honest answer is that it does not know.
  //
  // So the default is to REPORT what it would remove and leave the judgement with the user.
  // Only an explicit on/true/1/yes turns the report into an action.
  const tidyBoundTopics = /^(on|true|1|yes)$/i.test(
    (env.TELEGRAM_BRIDGE_TIDY_BOUND || '').trim(),
  )

  return {
    token,
    chatId,
    plannerPath,
    journalDir: path.join(plannerPath, 'journal'),
    completedBoardPath: path.join(plannerPath, 'planner-completed.md'),
    boardPath: path.join(plannerPath, 'planner.md'),
    // The app's per-task sync records. These carry the `deleted: true`
    // tombstone, which is the ONLY durable signal that a task was removed in
    // the UI — a deleted task leaves both boards, so the boards alone cannot
    // distinguish "deleted" from "never existed".
    syncRecordPaths: [
      path.join(plannerPath, 'planner.md.sync.json'),
      path.join(plannerPath, 'planner-completed.md.sync.json'),
    ],
    stateDir,
    taskAllowlist,
    archiveCompleted,
    digestEnabled,
    digestTopic,
    tidyBoundTopics,
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
