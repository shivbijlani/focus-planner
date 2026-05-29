// Token store — per-provider tokens persisted in IndexedDB.
// Shared between main thread (writes after OAuth) and service worker (reads + refresh).

import { idbGet, idbSet, idbDel } from '../idb.js'

const STORE = 'tokens'

/**
 * @typedef {object} TokenRecord
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} expiresAt  - epoch ms
 * @property {string} providerId
 * @property {object} [meta]
 */

export async function getTokens(providerId) {
  return (await idbGet(STORE, providerId)) || null
}

export async function setTokens(providerId, record) {
  await idbSet(STORE, providerId, { ...record, providerId })
}

export async function clearTokens(providerId) {
  await idbDel(STORE, providerId)
}

export function isExpired(record, skewMs = 60_000) {
  if (!record || !record.expiresAt) return true
  return Date.now() >= record.expiresAt - skewMs
}
