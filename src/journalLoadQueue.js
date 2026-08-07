// Ordered, concurrency-limited, de-duplicated async work queue.
//
// The planner board renders one row per task, and each row reads its journal
// file to show todos, the Telegram deep-link, and the read/unread dot. With
// 90+ rows mounting at once that meant ~180 concurrent journal reads (two per
// row) hammering the storage provider all at once. On cloud providers
// (OneDrive / Google Drive) that thrashes the network and stalls the whole
// board until every read lands.
//
// This queue funnels those reads so they run a few at a time, in board order
// (Today first, top-to-bottom via each row's `loadOrder`), and never fetches
// the same journal twice while a read is already in flight. Each row still
// renders incrementally — its badge and todos appear the moment its own read
// resolves — but the reads are staged instead of stampeding.

export function createLoadQueue({ concurrency = 4 } = {}) {
  const pending = [] // [{ key, priority, run, resolve, reject }]
  const inflight = new Map() // namespace -> Map(key -> Promise)
  const defaultNamespace = Symbol('default-load-queue-namespace')
  const idleWaiters = new Set()
  let active = 0

  // Enqueue `run` (a thunk returning a value or promise). Lower `priority`
  // numbers run earlier. If `key` is non-null and an identical read is already
  // queued or running, the existing promise is returned instead of scheduling
  // a duplicate fetch.
  function enqueue(key, priority, run, namespace = defaultNamespace) {
    const namespaceInflight = inflight.get(namespace)
    if (key != null && namespaceInflight?.has(key)) return namespaceInflight.get(key)

    const p = new Promise((resolve, reject) => {
      pending.push({ key, namespace, priority: priority ?? 0, run, resolve, reject })
    })
    if (key != null) {
      const entries = namespaceInflight ?? new Map()
      entries.set(key, p)
      inflight.set(namespace, entries)
    }
    drain()
    return p
  }

  function drain() {
    while (active < concurrency && pending.length > 0) {
      // Pick the lowest priority number currently waiting (earliest board row).
      let idx = 0
      for (let i = 1; i < pending.length; i++) {
        if (pending[i].priority < pending[idx].priority) idx = i
      }
      const item = pending.splice(idx, 1)[0]
      active++
      Promise.resolve()
        .then(item.run)
        .then(
          // Resolve the row's promise first so its content handler (including
          // unread tracking) runs before an idle waiter closes initial seeding.
          (value) => { item.resolve(value); settle(item.namespace, item.key) },
          (err) => { item.reject(err); settle(item.namespace, item.key) },
        )
    }
  }

  function settle(namespace, key) {
    active--
    if (key != null) {
      const entries = inflight.get(namespace)
      entries?.delete(key)
      if (entries?.size === 0) inflight.delete(namespace)
    }
    drain()
    if (active === 0 && pending.length === 0) {
      for (const resolve of idleWaiters) resolve()
      idleWaiters.clear()
    }
  }

  function onIdle() {
    if (active === 0 && pending.length === 0) return Promise.resolve()
    return new Promise(resolve => idleWaiters.add(resolve))
  }

  return {
    enqueue,
    onIdle,
    get size() { return pending.length },
    get active() { return active },
  }
}

// Shared board-wide queue. Concurrency of 4 keeps a handful of reads in flight
// (enough to stay responsive) without stampeding the storage provider.
export const journalLoadQueue = createLoadQueue({ concurrency: 4 })
export const JOURNAL_LOAD_TIMEOUT_MS = 15_000

function runWithDeadline(run, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const assertActive = () => {
      if (!settled) return
      const error = new Error('Journal load is no longer active')
      error.name = 'AbortError'
      throw error
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      const error = new Error('Journal load cancelled')
      error.name = 'AbortError'
      finish(reject, error)
    }
    const timer = setTimeout(
      () => finish(reject, new Error(`Journal load timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => {
        assertActive()
        return run(assertActive)
      })
      .then(
        value => finish(resolve, value),
        error => finish(reject, error),
      )
  })
}

/**
 * Queue one source-stable journal lookup/read. The provider object is both the
 * de-duplication namespace and the captured read target, so switching sources
 * cannot attach a new row to an unfinished promise from the previous source.
 */
export function enqueueJournalLoad({
  queue = journalLoadQueue,
  provider,
  taskId,
  priority = 0,
  signal,
  timeoutMs = JOURNAL_LOAD_TIMEOUT_MS,
}) {
  if (!provider) return Promise.reject(new Error('No journal provider'))
  const fallbackPath = `journal/task-${taskId}.md`
  return queue.enqueue(
    fallbackPath,
    priority,
    () => runWithDeadline(async (assertActive) => {
      const journal = await provider.checkJournal(taskId)
      assertActive()
      if (!journal?.exists) return { exists: false, path: journal?.path ?? fallbackPath, content: '' }
      const path = journal.path ?? fallbackPath
      const content = await provider.read(path)
      assertActive()
      return { exists: true, path, content }
    }, { signal, timeoutMs }),
    provider,
  )
}

/**
 * Let the current React effect flush enqueue its initial row loads, then wait
 * until every queued lookup/read has settled.
 */
export async function waitForInitialJournalLoads(queue = journalLoadQueue) {
  await Promise.resolve()
  await queue.onIdle()
}
