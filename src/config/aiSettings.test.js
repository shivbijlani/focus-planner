import { describe, it, expect } from 'vitest'
import { AI_SETTINGS_FILE, AI_SETTINGS_TEMPLATE } from './aiSettings.js'

describe('aiSettings', () => {
  it('writes to user-settings.md so the agent resolves the same file', () => {
    expect(AI_SETTINGS_FILE).toBe('user-settings.md')
  })

  it('seed template carries the sections the agent parses', () => {
    expect(AI_SETTINGS_TEMPLATE).toContain('## Settings')
    expect(AI_SETTINGS_TEMPLATE).toContain('## Preferences')
    // Key rows the skill reads.
    expect(AI_SETTINGS_TEMPLATE).toContain('| Timezone |')
    expect(AI_SETTINGS_TEMPLATE).toContain('| Planner board |')
    expect(AI_SETTINGS_TEMPLATE).toContain('| Agent email account |')
  })

  it('seed template still has placeholders to fill in', () => {
    expect(AI_SETTINGS_TEMPLATE).toMatch(/<[^>]+>/)
  })
})
