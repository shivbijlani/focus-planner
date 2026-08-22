// Coalesces the backup/sync status stream so the board doesn't thrash.
//
// The sync engine emits a status object on every nudge during a backup. Most of
// those pushes are *value-identical* (a fresh object, same semantic state) and a
// burst of rapid save cycles (write → syncing → synced → write → …) flips the
// aggregate back and forth many times a second. App.jsx feeds each push straight
// into React state, so every one forces a full board re-render. Beyond being
// wasteful, the constant DOM churn defeats Playwright's "wait for the page to go
// quiet" gate, blocking automation (#133).
//
// This module keeps the label truthful while cutting renders to a handful:
//   • dedup — drop pushes that are value-identical to what's already shown;
//   • leading edge — apply the first change in a quiet period immediately, so
//     "Backing up…" appears promptly;
//   • trailing edge — coalesce a burst of changes and apply the final one once
//     the flurry settles, so N save cycles collapse to a stable end state.

// Compare two mapped sync-status objects by value. Identity always changes
// (mapEngineStatus builds a new object each time), so we must compare the parts
// App.jsx actually renders: the aggregate plus each target's status/message.
export function sameSyncStatus(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.aggregate !== b.aggregate) return false
  const fa = a.folders || {}
  const fb = b.folders || {}
  const folderKeys = new Set([...Object.keys(fa), ...Object.keys(fb)])
  for (const fk of folderKeys) {
    const ta = fa[fk]?.targets || {}
    const tb = fb[fk]?.targets || {}
    const targetKeys = new Set([...Object.keys(ta), ...Object.keys(tb)])
    for (const tk of targetKeys) {
      const xa = ta[tk] || {}
      const xb = tb[tk] || {}
      if (xa.status !== xb.status) return false
      if ((xa.message || '') !== (xb.message || '')) return false
    }
  }
  return true
}

// Build a coalescer that forwards far fewer status changes to `apply`.
// `delay` is the trailing coalescing window in ms. `setTimer`/`clearTimer` are
// injectable so tests can drive time deterministically.
export function makeSyncStatusCoalescer({
  apply,
  delay = 800,
  equals = sameSyncStatus,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let lastApplied
  let pending
  let hasPending = false
  let timer = null

  const fire = () => {
    timer = null
    if (hasPending && !equals(pending, lastApplied)) {
      lastApplied = pending
      apply(pending)
    }
    hasPending = false
    pending = undefined
  }

  const push = (status) => {
    if (equals(status, lastApplied)) {
      // Latest truth already matches what's shown. Also drop any stale pending
      // so the trailing edge doesn't re-render to a now-superseded intermediate
      // state (e.g. syncing → synced → syncing settles back to syncing, silently).
      hasPending = false
      pending = undefined
      return
    }
    if (timer === null) {
      // Quiet period: show this change right away, then open a window that
      // soaks up any burst that follows.
      lastApplied = status
      apply(status)
      timer = setTimer(fire, delay)
    } else {
      // Inside the window: remember only the newest state; it lands on the
      // trailing edge when the burst goes quiet.
      pending = status
      hasPending = true
    }
  }

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    hasPending = false
    pending = undefined
  }

  return { push, cancel }
}
