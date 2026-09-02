#!/usr/bin/env node
// Deterministic fact collector for the generated spec wiki.
//
// WHY THIS EXISTS
// ---------------
// The obvious way to generate a spec is to hand an agent the repo and say
// "write the spec". That produces confident prose that drifts from the code
// immediately and cannot be checked. The failure is not that the agent writes
// badly -- it is that nothing anchors what it writes to what exists.
//
// So this script is the MECHANISM half of a mechanism/policy split: it extracts
// ground-truth facts with NO model involved -- module graph, exports, data
// formats, tests, workflows, open issues. The agent then writes prose FROM these
// facts, and `verify.mjs` asserts the prose only references things that appear
// here. Collection is reproducible and diffable; only the prose is generated.
//
// Deliberately dependency-free (no parser): these are structural facts, and a
// regex pass over source is robust enough to enumerate them. Adding a parser
// would buy precision we do not need and a dependency we would have to maintain.
//
// Usage:  node scripts/spec/collect.mjs [--out spec-facts.json] [--no-issues]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, relative, extname, sep } from 'path'
import { execFileSync } from 'child_process'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const outPath = argValue('--out') ?? 'spec-facts.json'
const withIssues = !args.includes('--no-issues')

function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.vite', '.vite-temp',
  '.github', 'docs', 'public', '.worktrees',
])
const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx'])

function walk(dir, acc = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return acc }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, acc)
    else if (CODE_EXT.has(extname(name))) acc.push(full)
  }
  return acc
}

const rel = (p) => relative(ROOT, p).split(sep).join('/')

// --- structural extraction ---------------------------------------------------

function exportsOf(src) {
  const out = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^export\s+(?:const|let|class)\s+([A-Za-z0-9_$]+)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name) out.add(name)
    }
  }
  if (/^export\s+default/m.test(src)) out.add('default')
  return [...out].sort()
}

function importsOf(src) {
  const out = new Set()
  for (const m of src.matchAll(/^import\s+[^'"]*from\s*['"]([^'"]+)['"]/gm)) out.add(m[1])
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1])
  return [...out].sort()
}

// React components: exported functions whose name is PascalCase and whose body
// returns JSX. Cheap heuristic, and wrong only in the harmless direction.
function componentsOf(src, names) {
  return names.filter((n) => /^[A-Z]/.test(n) && new RegExp(`function\\s+${n}\\b[\\s\\S]{0,4000}?<[A-Za-z]`).test(src))
}

// A file's leading comment block is, in this repo, consistently a rationale note
// ("WHY THIS EXISTS"). That is exactly the design intent a spec needs and it is
// nowhere else, so capture it verbatim rather than asking the model to infer it.
function headerDoc(src) {
  const lines = src.split(/\r?\n/)
  const doc = []
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('#!')) continue
    if (t.startsWith('//')) { doc.push(t.replace(/^\/\/\s?/, '')); continue }
    if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) {
      doc.push(t.replace(/^\/\*+\s?/, '').replace(/^\*+\/?\s?/, ''))
      continue
    }
    if (t === '') { if (doc.length) break; continue }
    break
  }
  return doc.join('\n').trim()
}

// Test names are the behavioural specification: they state, in English, what the
// system must do. They are the highest-signal artifact in the repo for a spec
// whose bar is "someone could rebuild this", so they are collected in full.
function testsOf(src) {
  const out = []
  let suite = null
  for (const line of src.split(/\r?\n/)) {
    const d = line.match(/^\s*describe\s*\(\s*['"`](.+?)['"`]/)
    if (d) { suite = d[1]; continue }
    const t = line.match(/^\s*it\s*\(\s*['"`](.+?)['"`]/)
    if (t) out.push(suite ? `${suite} > ${t[1]}` : t[1])
  }
  return out
}

// --- collect -----------------------------------------------------------------

const files = walk(ROOT)
const modules = []
const testFiles = []

for (const abs of files) {
  const path = rel(abs)
  let src
  try { src = readFileSync(abs, 'utf8') } catch { continue }
  const isTest = /\.test\.[a-z]+$/.test(path)
  const names = exportsOf(src)
  const record = {
    path,
    lines: src.split(/\r?\n/).length,
    exports: names,
    imports: importsOf(src).filter((i) => i.startsWith('.')),
    externalImports: importsOf(src).filter((i) => !i.startsWith('.')),
  }
  if (isTest) {
    testFiles.push({ path, tests: testsOf(src) })
  } else {
    record.components = componentsOf(src, names)
    const doc = headerDoc(src)
    if (doc) record.doc = doc
    modules.push(record)
  }
}

// Group by domain so each generated page gets a focused, bounded slice of the
// codebase rather than the whole thing (which is what makes output shallow).
function domainOf(path) {
  // Any workspace package is its own domain. Matching only the one package we
  // happen to know about silently files every other package under `root`, where
  // it is indistinguishable from config noise and gets no page of its own.
  const pkg = path.match(/^packages\/([^/]+)\//)
  if (pkg) return pkg[1]
  if (path.startsWith('src/storage/')) return 'storage'
  if (path.startsWith('src/config/')) return 'config'
  if (path.startsWith('scripts/')) return 'scripts'
  if (path.startsWith('src/')) return 'app'
  if (path.startsWith('plugins/')) return 'overnight-agent'
  return 'root'
}
for (const m of modules) m.domain = domainOf(m.path)
for (const t of testFiles) t.domain = domainOf(t.path)

// Data formats are the part a rebuilder cannot guess and cannot recover from
// code alone without reading every parser. Capture real samples.
const dataFormats = []
function sampleFormat(label, path, take = 40) {
  if (!existsSync(path)) return
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(0, take)
    dataFormats.push({ label, path: rel(path), sample: lines.join('\n') })
  } catch { /* unreadable sample is not fatal */ }
}
sampleFormat('README', join(ROOT, 'README.md'), 60)

let pkg = {}
try { pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) } catch { /* optional */ }

const workflows = []
const wfDir = join(ROOT, '.github', 'workflows')
if (existsSync(wfDir)) {
  for (const name of readdirSync(wfDir)) {
    try {
      workflows.push({ name, content: readFileSync(join(wfDir, name), 'utf8') })
    } catch { /* skip */ }
  }
}

// Open issues carry design intent and known gaps that exist nowhere in the code.
// A spec that omits them documents only what was built, not what it must become.
let issues = []
if (withIssues) {
  try {
    const raw = execFileSync('gh', [
      'issue', 'list', '--state', 'open', '--limit', '200',
      '--json', 'number,title,labels,body',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    issues = JSON.parse(raw).map((i) => ({
      number: i.number,
      title: i.title,
      labels: (i.labels || []).map((l) => l.name),
      // Bodies are long; the opening is where the problem statement lives.
      body: (i.body || '').slice(0, 4000),
    }))
  } catch (err) {
    process.stderr.write(`[collect] warning: could not read issues (${err.message.split('\n')[0]})\n`)
  }
}

// The set of #NNN references verify.mjs accepts on rationale/history pages.
// It must be BROADER than open issues: a closed issue cited as shipped history,
// or a merged PR cited as real design history, is legitimate evidence -- and
// `prompt.md` rule 4 asks authors to cite exactly these. Two facts force the
// shape of this query:
//   - PRs share the issue-number namespace, and `gh issue list` EXCLUDES PRs,
//     so we must union issues AND prs, or a ref like #313 (a merged PR) is
//     unresolvable and gets flagged as invented.
//   - `--state all` is required so closed issues resolve, not just open ones.
// On failure this is left empty so verify degrades to open-only (see the
// `?? [...openIssues]` fallback there) rather than crashing.
const REF_LIMIT = 1000
let validRefNumbers = []
if (withIssues) {
  // LIMIT GUARD: `--limit 1000` alone is not enough. `gh pr list` returns
  // newest-first, so a silent truncation at the cap would drop the OLDEST PRs --
  // exactly the historical ones rationale citations reach for -- and do it
  // invisibly. Asserting the returned count is strictly under the limit turns a
  // future overflow into a loud failure instead of a silently-shrunk valid set.
  // (Measured on this repo: issues --state all = 99, prs = 244, union max = 343.)
  const collectRefs = (kind) => {
    const raw = execFileSync('gh', [
      kind, 'list', '--state', 'all', '--limit', String(REF_LIMIT), '--json', 'number',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const rows = JSON.parse(raw)
    if (rows.length >= REF_LIMIT) {
      throw new Error(
        `gh ${kind} list returned ${rows.length} rows (>= --limit ${REF_LIMIT}); ` +
        'the set may be truncated. Raise --limit rather than validate against a partial set.',
      )
    }
    return rows.map((r) => r.number)
  }
  try {
    const refs = new Set(collectRefs('issue'))
    // FAIL-CLOSED: if the issue call above succeeds but this pr call throws, the
    // whole block falls to the catch and validRefNumbers is reset to [] (verify
    // then degrades to open-only). We never keep an issue-only, PR-incomplete
    // set: a populated validRefNumbers here always means BOTH calls succeeded,
    // so a future reader must not read a non-empty field as "issues only".
    for (const n of collectRefs('pr')) refs.add(n)
    validRefNumbers = [...refs].sort((a, b) => a - b)
  } catch (err) {
    process.stderr.write(`[collect] warning: could not read valid refs (${err.message.split('\n')[0]})\n`)
    validRefNumbers = []
  }
}

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch { /* not fatal */ }

const facts = {
  generatedAt: new Date().toISOString(),
  commit,
  repo: pkg.name ?? 'unknown',
  packageScripts: pkg.scripts ?? {},
  dependencies: pkg.dependencies ?? {},
  devDependencies: pkg.devDependencies ?? {},
  domains: [...new Set(modules.map((m) => m.domain))].sort(),
  counts: {
    modules: modules.length,
    testFiles: testFiles.length,
    tests: testFiles.reduce((n, t) => n + t.tests.length, 0),
    openIssues: issues.length,
    validRefNumbers: validRefNumbers.length,
    workflows: workflows.length,
  },
  modules,
  testFiles,
  workflows,
  dataFormats,
  issues,
  validRefNumbers,
}

writeFileSync(outPath, JSON.stringify(facts, null, 2), 'utf8')

process.stdout.write(
  `[collect] ${facts.counts.modules} modules, ${facts.counts.tests} tests in ` +
  `${facts.counts.testFiles} files, ${facts.counts.openIssues} open issues, ` +
  `${facts.counts.validRefNumbers} valid refs, ${facts.counts.workflows} workflows -> ${outPath}\n` +
  `[collect] domains: ${facts.domains.join(', ')}\n`,
)
