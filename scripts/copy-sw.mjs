// Copies the folder-sync source tree into public/folder-sync/ so Vite serves
// the service worker and its ES-module imports from the app's own origin.
// (A service worker can only be registered from a URL on the page's origin.)
import { cp, rm, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '..', 'packages', 'folder-sync', 'src')
const DEST = resolve(__dirname, '..', 'public', 'folder-sync')

await rm(DEST, { recursive: true, force: true })
await mkdir(DEST, { recursive: true })
// Skip unit-test files — they are only relevant in the package, and copying
// them into public/ would make Vitest discover and re-run them at the app root.
await cp(SRC, DEST, {
  recursive: true,
  filter: (src) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(src),
})
console.log(`[copy-sw] ${SRC} -> ${DEST}`)
