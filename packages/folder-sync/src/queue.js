// Dirty-file queue — persisted in IndexedDB so writes survive reloads.
// Key: filename. Value: { enqueuedAt }.

import { idbGet, idbSet, idbDel, idbKeys } from './idb.js'

const STORE = 'queue'

export async function enqueue(filename) {
  await idbSet(STORE, filename, { enqueuedAt: Date.now() })
}

export async function dequeue(filename) {
  await idbDel(STORE, filename)
}

export async function peekAll() {
  return idbKeys(STORE)
}

export async function has(filename) {
  return (await idbGet(STORE, filename)) != null
}
