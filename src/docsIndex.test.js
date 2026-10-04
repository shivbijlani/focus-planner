import { describe, expect, it } from 'vitest'
import { getTaskDocs, taskLinkPlan } from './docsIndex.js'

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
    expect(taskLinkPlan({ hasDoc: true }).desktop).toEqual(['doc'])
  })

  it('uses the document, then Telegram, then Journal for the mobile rail', () => {
    expect(taskLinkPlan({ mobile: true, hasDoc: true, hasJournal: true, hasTelegram: true }))
      .toEqual({ desktop: ['telegram', 'journal', 'doc'], rail: 'doc', overflow: ['telegram', 'journal'] })
    expect(taskLinkPlan({ mobile: true, hasJournal: true, hasTelegram: true }))
      .toEqual({ desktop: ['telegram', 'journal'], rail: 'telegram', overflow: ['journal'] })
    expect(taskLinkPlan({ mobile: true, hasJournal: true }))
      .toEqual({ desktop: ['journal'], rail: 'journal', overflow: [] })
  })
})
