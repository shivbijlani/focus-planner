/**
 * FSA provider — wraps the existing fsa.js for desktop Chromium browsers.
 */
import {
  pickFolder, restoreFolder,
  readFile, writeFile, deleteFile,
  journalExists, listFiles,
  getMaxJournalId, scaffoldIfEmpty,
} from './fsa.js'
import { get, set } from 'idb-keyval'

export class FSAProvider {
  constructor() {
    this._handle = null
  }

  folderName() { return this._handle?.name ?? '' }

  async pick() {
    this._handle = await pickFolder()
    return this._handle
  }

  async restore() {
    this._handle = await restoreFolder()
    return this._handle
  }

  async scaffold() {
    return scaffoldIfEmpty(this._handle)
  }

  async read(path) {
    return readFile(this._handle, path)
  }

  async write(path, content) {
    return writeFile(this._handle, path, content)
  }

  async remove(path) {
    return deleteFile(this._handle, path)
  }

  async getFiles() {
    return listFiles(this._handle)
  }

  async checkJournal(taskId) {
    return journalExists(this._handle, taskId)
  }

  async maxJournalId() {
    return getMaxJournalId(this._handle)
  }
}
