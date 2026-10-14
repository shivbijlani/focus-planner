import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(
  fileURLToPath(new URL('./App.jsx', import.meta.url)),
  'utf8',
)
const taskSectionSource = appSource.slice(
  appSource.indexOf('function TaskSection('),
  appSource.indexOf('function ManagerPrioritiesSection('),
)

describe('task-section journal wiring', () => {
  it('creates journals through the active source', () => {
    expect(taskSectionSource).toContain('onCreateJournal(taskId, taskName)')
    expect(appSource).toContain('await storage.write(journalPath, journalContent)')
  })

  it('registers seed candidates outside the collapsed-row render gate', () => {
    const registration = taskSectionSource.indexOf('registerInitialSeedCandidates')
    const openRowsGate = taskSectionSource.indexOf('{effectiveOpen && (')

    expect(registration).toBeGreaterThan(-1)
    expect(openRowsGate).toBeGreaterThan(registration)
  })
})
