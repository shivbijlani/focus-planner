import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Regression guard for task #371 (follow-up): "the overnight agent wrote a new
// journal (task-371.md) to the folder while the Focus Planner tab was open, but
// it never appeared in the sidebar — the count stayed at its load-time value."
//
// Root cause: the sidebar tree only refreshes via `storage.onLocalChange`, which
// fires for the app's OWN writes and sync pulls. The browser cannot observe files
// added to the folder by an EXTERNAL process (the overnight agent, or OneDrive/
// Drive sync from another device), so externally-added journals stayed invisible
// until a manual reload. The fix re-fetches the tree (`loadFiles`) when the tab
// regains focus/visibility, so returning to the tab picks up the new files.
//
// App.jsx is a large monolithic component with no component-test harness in this
// repo (node-env vitest only), so this test guards the wiring at the source level
// to stop the refresh from being silently dropped again.

const appSource = readFileSync(
  fileURLToPath(new URL('./App.jsx', import.meta.url)),
  'utf8',
)

describe('sidebar tree refreshes on focus/visibility (#371)', () => {
  it('registers a window focus listener that refreshes the tree', () => {
    expect(appSource).toMatch(/window\.addEventListener\('focus', scheduleRefresh\)/)
  })

  it('registers a visibilitychange listener that refreshes the tree', () => {
    expect(appSource).toMatch(/document\.addEventListener\('visibilitychange', onVisibility\)/)
  })

  it('only refreshes when the document becomes visible', () => {
    expect(appSource).toMatch(/document\.visibilityState === 'visible'/)
  })

  it('the focus/visibility handler calls loadFiles', () => {
    // The scheduleRefresh debounce body re-fetches the tree via loadFiles.
    const calls = appSource.match(/loadFiles\(\)\.catch\(\(\) => \{\}\)/g) || []
    // Existing onLocalChange debounce + the new focus/visibility debounce.
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('cleans up both listeners on unmount', () => {
    expect(appSource).toMatch(/window\.removeEventListener\('focus', scheduleRefresh\)/)
    expect(appSource).toMatch(/document\.removeEventListener\('visibilitychange', onVisibility\)/)
  })
})
