import { defineConfig, devices } from '@playwright/test'
import process from 'node:process'

const port = Number(process.env.DOCS_SEAMS_PORT) || 4319
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'docs-seams.spec.js',
  outputDir: 'test-results/docs-seams',
  workers: 1,
  timeout: 60_000,
  use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL, baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
