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
  const inflight = new Map() // key -> Promise (de-dupe while running/queued)
  let active = 0

  // Enqueue `run` (a thunk returning a value or promise). Lower `priority`
  // numbers run earlier. If `key` is non-null and an identical read is already
  // queued or running, the existing promise is returned instead of scheduling
  // a duplicate fetch.
  function enqueue(key, priority, run) {
    if (key != null && inflight.has(key)) return inflight.get(key)

    const p = new Promise((resolve, reject) => {
      pending.push({ key, priority: priority ?? 0, run, resolve, reject })
    })
    if (key != null) inflight.set(key, p)
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
          (value) => { settle(item.key); item.resolve(value) },
          (err) => { settle(item.key); item.reject(err) },
        )
    }
  }

  function settle(key) {
    active--
    if (key != null) inflight.delete(key)
    drain()
  }

  return {
    enqueue,
    get size() { return pending.length },
    get active() { return active },
  }
}

// Shared board-wide queue. Concurrency of 4 keeps a handful of reads in flight
// (enough to stay responsive) without stampeding the storage provider.
export const journalLoadQueue = createLoadQueue({ concurrency: 4 })
