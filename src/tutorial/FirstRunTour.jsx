import { useEffect, useMemo, useState } from 'react'
import './tutorial.css'
import {
  LESSONS,
  nextLesson as resolveNextLesson,
  completedCount,
  isLessonDone,
} from './lessons.js'
import {
  getTutorialState,
  recordLesson,
  markGraduated,
  markDismissed,
  resetTutorialState,
} from './tutorialState.js'

// The three life priorities the tutorial seeds. "Plan better" is intentionally
// the lowest — the ladder bottoms out at getting better at planning itself.
const GHOST_PRIORITIES = [
  { id: 'health', label: 'Health', emoji: '🏃' },
  { id: 'relationships', label: 'Relationships', emoji: '❤️' },
  { id: 'plan-better', label: 'Plan better', emoji: '🧭' },
]

const FAKE_TASK = { id: '01', name: 'Go for a 20-min walk', priority: 'health' }
const FAKE_TODO = 'Pick a scenic route'
const PROMOTED_TASK = { id: '02', name: 'Pick a scenic route', priority: 'health' }

const DEFAULT_GITHUB_URL = 'https://github.com/shivbijlani/focus-planner/issues/88'

function priorityMeta(id) {
  return GHOST_PRIORITIES.find((p) => p.id === id) || GHOST_PRIORITIES[0]
}

export default function FirstRunTour({ onExit, githubUrl = DEFAULT_GITHUB_URL }) {
  const [state, setState] = useState(() => getTutorialState())
  const [stepIdx, setStepIdx] = useState(() => {
    const next = resolveNextLesson(getTutorialState().lessons)
    return next ? LESSONS.findIndex((l) => l.id === next.id) : 0
  })
  const [showBack, setShowBack] = useState(() => completedCount(getTutorialState().lessons) > 0)
  const [graduated, setGraduated] = useState(false)

  // Board model driven by the guided actions.
  const [chosen, setChosen] = useState([]) // priority ids committed
  const [tasks, setTasks] = useState([]) // {id,name,priority}
  const [journalTaskId, setJournalTaskId] = useState(null)
  const [todos, setTodos] = useState([]) // strings
  const [flash, setFlash] = useState('')

  const lesson = LESSONS[stepIdx]
  const done = state.lessons

  useEffect(() => {
    if (!flash) return undefined
    const t = setTimeout(() => setFlash(''), 1400)
    return () => clearTimeout(t)
  }, [flash])

  const progressPct = useMemo(
    () => Math.round((completedCount(done) / LESSONS.length) * 100),
    [done]
  )

  function celebrate(msg) {
    setFlash(msg)
  }

  function advanceTo(idx) {
    setTimeout(() => setStepIdx(idx), 650)
  }

  function complete(lessonId, nextIdx) {
    const s = recordLesson(lessonId)
    setState(s)
    if (nextIdx != null && nextIdx < LESSONS.length) advanceTo(nextIdx)
  }

  // --- Lesson actions -------------------------------------------------------
  function tapGhostPriority(p) {
    if (chosen.includes(p.id)) return
    const nextChosen = [...chosen, p.id]
    setChosen(nextChosen)
    const s = recordLesson('create-priority')
    setState(s)
    if (nextChosen.length >= 3) {
      celebrate('Priorities set 🎯')
      advanceTo(1)
    }
  }

  function tapAddTask() {
    if (tasks.some((t) => t.id === FAKE_TASK.id)) return
    setTasks([{ ...FAKE_TASK }])
    celebrate('Task laddered to Health ✅')
    complete('create-task', 2)
  }

  function tapJournal(taskId) {
    setJournalTaskId(taskId)
    celebrate('Journal opened 📓')
    complete('create-journal', 3)
  }

  function tapAddTodo() {
    if (todos.includes(FAKE_TODO)) return
    setTodos([FAKE_TODO])
    celebrate('Sub-task added ☑️')
    complete('add-todo', 4)
  }

  function tapPromoteTodo() {
    setTasks((prev) =>
      prev.some((t) => t.id === PROMOTED_TASK.id) ? prev : [...prev, { ...PROMOTED_TASK }]
    )
    setTodos([])
    setJournalTaskId(null)
    celebrate('Promoted to its own task ⬆️')
    complete('promote-todo', 5)
  }

  function tapDelegateAi() {
    complete('delegate-ai', LESSONS.length)
    try {
      window.open(githubUrl, '_blank', 'noopener')
    } catch {
      /* popup blocked in headless — the demo still graduates */
    }
    setTimeout(() => {
      markGraduated()
      setGraduated(true)
    }, 700)
  }

  function restart() {
    const s = resetTutorialState()
    setState(s)
    setChosen([])
    setTasks([])
    setTodos([])
    setJournalTaskId(null)
    setGraduated(false)
    setShowBack(false)
    setStepIdx(0)
  }

  function skip() {
    markDismissed()
    onExit && onExit()
  }

  // --- Sub-renders ----------------------------------------------------------
  const Header = (
    <header className="tour-header">
      <div className="tour-header-row">
        <span className="tour-kicker">Getting started</span>
        <button className="tour-skip" onClick={skip}>Skip</button>
      </div>
      <div className="tour-progress">
        <div className="tour-progress-bar">
          <div className="tour-progress-fill" style={{ transform: `scaleX(${progressPct / 100})` }} />
        </div>
        <span className="tour-progress-label">{completedCount(done)}/{LESSONS.length}</span>
      </div>
      <ol className="tour-checklist">
        {LESSONS.map((l, i) => {
          const isDone = isLessonDone(done, l.id)
          const active = i === stepIdx && !graduated
          return (
            <li
              key={l.id}
              className={`tour-check${isDone ? ' is-done' : ''}${active ? ' is-active' : ''}`}
              title={l.title}
            >
              <span className="tour-check-mark">{isDone ? '✅' : l.icon}</span>
            </li>
          )
        })}
      </ol>
    </header>
  )

  const PriorityChips = (
    <div className="tour-priorities">
      <div className="tour-section-label">Priorities</div>
      <div className="tour-chip-row">
        {GHOST_PRIORITIES.map((p) => {
          const committed = chosen.includes(p.id)
          const pulse = stepIdx === 0 && !committed
          return (
            <button
              key={p.id}
              className={`tour-chip${committed ? ' committed' : ' ghost'}${pulse ? ' pulse' : ''}`}
              onClick={() => stepIdx === 0 && tapGhostPriority(p)}
              disabled={stepIdx !== 0 && !committed}
            >
              <span className="chip-emoji">{p.emoji}</span>
              {p.label}
              {committed && <span className="chip-star">★</span>}
            </button>
          )
        })}
      </div>
    </div>
  )

  function TaskCard(task, idx) {
    const meta = priorityMeta(task.priority)
    const canJournal = stepIdx === 2 && idx === 0
    const canAi = stepIdx === 5 && idx === 0
    return (
      <div className={`tour-task${task.id === FAKE_TASK.id ? ' primary' : ''}`} key={task.id}>
        <span className="task-eisenhower" aria-hidden="true">🟡</span>
        <div className="task-main">
          <div className="task-name">{task.name}</div>
          <div className="task-tag" style={{ '--pill': meta.id }}>
            {meta.emoji} {meta.label}
          </div>
        </div>
        <div className="task-actions">
          <button
            className={`task-icon-btn${canJournal ? ' pulse' : ''}`}
            onClick={() => canJournal && tapJournal(task.id)}
            aria-label="Open journal"
          >📓</button>
          <button
            className={`task-icon-btn ai${canAi ? ' pulse' : ''}`}
            onClick={() => canAi && tapDelegateAi()}
            aria-label="Ask AI to finish"
          >✨</button>
        </div>
      </div>
    )
  }

  const AddTaskGhost = stepIdx === 1 && (
    <button className="tour-task ghost-task pulse" onClick={tapAddTask}>
      <span className="task-eisenhower">➕</span>
      <div className="task-main">
        <div className="task-name">Go for a 20-min walk</div>
        <div className="task-tag ghost">🏃 tag to Health →</div>
      </div>
    </button>
  )

  const Journal = journalTaskId && (
    <div className="tour-journal">
      <div className="journal-head">
        <button className="journal-back" onClick={() => setJournalTaskId(null)}>‹ Board</button>
        <span className="journal-title">📓 {FAKE_TASK.name}</span>
      </div>
      <div className="journal-thread">
        <div className="bubble me">Starting this — I&apos;ll break it down.</div>
        {todos.map((t) => (
          <div className="bubble me todo-bubble" key={t}>
            <label className="todo-line">
              <input type="checkbox" readOnly />
              <span>{t}</span>
            </label>
            {stepIdx === 4 && (
              <button className="promote-btn pulse" onClick={tapPromoteTodo}>⬆️ Promote to task</button>
            )}
          </div>
        ))}
      </div>
      {stepIdx === 3 && (
        <button className="journal-add-todo pulse" onClick={tapAddTodo}>☑️ Add a to-do</button>
      )}
    </div>
  )

  const Board = (
    <div className="tour-board">
      {PriorityChips}
      <div className="tour-section-label today-label">Today</div>
      <div className="tour-task-list">
        {tasks.map((t, i) => TaskCard(t, i))}
        {AddTaskGhost}
        {tasks.length === 0 && stepIdx < 1 && (
          <div className="tour-empty-hint">Your tasks will appear here.</div>
        )}
      </div>
    </div>
  )

  // --- Screens --------------------------------------------------------------
  if (graduated) {
    return (
      <div className="fp-tour graduated">
        {Header}
        <div className="tour-grad">
          <div className="grad-confetti" aria-hidden="true">🎉</div>
          <h2>You&apos;re ready.</h2>
          <p>You just learned the whole loop:</p>
          <ul className="grad-list">
            {LESSONS.map((l) => (
              <li key={l.id}><span>{l.icon}</span> {l.title}</li>
            ))}
          </ul>
          <p className="grad-note">
            Every task now ladders up to a priority — down to <strong>Plan better</strong>,
            where getting good at this pays off.
          </p>
          <div className="grad-actions">
            <button className="tour-primary" onClick={() => onExit && onExit()}>Start planning</button>
            <button className="tour-ghost-btn" onClick={restart}>Replay tutorial</button>
          </div>
        </div>
      </div>
    )
  }

  if (showBack) {
    return (
      <div className="fp-tour">
        {Header}
        <div className="tour-welcome-back">
          <h2>Welcome back 👋</h2>
          <p>Here&apos;s what you&apos;ve already learned:</p>
          <ul className="wb-list">
            {LESSONS.map((l) => (
              <li key={l.id} className={isLessonDone(done, l.id) ? 'done' : ''}>
                <span>{isLessonDone(done, l.id) ? '✅' : '⬜'}</span> {l.title}
              </li>
            ))}
          </ul>
          <p className="wb-next">Next up: <strong>{lesson?.title}</strong></p>
          <button className="tour-primary" onClick={() => setShowBack(false)}>Continue</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fp-tour">
      {Header}
      <div className="tour-stage">
        {Journal || Board}
        {flash && <div className="tour-flash">{flash}</div>}
      </div>
      <footer className="tour-coach">
        <span className="coach-icon">{lesson.icon}</span>
        <div className="coach-body">
          <div className="coach-title">{lesson.title}</div>
          <div className="coach-text">{lesson.coach}</div>
        </div>
      </footer>
    </div>
  )
}
