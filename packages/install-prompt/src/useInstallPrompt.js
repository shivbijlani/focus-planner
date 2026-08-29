import { useEffect, useState } from 'react'

const DISMISS_KEY = 'install-prompt-dismissed-at'
const VISITS_KEY = 'install-prompt-visit-count'
const WELCOME_SHOWN_KEY = 'install-prompt-welcome-shown'
const VISIT_THRESHOLD = 3
const DISMISS_REMIND_MS = 30 * 24 * 60 * 60 * 1000

function readStandalone() {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

export function detectPlatform() {
  if (typeof navigator === 'undefined') return { os: 'desktop', browser: 'other', canInstall: true }
  const ua = navigator.userAgent || ''
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
  const isAndroid = /Android/i.test(ua)
  const os = isIOS ? 'ios' : isAndroid ? 'android' : 'desktop'

  let browser = 'other'
  if (isIOS) {
    if (/CriOS/i.test(ua)) browser = 'chrome-ios'
    else if (/FxiOS/i.test(ua)) browser = 'firefox-ios'
    else if (/EdgiOS/i.test(ua)) browser = 'edge-ios'
    else if (/Safari/i.test(ua)) browser = 'safari'
    else browser = 'other-ios'
  } else if (/Edg\//i.test(ua)) browser = 'edge'
  else if (/Chrome\//i.test(ua)) browser = 'chrome'
  else if (/Firefox\//i.test(ua)) browser = 'firefox'
  else if (/Safari/i.test(ua)) browser = 'safari'

  // On iOS, only Safari can install PWAs. All other iOS browsers (Chrome, Firefox, Edge)
  // are WKWebView-wrappers that lack the "Add to Home Screen" capability.
  const canInstall = !isIOS || browser === 'safari'

  return { os, browser, canInstall }
}

export function useInstallPrompt() {
  const [installed, setInstalled] = useState(() => readStandalone())
  const [deferred, setDeferred] = useState(null)
  const [eligible, setEligible] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)

  useEffect(() => {
    // Surface a one-time welcome when running as installed PWA for the first time.
    if (installed && !localStorage.getItem(WELCOME_SHOWN_KEY)) {
      localStorage.setItem(WELCOME_SHOWN_KEY, String(Date.now()))
      queueMicrotask(() => setShowWelcome(true))
    }

    if (installed) return

    if (!window.__installPromptVisitCounted) {
      window.__installPromptVisitCounted = true
      const v = parseInt(localStorage.getItem(VISITS_KEY) || '0', 10) + 1
      localStorage.setItem(VISITS_KEY, String(v))
    }
    const visits = parseInt(localStorage.getItem(VISITS_KEY) || '0', 10)

    const dismissedAt = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10)
    const dismissedRecently = dismissedAt && (Date.now() - dismissedAt) < DISMISS_REMIND_MS
    if (!dismissedRecently && visits >= VISIT_THRESHOLD) {
      queueMicrotask(() => setEligible(true))
    }

    const onBeforeInstall = (e) => { e.preventDefault(); setDeferred(e) }
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
  const canShowPrompt = !installed && (deferred || platform.os === 'ios' || platform.os === 'android' || platform.os === 'desktop')

  const promptInstall = async () => {
    if (!deferred) return 'unavailable'
    try {
      deferred.prompt()
      const { outcome } = await deferred.userChoice
      if (outcome === 'accepted') setInstalled(true)
      else localStorage.setItem(DISMISS_KEY, String(Date.now()))
      setDeferred(null)
      return outcome
    } catch {
      setDeferred(null)
      return 'error'
    }
  }

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setEligible(false)
  }

  const dismissWelcome = () => setShowWelcome(false)

  return {
    installed,
    canShowPrompt,
    eligible: eligible && canShowPrompt,
    platform,
    hasNativePrompt: !!deferred,
    promptInstall,
    dismiss,
    showWelcome,
    dismissWelcome,
  }
}
