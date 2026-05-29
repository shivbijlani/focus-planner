// Mock provider — simulates a remote backend purely in IndexedDB.
//
// Useful for local development and testing the engine + service-worker round
// trip without any real OAuth or network. The "remote" lives in the `meta`
// store under keys `mock:<filename>` so both the main thread and the SW can
// inspect/mutate it.

import { idbGet, idbSet, idbDel, idbEntries } from '../idb.js'
import { setTokens } from '../auth/tokenStore.js'

const PROVIDER_ID = 'mock'
const META_STORE = 'meta'
const KEY_PREFIX = 'mock:'

export function mockProvider() {
  return {
    id: PROVIDER_ID,
    displayName: 'Mock (dev)',
    clientId: 'mock-client',

    // Main-thread: instantly "log in" with a fake token.
    startAuth: async () => {
      await setTokens(PROVIDER_ID, {
        accessToken: 'mock-token',
        refreshToken: 'mock-refresh',
        expiresAt: Date.now() + 86400_000,
      })
      // No redirect — just refresh so the engine picks up the new state.
      if (typeof window !== 'undefined') window.location.reload()
    },
    completeAuth: async () => false, // never called — we don't redirect

    // Isomorphic HTTP-like helpers (work in main + SW)
    listRemote,
    readRemote,
    writeRemote,
    deleteRemote,
    refresh: async () => ({
      accessToken: 'mock-token',
      refreshToken: 'mock-refresh',
      expiresAt: Date.now() + 86400_000,
    }),
  }
}

async function listRemote() {
  const all = await idbEntries(META_STORE)
  return all
    .filter(([key]) => typeof key === 'string' && key.startsWith(KEY_PREFIX))
    .map(([key, value]) => ({
      name: key.slice(KEY_PREFIX.length),
      mtime: value?.mtime || 0,
    }))
}

async function readRemote(_cfg, filename) {
  const rec = await idbGet(META_STORE, KEY_PREFIX + filename)
  return rec ? rec.content : null
}

async function writeRemote(_cfg, filename, contents) {
  const mtime = Date.now()
  await idbSet(META_STORE, KEY_PREFIX + filename, { content: contents, mtime })
  return { mtime }
}

async function deleteRemote(_cfg, filename) {
  await idbDel(META_STORE, KEY_PREFIX + filename)
}
