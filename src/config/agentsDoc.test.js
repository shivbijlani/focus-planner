import { describe, it, expect } from 'vitest'
import { scaffoldAgentsDoc, AGENTS_DOC, AGENTS_FILE, AGENTS_DOC_VERSION } from './agentsDoc.js'

// In-memory fake provider for exercising scaffoldAgentsDoc.
function fakeStore(initial = {}, { throwOnMissing = false } = {}) {
  const files = { ...initial }
  return {
    files,
    read: async (p) => {
      if (!(p in files)) {
        if (throwOnMissing) throw new Error('not found')
        return ''
      }
      return files[p]
    },
    write: async (p, c) => { files[p] = c },
  }
}

describe('AGENTS_DOC content', () => {
  it('embeds the current version marker', () => {
    expect(AGENTS_DOC).toContain(`planner-agents-doc v${AGENTS_DOC_VERSION}`)
  })
  it('documents the core journal markers', () => {
    expect(AGENTS_DOC).toContain('## YYYY-MM-DD')
    expect(AGENTS_DOC).toContain('<!-- from: name -->')
    expect(AGENTS_DOC).toContain('journal/task-XX.md')
  })
})

describe('scaffoldAgentsDoc', () => {
  it('writes AGENTS.md when missing (read returns empty)', async () => {
    const s = fakeStore()
    await scaffoldAgentsDoc(s.read, s.write)
    expect(s.files[AGENTS_FILE]).toBe(AGENTS_DOC)
  })

  it('writes AGENTS.md when the provider throws on a missing file', async () => {
    const s = fakeStore({}, { throwOnMissing: true })
    await scaffoldAgentsDoc(s.read, s.write)
    expect(s.files[AGENTS_FILE]).toBe(AGENTS_DOC)
  })

  it('does not overwrite an up-to-date doc (no churn)', async () => {
    const current = `# AGENTS.md\n<!-- planner-agents-doc v${AGENTS_DOC_VERSION} -->\nuser tweaked this`
    const s = fakeStore({ [AGENTS_FILE]: current })
    let writes = 0
    const write = async (p, c) => { writes++; s.files[p] = c }
    await scaffoldAgentsDoc(s.read, write)
    expect(writes).toBe(0)
    expect(s.files[AGENTS_FILE]).toBe(current)
  })

  it('refreshes an older-version doc', async () => {
    const old = '# AGENTS.md\n<!-- planner-agents-doc v0 -->\nstale'
    const s = fakeStore({ [AGENTS_FILE]: old })
    await scaffoldAgentsDoc(s.read, s.write)
    expect(s.files[AGENTS_FILE]).toBe(AGENTS_DOC)
  })

  it('never throws when write fails', async () => {
    const read = async () => ''
    const write = async () => { throw new Error('disk full') }
    await expect(scaffoldAgentsDoc(read, write)).resolves.toBeUndefined()
  })
})
