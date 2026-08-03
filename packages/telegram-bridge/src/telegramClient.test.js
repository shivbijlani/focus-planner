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
