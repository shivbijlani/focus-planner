import { describe, it, expect } from 'vitest'
import {
  telegramDeepLink,
  parseTgMeta,
  parseTgLink,
  buildTgMetaMarker,
  upsertTgMetaMarker,
} from './deepLink.js'

describe('telegramDeepLink', () => {
  it('builds a private supergroup link by stripping the -100 prefix', () => {
    expect(telegramDeepLink({ chatId: '-1004310604015', threadId: 17 })).toBe(
      'https://t.me/c/4310604015/17',
    )
  })

  it('builds a public supergroup link from a username', () => {
    expect(telegramDeepLink({ username: 'my_group', threadId: 5 })).toBe(
      'https://t.me/my_group/5',
    )
    // Leading @ is tolerated.
    expect(telegramDeepLink({ username: '@my_group', threadId: 5 })).toBe(
      'https://t.me/my_group/5',
    )
  })

  it('prefers username over chatId when both are present', () => {
    expect(telegramDeepLink({ chatId: '-1004310604015', username: 'grp', threadId: 3 })).toBe(
      'https://t.me/grp/3',
    )
  })

  it('links to the group root when there is no thread', () => {
    expect(telegramDeepLink({ chatId: '-1004310604015' })).toBe('https://t.me/c/4310604015')
  })

  it('returns empty string when there is nothing to link to', () => {
    expect(telegramDeepLink({})).toBe('')
    expect(telegramDeepLink({ threadId: 9 })).toBe('')
    expect(telegramDeepLink()).toBe('')
  })
})

describe('parseTgMeta / parseTgLink', () => {
  it('parses a marker and computes the url', () => {
    const content = '# Task 42: Demo\n<!-- tg-meta chatId=-1004310604015 threadId=17 -->\n\nnotes'
    expect(parseTgMeta(content)).toEqual({
      chatId: '-1004310604015',
      threadId: '17',
      username: '',
    })
    expect(parseTgLink(content)).toEqual({
      chatId: '-1004310604015',
      threadId: '17',
      username: '',
      url: 'https://t.me/c/4310604015/17',
    })
  })

  it('returns null when no marker is present', () => {
    expect(parseTgMeta('# Task 42: Demo\n\njust notes')).toBeNull()
    expect(parseTgLink('# Task 42: Demo\n\njust notes')).toBeNull()
    expect(parseTgMeta('')).toBeNull()
  })

  it('ignores unknown fields and tolerates quotes', () => {
    const content = '<!-- tg-meta chatId="-1004310604015" threadId=\'8\' extra=whatever -->'
    expect(parseTgMeta(content)).toEqual({
      chatId: '-1004310604015',
      threadId: '8',
      username: '',
    })
  })

  it('parseTgLink returns null when the marker cannot form a link', () => {
    // threadId only, no chat id or username -> no usable link.
    expect(parseTgLink('<!-- tg-meta threadId=8 -->')).toBeNull()
  })
})

describe('buildTgMetaMarker', () => {
  it('emits only the non-empty fields', () => {
    expect(buildTgMetaMarker({ chatId: '-100', threadId: 3 })).toBe(
      '<!-- tg-meta chatId=-100 threadId=3 -->',
    )
    expect(buildTgMetaMarker({ username: '@grp', threadId: 3 })).toBe(
      '<!-- tg-meta threadId=3 username=grp -->',
    )
  })
})

describe('upsertTgMetaMarker', () => {
  const journal = '# Task 42: Demo\n\nsome notes\n'

  it('inserts a new marker right under the first H1', () => {
    const out = upsertTgMetaMarker(journal, { chatId: '-1004310604015', threadId: 17 })
    expect(out).toBe(
      '# Task 42: Demo\n<!-- tg-meta chatId=-1004310604015 threadId=17 -->\n\nsome notes\n',
    )
  })

  it('prepends the marker when there is no H1', () => {
    const out = upsertTgMetaMarker('just notes', { chatId: '-100', threadId: 1 })
    expect(out).toBe('<!-- tg-meta chatId=-100 threadId=1 -->\njust notes')
  })

  it('replaces an existing marker in place', () => {
    const withMarker = upsertTgMetaMarker(journal, { chatId: '-100', threadId: 1 })
    const updated = upsertTgMetaMarker(withMarker, { chatId: '-100', threadId: 2 })
    expect(updated).toContain('threadId=2')
    expect(updated).not.toContain('threadId=1')
    // Only one marker ever exists.
    expect(updated.match(/tg-meta/g)).toHaveLength(1)
  })

  it('is idempotent when nothing changes', () => {
    const once = upsertTgMetaMarker(journal, { chatId: '-100', threadId: 1 })
    const twice = upsertTgMetaMarker(once, { chatId: '-100', threadId: 1 })
    expect(twice).toBe(once)
  })
})
