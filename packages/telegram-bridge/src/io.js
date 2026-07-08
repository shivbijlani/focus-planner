// Filesystem adapter for the bridge: enumerates task journals and reads/writes
// them as UTF-8. Kept separate from bridge.js so the orchestration can be
// tested with an in-memory io instead.

import fs from 'fs/promises'
import path from 'path'
import { taskIdFromFilename, journalFilename } from './journal.js'

export function createFsIo({ journalDir }) {
  return {
    async listJournals() {
      let entries
      try {
        entries = await fs.readdir(journalDir, { withFileTypes: true })
      } catch {
        return []
      }
      const journals = []
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const taskId = taskIdFromFilename(entry.name)
        if (taskId) journals.push({ taskId, filename: entry.name })
      }
      return journals
    },

    async readJournal(taskId) {
      return fs.readFile(path.join(journalDir, journalFilename(taskId)), 'utf-8')
    },

    async writeJournal(taskId, content) {
      await fs.writeFile(
        path.join(journalDir, journalFilename(taskId)),
        content,
        'utf-8',
      )
    },
  }
}
