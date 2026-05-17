import { useEffect, useState } from 'react'
import { APP_NAME } from '../config/branding.js'

const DISMISS_KEY = 'install-dismissed-at'
const VISITS_KEY = 'install-visit-count'
const VISIT_THRESHOLD = 3
const DISMISS_REMIND_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function isStandalone() {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

function detectPlatform() {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'desktop'
}

export function useInstallPrompt() {
  const [installed, setInstalled] = useState(() => isStandalone())
  const [deferred, setDeferred] = useState(null)
  const [eligible, setEligible] = useState(false)

  useEffect(() => {
    if (installed) return

    // Only count this visit once per page load even if hook is mounted multiple times.
    if (!window.__plannerInstallVisitCounted) {
      window.__plannerInstallVisitCounted = true
      const visits = parseInt(localStorage.getItem(VISITS_KEY) || '0', 10) + 1
      localStorage.setItem(VISITS_KEY, String(visits))
    }
    const visits = parseInt(localStorage.getItem(VISITS_KEY) || '0', 10)

    const dismissedAt = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10)
    const dismissedRecently = dismissedAt && (Date.now() - dismissedAt) < DISMISS_REMIND_MS
    if (!dismissedRecently && visits >= VISIT_THRESHOLD) setEligible(true)

    const onBeforeInstall = (e) => {
      e.preventDefault()
      setDeferred(e)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
      localStorage.removeItem(DISMISS_KEY)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [installed])

  const platform = detectPlatform()
  const canShowPrompt = !installed && (deferred || platform === 'ios')

  const promptInstall = async () => {
    if (deferred) {
      try {
        deferred.prompt()
        const { outcome } = await deferred.userChoice
        if (outcome === 'accepted') setInstalled(true)
        else localStorage.setItem(DISMISS_KEY, String(Date.now()))
      } catch { /* ignore */ }
      setDeferred(null)
    }
  }

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setEligible(false)
  }

  return {
    installed,
    canShowPrompt,
    eligible: eligible && canShowPrompt,
    platform,
    hasNativePrompt: !!deferred,
    promptInstall,
    dismiss,
  }
}

export function InstallButton({ onOpen }) {
  const { canShowPrompt, installed } = useInstallPrompt()
  if (installed || !canShowPrompt) return null
  return (
    <button
      className="storage-footer-toggle"
      onClick={onOpen}
      title={`Install ${APP_NAME} as an app`}
    >
      <span className="storage-footer-icon">📱</span>
      <span className="storage-footer-label">Install app</span>
    </button>
  )
}

export function InstallModal({ onClose }) {
  const { platform, hasNativePrompt, promptInstall, installed } = useInstallPrompt()

  if (installed) {
    return (
      <div className="dialog-overlay" onClick={onClose}>
        <div className="settings-dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px' }}>
          <div className="settings-dialog-header">
            <h3>Already installed ✨</h3>
            <button className="settings-dialog-close" onClick={onClose}>✕</button>
          </div>
          <div className="settings-dialog-section">
            <div className="storage-footer-note">{APP_NAME} is running as an installed app.</div>
          </div>
        </div>
      </div>
    )
  }

  const handleInstall = async () => {
    await promptInstall()
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: '460px' }}>
        <div className="settings-dialog-header">
          <h3>Install {APP_NAME}</h3>
          <button className="settings-dialog-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-dialog-section">
          <div className="storage-footer-note">
            Add {APP_NAME} to your home screen for fast access, offline use, and a clean full-screen experience.
          </div>

          {hasNativePrompt && (
            <div className="storage-footer-actions" style={{ marginTop: '0.75rem' }}>
              <button className="storage-footer-btn secondary" onClick={onClose}>Not now</button>
              <button className="storage-footer-btn" onClick={handleInstall}>Install</button>
            </div>
          )}

          {!hasNativePrompt && platform === 'ios' && (
            <ol style={{ paddingLeft: '1.25rem', lineHeight: 1.6 }}>
              <li>Tap the <strong>Share</strong> button <span role="img" aria-label="share">⎙</span> at the bottom of Safari.</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong> in the top-right corner.</li>
            </ol>
          )}

          {!hasNativePrompt && platform === 'android' && (
            <ol style={{ paddingLeft: '1.25rem', lineHeight: 1.6 }}>
              <li>Tap the browser menu <strong>⋮</strong> in the top-right.</li>
              <li>Tap <strong>Install app</strong> (or <strong>Add to Home Screen</strong>).</li>
              <li>Confirm to add it to your home screen.</li>
            </ol>
          )}

          {!hasNativePrompt && platform === 'desktop' && (
            <div className="storage-footer-note">
              In Chrome or Edge, look for the install icon <strong>⊕</strong> in the address bar (right side), or
              open the browser menu and choose <strong>Install {APP_NAME}…</strong>.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function InstallNudge({ onOpen }) {
  const { eligible, dismiss } = useInstallPrompt()
  if (!eligible) return null
  return (
    <div className="install-nudge" role="status">
      <span className="install-nudge-icon">📱</span>
      <div className="install-nudge-text">
        <strong>Install {APP_NAME}</strong>
        <span>Faster launch, offline-ready, no browser chrome.</span>
      </div>
      <div className="install-nudge-actions">
        <button className="storage-footer-btn secondary" onClick={dismiss}>Not now</button>
        <button className="storage-footer-btn" onClick={onOpen}>Install</button>
      </div>
    </div>
  )
}
