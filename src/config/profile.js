import { APP_DESCRIPTION, APP_NAME, CLOUD_FOLDER_NAME, COMPLETED_FILE, PLAN_FILE } from './branding.js'
import { BUILTIN_PROVIDER_TYPES } from '../storage/providerTypes.js'

export function validateDeploymentProfile(profile, providerTypes = BUILTIN_PROVIDER_TYPES) {
  if (!profile || !Array.isArray(profile.enabledProviders)) {
    throw new Error('Deployment profile must define enabledProviders as an array')
  }
  const unknown = profile.enabledProviders.filter(type => !providerTypes.includes(type))
  if (unknown.length) {
    throw new Error(`Unknown storage provider type(s) in deployment profile: ${unknown.join(', ')}`)
  }
  return profile
}

const deploymentMode = import.meta.env?.VITE_DEPLOYMENT_PROFILE || 'consumer-web'

if (deploymentMode !== 'consumer-web') {
  throw new Error(`Unknown deployment profile "${deploymentMode}". Override #planner/deployment-profile to provide it.`)
}

export const deploymentProfile = validateDeploymentProfile({
  deploymentMode,
  enabledProviders: [
    'local-storage',
    'fsa',
    'onedrive',
    'google-drive',
  ],
  plannerRoot: null,
  installPrompt: true,
  branding: {
    name: APP_NAME,
    description: APP_DESCRIPTION,
    icon: 'icon.svg',
    links: [],
    planFile: PLAN_FILE,
    completedFile: COMPLETED_FILE,
    cloudFolderName: CLOUD_FOLDER_NAME,
  },
  syncScheduler: 'page',
  enabledIntegrations: [],
})

export default deploymentProfile
