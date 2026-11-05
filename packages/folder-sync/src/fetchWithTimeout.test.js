import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout } from './fetchWithTimeout.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('cloud request deadline', () => {
  it('attaches a 30-second abort deadline to a stalled request', async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
    })))
    const request = fetchWithTimeout('https://example.test/cloud')
    const failure = expect(request).rejects.toThrow('Cloud request timed out')
    deadline.abort(new DOMException('Cloud request timed out', 'TimeoutError'))
    await failure
    expect(timeout).toHaveBeenCalledWith(30_000)
  })

  it('keeps the deadline live after headers arrive and preserves caller cancellation', async () => {
    const deadline = new AbortController()
    const caller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    let responseSignal
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { responseSignal = init.signal; return { ok: true } }))
    expect(await fetchWithTimeout('https://example.test/cloud', { method: 'PUT', body: 'content', signal: caller.signal })).toEqual({ ok: true })
    expect(responseSignal.aborted).toBe(false)
    deadline.abort(new DOMException('body timed out', 'TimeoutError'))
    expect(responseSignal.aborted).toBe(true)
    expect(responseSignal.reason.message).toBe('body timed out')

    const otherDeadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(otherDeadline.signal)
    await fetchWithTimeout('https://example.test/cloud', { signal: caller.signal })
    caller.abort(new Error('cancelled by caller'))
    expect(responseSignal.reason.message).toBe('cancelled by caller')
  })
})
