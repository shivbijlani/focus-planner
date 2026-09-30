import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAuthResponseParams, recentAutoReconnects } from './engine.js'

afterEach(() => vi.unstubAllGlobals())

describe('recentAutoReconnects (redirect-loop guard)', () => {
  it('counts only attempts inside the 10-minute window', () => {
    const now = 1_000_000_000
    const store = { 'folder-sync:auto-reconnect-log:google-drive': JSON.stringify([now - 11 * 60_000, now - 60_000, now - 1000]) }
    vi.stubGlobal('sessionStorage', { getItem: k => store[k] ?? null })
    expect(recentAutoReconnects('google-drive', now)).toEqual([now - 60_000, now - 1000])
    expect(recentAutoReconnects('onedrive', now)).toEqual([])
  })

  it('tolerates a corrupt log', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => '{not json' })
    expect(recentAutoReconnects('google-drive')).toEqual([])
  })
})

describe('readAuthResponseParams', () => {
  it('reads an auth-code response from the query string (OneDrive)', () => {
    const p = readAuthResponseParams({ search: '?code=abc&state=s', hash: '' })
    expect(p.get('code')).toBe('abc')
    expect(p.fromFragment).toBe(false)
  })

  it('reads a token-model response from the fragment (Google)', () => {
    const p = readAuthResponseParams({ search: '', hash: '#access_token=tok&expires_in=3599&state=s' })
    expect(p.get('access_token')).toBe('tok')
    expect(p.get('state')).toBe('s')
    expect(p.fromFragment).toBe(true)
  })

  it('reads a failed silent renewal from the fragment so it can be cleaned up', () => {
    const p = readAuthResponseParams({ search: '', hash: '#error=interaction_required&state=s' })
    expect(p.get('error')).toBe('interaction_required')
  })

  it('ignores ordinary URLs and fragments without state', () => {
    expect(readAuthResponseParams({ search: '', hash: '' })).toBeNull()
    expect(readAuthResponseParams({ search: '?code=abc', hash: '' })).toBeNull()
    expect(readAuthResponseParams({ search: '', hash: '#access_token=tok' })).toBeNull()
    expect(readAuthResponseParams({ search: '', hash: '#section-2' })).toBeNull()
  })
})
