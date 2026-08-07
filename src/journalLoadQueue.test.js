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
