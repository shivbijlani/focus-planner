// Keeps implementation detail out of the spec's main reading path.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DETAILS_OPEN = '<details>'
const DETAILS_CLOSE = '</details>'
const TECHNICAL_PAGE = 'Technical-Architecture.md'
const GENERATED_WRAPPER_RE =
  /<details>\r?\n<summary><strong>(Technical detail:[^<]+)<\/strong><\/summary>\r?\n\r?\n> \[!NOTE\]\r?\n> Optional implementation detail\. The surrounding section states the product behavior\.\r?\n\r?\n([\s\S]*?)\r?\n\r?\n<\/details>/g

function regions(text, open, close) {
  const found = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor)
    if (start === -1) break
    const end = text.indexOf(close, start + open.length)
    if (end === -1) break
    found.push([start, end + close.length])
    cursor = end + close.length
  }
  return found
}

function fencedBlocks(text) {
  const blocks = []
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm
  let match
  while ((match = opening.exec(text)) !== null) {
    const marker = match[1][0]
    const closing = new RegExp(`^ {0,3}\\${marker}{${match[1].length},}\\s*$`, 'gm')
    closing.lastIndex = match.index + match[0].length
    const end = closing.exec(text)
    if (!end) continue
    blocks.push({
      start: match.index,
      end: end.index + end[0].length,
      language: match[2].trim().split(/\s+/)[0].toLowerCase(),
      text: text.slice(match.index, end.index + end[0].length),
    })
    opening.lastIndex = end.index + end[0].length
  }
  return blocks
}

function technicalTables(text) {
  const lines = [...text.matchAll(/.*(?:\r?\n|$)/g)]
  const tables = []
  for (let index = 0; index < lines.length - 1; index++) {
    const header = lines[index][0]
    const separator = lines[index + 1][0]
    if (!header.includes('|') || !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(separator)) {
      continue
    }
    let endIndex = index + 2
    while (endIndex < lines.length && lines[endIndex][0].includes('|')) endIndex++
    const start = lines[index].index
    const end = lines[endIndex - 1].index + lines[endIndex - 1][0].replace(/\r?\n$/, '').length
    const table = text.slice(start, end)
    if (/(?:src|scripts|packages|plugins)\/[A-Za-z0-9_.\-/]+/.test(table)) {
      tables.push({ start, end, text: table })
    }
    index = endIndex - 1
  }
  return tables
}

function inside(index, spans) {
  return spans.some(([start, end]) => index > start && index < end)
}

function hasAdjacentAlert(text, detailsStart) {
  const before = text.slice(0, detailsStart)
  return /(?:^|\r?\n)> \[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\r?\n(?:>[^\r\n]*(?:\r?\n|$))+\r?\n$/.test(before)
}

export function formatTechnicalDetails(text, page = '') {
  if (page === TECHNICAL_PAGE) return text

  let formatted = text.replace(
    GENERATED_WRAPPER_RE,
    [
      '> [!NOTE]',
      '> **$1** Optional implementation detail; the surrounding section states the product behavior.',
      '',
      DETAILS_OPEN,
      '<summary><strong>Show technical detail</strong></summary>',
      '',
      '$2',
      '',
      DETAILS_CLOSE,
    ].join('\n'),
  )
  const detailSpans = regions(formatted, DETAILS_OPEN, DETAILS_CLOSE)
  const exposed = [
    ...fencedBlocks(formatted).filter((block) => !inside(block.start, detailSpans)),
    ...technicalTables(formatted).filter((table) => !inside(table.start, detailSpans)),
  ].sort((a, b) => b.start - a.start)

  for (const block of exposed) {
    const replacement = [
      '> [!NOTE]',
      '> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.',
      '',
      DETAILS_OPEN,
      '<summary><strong>Show technical detail</strong></summary>',
      '',
      block.text,
      '',
      DETAILS_CLOSE,
    ].join('\n')
    formatted = formatted.slice(0, block.start) + replacement + formatted.slice(block.end)
  }

  return formatted
}

export function readabilityFindings(page, text) {
  const findings = []
  const detailSpans = regions(text, DETAILS_OPEN, DETAILS_CLOSE)

  for (const block of fencedBlocks(text)) {
    if (page === TECHNICAL_PAGE) {
      if (block.language !== 'mermaid') {
        findings.push({
          kind: 'technical-doc-code',
          page,
          detail: 'only Mermaid architecture diagrams are allowed; implementation code is not',
        })
      }
    } else if (!inside(block.start, detailSpans)) {
      findings.push({
        kind: 'exposed-technical-detail',
        page,
        detail: 'fenced examples must be inside a collapsible <details> block',
      })
    }
  }

  for (const [start, end] of detailSpans) {
    const block = text.slice(start, end)
    if (!/<summary>[\s\S]*?<\/summary>/.test(block)) {
      findings.push({
        kind: 'unlabelled-technical-detail',
        page,
        detail: 'each <details> block needs a summary',
      })
    }
    if (!hasAdjacentAlert(text, start)) {
      findings.push({
        kind: 'uncoloured-technical-detail',
        page,
        detail: 'each <details> block needs a GitHub alert callout immediately before it',
      })
    }
  }

  if (page !== TECHNICAL_PAGE) {
    for (const table of technicalTables(text)) {
      if (!inside(table.start, detailSpans)) {
        findings.push({
          kind: 'exposed-technical-detail',
          page,
          detail: 'module-path tables must be inside a collapsible <details> block',
        })
      }
    }
  }

  return findings
}

export function checkTechnicalPageLink(pagesByName) {
  const home = pagesByName.get('Home.md') ?? ''
  if (!pagesByName.has(TECHNICAL_PAGE)) {
    return [{
      kind: 'missing-technical-doc',
      page: '(none)',
      detail: TECHNICAL_PAGE,
    }]
  }
  if (!home.includes('[Technical Architecture](Technical-Architecture)')) {
    return [{
      kind: 'unlinked-technical-doc',
      page: 'Home.md',
      detail: '[Technical Architecture](Technical-Architecture)',
    }]
  }
  return []
}

function argValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : null
}

export function formatDirectory(dir) {
  const changed = []
  for (const page of readdirSync(dir).filter((file) => file.endsWith('.md'))) {
    const path = join(dir, page)
    const before = readFileSync(path, 'utf8')
    const after = formatTechnicalDetails(before, page)
    if (after === before) continue
    writeFileSync(path, after, 'utf8')
    changed.push(page)
  }
  return changed
}

const invokedPath = process.argv[1] ? basename(process.argv[1]) : ''
if (invokedPath === basename(fileURLToPath(import.meta.url))) {
  const dir = argValue(process.argv.slice(2), '--dir') ?? 'docs/spec'
  if (!existsSync(dir)) {
    process.stderr.write(`[readability] spec directory not found: ${dir}\n`)
    process.exit(1)
  }
  const changed = formatDirectory(dir)
  process.stdout.write(
    changed.length
      ? `[readability] wrapped technical examples in ${changed.length} page(s): ${changed.join(', ')}\n`
      : '[readability] no exposed technical examples found\n',
  )
}
