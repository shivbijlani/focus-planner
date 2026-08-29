import { describe, it, expect } from 'vitest'
import {
  parseSettingsForm,
  serializeSettingsForm,
  groupSettingsForm,
  hasSettingsForm,
} from './userSettingsForm.js'

// A fixture that mirrors the real user-settings.md shape: intro prose, a
// blockquote, a Settings table, a second (Telegram) table, and a Preferences
// list with multi-line prose bullets. The parser must ignore everything that
// isn't a Setting|Value data row, and the serializer must never disturb it.
const SAMPLE = `# Overnight Agent — user settings

This file is the **source of truth** for the agent's config.

> Personal data lives here on purpose.

## Settings

| Setting | Value |
| --- | --- |
| User | Shiv (\`shivbijlani\` on GitHub) |
| Timezone | America/Los_Angeles |
| Planner board | \`C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner\\planner.md\` |
| Dev drive (repos) | \`V:\\repos\\\` (worktrees in \`V:\\repos\\<name>.worktrees\\\`) |

## Telegram (mobile journal bridge)

| Setting | Value |
| --- | --- |
| Enabled | \`on\` — mirror journals to Telegram at the end of every run. |
| Chat ID | \`-1004310604015\` |

## Preferences

- **Inbox check:** \`on\` — check the agent email inbox at the start of every run.
- **Code tasks open a draft PR:** \`on\` — prefer **draft** PRs.
- **Long emails:** whenever the agent emails a long message, also send it to
  Kindle so it lands on the device. Wraps across two lines on purpose.
`

describe('parseSettingsForm', () => {
  it('surfaces every Setting|Value data row across all tables, in order', () => {
    const rows = parseSettingsForm(SAMPLE)
    expect(rows.map(r => r.label)).toEqual([
      'User',
      'Timezone',
      'Planner board',
      'Dev drive (repos)',
      'Enabled',
      'Chat ID',
    ])
  })

  it('captures the section each row belongs to', () => {
    const rows = parseSettingsForm(SAMPLE)
    expect(rows.find(r => r.label === 'Timezone').section).toBe('Settings')
    expect(rows.find(r => r.label === 'Chat ID').section).toBe('Telegram (mobile journal bridge)')
  })

  it('trims the value cell and never includes header or separator rows', () => {
    const rows = parseSettingsForm(SAMPLE)
    expect(rows.find(r => r.label === 'Timezone').value).toBe('America/Los_Angeles')
    expect(rows.some(r => r.label.toLowerCase() === 'setting')).toBe(false)
    expect(rows.some(r => /^:?-{3,}:?$/.test(r.label))).toBe(false)
  })

  it('ignores prose, blockquotes and Preferences bullets (only tables)', () => {
    const rows = parseSettingsForm(SAMPLE)
    expect(rows.some(r => /Inbox check/.test(r.label))).toBe(false)
    expect(rows.some(r => /source of truth/.test(r.value))).toBe(false)
  })

  it('returns [] for non-string or empty input', () => {
    expect(parseSettingsForm(null)).toEqual([])
    expect(parseSettingsForm('')).toEqual([])
    expect(parseSettingsForm('# just a heading\n\nno tables here')).toEqual([])
  })
})

describe('serializeSettingsForm — round trip identity', () => {
  it('re-writing every row with its own value returns the file byte-for-byte', () => {
    const rows = parseSettingsForm(SAMPLE)
    const out = serializeSettingsForm(SAMPLE, rows.map(r => r.value))
    expect(out).toBe(SAMPLE)
  })

  it('passing no updates returns the file unchanged', () => {
    expect(serializeSettingsForm(SAMPLE, [])).toBe(SAMPLE)
    expect(serializeSettingsForm(SAMPLE, undefined)).toBe(SAMPLE)
  })

  it('preserves CRLF line endings exactly', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n')
    const rows = parseSettingsForm(crlf)
    expect(serializeSettingsForm(crlf, rows.map(r => r.value))).toBe(crlf)
  })

  it('preserves unusual value-cell padding on unrelated rows', () => {
    const padded = '## Settings\n\n| Setting | Value |\n| --- | --- |\n| A |    spaced-out    |\n| B | tight |\n'
    const rows = parseSettingsForm(padded)
    expect(serializeSettingsForm(padded, rows.map(r => r.value))).toBe(padded)
  })
})

describe('serializeSettingsForm — surgical edits', () => {
  it('changes only the edited cell, leaving all other bytes untouched', () => {
    const rows = parseSettingsForm(SAMPLE)
    const idx = rows.findIndex(r => r.label === 'Timezone')
    const updates = rows.map((r, i) => (i === idx ? 'America/New_York' : r.value))
    const out = serializeSettingsForm(SAMPLE, updates)
    expect(out).toContain('| Timezone | America/New_York |')
    expect(out).not.toContain('America/Los_Angeles')
    // Everything before and after the edited line is identical.
    const before = SAMPLE.split('\n')
    const after = out.split('\n')
    expect(after.length).toBe(before.length)
    after.forEach((ln, i) => {
      if (!before[i].includes('Timezone')) expect(ln).toBe(before[i])
    })
  })

  it('edits a row in a second table without touching the first', () => {
    const rows = parseSettingsForm(SAMPLE)
    const idx = rows.findIndex(r => r.label === 'Chat ID')
    const out = serializeSettingsForm(SAMPLE, rows.map((r, i) => (i === idx ? '`-1009999999999`' : r.value)))
    expect(out).toContain('| Chat ID | `-1009999999999` |')
    expect(out).toContain('| Timezone | America/Los_Angeles |')
  })

  it('collapses newlines in a new value so a cell cannot break the table', () => {
    const rows = parseSettingsForm(SAMPLE)
    const idx = rows.findIndex(r => r.label === 'User')
    const out = serializeSettingsForm(SAMPLE, rows.map((r, i) => (i === idx ? 'line one\nline two' : r.value)))
    expect(out).toContain('| User | line one line two |')
    // Row count is unchanged — no injected line break.
    expect(out.split('\n').length).toBe(SAMPLE.split('\n').length)
  })

  it('round-trips a value that itself contains an escaped pipe', () => {
    const md = '## Settings\n\n| Setting | Value |\n| --- | --- |\n| Cmd | `a \\| b` |\n'
    const rows = parseSettingsForm(md)
    expect(rows[0].value).toBe('`a \\| b`')
    expect(serializeSettingsForm(md, rows.map(r => r.value))).toBe(md)
  })
})

describe('groupSettingsForm', () => {
  it('groups rows by section preserving order and flat indexes', () => {
    const groups = groupSettingsForm(SAMPLE)
    expect(groups.map(g => g.section)).toEqual(['Settings', 'Telegram (mobile journal bridge)'])
    expect(groups[0].rows.map(r => r.label)).toEqual(['User', 'Timezone', 'Planner board', 'Dev drive (repos)'])
    // Flat index lines up with parseSettingsForm order (what serialize expects).
    const flat = parseSettingsForm(SAMPLE)
    const chat = groups[1].rows.find(r => r.label === 'Chat ID')
    expect(flat[chat.index].label).toBe('Chat ID')
  })
})

describe('hasSettingsForm', () => {
  it('is true when structured rows exist and false otherwise', () => {
    expect(hasSettingsForm(SAMPLE)).toBe(true)
    expect(hasSettingsForm('# heading only\n\nprose')).toBe(false)
    expect(hasSettingsForm('')).toBe(false)
  })
})
