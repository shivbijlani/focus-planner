import { useState } from 'react'
import { scrollToAndFlashTask } from './scrollToTask.js'
import { splitTaskRefs, stripCode, ACTIVE_TASKS_COLUMN } from './skillsSection.js'

/**
 * Read-only `## Skills` inventory (GH #188, board task #357).
 *
 * The planner *surfaces* skills; it never edits them — authoring stays in the
 * OneDrive skills library + harness junctions. So this section is deliberately
 * inert: no add/edit/delete affordances, no drag, no context menu, no row
 * actions. The only interactive elements are the `#123` task references, which
 * scroll to that row on the board via the same helper the Priorities section
 * uses.
 *
 * Search: skill rows are deliberately **excluded** from board search. The
 * search box filters task rows (`taskRowMatchesSearch` keys off `ID`/`Task`,
 * neither of which a skill row has), so this component simply never receives
 * the query — filtering it would silently hide skills for a query that was
 * only ever aimed at tasks.
 */

export function SkillsTaskRefs({ text, onNavigateToTask = scrollToAndFlashTask }) {
  const parts = splitTaskRefs(text)
  if (parts.length === 0) return null
  return (
    <>
      {parts.map((p, i) => (
        p.type === 'ref' ? (
          <span
            key={i}
            className="skill-task-ref"
            role="button"
            tabIndex={0}
            title={`Go to task #${p.value}`}
            onClick={() => onNavigateToTask(p.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onNavigateToTask(p.value)
              }
            }}
          >
            #{p.value}
          </span>
        ) : (
          <span key={i}>{p.value}</span>
        )
      ))}
    </>
  )
}

export default function SkillsSection({
  headers,
  rows,
  notes = [],
  defaultOpen = false,
  onNavigateToTask = scrollToAndFlashTask,
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className="task-section skills-section">
      <h2 className="section-header" onClick={() => setIsOpen(!isOpen)}>
        <span className="collapse-icon">{isOpen ? '▼' : '▶'}</span>
        Skills
        <span className="skills-count">{rows.length}</span>
      </h2>
      {isOpen && (
        <div className="task-table-container">
          {notes.length > 0 && (
            <div className="skills-notes">
              {notes.map((n, i) => <div key={i}>{n.replace(/^\*|\*$/g, '')}</div>)}
            </div>
          )}
          <table className="task-table skills-table">
            <thead>
              <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {headers.map((h, ci) => {
                    if (h === ACTIVE_TASKS_COLUMN) {
                      return (
                        <td key={ci}>
                          <SkillsTaskRefs text={row[h]} onNavigateToTask={onNavigateToTask} />
                        </td>
                      )
                    }
                    if (ci === 0) {
                      return <td key={ci}><code className="skill-name">{stripCode(row[h])}</code></td>
                    }
                    return <td key={ci} title={row[h]}>{row[h]}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
