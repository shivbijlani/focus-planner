import { describe, expect, it } from 'vitest'
import { getTaskDocs, mobileTaskMenuLinks, taskLinkPlan } from './docsIndex.js'

describe('Docs task link gate and placement', () => {
  it('checks only docs/index.json when Docs are absent', async () => {
    const reads = []
    const provider = {
      async read(path) {
        reads.push(path)
        return ''
      },
    }
    expect(await getTaskDocs(provider)).toBeNull()
    expect(reads).toEqual(['docs/index.json'])
  })

  it('shows available desktop links side by side in trio order', () => {
    expect(taskLinkPlan({ hasDoc: true, hasJournal: true, hasTelegram: true }))
      .toEqual({ desktop: ['telegram', 'journal', 'doc'], rail: null, overflow: [] })
    expect(taskLinkPlan({ hasDoc: true, hasBriefing: true, hasJournal: true, hasTelegram: true }))
      .toEqual({ desktop: ['telegram', 'journal', 'doc', 'briefing'], rail: null, overflow: [] })
    expect(taskLinkPlan({ hasDoc: true }).desktop).toEqual(['doc'])
  })

  it('keeps the native Docs primary first and exposes a separate file briefing on mobile', () => {
    expect(taskLinkPlan({ mobile: true, hasDoc: true, hasJournal: true, hasTelegram: true }))
      .toEqual({ desktop: ['telegram', 'journal', 'doc'], rail: 'doc', overflow: ['telegram', 'journal'] })
    expect(taskLinkPlan({ mobile: true, hasDoc: true, hasBriefing: true, hasJournal: true }))
      .toEqual({ desktop: ['journal', 'doc', 'briefing'], rail: 'doc', overflow: ['journal', 'briefing'] })
    expect(taskLinkPlan({ mobile: true, hasBriefing: true, hasJournal: true }))
      .toEqual({ desktop: ['journal', 'briefing'], rail: 'briefing', overflow: ['journal'] })
    expect(taskLinkPlan({ mobile: true, hasJournal: true, hasTelegram: true }))
      .toEqual({ desktop: ['telegram', 'journal'], rail: 'telegram', overflow: ['journal'] })
    expect(taskLinkPlan({ mobile: true, hasJournal: true }))
      .toEqual({ desktop: ['journal'], rail: 'journal', overflow: [] })
  })

  it('preserves mobile task-menu labels and order for journal-only and Telegram tasks', () => {
    expect(mobileTaskMenuLinks({ hasJournal: true }).map(({ label, icon }) => ({ label, icon })))
      .toEqual([{ label: 'Open chat', icon: '💬' }])
    expect(mobileTaskMenuLinks({ hasJournal: true, hasTelegram: true }).map(({ label, icon }) => ({ label, icon })))
      .toEqual([{ label: 'Open journal', icon: '📔' }])
    expect(mobileTaskMenuLinks({ hasJournal: true, hasTelegram: true, hasDoc: true })
      .map(({ label, icon }) => ({ label, icon })))
      .toEqual([
        { label: 'Open Telegram', icon: '💬' },
        { label: 'Open journal', icon: '📔' },
      ])
    expect(mobileTaskMenuLinks({ hasDoc: true, hasBriefing: true, hasJournal: true })
      .map(({ key, label, icon }) => ({ key, label, icon }))).toEqual([
        { key: 'journal', label: 'Open journal', icon: '📔' },
        { key: 'briefing', label: 'Open briefing', icon: '📑' },
      ])
    expect(mobileTaskMenuLinks({ hasBriefing: true, hasJournal: true })
      .map(({ key, label }) => ({ key, label }))).toEqual([
        { key: 'journal', label: 'Open journal' },
      ])
  })
})
