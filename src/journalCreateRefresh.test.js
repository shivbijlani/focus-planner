import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Regression guard for task #371: "created a journal, but it never showed up in
// the sidebar (hamburger) pane — even though the file was on disk / in OneDrive."
//
// Root cause: both handleCreateJournal implementations wrote the journal file
// but never refreshed the sidebar's cached `files` tree, so a freshly created
// journal was invisible until a full reload. The fix threads an `onDataChanged`
// refresh callback (wired to `loadFiles`) into FocusPlanView and
// CombinedFocusPlanView and calls it right after the journal is written.
//
// App.jsx is a large monolithic component with no component-test harness in this
// repo (node-env vitest only), so this test guards the wiring at the source level
// to stop the refresh call from being silently dropped again.

const appSource = readFileSync(
  fileURLToPath(new URL('./App.jsx', import.meta.url)),
  'utf8',
)

describe('journal creation refreshes the sidebar tree (#371)', () => {
  it('FocusPlanView accepts an onDataChanged refresh callback', () => {
    expect(appSource).toMatch(
      /function FocusPlanView\(\{[^}]*\bonDataChanged\b[^}]*\}\)/,
    )
  })

  it('CombinedFocusPlanView accepts an onDataChanged refresh callback', () => {
    expect(appSource).toMatch(
      /function CombinedFocusPlanView\(\{[^}]*\bonDataChanged\b[^}]*\}\)/,
    )
  })

  it('both views are wired to loadFiles at their render sites', () => {
    const matches = appSource.match(/onDataChanged=\{loadFiles\}/g) || []
    // FocusPlanView + CombinedFocusPlanView + the existing StorageFooter wiring.
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  it('both handleCreateJournal implementations refresh the tree after writing', () => {
    // The refresh must run after the storage write, before/around navigation.
    const refreshCalls = appSource.match(/await onDataChanged\?\.\(\)/g) || []
    expect(refreshCalls.length).toBeGreaterThanOrEqual(2)
  })
})
