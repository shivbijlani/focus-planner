import { IndexedDbProvider } from './indexeddb-provider.js'
import { FSAProvider } from './fsa-provider.js'
import { OneDriveProvider } from './onedrive-provider.js'
import { GoogleDriveProvider } from './google-drive-provider.js'
import { registerProvider, validateRegisteredProviders } from './registry.js'
import { PROVIDERS } from './providerTypes.js'

registerProvider({
  type: PROVIDERS.LOCAL_STORAGE,
  label: 'Browser Storage',
  factory: () => new IndexedDbProvider(),
  capabilities: { settingsSource: true },
})
registerProvider({
  type: PROVIDERS.FSA,
  label: 'Local Folder',
  factory: ({ id } = {}) => new FSAProvider(id),
  capabilities: { needsUserGesture: true, pickFolder: true, settingsSource: true },
})
registerProvider({
  type: PROVIDERS.ONEDRIVE,
  label: 'OneDrive',
  factory: () => new OneDriveProvider(),
  capabilities: { oauthRedirect: true },
})
registerProvider({
  type: PROVIDERS.GOOGLE_DRIVE,
  label: 'Google Drive',
  factory: ({ config, folderName } = {}) => new GoogleDriveProvider(config?.folderName || folderName || null),
  capabilities: { oauthRedirect: true },
})

validateRegisteredProviders()
