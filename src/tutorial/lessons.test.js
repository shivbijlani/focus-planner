import { describe, it, expect } from 'vitest'
import {
  LESSONS,
  LESSON_IDS,
  LESSON_STATUS,
  getLesson,
  emptyLessonProgress,
  normalizeLessonProgress,
  isLessonDone,
  nextLesson,
  completedCount,
  allDone,
  advanceLesson,
} from './lessons.js'

describe('lessons model', () => {
  it('exposes six ordered lessons ending in delegate-ai', () => {
    expect(LESSON_IDS).toEqual([
      'create-priority',
      'create-task',
      'create-journal',
      'add-todo',
      'promote-todo',
      'delegate-ai',
    ])
    expect(LESSONS[LESSONS.length - 1].id).toBe('delegate-ai')
  })

  it('getLesson returns a lesson or null', () => {
    expect(getLesson('add-todo').icon).toBe('☑️')
    expect(getLesson('nope')).toBeNull()
  })

  it('emptyLessonProgress starts everything not started with zero count', () => {
    const p = emptyLessonProgress()
    for (const id of LESSON_IDS) {
      expect(p[id]).toEqual({ status: LESSON_STATUS.NOT_STARTED, count: 0 })
    }
  })

  it('normalizeLessonProgress fills missing ids and drops junk', () => {
    const p = normalizeLessonProgress({
      'add-todo': { status: LESSON_STATUS.DONE, count: 1 },
      bogus: { status: 'x' },
    })
    expect(p['add-todo'].status).toBe(LESSON_STATUS.DONE)
    expect(p['create-task'].status).toBe(LESSON_STATUS.NOT_STARTED)
    expect(p.bogus).toBeUndefined()
  })

  it('normalizeLessonProgress coerces invalid status/count', () => {
    const p = normalizeLessonProgress({
      'create-task': { status: 'weird', count: 'nope' },
    })
    expect(p['create-task']).toMatchObject({
      status: LESSON_STATUS.NOT_STARTED,
      count: 0,
    })
  })

  it('multi-count lesson only completes at its target', () => {
    let p = emptyLessonProgress()
    p = advanceLesson(p, 'create-priority')
    expect(p['create-priority'].status).toBe(LESSON_STATUS.IN_PROGRESS)
    p = advanceLesson(p, 'create-priority')
    p = advanceLesson(p, 'create-priority')
    expect(p['create-priority'].status).toBe(LESSON_STATUS.DONE)
    expect(p['create-priority'].count).toBe(3)
    expect(isLessonDone(p, 'create-priority')).toBe(true)
  })

  it('advanceLesson is a no-op once done and does not overshoot', () => {
    let p = advanceLesson(emptyLessonProgress(), 'add-todo')
    expect(isLessonDone(p, 'add-todo')).toBe(true)
    const again = advanceLesson(p, 'add-todo')
    expect(again['add-todo'].count).toBe(1)
  })

  it('advanceLesson ignores unknown ids and returns a new map', () => {
    const p = emptyLessonProgress()
    const out = advanceLesson(p, 'not-real')
    expect(out).not.toBe(p)
    expect(completedCount(out)).toBe(0)
  })

  it('advanceLesson stamps firstDoneAt when completing', () => {
    const p = advanceLesson(emptyLessonProgress(), 'add-todo', '2026-01-01T00:00:00.000Z')
    expect(p['add-todo'].firstDoneAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('nextLesson walks the ladder in order', () => {
    let p = emptyLessonProgress()
    expect(nextLesson(p).id).toBe('create-priority')
    p = { ...p, 'create-priority': { status: LESSON_STATUS.DONE, count: 3 } }
    expect(nextLesson(p).id).toBe('create-task')
  })

  it('completedCount and allDone track the whole ladder', () => {
    let p = emptyLessonProgress()
    expect(completedCount(p)).toBe(0)
    expect(allDone(p)).toBe(false)
    for (const l of LESSONS) {
      for (let i = 0; i < l.target; i++) p = advanceLesson(p, l.id)
    }
    expect(completedCount(p)).toBe(LESSONS.length)
    expect(allDone(p)).toBe(true)
    expect(nextLesson(p)).toBeNull()
  })
})
