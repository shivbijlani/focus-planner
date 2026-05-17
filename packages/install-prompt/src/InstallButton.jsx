import { useInstallPrompt } from './useInstallPrompt.js'

export function InstallButton({
  onOpen,
  appName = 'this app',
  label = 'Install app',
  className = 'install-prompt-btn',
  iconClassName = '',
  labelClassName = '',
}) {
  const { canShowPrompt, installed } = useInstallPrompt()
  if (installed || !canShowPrompt) return null
  return (
    <button
      type="button"
      className={className}
      onClick={onOpen}
      title={`Install ${appName} as an app`}
    >
      <span className={iconClassName} aria-hidden="true">📱</span>
      <span className={labelClassName}>{label}</span>
    </button>
  )
}
