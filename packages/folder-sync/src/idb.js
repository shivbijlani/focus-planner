// Minimal IndexedDB helper — works in both window and ServiceWorker contexts.
// Single DB per origin: 'folder-sync'. Object stores: 'tokens', 'queue', 'meta', 'fsa'.

const DB_NAME = 'folder-sync'
const DB_VERSION = 1
const STORES = ['tokens', 'queue', 'meta', 'fsa']

let dbPromise = null

export function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name)
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export async function idbGet(store, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbSet(store, key, value) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// Compare and commit a snapshot in one transaction. A worker that read before a
// page's edit must retry its merge, never overwrite that edit with old content.
export async function idbCompareAndSet(store, expected, writes) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    const objectStore = tx.objectStore(store)
    let matches = true
    let remaining = expected.length
    const commit = () => {
      if (matches) {
        for (const [key, value] of writes) objectStore.put(value, key)
      }
    }
    if (!remaining) commit()
    for (const [key, value] of expected) {
      const req = objectStore.get(key)
      req.onsuccess = () => {
        if (JSON.stringify(req.result) !== JSON.stringify(value)) matches = false
        if (--remaining === 0) commit()
      }
    }
    tx.oncomplete = () => resolve(matches)
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB snapshot commit failed'))
  })
}

export async function idbDel(store, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function idbKeys(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAllKeys()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbEntries(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const keysReq = tx.objectStore(store).getAllKeys()
    const valuesReq = tx.objectStore(store).getAll()
    let keys, values
    keysReq.onsuccess = () => { keys = keysReq.result }
    valuesReq.onsuccess = () => { values = valuesReq.result }
    tx.oncomplete = () => resolve(keys.map((k, i) => [k, values[i]]))
    tx.onerror = () => reject(tx.error)
  })
}
