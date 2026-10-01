import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Build identifier (UTC build time) surfaced in Settings so users can confirm
// the running version after an "Update app" — and so support can tell whether a
// device is on a stale service worker.
const BUILD_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    // Two apps, one origin (plans/docs-app-design.md §3): Focus Planner (index.html) and
    // Docs (docs.html). Shared modules (storage, folder-sync) are emitted as common chunks,
    // and both pages register the same network-first service worker (public/app-sw.js),
    // so deploying one never strands the other on a stale cache.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        docs: resolve(__dirname, 'docs.html'),
      },
    },
  },
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_ID),
  },
  test: {
    // `plugins/overnight-agent/checks/` holds the agent's standalone check scripts. A few
    // are named `*.test.mjs` but are not vitest suites: they are self-tests that read
    // %LOCALAPPDATA%, shell out, and call process.exit(). Collecting them makes vitest fail
    // the whole run on the Linux CI runner, where %LOCALAPPDATA% is undefined. They are run
    // by run-sweeps.ps1, which is the only thing that can supply their environment.
    exclude: ['**/node_modules/**', '**/dist/**', 'plugins/**'],
  },
})
