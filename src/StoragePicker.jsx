/**
 * StoragePicker — shown on first visit or when no storage is configured.
 * Lets user choose Local Folder, OneDrive, or Google Drive.
 */
import { useState, useEffect } from 'react'
import { PROVIDERS, getAvailableProviders, getProviderName, setActiveProvider } from './storage/storage.js'
import { FSAProvider } from './storage/fsa-provider.js'
import { OneDriveProvider } from './storage/onedrive-provider.js'
import { GoogleDriveProvider } from './storage/google-drive-provider.js'

function makeProvider(id) {
  switch (id) {
    case PROVIDERS.FSA: return new FSAProvider()
    case PROVIDERS.ONEDRIVE: return new OneDriveProvider()
    case PROVIDERS.GOOGLE_DRIVE: return new GoogleDriveProvider()
    default: throw new Error(`Unknown provider: ${id}`)
  }
}

export function StoragePicker({ onReady }) {
  const [availableProviders] = useState(getAvailableProviders)
  const [connecting, setConnecting] = useState(null) // provider id being connected
  const [error, setError] = useState('')

  // On mount: check for saved provider or returning from OAuth redirect
  useEffect(() => {
    const savedId = localStorage.getItem('fp-storage-provider')
    const hasODCode = new URLSearchParams(window.location.search).get('code') && sessionStorage.getItem('onedrive_verifier')
    const hasGDCode = new URLSearchParams(window.location.search).get('code') && sessionStorage.getItem('gd_verifier')

    if (hasODCode) {
      tryConnect(PROVIDERS.ONEDRIVE, true)
    } else if (hasGDCode) {
      tryConnect(PROVIDERS.GOOGLE_DRIVE, true)
    } else if (savedId) {
      tryConnect(savedId, true)
    }
  }, [])

  const tryConnect = async (id, silent = false) => {
    setConnecting(id)
    setError('')
    try {
      const provider = makeProvider(id)
      const result = await provider.restore()
      if (result) {
        // Restore succeeded (has valid tokens or just completed OAuth)
        setActiveProvider(provider)
        localStorage.setItem('fp-storage-provider', id)
        onReady(id)
        return
      }
      if (id === PROVIDERS.FSA) {
        // FSA restore failed — need user to pick
        setConnecting(null)
        if (!silent) setError('Could not restore folder access. Please pick a folder.')
        return
      }
      // Cloud provider — no tokens yet, prompt
      if (!silent) {
        // Already connecting, will redirect
      } else {
        setConnecting(null)
      }
    } catch (e) {
      if (!e.message?.includes('Redirecting')) {
        setError(e.message || 'Connection failed')
      }
      setConnecting(null)
    }
  }

  const handlePick = async (id) => {
    setConnecting(id)
    setError('')
    // Save before redirect so we can resume
    localStorage.setItem('fp-storage-provider', id)
    try {
      const provider = makeProvider(id)
      if (id === PROVIDERS.FSA) {
        const handle = await provider.pick()
        if (handle) {
          setActiveProvider(provider)
          onReady(id)
        } else {
          setConnecting(null)
        }
      } else {
        // Cloud — will redirect to OAuth
        await provider.pick()
      }
    } catch (e) {
      if (!e.message?.includes('Redirecting')) {
        setError(e.message || 'Connection failed')
        setConnecting(null)
      }
    }
  }

  const descriptions = {
    [PROVIDERS.FSA]: 'Store files locally on this device. Works in Chrome & Edge on desktop. No account needed.',
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
