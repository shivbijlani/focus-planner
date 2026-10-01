/**
 * StoragePicker — shown on first visit or when no storage is configured.
 * Lets user choose Local Folder, OneDrive, or Google Drive.
 */
import { useState, useCallback } from 'react'
import { PROVIDERS, getProviderName } from './storage/storage.js'
import { getEnabledProviderTypes } from './storage/registry.js'
import {
  createSourceDescriptor,
  clearPendingSource,
  getSources,
  getActiveSourceId,
  getProvider,
  makeProviderFor,
  removeSource,
  saveSource,
  setActiveSource,
  setPendingSource,
} from './storage/sources.js'
import { findSavedSourceForProvider } from './storage/sourceRecovery.js'

export function StoragePicker({ onReady }) {
  const [availableProviders] = useState(getEnabledProviderTypes)
  const [connecting, setConnecting] = useState(null) // provider id being connected
  const [error, setError] = useState('')

  const tryConnect = useCallback(async (id) => {
    setConnecting(id)
    setError('')
    try {
      const existing = findSavedSourceForProvider(getSources(), id, getActiveSourceId())
      const source = existing || createSourceDescriptor({ providerType: id })
      const provider = existing ? getProvider(source.id) : makeProviderFor(source)
      if (id === PROVIDERS.FSA) {
        const handle = await provider.pick()
        if (!handle) { setConnecting(null); return }
        await provider.scaffold()
      } else if (id === PROVIDERS.LOCAL_STORAGE) {
        if (!await provider.restore()) throw new Error('Browser Storage is unavailable')
        await provider.scaffold()
      } else {
        if (!existing) saveSource(source, provider)
        setPendingSource(source.id, { created: !existing })
        try {
          await provider.pick()
        } catch (error) {
          clearPendingSource(source.id)
          if (!existing) removeSource(source.id)
          throw error
        }
        return
      }
      if (!existing) saveSource(source, provider)
      await setActiveSource(source.id)
      onReady(id)
    } catch (e) {
      if (!e.message?.includes('Redirecting')) {
        setError(e.message || 'Connection failed')
        setConnecting(null)
      }
    }
  }, [onReady])

  const handlePick = async (id) => {
    await tryConnect(id)
  }

  const descriptions = {
    [PROVIDERS.FSA]: 'Store files locally on this device. Works in Chrome & Edge on desktop. No account needed.',
    [PROVIDERS.LOCAL_STORAGE]: 'Default local store in this browser. Fast, private, and works offline.',
    [PROVIDERS.ONEDRIVE]: 'Store in your Microsoft OneDrive. Works on any device and browser, including mobile.',
    [PROVIDERS.GOOGLE_DRIVE]: 'Store in your Google Drive. Works on any device and browser, including mobile.',
  }

  return (
    <div className="storage-picker-overlay">
      <div className="storage-picker">
        <div className="storage-picker-logo">📋</div>
        <h1 className="storage-picker-title">Planner</h1>
        <p className="storage-picker-subtitle">Choose where to store your planning files</p>

        {error && <div className="storage-picker-error">⚠️ {error}</div>}

        <div className="storage-options">
          {availableProviders.map(id => {
            const isConnecting = connecting === id
            return (
              <div key={id} className="storage-option">
                <div className="storage-option-icon">
                  {id === PROVIDERS.FSA ? '💾' : id === PROVIDERS.ONEDRIVE ? '☁️' : '🌐'}
                </div>
                <div className="storage-option-info">
                  <div className="storage-option-name">{getProviderName(id)}</div>
                  <div className="storage-option-desc">{descriptions[id]}</div>
                </div>
                <button
                  className={`storage-option-btn${isConnecting ? ' loading' : ''}`}
                  onClick={() => handlePick(id)}
                  disabled={!!connecting}
                >
                  {isConnecting ? <span className="spinner" /> : 'Connect'}
                </button>
              </div>
            )
          })}
        </div>

        <p className="storage-picker-note">
          Your files stay private. The app stores markdown in a folder you control.
        </p>
      </div>
    </div>
  )
}
