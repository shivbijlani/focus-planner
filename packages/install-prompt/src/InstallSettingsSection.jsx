import { useInstallPrompt } from './useInstallPrompt.js'

export function InstallSettingsSection({ onOpen, appName = 'this app', sectionClassName = 'install-prompt-section' }) {
  const { installed, platform, hasNativePrompt } = useInstallPrompt()
  if (installed) return null

  const platformLabel =
    platform.os === 'ios' ? 'iPhone or iPad'
    : platform.os === 'android' ? 'Android'
    : 'this computer'

  // On iOS non-Safari we still show the card (it explains why install isn't possible).
  return (
    <div className={sectionClassName}>
      <div className="install-prompt-section-title">Install app</div>
      <div className="install-prompt-card">
        <div className="install-prompt-card-main">
          <span className="install-prompt-card-icon" aria-hidden="true">📱</span>
          <div>
            <div className="install-prompt-card-name">Install {appName} on {platformLabel}</div>
            <div className="install-prompt-card-status">
              Home-screen icon, faster launch, full-screen view, and offline access.
            </div>
          </div>
        </div>
        <div className="install-prompt-card-actions">
          <button
            type="button"
            className="install-prompt-primary"
            onClick={onOpen}
          >
            {hasNativePrompt ? 'Install' : 'How to install'}
          </button>
        </div>
      </div>
    </div>
  )
}
