/**
 * FSA provider — wraps the existing fsa.js for desktop Chromium browsers.
 */
import {
  pickFolder, restoreFolder, forgetFolder,
  readFile, writeFile, deleteFile,
  journalExists, listFiles,
  getMaxJournalId, getJournalIds, scaffoldIfEmpty,
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
    // The directory handle may be null if this instance hasn't been restored
    // yet (e.g. a freshly lazy-created provider). Restore on demand so listing
    // never crashes on a null handle.
    if (!this._handle) await this.restore().catch(() => null)
    return listFiles(this._handle)
  }

  async checkJournal(taskId) {
    return journalExists(this._handle, taskId)
  }

  async maxJournalId() {
    return getMaxJournalId(this._handle)
  }

  async journalIds() {
    return getJournalIds(this._handle)
  }
}
