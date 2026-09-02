import { describe, it, expect } from 'vitest'
import { createTelegramClient } from './telegramClient.js'

// A fetch stub that records calls and always returns { ok: true, result }.
function makeFetch(result = true) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) })
    return { status: 200, async json() { return { ok: true, result } } }
  }
  return { fetchImpl, calls }
}

describe('telegram client forum-topic archiving', () => {
  it('closeForumTopic posts chat_id + message_thread_id to closeForumTopic', async () => {
    const { fetchImpl, calls } = makeFetch()
    const client = createTelegramClient({ token: 't', fetchImpl })
    await client.closeForumTopic({ chatId: '-100', messageThreadId: 7 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/closeForumTopic')
    expect(calls[0].body).toEqual({ chat_id: '-100', message_thread_id: 7 })
  })

  it('reopenForumTopic posts chat_id + message_thread_id to reopenForumTopic', async () => {
    const { fetchImpl, calls } = makeFetch()
    const client = createTelegramClient({ token: 't', fetchImpl })
    await client.reopenForumTopic({ chatId: '-100', messageThreadId: 9 })
    expect(calls[0].url).toContain('/reopenForumTopic')
    expect(calls[0].body).toEqual({ chat_id: '-100', message_thread_id: 9 })
  })

  it('surfaces a Telegram API error description', async () => {
    const fetchImpl = async () => ({
      status: 400,
      async json() {
        return { ok: false, description: 'not enough rights to manage topics' }
      },
    })
    const client = createTelegramClient({ token: 't', fetchImpl })
    await expect(
      client.closeForumTopic({ chatId: '-100', messageThreadId: 7 }),
    ).rejects.toThrow(/not enough rights/)
  })
})

// Node's global fetch has no default timeout, so before this guard a stalled
// connection hung the bridge forever -- and the bridge runs inside every agent
// run, so that hung the run. These assert the deadline exists, is bounded, and
// fails with a NAMED error rather than silently.
describe('telegram client request deadline', () => {
  it('passes an AbortSignal so a stalled request cannot hang forever', async () => {
    const seen = []
    const fetchImpl = async (url, opts) => {
      seen.push(opts.signal)
      return { status: 200, async json() { return { ok: true, result: true } } }
    }
    const client = createTelegramClient({ token: 't', fetchImpl })
    await client.getMe()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })

  it('aborts a request that never settles, instead of awaiting forever', async () => {
    // Never resolves on its own: only the abort signal can end this.
    const fetchImpl = (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'TimeoutError'
          reject(err)
        })
      })
    const client = createTelegramClient({ token: 't', fetchImpl, timeoutMs: 20 })
    await expect(client.getMe()).rejects.toThrow(/timed out after/)
  })

  it('names the method and the budget in the timeout error', async () => {
    const fetchImpl = (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'TimeoutError'
          reject(err)
        })
      })
    const client = createTelegramClient({ token: 't', fetchImpl, timeoutMs: 20 })
    await expect(client.closeForumTopic({ chatId: '-100', messageThreadId: 7 })).rejects.toThrow(
      /Telegram closeForumTopic: timed out after \d+ ms \(budget 20 ms\)/,
    )
  })

  it('extends the budget by the long-poll window so getUpdates is not aborted early', async () => {
    // getUpdates(timeout: 25) asks Telegram to hold the connection for 25s. A fixed
    // transport deadline shorter than that would abort a request behaving correctly.
    // With timeoutMs=1 and NO long-poll extension the signal fires after ~1ms, so
    // waiting here and then reading `aborted` distinguishes the two implementations.
    let abortedAfterWait = null
    const fetchImpl = async (url, opts) => {
      await new Promise((r) => setTimeout(r, 60))
      abortedAfterWait = opts.signal.aborted
      return { status: 200, async json() { return { ok: true, result: [] } } }
    }
    const client = createTelegramClient({ token: 't', fetchImpl, timeoutMs: 1 })
    await client.getUpdates({ timeout: 25 })
    expect(abortedAfterWait).toBe(false)
  })

  it('still aborts a long-poll request once even its extended budget expires', async () => {
    // The extension must be a longer deadline, not the absence of one.
    const fetchImpl = (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'TimeoutError'
          reject(err)
        })
      })
    const client = createTelegramClient({ token: 't', fetchImpl, timeoutMs: 10 })
    // timeout: 0 -> budget is just timeoutMs, so this resolves quickly.
    await expect(client.getUpdates({ timeout: 0 })).rejects.toThrow(/timed out after/)
  })

  it('does not send a signal-less request even for a plain call', async () => {
    const seen = []
    const fetchImpl = async (url, opts) => {
      seen.push('signal' in opts)
      return { status: 200, async json() { return { ok: true, result: 1 } } }
    }
    const client = createTelegramClient({ token: 't', fetchImpl })
    await client.sendMessage({ chatId: '-100', text: 'hi' })
    expect(seen[0]).toBe(true)
  })
})

describe('rate-limit errors carry structured data (#172)', () => {
  const errFetch = (payload, status = 429) => async () => ({
    status,
    json: async () => payload,
  })

  it('surfaces retry_after as a number on the error, not only in the message', async () => {
    const client = createTelegramClient({
      token: 't',
      fetchImpl: errFetch({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 41',
        parameters: { retry_after: 41 },
      }),
    })
    await expect(client.sendMessage({ chatId: '-100', text: 'hi' })).rejects.toMatchObject({
      retryAfter: 41,
      isRateLimit: true,
      errorCode: 429,
      telegramMethod: 'sendMessage',
    })
  })

  it('flags a rate limit even when parameters are missing', async () => {
    const client = createTelegramClient({
      token: 't',
      fetchImpl: errFetch({ ok: false, error_code: 429, description: 'Too Many Requests' }),
    })
    const err = await client.sendMessage({ chatId: '-100', text: 'hi' }).catch((e) => e)
    expect(err.isRateLimit).toBe(true)
    expect(err.retryAfter).toBeUndefined()
  })

  it('does not flag an ordinary API error as a rate limit', async () => {
    const client = createTelegramClient({
      token: 't',
      fetchImpl: errFetch({ ok: false, error_code: 400, description: "can't parse entities" }, 400),
    })
    const err = await client.sendMessage({ chatId: '-100', text: 'hi' }).catch((e) => e)
    expect(err.isRateLimit).toBe(false)
    expect(err.message).toMatch(/can't parse entities/)
  })
})
