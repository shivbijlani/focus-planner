import { useInstallPrompt } from './useInstallPrompt.js'
import { ShareIcon } from './ShareIcon.jsx'

export function InstallModal({ onClose, appName = 'this app' }) {
  const { platform, hasNativePrompt, promptInstall, installed } = useInstallPrompt()

  if (installed) {
    return (
      <Overlay onClose={onClose}>
        <Header title="Already installed ✨" onClose={onClose} />
        <div className="install-prompt-body">
          <p>{appName} is running as an installed app.</p>
        </div>
      </Overlay>
    )
  }

  const handleInstall = async () => {
    await promptInstall()
    onClose()
  }

  return (
    <Overlay onClose={onClose}>
      <Header title={`Install ${appName}`} onClose={onClose} />
      <div className="install-prompt-body">
        <p className="install-prompt-lede">
          Get a home-screen icon, faster launch, full-screen view, and offline access.
        </p>

        {hasNativePrompt && (
          <div className="install-prompt-actions">
            <button type="button" className="install-prompt-secondary" onClick={onClose}>Not now</button>
            <button type="button" className="install-prompt-primary" onClick={handleInstall}>Install</button>
          </div>
        )}

        {!hasNativePrompt && platform.os === 'ios' && !platform.canInstall && (
          <IosNonSafari appName={appName} />
        )}

        {!hasNativePrompt && platform.os === 'ios' && platform.canInstall && (
          <IosSafariSteps appName={appName} />
        )}

        {!hasNativePrompt && platform.os === 'android' && (
          <AndroidSteps appName={appName} />
        )}

        {!hasNativePrompt && platform.os === 'desktop' && (
          <DesktopSteps appName={appName} />
        )}
      </div>
    </Overlay>
  )
}

function Overlay({ onClose, children }) {
  return (
    <div className="install-prompt-overlay" onClick={onClose}>
      <div className="install-prompt-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  )
}

function Header({ title, onClose }) {
  return (
    <div className="install-prompt-header">
      <h3>{title}</h3>
      <button type="button" className="install-prompt-close" onClick={onClose} aria-label="Close">✕</button>
    </div>
  )
}

function IosSafariSteps({ appName }) {
  return (
    <>
      <ol className="install-prompt-steps">
        <li>
          Tap the <strong>Share</strong> button <span className="install-prompt-glyph"><ShareIcon /></span>{' '}
          at the <strong>bottom</strong> of Safari (or top-right on iPad).
        </li>
        <li>
          Scroll the share sheet and tap <strong>Add to Home Screen</strong>.
        </li>
        <li>
          Confirm the name and tap <strong>Add</strong> in the top-right corner.
        </li>
      </ol>
      <p className="install-prompt-note">
        After installing, open {appName} from your home screen for the full-screen app experience.
      </p>
    </>
  )
}

function IosNonSafari({ appName }) {
  return (
    <div className="install-prompt-warning">
      <p>
        <strong>Open this page in Safari to install.</strong>
      </p>
      <p>
        On iPhone and iPad, only Safari can add apps to your home screen — Chrome,
        Firefox, and other browsers don't support it.
      </p>
      <ol className="install-prompt-steps">
        <li>Tap the address bar and copy the link to {appName}.</li>
        <li>Open <strong>Safari</strong>.</li>
        <li>Paste and visit the link, then come back here for the install steps.</li>
      </ol>
    </div>
  )
}

function AndroidSteps({ appName }) {
  return (
    <>
      <ol className="install-prompt-steps">
        <li>Tap the browser menu <strong>⋮</strong> in the top-right.</li>
        <li>Choose <strong>Install app</strong> (or <strong>Add to Home Screen</strong>).</li>
        <li>Confirm to add {appName} to your home screen.</li>
      </ol>
      <p className="install-prompt-note">
        If you don't see "Install app", reload the page and try again.
      </p>
    </>
  )
}

function DesktopSteps({ appName }) {
  return (
    <p className="install-prompt-note">
      In Chrome or Edge, look for the install icon{' '}
      <strong>⊕</strong> on the right side of the address bar, or open the browser menu and choose{' '}
      <strong>Install {appName}…</strong>.
    </p>
  )
}
