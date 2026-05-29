// Browser localStorage local adapter — default for any consumer.
// `prefix` namespaces keys so multiple apps can coexist on one origin.

export function browserStorageAdapter({ prefix = 'folder-sync:' } = {}) {
  const k = (name) => prefix + name

  return {
    id: 'browser-storage',
    displayName: 'Browser Storage',
    async init() { return true },
    async isReady() { return true },
    async getFolderName() { return 'Browser Storage' },

    async readFile(filename) {
      return localStorage.getItem(k(filename)) ?? ''
    },
    async writeFile(filename, contents) {
      localStorage.setItem(k(filename), contents)
      return { mtime: Date.now() }
    },
    async deleteFile(filename) {
      localStorage.removeItem(k(filename))
    },
    async listFiles() {
      const out = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith(prefix)) out.push(key.slice(prefix.length))
      }
      return out
    },
    async getMtime(filename) {
      const v = localStorage.getItem(k(filename) + ':mtime')
      return v ? parseInt(v) : null
    },
    async setMtime(filename, mtime) {
      localStorage.setItem(k(filename) + ':mtime', String(mtime))
    },
  }
}
