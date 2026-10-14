import { PROVIDERS } from './storage/providerTypes.js'
import { listSettingsProviders } from './storage/registry.js'

const PROVIDER_DETAILS = {
  [PROVIDERS.LOCAL_STORAGE]: {
    description: 'A storage source saved in this browser.',
    icon: '🗂️',
    action: 'Use this',
  },
  [PROVIDERS.FSA]: {
    description: 'A storage source in a folder on this device.',
    icon: '📂',
    action: 'Choose folder',
  },
}

export function StorageSourceSettings({ activeProviderType, onChoose, busy }) {
  return listSettingsProviders().map(({ type, label }) => {
    const active = activeProviderType === type
    const details = PROVIDER_DETAILS[type] || {}
    return (
      <div key={type} className={`sync-target-card${active ? ' active-source' : ''}`}>
        <div className="sync-target-main">
          <span className="sync-target-icon">{details.icon || '📁'}</span>
          <div>
            <div className="sync-target-name">{label}</div>
            <div className="sync-target-status">{details.description || `A ${label} source for this deployment.`}</div>
          </div>
        </div>
        <div className="sync-target-actions">
          {active
            ? <span className="sync-active-badge">● Active</span>
            : <button className="storage-footer-btn sync-target-action" onClick={() => onChoose(type)} disabled={busy}>{details.action || 'Use this'}</button>}
        </div>
      </div>
    )
  })
}
