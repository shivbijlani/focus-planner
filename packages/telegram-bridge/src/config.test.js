import { describe, it, expect } from 'vitest'
import { loadConfig } from './config.js'

const BASE = { PLANNER_PATH: 'C:/planner', TELEGRAM_CHAT_ID: '-100' }

describe('loadConfig archiveCompleted', () => {
  it('defaults to on when the env var is unset', async () => {
    const cfg = await loadConfig({ env: { ...BASE } })
    expect(cfg.archiveCompleted).toBe(true)
  })

  it('stays on for affirmative values', async () => {
    for (const v of ['on', 'true', '1', 'yes', 'anything']) {
      const cfg = await loadConfig({ env: { ...BASE, TELEGRAM_BRIDGE_ARCHIVE: v } })
      expect(cfg.archiveCompleted, `value=${v}`).toBe(true)
    }
  })

  it('turns off only for explicit off/false/0/no (case-insensitive)', async () => {
    for (const v of ['off', 'OFF', 'false', 'False', '0', 'no', ' No ']) {
      const cfg = await loadConfig({ env: { ...BASE, TELEGRAM_BRIDGE_ARCHIVE: v } })
      expect(cfg.archiveCompleted, `value=${v}`).toBe(false)
    }
  })
})
