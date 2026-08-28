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

function runWithDeadline(run, { signal, timeoutMs, decorateError = error => error, onTimeout }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const assertActive = () => {
      if (!settled) return
      const error = new Error('Journal load is no longer active')
      error.name = 'AbortError'
      throw error
    }
    const finish = (callback, value) => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
      return true
    }
    const onAbort = () => {
      const error = signal?.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Journal load cancelled'), { name: 'AbortError' })
      finish(reject, decorateError(error))
    }
    const timer = setTimeout(
      () => {
        const error = new Error(`Journal load timed out after ${timeoutMs}ms`)
        if (finish(reject, decorateError(error))) onTimeout?.(error)
      },
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
        error => finish(reject, decorateError(error)),
      )
  })
}

const sharedJournalLoads = new WeakMap()

function journalLoadsFor(queue, provider) {
  let queueLoads = sharedJournalLoads.get(queue)
  if (!queueLoads) {
    queueLoads = new Map()
    sharedJournalLoads.set(queue, queueLoads)
  }
  let providerLoads = queueLoads.get(provider)
  if (!providerLoads) {
    providerLoads = new Map()
    queueLoads.set(provider, providerLoads)
  }
  return providerLoads
}

function attachJournalLoadConsumer(entry, signal, onLastConsumerDetached) {
  entry.consumers++
  return new Promise((resolve, reject) => {
    let detached = false
    const detach = () => {
      if (detached) return
      detached = true
      signal?.removeEventListener('abort', onAbort)
      entry.consumers--
      if (entry.consumers === 0 && !entry.settled) onLastConsumerDetached()
    }
    const onAbort = () => {
      const error = new Error('Journal load cancelled')
      error.name = 'AbortError'
      detach()
      reject(error)
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(
      value => { detach(); resolve(value) },
      error => { detach(); reject(error) },
    )
  })
}

/**
 * Queue one source-stable journal lookup/read. Shared provider work is
 * reference-counted behind per-consumer promises, so one row unmounting cannot
 * cancel another row's read and a rapid remount can start a fresh generation.
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
  if (signal?.aborted) {
    const error = new Error('Journal load cancelled')
    error.name = 'AbortError'
    return Promise.reject(error)
  }
  const fallbackPath = `journal/task-${taskId}.md`
  const providerLoads = journalLoadsFor(queue, provider)
  let entry = providerLoads.get(fallbackPath)
  if (!entry) {
    const controller = new AbortController()
    let knownJournal = null
    const decorateError = (error) => {
      if (!knownJournal?.exists) return error
      error.journal = knownJournal
      return error
    }
    entry = { consumers: 0, controller, settled: false, promise: null }
    entry.promise = queue.enqueue(
      null,
      priority,
      () => runWithDeadline(async (assertActive) => {
        const journal = await provider.checkJournal(taskId, { signal: controller.signal })
        assertActive()
        knownJournal = {
          exists: Boolean(journal?.exists),
          path: journal?.path ?? fallbackPath,
        }
        if (!journal?.exists) return { exists: false, path: journal?.path ?? fallbackPath, content: '' }
        const path = journal.path ?? fallbackPath
        const content = await provider.read(path, { signal: controller.signal })
        assertActive()
        return { exists: true, path, content }
      }, {
        signal: controller.signal,
        timeoutMs,
        decorateError,
        onTimeout: error => controller.abort(error),
      }),
    )
    providerLoads.set(fallbackPath, entry)
    const settledEntry = entry
    const markSettled = () => {
      settledEntry.settled = true
      if (providerLoads.get(fallbackPath) === settledEntry) providerLoads.delete(fallbackPath)
    }
    entry.promise.then(markSettled, markSettled)
  }

  const consumerEntry = entry
  return attachJournalLoadConsumer(consumerEntry, signal, () => {
    if (providerLoads.get(fallbackPath) === consumerEntry) providerLoads.delete(fallbackPath)
    consumerEntry.controller.abort()
  })
}

/**
 * Let the current React effect flush enqueue its initial row loads, then wait
 * until every queued lookup/read has settled.
 */
export async function waitForInitialJournalLoads(queue = journalLoadQueue) {
  await Promise.resolve()
  await queue.onIdle()
}
