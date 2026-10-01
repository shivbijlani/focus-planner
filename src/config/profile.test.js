import { describe, expect, it } from 'vitest'
import profile from './profile.js'

describe('consumer deployment profile', () => {
  it('preserves the consumer web defaults', () => {
    expect(profile).toMatchObject({
      deploymentMode: 'consumer-web',
      enabledProviders: ['local-storage', 'fsa', 'onedrive', 'google-drive'],
      plannerRoot: null,
      installPrompt: true,
      syncScheduler: 'page',
      enabledIntegrations: [],
      branding: {
        name: 'Planner',
        planFile: 'planner.md',
        completedFile: 'planner-completed.md',
      },
    })
  })
})
