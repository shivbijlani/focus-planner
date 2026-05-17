import { useInstallPrompt } from './useInstallPrompt.js'

/**
 * One-time toast that confirms successful installation. Appears on the first
 * launch in standalone mode and stays until dismissed.
 */
export function InstallSuccessToast({ appName = 'this app' }) {
  const { showWelcome, dismissWelcome } = useInstallPrompt()
  if (!showWelcome) return null
  return (
    <div className="install-prompt-toast" role="status">
      <span className="install-prompt-toast-icon" aria-hidden="true">✨</span>
      <div className="install-prompt-toast-text">
        <strong>Welcome to {appName}</strong>
        <span>You're running the installed app. Find it on your home screen any time.</span>
      </div>
      <button type="button" className="install-prompt-toast-close" onClick={dismissWelcome} aria-label="Dismiss">✕</button>
    </div>
  )
}
