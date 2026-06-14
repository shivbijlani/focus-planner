import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build identifier (UTC build time) surfaced in Settings so users can confirm
// the running version after an "Update app" — and so support can tell whether a
// device is on a stale service worker.
const BUILD_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_ID),
  },
})
