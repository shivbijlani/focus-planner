import { describe, it, expect } from 'vitest'
import {
  classifyAgentSetting,
  isUserFacingSetting,
  partitionAgentSettings,
} from './agentSettingsVisibility.js'
import { groupSettingsForm } from './userSettingsForm.js'

describe('agentSettingsVisibility', () => {
  describe('classifyAgentSetting / isUserFacingSetting', () => {
    it('treats a small conservative set of labels as user-facing', () => {
      for (const label of ['User', 'Timezone', 'Enabled', 'Tasks']) {
        expect(classifyAgentSetting(label)).toBe('user')
        expect(isUserFacingSetting(label)).toBe(true)
      }
    })

    it('treats paths, accounts, IDs and allow-lists as advanced', () => {
      for (const label of [
        'Planner board',
        'Journals folder',
        'Dev drive (repos)',
        'GitHub owner',
        'Agent email account',
        'Authorized sender addresses',
        'Auto-send (email) allow-list',
        'Chat ID',
        'Bot',
        'Bot token',
      ]) {
        expect(classifyAgentSetting(label)).toBe('advanced')
        expect(isUserFacingSetting(label)).toBe(false)
      }
    })

    it('is case-insensitive and trims whitespace', () => {
      expect(isUserFacingSetting('  timezone  ')).toBe(true)
      expect(isUserFacingSetting('ENABLED')).toBe(true)
      expect(isUserFacingSetting('user')).toBe(true)
    })

    it('defaults unknown labels to advanced (never leaks into the simple view)', () => {
      expect(classifyAgentSetting('Some brand new knob')).toBe('advanced')
      expect(classifyAgentSetting('')).toBe('advanced')
      expect(classifyAgentSetting(null)).toBe('advanced')
      expect(classifyAgentSetting(undefined)).toBe('advanced')
    })
  })

  describe('partitionAgentSettings', () => {
    const md = [
      '## Settings',
      '',
      '| Setting | Value |',
      '| --- | --- |',
      '| User | Shiv |',
      '| Timezone | America/Los_Angeles |',
      '| Planner board | C:\\board.md |',
      '| GitHub owner | github.com/shivbijlani |',
      '',
      '## Telegram (mobile journal bridge — task #352)',
      '',
      '| Setting | Value |',
      '| --- | --- |',
      '| Enabled | on |',
      '| Tasks | (empty) |',
      '| Chat ID | -100123 |',
      '| Bot token | vault |',
      '',
    ].join('\n')

    it('splits each section into user-facing and advanced rows', () => {
      const groups = groupSettingsForm(md)
      const { user, advanced } = partitionAgentSettings(groups)

      const userLabels = user.flatMap((g) => g.rows.map((r) => r.label))
      const advancedLabels = advanced.flatMap((g) => g.rows.map((r) => r.label))

      expect(userLabels).toEqual(['User', 'Timezone', 'Enabled', 'Tasks'])
      expect(advancedLabels).toEqual(['Planner board', 'GitHub owner', 'Chat ID', 'Bot token'])
    })

    it('preserves each row\'s original flat index for serialization', () => {
      const groups = groupSettingsForm(md)
      const { user, advanced } = partitionAgentSettings(groups)
      const all = [...user, ...advanced].flatMap((g) => g.rows)
      for (const row of all) {
        expect(typeof row.index).toBe('number')
      }
      // Enabled is the 5th parsed row (index 4) in the flat list.
      const enabled = user.flatMap((g) => g.rows).find((r) => r.label === 'Enabled')
      expect(enabled.index).toBe(4)
    })

    it('loses no rows — union of partitions equals the input rows', () => {
      const groups = groupSettingsForm(md)
      const inputIndices = groups.flatMap((g) => g.rows.map((r) => r.index)).sort((a, b) => a - b)
      const { user, advanced } = partitionAgentSettings(groups)
      const outIndices = [...user, ...advanced]
        .flatMap((g) => g.rows.map((r) => r.index))
        .sort((a, b) => a - b)
      expect(outIndices).toEqual(inputIndices)
    })

    it('keeps section headers with their rows and drops empty partitions', () => {
      const groups = groupSettingsForm(md)
      const { user, advanced } = partitionAgentSettings(groups)
      // Both sections contribute to both partitions here.
      expect(user.map((g) => g.section)).toEqual([
        'Settings',
        'Telegram (mobile journal bridge — task #352)',
      ])
      expect(advanced.map((g) => g.section)).toEqual([
        'Settings',
        'Telegram (mobile journal bridge — task #352)',
      ])
    })

    it('is robust to empty / malformed input', () => {
      expect(partitionAgentSettings([])).toEqual({ user: [], advanced: [] })
      expect(partitionAgentSettings(null)).toEqual({ user: [], advanced: [] })
      expect(partitionAgentSettings([{ section: 'X' }])).toEqual({ user: [], advanced: [] })
    })
  })
})
