// Build the pinned, dependency-free planner-tools release archive (#836).
//
// The archive mirrors repository-relative paths for the exact import closure
// of bin/planner.js, so the shipped files are byte-for-byte the modules the
// Planner UI imports (after LF normalization), with no rewriting. Output is
// deterministic: sorted entries, fixed mtimes/owners, so the SHA-256 is
// reproducible from the same commit. MANIFEST.json records each file's hash.
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(PKG_DIR, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/')
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

// Repository workspace packages the closure may import by name. The archive
// ships each as a two-file shim under node_modules that re-exports the
// workspace source, so imported modules stay byte-identical to the repository.
const WORKSPACE_PACKAGES = { '@focus/docs-core': 'packages/docs-core/src/index.js' }

export function importClosure(entry) {
  const seen = new Set()
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    const text = read(file)
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2]
      if (spec.startsWith('node:')) continue
      if (Object.hasOwn(WORKSPACE_PACKAGES, spec)) {
        queue.push(path.join(REPO, WORKSPACE_PACKAGES[spec]))
        continue
      }
      if (!spec.startsWith('.')) throw new Error(`${rel(file)} imports "${spec}"; the release must have no npm dependencies.`)
      queue.push(path.resolve(path.dirname(file), spec))
    }
  }
  return [...seen].sort()
}

function workspaceShims() {
  const entries = new Map()
  for (const [name, target] of Object.entries(WORKSPACE_PACKAGES)) {
    const dir = `node_modules/${name}`
    const up = dir.split('/').map(() => '..').join('/')
    entries.set(`${dir}/package.json`, Buffer.from(`${JSON.stringify({ name, private: true, type: 'module', main: 'index.js' }, null, 2)}\n`))
    entries.set(`${dir}/index.js`, Buffer.from(`export * from '${up}/${target}'\n`))
  }
  return entries
}

function tarEntry(name, data) {
  const header = Buffer.alloc(512)
  const put = (value, offset, length) => header.write(value, offset, length, 'utf8')
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'
  if (Buffer.byteLength(name) > 100) throw new Error(`Path too long for tar: ${name}`)
  put(name, 0, 100)
  put(octal(0o644, 8), 100, 8)
  put(octal(0, 8), 108, 8)
  put(octal(0, 8), 116, 8)
  put(octal(data.length, 12), 124, 12)
  put(octal(0, 12), 136, 12)
  put('        ', 148, 8)
  put('0', 156, 1)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  let sum = 0
  for (const byte of header) sum += byte
  put(octal(sum, 7) + ' ', 148, 8)
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, pad])
}

export function buildRelease(outDir) {
  const files = importClosure(path.join(PKG_DIR, 'bin', 'planner.js'))
  const entries = new Map()
  for (const file of files) entries.set(rel(file), Buffer.from(read(file), 'utf8'))
  for (const [name, data] of workspaceShims()) entries.set(name, data)
  entries.set('README.md', Buffer.from(read(path.join(PKG_DIR, 'README.md')), 'utf8'))
  entries.set('package.json', Buffer.from(`${JSON.stringify({
    name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license, type: 'module',
    engines: pkg.engines, bin: { planner: 'packages/planner-tools/bin/planner.js' },
  }, null, 2)}\n`))
  const manifest = {
    version: pkg.version,
    files: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([n, d]) => [n, createHash('sha256').update(d).digest('hex')])),
  }
  entries.set('MANIFEST.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  const tar = Buffer.concat([
    ...[...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => tarEntry(`package/${name}`, data)),
    Buffer.alloc(1024),
  ])
  const gz = gzipSync(tar, { level: 9 })
  gz[9] = 255 // gzip OS byte: "unknown", so the archive is identical on every platform
  const file = `planner-tools-${pkg.version}.tgz`
  const sha256 = createHash('sha256').update(gz).digest('hex')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, file), gz)
  fs.writeFileSync(path.join(outDir, `${file}.sha256`), `${sha256}  ${file}\n`)
  fs.writeFileSync(path.join(outDir, 'version.json'), `${JSON.stringify({
    version: pkg.version, file, sha256, node: pkg.engines.node,
    clientId: '4f22242f-c9a7-4a61-9208-8ca0e5ef8697', scopes: ['Files.ReadWrite.AppFolder', 'offline_access'],
  }, null, 2)}\n`)
  return { file: path.join(outDir, file), sha256, files: [...entries.keys()] }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildRelease(path.resolve(process.argv[2] || path.join(PKG_DIR, 'dist')))
  console.log(`${result.sha256}  ${result.file}\n${result.files.length} files`)
}
