#!/usr/bin/env node
// Verification gate for the generated spec wiki.
//
// WHY THIS EXISTS
// ---------------
// A generated spec fails in two directions, and both look fine when you read it:
//
//   1. INVENTION -- it confidently describes a file, module or export that does
//      not exist. Prose is fluent, so this survives review.
//   2. OMISSION  -- a whole domain of the system is simply absent, so the spec
//      appears complete while omitting an important product capability.
//
// Neither is detectable by reading the spec, because the thing that is wrong is
// its relationship to the code -- which is exactly what a reader does not have
// in front of them. So we check the artifact against the collected facts, and
// fail the build rather than publishing something that reads authoritative and
// is not.
//
// This is the same discipline as the rest of the repo's checks: assert the
// artifact at the far end, never the return code of the step that produced it.
// "Copilot exited 0" says nothing about whether the spec is true.
//
// Usage:  node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { checkTechnicalPageLink, readabilityFindings } from './readability.mjs'
import { validatePages } from './reviewPolicy.mjs'

const args = process.argv.slice(2)
const factsPath = argValue('--facts') ?? 'spec-facts.json'
const specDir = argValue('--dir') ?? 'docs/spec'

function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

if (!existsSync(factsPath)) {
  process.stderr.write(`[verify] facts file not found: ${factsPath}\n`)
  process.exit(1)
}
if (!existsSync(specDir)) {
  process.stderr.write(`[verify] spec directory not found: ${specDir}\n`)
  process.exit(1)
}

const facts = JSON.parse(readFileSync(factsPath, 'utf8'))
// README.md is provenance for humans browsing the folder, not a wiki page.
const pages = readdirSync(specDir)
  .filter((f) => f.endsWith('.md'))
  .filter((f) => f.toLowerCase() !== 'readme.md')

if (pages.length === 0) {
  process.stderr.write(`[verify] no spec pages in ${specDir}\n`)
  process.exit(1)
}

const knownFiles = new Set(facts.modules.map((m) => m.path))
for (const t of facts.testFiles) knownFiles.add(t.path)
for (const w of facts.workflows) knownFiles.add(`.github/workflows/${w.name}`)

const openIssues = new Set(facts.issues.map((i) => String(i.number)))
// The broad set accepted on rationale/history pages: open + closed issues + all
// PRs (collect.mjs unions `gh issue list --state all` and `gh pr list --state all`,
// because PRs share the issue-number namespace and `gh issue list` excludes them).
// The `?? [...openIssues]` fallback is REQUIRED for back-compat: an old
// spec-facts.json written before validRefNumbers existed still verifies at the
// current (open-only) strictness -- no crash, no silent weakening.
const validRefs = new Set((facts.validRefNumbers ?? [...openIssues]).map(String))

// Gaps-style pages enumerate OPEN issues as the system's current state, so a
// CLOSED issue presented there as a live gap is stale/false and must be caught
// (this is the open-only check that flagged #226/#262 on Roadmap). Every other
// page is rationale/history, where closed-issue and PR citations are legitimate
// evidence, so it validates against the broad validRefs set instead. Splitting by
// role is what lets us accept honest closed-ref citations without deleting the
// staleness check where a closed ref genuinely lies.
const GAPS_PAGES = new Set(['Roadmap.md'])
const findings = []
const closedRefsByPage = []
const pagesByName = new Map()
let totalWords = 0

// --- 1. INVENTION: every repo-ish path the spec names must exist -------------
// Only paths that look like real source references are checked: a slash plus a
// known code extension. That deliberately ignores prose like "the storage layer"
// and illustrative names, and catches the failure that matters -- a spec telling
// a rebuilder to create `src/thing.js` that was never in the system.
//
// The extension alternation is ordered LONGEST-FIRST and closed with a boundary.
// Ordered `js|jsx`, the engine matches `.js` inside `src/App.jsx` and reports the
// truncated `src/App.js` as invented -- a false positive on every correct spec,
// which would have made this gate noise and trained everyone to ignore it.
// Caught by running the checker against a deliberately-valid page.
const PATH_RE = /(?:^|[\s`("[])((?:src|scripts|packages|plugins)\/[A-Za-z0-9_\-./]+\.(?:jsx|tsx|mjs|ts|js))(?![A-Za-z0-9])/g

for (const page of pages) {
  const text = readFileSync(join(specDir, page), 'utf8')
  pagesByName.set(page, text)
  totalWords += text.split(/\s+/).filter(Boolean).length
  findings.push(...readabilityFindings(page, text))

  const seen = new Set()
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/[.,;:)\]]+$/, '')
    if (seen.has(p)) continue
    seen.add(p)
    if (!knownFiles.has(p)) {
      findings.push({ kind: 'invented-path', page, detail: p })
    }
  }

  // Issue references must resolve to a real number. WHICH set is allowed depends
  // on the page's role: gaps pages (Roadmap) accept OPEN issues only, so a closed
  // ref framed as a live gap still fails; every other page accepts the broad
  // validRefs (open + closed issues + PRs) so closed-issue/PR rationale is valid.
  //
  // The boundary is a negative lookbehind, NOT `(?:^|\s)`: Roadmap entries are
  // written `- **#226 -- ...**`, so a `#` glued to `*`, `(` or `,` is real. The
  // old whitespace boundary could not see those lines -- the very lines that
  // ASSERT an issue is open -- so staleness there was caught only incidentally by
  // passing prose mentions elsewhere. `(?<![\w\/])` still rejects a `#` after a
  // word char or slash, so URL fragments like `/pull/342#issuecomment-123` (the
  // `#` follows a digit) are not mistaken for issue refs. (Node 22 runs this.)
  const allowed = GAPS_PAGES.has(page) ? openIssues : validRefs
  const closedOnPage = []
  for (const m of text.matchAll(/(?<![\w/])#(\d{1,4})\b/g)) {
    if (!allowed.has(m[1])) {
      findings.push({ kind: 'unknown-issue', page, detail: `#${m[1]}` })
    } else if (!openIssues.has(m[1])) {
      // Resolves, but to a CLOSED issue or a PR. Accepted here (that is the fix),
      // but recorded for the unconditional informational report below.
      closedOnPage.push(`#${m[1]}`)
    }
  }
  if (closedOnPage.length) closedRefsByPage.push({ page, refs: [...new Set(closedOnPage)] })
}

findings.push(...checkTechnicalPageLink(pagesByName))

// --- 2. OMISSION: every domain must be described somewhere -------------------
const allText = pages.map((p) => readFileSync(join(specDir, p), 'utf8')).join('\n')
for (const domain of facts.domains) {
  if (!allText.includes(domain) && !pages.includes(`Domain-${domain}.md`)) {
    findings.push({ kind: 'uncovered-domain', page: '(none)', detail: domain })
  }
}

// Reader-first coverage replaces quotas and forced module/code inventories.
try {
  validatePages(Object.fromEntries(pagesByName), {}, process.env.GITHUB_REPOSITORY)
} catch (error) {
  findings.push({ kind: 'reader-policy', page: '(all)', detail: error.message })
}

// --- report -------------------------------------------------------------------
process.stdout.write(
  `[verify] ${pages.length} page(s), ${totalWords} words, checked against ` +
  `${knownFiles.size} known files / ${openIssues.size} open issues / ${validRefs.size} valid refs\n`,
)

// UNCONDITIONAL, NON-FATAL: the per-page split preserves staleness detection for
// gaps LISTS (Roadmap) but cannot catch a stale gap CITATION on a rationale page
// -- "issue #226 is a currently-open gap" now passes because #226 is in validRefs,
// and framing is not inferable from a number. So surface (never block) every ref
// that resolves to a CLOSED issue or a PR, so the human reviewing the spec PR can
// check the framing -- the only place that judgement can live. This deliberately
// does NOT touch findings or the exit code, and is NOT behind a flag (an opt-in
// drift check has the same "nobody turns it on" defect one level up).
for (const { page, refs } of closedRefsByPage) {
  process.stdout.write(`[verify] closed refs (informational): ${page}: ${refs.join(' ')}\n`)
}

if (findings.length === 0) {
  process.stdout.write('[verify] no findings: the spec references only things that exist, and covers every domain.\n')
  process.exit(0)
}

const byKind = {}
for (const f of findings) (byKind[f.kind] ??= []).push(f)
for (const [kind, list] of Object.entries(byKind)) {
  process.stderr.write(`\n[verify] ${kind} (${list.length}):\n`)
  for (const f of list.slice(0, 25)) {
    process.stderr.write(`   ${f.page}: ${f.detail}\n`)
  }
  if (list.length > 25) process.stderr.write(`   ... and ${list.length - 25} more\n`)
}
process.stderr.write(
  '\n[verify] FAILED. The spec must describe the system that exists: fix the ' +
  'invented references, or regenerate the missing coverage.\n',
)
process.exit(1)
