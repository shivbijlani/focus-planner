import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  advertiseDiagnosticsToWorker,
  clearDiagnostics,
  diag,
  dumpDiagnostics,
  enableDiagnostics,
  ingestRelayedEvents,
  isDiagEnabled,
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

  it('keeps the CDP buffer bounded as a ring', () => {
    setDiagnosticsLimit(2)
    enableDiagnostics({ persist: false })

    diag('sync', 'one')
    diag('sync', 'two')
    diag('sync', 'three')

    expect(dumpDiagnostics().map((item) => item.event)).toEqual(['two', 'three'])
  })

  it('emits one lightweight console record per event', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const table = vi.spyOn(console, 'table').mockImplementation(() => {})
    resetDiagnosticsForTests()
    enableDiagnostics({ persist: false })

    diag('folder-sync.reconcile', 'mirror-reconcile-summary', { scanned: 700 })

    expect(debug).toHaveBeenCalledTimes(1)
    expect(table).not.toHaveBeenCalled()
    debug.mockRestore()
    table.mockRestore()
  })

  it('keeps relayed worker events in the buffer without echoing them to CDP', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    resetDiagnosticsForTests()
    enableDiagnostics({ persist: false })

    ingestRelayedEvents([
      { channel: 'folder-sync', event: 'one', fields: { path: 'a' } },
      { channel: 'folder-sync', event: 'two', fields: { path: 'b' } },
    ])

    expect(debug).not.toHaveBeenCalled()
    expect(dumpDiagnostics().map(item => item.event)).toEqual(['one', 'two'])
    debug.mockRestore()
  })

  it('batches a burst of worker events into one client lookup and message', async () => {
    vi.useFakeTimers()
    const client = { postMessage: vi.fn() }
    const matchAll = vi.fn().mockResolvedValue([client])
    globalThis.self = {
      addEventListener: vi.fn(),
      clients: { matchAll },
    }
    resetDiagnosticsForTests()
    enableDiagnostics({ persist: false })

    for (let i = 0; i < 500; i++) diag('folder-sync', `event-${i}`)
    expect(matchAll).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()

    expect(matchAll).toHaveBeenCalledTimes(1)
    expect(client.postMessage).toHaveBeenCalledTimes(1)
    expect(client.postMessage.mock.calls[0][0].type).toBe('planner-diag-batch')
    expect(client.postMessage.mock.calls[0][0].events).toHaveLength(250)
    expect(client.postMessage.mock.calls[0][0].events[0].event).toBe('event-250')
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
