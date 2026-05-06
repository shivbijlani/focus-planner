/**
 * FSA provider — wraps the existing fsa.js for desktop Chromium browsers.
 */
import {
  pickFolder, restoreFolder, forgetFolder,
  readFile, writeFile, deleteFile,
  journalExists, listFiles,
  getMaxJournalId, scaffoldIfEmpty,
} from './fsa.js'

export class FSAProvider {
  constructor(sourceId) {
    this._handle = null
    this._sourceId = sourceId || null
  }

  folderName() { return this._handle?.name ?? '' }

  async pick() {
    this._handle = await pickFolder(this._sourceId)
    return this._handle
  }

  async restore() {
    this._handle = await restoreFolder(this._sourceId)
    return this._handle
  }

  async forget() {
    await forgetFolder(this._sourceId)
    this._handle = null
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
