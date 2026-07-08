import { describe, it, expect } from 'vitest'
import {
  emptyState,
  setTopic,
  setLastPosted,
  setOffset,
  getTask,
  findTaskByTopic,
} from './state.js'

describe('state reducers', () => {
  it('sets and reads a topic mapping', () => {
    const s = emptyState()
    setTopic(s, '352', 5, '#352 \u00B7 Telegram')
    expect(getTask(s, '352')).toMatchObject({ topicId: 5, name: '#352 \u00B7 Telegram' })
  })

  it('preserves lastPostedHash when the topic is re-set', () => {
    const s = emptyState()
    setTopic(s, '352', 5, 'name')
    setLastPosted(s, '352', 'abc')
    setTopic(s, '352', 5, 'renamed')
    expect(getTask(s, '352')).toMatchObject({ topicId: 5, lastPostedHash: 'abc', name: 'renamed' })
  })

  it('tracks the update offset', () => {
    const s = emptyState()
    setOffset(s, 101)
    expect(s.updateOffset).toBe(101)
  })

  it('reverse-looks-up a task by topic id', () => {
    const s = emptyState()
    setTopic(s, '352', 7, 'a')
    setTopic(s, '360', 9, 'b')
    expect(findTaskByTopic(s, 9)).toBe('360')
    expect(findTaskByTopic(s, 99)).toBeNull()
  })
})
