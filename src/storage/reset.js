export const RESET_KEY = 'planner.reset-in-progress'
export const RESET_CONFIRMED_KEY = 'planner.reset-confirmed'
export const RESET_CONFIRMATION = 'Reset Planner and sign out? This clears this browser, including unsynced changes. Cloud backups and files on your computer are kept.'

export function isPlannerStorageKey(key) {
  return /^(fp[-:]|focus-planner|planner[.:-]|folder-sync[:.-]|od_|gd_|onedrive_|google-drive_)/.test(key)
}

function clearPreferences(storage) {
  for (const key of Object.keys(storage)) {
    if (key !== RESET_KEY && isPlannerStorageKey(key)) storage.removeItem(key)
  }
}

export async function clearBrowserDatabase(name, indexedDb = indexedDB) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDb.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const stores = [...db.objectStoreNames]
    if (!stores.length) return
    await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite')
      for (const name of stores) {
        const store = tx.objectStore(name)
        if (db.name === 'keyval-store') {
          const request = store.openCursor()
          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) return
            if (String(cursor.key).startsWith('focus-planner-dir-handle')) cursor.delete()
            cursor.continue()
          }
        } else store.clear()
      }
      tx.oncomplete = resolve
      tx.onabort = tx.onerror = () => reject(tx.error || new Error(`Could not clear ${name}`))
    })
  } finally { db.close() }
}

export function pauseSyncWorker(worker, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const finish = (error) => {
      clearTimeout(timer)
      channel.port1.close()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error(
      'Backup has not confirmed it stopped. Nothing has been cleared. Close other Planner windows, update the app, and retry.',
    )), timeoutMs)
    channel.port1.onmessage = ({ data }) => {
      if (data?.paused) finish()
      else finish(new Error(data?.error || 'Backup did not confirm it stopped.'))
    }
    try { worker.postMessage({ type: 'pause-for-reset' }, [channel.port2]) }
    catch (error) { channel.port2.close(); finish(error) }
  })
}

async function activeWorker(registration) {
  if (registration.active) return registration.active
  const worker = registration.installing || registration.waiting
  if (!worker) throw new Error('Backup worker is unavailable. Reload this reset page and retry.')
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer)
      worker.removeEventListener('statechange', changed)
      if (error) reject(error)
      else resolve(worker)
    }
    const changed = () => {
      if (worker.state === 'activated') finish()
      else if (worker.state === 'redundant') finish(new Error('Backup worker was replaced. Retry reset.'))
    }
    const timer = setTimeout(() => finish(new Error('Backup worker did not activate. Retry reset.')), 15_000)
    worker.addEventListener('statechange', changed)
    changed()
  })
}

// Run only on the standalone reset page, where no app or sync engine is mounted.
export async function resetBrowser({
  serviceWorker = navigator.serviceWorker,
  local = localStorage,
  session = sessionStorage,
  indexedDb = indexedDB,
  pause = pauseSyncWorker,
} = {}) {
  let markerNeedsSpace = false
  try { local.setItem(RESET_KEY, '1') }
  catch (error) {
    if (error.name !== 'QuotaExceededError') throw error
    markerNeedsSpace = true
  }
  if (!serviceWorker) throw new Error('A service worker is required to stop backup safely. Nothing has been cleared.')
  const registrations = await serviceWorker.getRegistrations()
  const syncRegistration = registrations.find(r => new URL(r.scope).pathname.endsWith('/folder-sync/'))
    || await serviceWorker.register('./folder-sync/sw.js', { type: 'module', scope: './folder-sync/' })
  await pause(await activeWorker(syncRegistration))
  // Legacy fp-file copies can fill localStorage completely. Only free their
  // space after the worker has stopped and checked that no other app is open.
  if (markerNeedsSpace) {
    clearPreferences(local)
    local.setItem(RESET_KEY, '1')
  }
  // Recheck after the marker exists so a client that opened during marker
  // recovery cannot keep writing while local databases are cleared.
  await pause(await activeWorker(syncRegistration))
  if (!await syncRegistration.unregister()) throw new Error('Could not unregister the stopped backup worker. Retry reset.')
  // Never call engine.deleteFile/provider.remove: those propagate deletions to the cloud.
  await clearBrowserDatabase('folder-sync', indexedDb)
  await clearBrowserDatabase('focus-planner', indexedDb)
  await clearBrowserDatabase('keyval-store', indexedDb)
  clearPreferences(local)
  clearPreferences(session)
  local.removeItem(RESET_KEY)
}
