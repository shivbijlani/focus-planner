import { describe, expect, it } from 'vitest'

import {
  createLoadQueue,
  enqueueJournalLoad,
  waitForInitialJournalLoads,
} from './journalLoadQueue.js'

// A deferred promise plus a resolver we can trigger by hand, so tests can
// control exactly when each "read" finishes and assert ordering / concurrency.
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createLoadQueue', () => {
  it('runs work and resolves with its value', async () => {
    const q = createLoadQueue({ concurrency: 2 })
    const value = await q.enqueue('a', 0, () => 'hello')
    expect(value).toBe('hello')
  })

  it('never exceeds the concurrency limit', async () => {
    const q = createLoadQueue({ concurrency: 2 })
    let active = 0
    let maxActive = 0
    const gates = [deferred(), deferred(), deferred(), deferred()]

    const runs = gates.map((g, i) =>
      q.enqueue(`k${i}`, i, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await g.promise
        active--
      }),
    )

    await tick()
    expect(maxActive).toBe(2) // only 2 allowed to start
    gates.forEach((g) => g.resolve())
    await Promise.all(runs)
    expect(maxActive).toBe(2)
  })

  it('drains waiting work in ascending priority order', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    const order = []
    const first = deferred()

    // Occupy the single slot so the rest queue up behind it.
    const blocker = q.enqueue('blocker', -1, async () => { await first.promise })

    q.enqueue('c', 5, () => { order.push('c') })
    q.enqueue('a', 1, () => { order.push('a') })
    q.enqueue('b', 3, () => { order.push('b') })

    first.resolve()
    await blocker
    await tick()

    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('de-dupes concurrent reads of the same key into one run', async () => {
    const q = createLoadQueue({ concurrency: 4 })
    let calls = 0
    const gate = deferred()
    const run = async () => { calls++; await gate.promise; return 'shared' }

    const p1 = q.enqueue('same', 0, run)
    const p2 = q.enqueue('same', 0, run)
    expect(p1).toBe(p2) // same promise handed back

    gate.resolve()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(calls).toBe(1) // only fetched once
    expect(r1).toBe('shared')
    expect(r2).toBe('shared')
  })

  it('allows a fresh read of a key after the previous one settles', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    let calls = 0
    await q.enqueue('k', 0, () => { calls++ })
    await q.enqueue('k', 0, () => { calls++ })
    expect(calls).toBe(2) // dedupe is only for in-flight reads, not a cache
  })

  it('keeps draining after a task rejects', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    await expect(q.enqueue('bad', 0, () => { throw new Error('boom') })).rejects.toThrow('boom')
    const value = await q.enqueue('good', 0, () => 'ok')
    expect(value).toBe('ok')
  })

  it('does not de-dupe when key is null', async () => {
    const q = createLoadQueue({ concurrency: 4 })
    let calls = 0
    const gate = deferred()
    const run = async () => { calls++; await gate.promise }
    const p1 = q.enqueue(null, 0, run)
    const p2 = q.enqueue(null, 0, run)
    expect(p1).not.toBe(p2)
    gate.resolve()
    await Promise.all([p1, p2])
    expect(calls).toBe(2)
  })

  it('does not reuse an unfinished journal read across providers', async () => {
    const q = createLoadQueue({ concurrency: 2 })
    const sourceAGate = deferred()
    const sourceA = {
      checkJournal: async () => ({ exists: true, path: 'journal/task-1.md' }),
      read: async () => sourceAGate.promise,
    }
    const sourceB = {
      checkJournal: async () => ({ exists: true, path: 'journal/task-1.md' }),
      read: async () => 'source-b',
    }

    const fromA = enqueueJournalLoad({ queue: q, provider: sourceA, taskId: '1' })
    const fromB = enqueueJournalLoad({ queue: q, provider: sourceB, taskId: '1' })

    expect(fromA).not.toBe(fromB)
    await expect(fromB).resolves.toMatchObject({ content: 'source-b' })
    sourceAGate.resolve('source-a')
    await expect(fromA).resolves.toMatchObject({ content: 'source-a' })
  })

  it('releases stalled old-source slots when their rows unmount', async () => {
    const q = createLoadQueue({ concurrency: 4 })
    const never = new Promise(() => {})
    const sourceA = {
      checkJournal: async (taskId) => ({ exists: true, path: `journal/task-${taskId}.md` }),
      read: async () => never,
    }
    let sourceBReads = 0
    const sourceB = {
      checkJournal: async () => ({ exists: true, path: 'journal/task-1.md' }),
      read: async () => { sourceBReads++; return 'source-b' },
    }
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const oldLoads = controllers.map((controller, i) => enqueueJournalLoad({
      queue: q,
      provider: sourceA,
      taskId: String(i + 1),
      signal: controller.signal,
      timeoutMs: 1_000,
    }))
    await tick()
    expect(q.active).toBe(4)

    const newLoad = enqueueJournalLoad({ queue: q, provider: sourceB, taskId: '1' })
    await tick()
    expect(sourceBReads).toBe(0)

    controllers.forEach(controller => controller.abort())
    await Promise.allSettled(oldLoads)
    await expect(newLoad).resolves.toMatchObject({ content: 'source-b' })
    expect(sourceBReads).toBe(1)
  })

  it('keeps shared work alive when only one deduplicated consumer unmounts', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    const gate = deferred()
    let reads = 0
    const provider = {
      checkJournal: async () => ({ exists: true, path: 'journal/task-1.md' }),
      read: async () => { reads++; return gate.promise },
    }
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = enqueueJournalLoad({
      queue: q,
      provider,
      taskId: '1',
      signal: firstController.signal,
    })
    const second = enqueueJournalLoad({
      queue: q,
      provider,
      taskId: '1',
      signal: secondController.signal,
    })
    expect(first).not.toBe(second)
    await tick()
    expect(reads).toBe(1)

    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    firstController.abort()
    gate.resolve('shared')

    await firstRejected
    await expect(second).resolves.toMatchObject({ content: 'shared' })
    expect(reads).toBe(1)
  })

  it('starts viable work for a StrictMode-style rapid remount after abort', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    const never = new Promise(() => {})
    let reads = 0
    const provider = {
      checkJournal: async () => ({ exists: true, path: 'journal/task-1.md' }),
      read: async () => {
        reads++
        return reads === 1 ? never : 'remounted'
      },
    }
    const firstController = new AbortController()
    const first = enqueueJournalLoad({
      queue: q,
      provider,
      taskId: '1',
      signal: firstController.signal,
    })
    await tick()
    expect(reads).toBe(1)

    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    firstController.abort()
    const remounted = enqueueJournalLoad({
      queue: q,
      provider,
      taskId: '1',
      signal: new AbortController().signal,
    })
    expect(first).not.toBe(remounted)

    await firstRejected
    await expect(remounted).resolves.toMatchObject({ content: 'remounted' })
    expect(reads).toBe(2)
  })

  it('preserves known journal existence and path when content read fails', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    const provider = {
      checkJournal: async () => ({ exists: true, path: 'journal/task-1.md' }),
      read: async () => { throw new Error('content unavailable') },
    }

    await expect(enqueueJournalLoad({
      queue: q,
      provider,
      taskId: '1',
    })).rejects.toMatchObject({
      message: 'content unavailable',
      journal: { exists: true, path: 'journal/task-1.md' },
    })
  })

  it('aborts provider I/O when the shared deadline expires', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    let checkSignal
    let readSignal
    let readAborted = false
    const provider = {
      checkJournal: async (_taskId, options) => {
        checkSignal = options.signal
        return { exists: true, path: 'journal/task-1.md' }
      },
      read: async (_path, options) => {
        readSignal = options.signal
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            readAborted = true
            reject(options.signal.reason)
          }, { once: true })
        })
      },
    }

    await expect(enqueueJournalLoad({
      queue: q,
      provider,
      taskId: '1',
      timeoutMs: 10,
    })).rejects.toMatchObject({
      message: 'Journal load timed out after 10ms',
      journal: { exists: true, path: 'journal/task-1.md' },
    })

    expect(checkSignal).toBe(readSignal)
    expect(readSignal.aborted).toBe(true)
    expect(readAborted).toBe(true)
  })

  it('times out a stalled read so queue drain and seeding stay live', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    const stalledProvider = {
      checkJournal: async () => new Promise(() => {}),
    }
    const healthyProvider = {
      checkJournal: async () => ({ exists: true, path: 'journal/task-2.md' }),
      read: async () => 'healthy',
    }

    const stalled = enqueueJournalLoad({
      queue: q,
      provider: stalledProvider,
      taskId: '1',
      timeoutMs: 10,
    })
    const healthy = enqueueJournalLoad({ queue: q, provider: healthyProvider, taskId: '2' })
    const drain = waitForInitialJournalLoads(q)

    await expect(stalled).rejects.toThrow('timed out')
    await expect(healthy).resolves.toMatchObject({ content: 'healthy' })
    await expect(drain).resolves.toBeUndefined()
  })

  it('keeps initial seeding open until the initial queue drains', async () => {
    const q = createLoadQueue({ concurrency: 1 })
    const gate = deferred()
    let seedingComplete = false
    const order = []

    const drain = waitForInitialJournalLoads(q).then(() => {
      seedingComplete = true
      order.push('complete-seeding')
    })
    const load = q.enqueue('journal/task-1.md', 0, () => gate.promise)
      .then(() => { order.push('track-journal') })
    await tick()
    expect(seedingComplete).toBe(false)

    gate.resolve()
    await Promise.all([load, drain])
    expect(seedingComplete).toBe(true)
    expect(order).toEqual(['track-journal', 'complete-seeding'])
  })
})
