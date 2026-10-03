// App mainline smoke suite (real browser). Characterizes what the app does
// today so refactors cannot silently break it. See README.md "Testing".
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.SMOKE_PORT) || 4317

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  // Per-test budget. CI runs each test in ~1 s, so 45 s there still fails a hang fast. A dev box is
  // often shared with the agent's sandbox runs: measured (#826) with two of them running, ordinary
  // tests took 15-22 s and the longest 40-70 s, so local runs get a budget that does not turn load
  // into red. Assertions and their own timeouts are the same everywhere.
  timeout: process.env.CI ? 45_000 : 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
