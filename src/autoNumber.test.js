import { describe, it, expect } from 'vitest'
import { opAddTask } from './focusPlanOps.js'

// Regression test for issue #22.
// When a task is added with an ADO/external-ticket URL the row is stored as
// `<localId>,[<adoId>](<url>)`. The auto-numbering for subsequent tasks must
// continue off the local ID, not jump to the (potentially huge) ADO ticket #.
describe('auto-numbering after adding an ADO-linked task', () => {
  const emptyPlan = [
    '## Today',
    '',
    '| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |',
    '|---|---|---|---|---|---|',
    '',
    '## Tomorrow',
    '',
    '| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |',
    '|---|---|---|---|---|---|',
    '',
  ].join('\n')

  it('continues local numbering after a task with an ADO link', () => {
    let r = opAddTask(emptyPlan, { task: 'first', priority: '🟡', linkedTask: '', section: 'Today' }, 0)
    expect(r.newId).toBe(1)

    r = opAddTask(r.content, {
      task: 'second',
      priority: '🟡',
      linkedTask: 'https://dev.azure.com/outlookweb/Time%20and%20Places/_workitems/edit/429496',
      section: 'Today',
    }, 0)
    expect(r.newId).toBe(2)
    expect(r.content).toContain('2,[429496]')

    r = opAddTask(r.content, { task: 'third', priority: '🟡', linkedTask: '', section: 'Today' }, 0)
    expect(r.newId).toBe(3)
  })
})
