import profile from '#planner/deployment-profile'

const providers = new Map()

export function registerProvider({ type, label, factory, capabilities = {} }) {
  if (!type || typeof type !== 'string') throw new TypeError('Provider type must be a non-empty string')
  if (providers.has(type)) throw new Error(`Storage provider already registered: ${type}`)
  if (typeof factory !== 'function') throw new TypeError(`Provider "${type}" must have a factory`)
  providers.set(type, { type, label, factory, capabilities })
}

export function getProvider(type) {
  return providers.get(type) || null
}

export function createProvider(type, options) {
  const provider = getProvider(type)
  if (!provider) throw new Error(`Unknown storage provider: ${type}`)
  return provider.factory(options)
}

export function listProviders(enabledProviders = profile.enabledProviders) {
  const unknown = enabledProviders.filter(type => !providers.has(type))
  if (unknown.length) {
    throw new Error(`Unknown storage provider type(s) in deployment profile: ${unknown.join(', ')}`)
  }
  return enabledProviders
    .map(type => providers.get(type))
    .filter(provider => !provider.capabilities.pickFolder
      || (typeof window !== 'undefined' && 'showDirectoryPicker' in window))
}

export function getEnabledProviderTypes() {
  return listProviders().map(provider => provider.type)
}

export function validateRegisteredProviders() {
  listProviders()
}

export function resetRegistryForTests() {
  providers.clear()
}
