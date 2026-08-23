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

// The digest is the only message the bridge sends outside a task topic, so it
// needs its own switch: silencing the General thread must not cost you the
// per-task mirroring that `archiveCompleted` and the allowlist leave intact.
describe('loadConfig digestEnabled', () => {
  it('defaults to on when the env var is unset', async () => {
    const cfg = await loadConfig({ env: { ...BASE } })
    expect(cfg.digestEnabled).toBe(true)
  })

  it('stays on for affirmative values', async () => {
    for (const v of ['on', 'true', '1', 'yes', 'anything']) {
      const cfg = await loadConfig({ env: { ...BASE, TELEGRAM_BRIDGE_DIGEST: v } })
      expect(cfg.digestEnabled, `value=${v}`).toBe(true)
    }
  })

  it('turns off only for explicit off/false/0/no (case-insensitive)', async () => {
    for (const v of ['off', 'OFF', 'false', 'False', '0', 'no', ' No ']) {
      const cfg = await loadConfig({ env: { ...BASE, TELEGRAM_BRIDGE_DIGEST: v } })
      expect(cfg.digestEnabled, `value=${v}`).toBe(false)
    }
  })

  it('is independent of archiveCompleted', async () => {
    const cfg = await loadConfig({
      env: { ...BASE, TELEGRAM_BRIDGE_DIGEST: 'off', TELEGRAM_BRIDGE_ARCHIVE: 'on' },
    })
    expect(cfg.digestEnabled).toBe(false)
    expect(cfg.archiveCompleted).toBe(true)
  })
})
