// File System Access API local adapter.
// Persists the directory handle in IndexedDB (store: 'fsa', key: 'dir').

import { idbGet, idbSet } from '../idb.js'

const HANDLE_KEY = 'dir'

export function fsaAdapter() {
  let dirHandle = null

  async function ensureHandle() {
    if (dirHandle) return dirHandle
    dirHandle = await idbGet('fsa', HANDLE_KEY)
    return dirHandle
  }

  async function chooseFolder() {
    if (!window.showDirectoryPicker) throw new Error('File System Access API not available')
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
    await idbSet('fsa', HANDLE_KEY, dirHandle)
    return dirHandle
  }

  async function verifyPermission() {
    const h = await ensureHandle()
    if (!h) return false
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
    return (await h.requestPermission({ mode: 'readwrite' })) === 'granted'
  }

  return {
    id: 'fsa',
    displayName: 'Local Folder',
    chooseFolder,
    async init() {
      const h = await ensureHandle()
      if (!h) return false
      return verifyPermission()
    },
    async isReady() {
      const h = await ensureHandle()
      if (!h) return false
      return (await h.queryPermission({ mode: 'readwrite' })) === 'granted'
    },
    async getFolderName() {
      const h = await ensureHandle()
      return h ? h.name : 'No folder selected'
    },
    async readFile(filename) {
      const h = await ensureHandle()
      if (!h) return ''
      try {
        const fh = await h.getFileHandle(filename)
        const f = await fh.getFile()
        return await f.text()
      } catch (e) {
        if (e.name === 'NotFoundError') return ''
        throw e
      }
    },
    async writeFile(filename, contents) {
      const h = await ensureHandle()
      const fh = await h.getFileHandle(filename, { create: true })
      const w = await fh.createWritable()
      await w.write(contents)
      await w.close()
      return { mtime: Date.now() }
    },
    async deleteFile(filename) {
      const h = await ensureHandle()
      try { await h.removeEntry(filename) } catch (e) {
        if (e.name !== 'NotFoundError') throw e
      }
    },
    async listFiles() {
      const h = await ensureHandle()
      if (!h) return []
      const out = []
      for await (const [name, entry] of h.entries()) {
        if (entry.kind === 'file') out.push(name)
      }
      return out
    },
    async getMtime(filename) {
      const h = await ensureHandle()
      if (!h) return null
      try {
        const fh = await h.getFileHandle(filename)
        const f = await fh.getFile()
        return f.lastModified
      } catch { return null }
    },
    async setMtime() { /* fs sets it automatically on write */ },
  }
}
