// Filesystem adapter for the bridge: enumerates task journals and reads/writes
// them as UTF-8. Kept separate from bridge.js so the orchestration can be
// tested with an in-memory io instead.

import fs from 'fs/promises'
import path from 'path'
import { taskIdFromFilename, journalFilename } from './journal.js'

export function createFsIo({ journalDir, completedBoardPath, boardPath }) {
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

    // Returns the raw completed-board markdown, or '' if it isn't configured or
    // doesn't exist yet. Never throws — a missing board just means "nothing to
    // archive this run".
    async readCompletedBoard() {
      if (!completedBoardPath) return ''
      try {
        return await fs.readFile(completedBoardPath, 'utf-8')
      } catch {
        return ''
      }
    },

    // Returns the raw ACTIVE board markdown (planner.md), or '' if it isn't
    // configured or doesn't exist. Used to order the approval digest by the
    // user's own board (section + row order + urgency) rather than by task-ID
    // magnitude. Never throws — a missing board just means "no ranking signal",
    // and the digest falls back to newest-first.
    async readBoard() {
      if (!boardPath) return ''
      try {
        return await fs.readFile(boardPath, 'utf-8')
      } catch {
        return ''
      }
    },
  }
}
