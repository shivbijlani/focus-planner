import {
  isSupported, pickFolder, restoreFolder,
  readFile, writeFile, deleteFile,
  journalExists, parseTodos, listFiles,
  getMaxJournalId, scaffoldIfEmpty,
} from './fsa.js'

let _handle = null

export { isSupported, parseTodos }

export function getHandle() { return _handle }
export function hasHandle() { return _handle !== null }
export function folderName() { return _handle?.name || '' }

export async function pick() {
  const handle = await pickFolder()
  _handle = handle
  return handle
}

export async function restore() {
  const handle = await restoreFolder()
  _handle = handle
  return handle
}

export async function scaffold() {
  return scaffoldIfEmpty(_handle)
}

export async function read(path) {
  return readFile(_handle, path)
}

export async function write(path, content) {
  return writeFile(_handle, path, content)
}

export async function remove(path) {
  return deleteFile(_handle, path)
}

export async function checkJournal(taskId) {
  return journalExists(_handle, taskId)
}

export async function getTodos(path) {
  const content = await readFile(_handle, path)
  return parseTodos(content)
}

export async function getFiles() {
  return listFiles(_handle)
}

export async function maxJournalId() {
  return getMaxJournalId(_handle)
}
