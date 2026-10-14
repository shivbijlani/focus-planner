// Production baseline only: isolated Edge contexts, synthetic browser-local files.
import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

export default defineConfig({
  ...base,
  testMatch: 'docs-app.spec.js',
  outputDir: 'test-results/personal-baseline',
  workers: 1,
  webServer: undefined,
  use: { ...base.use, baseURL: 'https://plannermd.com', channel: 'msedge' },
})
