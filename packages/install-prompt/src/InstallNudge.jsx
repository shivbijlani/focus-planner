import { useInstallPrompt } from './useInstallPrompt.js'

export function InstallNudge({ onOpen, appName = 'this app' }) {
  const { eligible, dismiss } = useInstallPrompt()
  if (!eligible) return null
  return (
    <div className="install-prompt-nudge" role="status">
      <span className="install-prompt-nudge-icon" aria-hidden="true">📱</span>
      <div className="install-prompt-nudge-text">
        <strong>Install {appName}</strong>
        <span>Faster launch, offline-ready, no browser chrome.</span>
      </div>
      <div className="install-prompt-nudge-actions">
        <button type="button" className="install-prompt-secondary" onClick={dismiss}>Not now</button>
        <button type="button" className="install-prompt-primary" onClick={onOpen}>Install</button>
      </div>
    </div>
  )
}
