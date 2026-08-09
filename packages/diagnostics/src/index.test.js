import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  advertiseDiagnosticsToWorker,
  clearDiagnostics,
  diag,
  dumpAllDiagnostics,
  dumpDiagnostics,
  enableDiagnostics,
  findDiagnosticsWorker,
  handleWorkerDiagnosticMessage,
  isDiagEnabled,
  printDiagnostics,
  registerDiagSink,
  reconcileWorkerDiagnosticsForClients,
  resetDiagnosticsForTests,
  requestWorkerDiagnosticClientStates,
  setDiagnosticsLimit,
  setWorkerDiagnosticsForClient,
  unregisterDiagSink,
} from './index.js'

describe('diagnostics', () => {
  beforeEach(() => {
    resetDiagnosticsForTests()
    unregisterDiagSink('console')
    clearDiagnostics()
  })

  afterEach(() => {
    delete globalThis.self
    vi.useRealTimers()
    resetDiagnosticsForTests()
  })

  it('is a cheap no-op when disabled', () => {
    const seen = []
    registerDiagSink('test', (item) => seen.push(item))

    expect(diag('sync', 'event', { id: 1 })).toBe(false)

    expect(seen).toEqual([])
    expect(dumpDiagnostics()).toEqual([])
  })

  it('fans out enabled events to every registered sink', () => {
    const a = []
    const b = []
    registerDiagSink('a', (item) => a.push(item))
    registerDiagSink('b', (item) => b.push(item))
    enableDiagnostics({ persist: false })

    expect(diag('folder-sync.merge', 'record-decision', { id: 'r1' })).toBe(true)

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].channel).toBe('folder-sync.merge')
    expect(a[0].event).toBe('record-decision')
    expect(a[0].fields).toEqual({ id: 'r1' })
  })

  it('keeps each context buffer bounded as a ring', () => {
    setDiagnosticsLimit(2)
    enableDiagnostics({ persist: false })

    diag('sync', 'one')
    diag('sync', 'two')
    diag('sync', 'three')

    expect(dumpDiagnostics().map((item) => item.event)).toEqual(['two', 'three'])
  })

  it('records without emitting live console traffic', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const table = vi.spyOn(console, 'table').mockImplementation(() => {})
    resetDiagnosticsForTests()
    enableDiagnostics({ persist: false })

    diag('folder-sync.reconcile', 'mirror-reconcile-summary', { scanned: 700 })

    expect(debug).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(table).not.toHaveBeenCalled()
    debug.mockRestore()
    log.mockRestore()
    table.mockRestore()
  })

  it('uses a shared event schema with per-context correlation fields', () => {
    enableDiagnostics({ persist: false })
    diag('folder-sync', 'one', { path: 'a' })
    diag('folder-sync', 'two', { path: 'b' })

    const [first, second] = dumpDiagnostics()
    expect(first).toMatchObject({
      schema: 1,
      context: 'page',
      channel: 'folder-sync',
      event: 'one',
      sequence: 1,
    })
    expect(first.contextId).toMatch(/^page:/)
    expect(second.contextId).toBe(first.contextId)
    expect(second.sequence).toBe(2)
  })

  it('does not create console or client-message backpressure during a driven burst', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const matchAll = vi.fn()
    globalThis.self = {
      addEventListener: vi.fn(),
      clients: { matchAll },
    }
    resetDiagnosticsForTests()
    enableDiagnostics({ persist: false })

    const drivenActions = []
    for (let i = 0; i < 5000; i++) {
      diag('folder-sync', 'record-decision', { id: i })
      if (i % 1000 === 0) drivenActions.push(`click-${i}`)
    }

    expect(debug).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(matchAll).not.toHaveBeenCalled()
    expect(drivenActions).toEqual(['click-0', 'click-1000', 'click-2000', 'click-3000', 'click-4000'])
    expect(dumpDiagnostics()).toHaveLength(250)
    debug.mockRestore()
    log.mockRestore()
  })

  it('pulls the worker buffer only when dumpAll is requested', async () => {
    const workerEvent = {
      schema: 1,
      t: Date.now() - 1,
      context: 'worker',
      contextId: 'worker:test',
      sequence: 1,
      channel: 'folder-sync',
      event: 'worker-event',
      fields: { path: 'planner.md' },
    }
    enableDiagnostics({ persist: false })
    diag('ui', 'page-event')

    let pagePort
    const messageChannelFactory = () => ({
      port1: {
        start: vi.fn(),
        close: vi.fn(),
        set onmessage(handler) { pagePort = handler },
      },
      port2: { id: 'worker-port' },
    })
    const worker = {
      postMessage: vi.fn((message) => {
        pagePort({
          data: {
            type: 'planner-diag-dump-response',
            requestId: message.requestId,
            events: [workerEvent],
          },
        })
      }),
    }

    const snapshot = await dumpAllDiagnostics({ worker, messageChannelFactory })

    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    expect(worker.postMessage.mock.calls[0][0].type).toBe('planner-diag-dump-request')
    expect(snapshot.workerAvailable).toBe(true)
    expect(snapshot.page.map(item => item.event)).toEqual(['page-event'])
    expect(snapshot.worker.map(item => item.event)).toEqual(['worker-event'])
    expect(snapshot.events.map(item => item.event)).toEqual(['worker-event', 'page-event'])
  })

  it('selects the folder-sync worker instead of the root app worker', () => {
    const rootWorker = { scriptURL: 'https://planner.test/app-sw.js' }
    const syncWorker = { scriptURL: 'https://planner.test/folder-sync/sw.js' }

    expect(findDiagnosticsWorker([
      { scope: 'https://planner.test/', active: rootWorker },
      { scope: 'https://planner.test/folder-sync/', active: syncWorker },
    ])).toBe(syncWorker)
  })

  it('serves a worker dump through the request message port', () => {
    enableDiagnostics({ persist: false })
    diag('folder-sync', 'worker-event')
    const postMessage = vi.fn()

    expect(handleWorkerDiagnosticMessage({
      data: { type: 'planner-diag-dump-request', requestId: 'request-1' },
      ports: [{ postMessage }],
    })).toBe(true)

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'planner-diag-dump-response',
      requestId: 'request-1',
      events: [expect.objectContaining({ event: 'worker-event' })],
    }))
  })

  it('prints only an explicitly requested snapshot', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    enableDiagnostics({ persist: false })
    diag('ui', 'page-event')

    await printDiagnostics({ worker: null })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      '[planner:diagnostics] snapshot',
      expect.objectContaining({ events: [expect.objectContaining({ event: 'page-event' })] }),
    )
    log.mockRestore()
  })

  it('keeps worker diagnostics enabled while another client still requests them', () => {
    setWorkerDiagnosticsForClient('diag-tab', true)
    expect(isDiagEnabled()).toBe(true)

    setWorkerDiagnosticsForClient('normal-tab', false)
    expect(isDiagEnabled()).toBe(true)

    setWorkerDiagnosticsForClient('diag-tab', false)
    expect(isDiagEnabled()).toBe(false)
  })

  it('prunes a diagnostic client after its tab closes', () => {
    setWorkerDiagnosticsForClient('diag-tab', true)
    expect(isDiagEnabled()).toBe(true)

    reconcileWorkerDiagnosticsForClients(['normal-tab'])

    expect(isDiagEnabled()).toBe(false)
  })

  it('requests and re-advertises enabled state after a worker restart', async () => {
    const diagnosticPage = { id: 'diag-tab', postMessage: vi.fn() }
    await requestWorkerDiagnosticClientStates({
      matchAll: vi.fn().mockResolvedValue([diagnosticPage]),
    })
    expect(diagnosticPage.postMessage).toHaveBeenCalledWith({
      type: 'planner-diag-state-request',
    })

    const restartedWorker = { postMessage: vi.fn() }
    enableDiagnostics({ persist: false })

    expect(advertiseDiagnosticsToWorker(restartedWorker)).toBe(true)
    expect(restartedWorker.postMessage).toHaveBeenCalledWith({
      type: 'planner-diag-enable',
      enabled: true,
    })
  })
})
