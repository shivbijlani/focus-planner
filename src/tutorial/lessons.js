/**
 * Lesson model for the first-run tutorial.
 *
 * Each lesson is one core skill the user learns by *doing* it on a fake
 * ("training-wheels") task. The app tracks which lessons a user has completed
 * so that re-entering the tutorial can show what they already know and spawn a
 * fresh fake task for the next unlearned step — laddering all the way down to
 * the lowest-priority skill ("Plan better").
 *
 * This module is intentionally pure (no React / DOM) so it can be unit tested
 * and later reused by the shipped, data-layer-integrated version.
 */

export const LESSON_STATUS = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
}

// Ordered list — the tutorial ladders top-to-bottom.
export const LESSONS = [
  {
    id: 'create-priority',
    title: 'Set your life priorities',
    // Learn by tapping three ghost priority chips into existence.
    coach: 'These are your 3 life priorities. Everything you do should ladder up to one.',
    target: 3,
    icon: '🎯',
  },
  {
    id: 'create-task',
    title: 'Add a task that ladders up',
    coach: "Tasks that don't serve a priority are just noise. Tag this one to a priority.",
    target: 1,
    icon: '➕',
  },
  {
    id: 'create-journal',
    title: 'Open a journal',
    coach: 'Journals are where the work — and the AI — actually happen.',
    target: 1,
    icon: '📓',
  },
  {
    id: 'add-todo',
    title: 'Break it into to-dos',
    coach: 'Complex tasks need sub-tasks. Add a to-do inside the journal.',
    target: 1,
    icon: '☑️',
  },
  {
    id: 'promote-todo',
    title: 'Promote a to-do',
    coach: 'When a sub-task gets big, promote it into its own task.',
    target: 1,
    icon: '⬆️',
  },
  {
    id: 'delegate-ai',
    title: 'Hand it to AI',
    coach: 'Let AI finish the job. This opens it up on GitHub.',
    target: 1,
    icon: '✨',
  },
]

export const LESSON_IDS = LESSONS.map((l) => l.id)

export function getLesson(id) {
  return LESSONS.find((l) => l.id === id) || null
}

/** Build a fresh, all-not-started lessons map. */
export function emptyLessonProgress() {
  const lessons = {}
  for (const l of LESSONS) {
    lessons[l.id] = { status: LESSON_STATUS.NOT_STARTED, count: 0 }
  }
  return lessons
}

/** Merge a persisted (possibly partial / older) map onto the full schema. */
export function normalizeLessonProgress(input) {
  const base = emptyLessonProgress()
  if (!input || typeof input !== 'object') return base
  for (const id of LESSON_IDS) {
    const v = input[id]
    if (v && typeof v === 'object') {
      base[id] = {
        status: Object.values(LESSON_STATUS).includes(v.status)
          ? v.status
          : LESSON_STATUS.NOT_STARTED,
        count: Number.isFinite(v.count) ? v.count : 0,
        firstDoneAt: typeof v.firstDoneAt === 'string' ? v.firstDoneAt : undefined,
      }
    }
  }
  return base
}

export function isLessonDone(progress, id) {
  return progress?.[id]?.status === LESSON_STATUS.DONE
}

/**
 * The next lesson the user should learn: the first one (in ladder order) that
 * is not yet done. Returns null when every lesson is complete.
 */
export function nextLesson(progress) {
  const p = normalizeLessonProgress(progress)
  return LESSONS.find((l) => p[l.id].status !== LESSON_STATUS.DONE) || null
}

export function completedCount(progress) {
  const p = normalizeLessonProgress(progress)
  return LESSON_IDS.filter((id) => p[id].status === LESSON_STATUS.DONE).length
}

export function allDone(progress) {
  return completedCount(progress) === LESSONS.length
}

/**
 * Record progress on a lesson. Increments `count`; marks the lesson done once
 * `count` reaches the lesson's target. Idempotent-safe and returns a NEW map.
 */
export function advanceLesson(progress, id, nowIso = new Date().toISOString()) {
  const p = normalizeLessonProgress(progress)
  const lesson = getLesson(id)
  if (!lesson) return p
  const prev = p[id]
  if (prev.status === LESSON_STATUS.DONE) return p
  const count = prev.count + 1
  const done = count >= lesson.target
  p[id] = {
    status: done ? LESSON_STATUS.DONE : LESSON_STATUS.IN_PROGRESS,
    count,
    firstDoneAt: done ? nowIso : prev.firstDoneAt,
  }
  return p
}
