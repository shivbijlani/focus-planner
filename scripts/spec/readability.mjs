// Keeps implementation detail out of the spec's main reading path.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DETAILS_OPEN = '<details>'
const DETAILS_CLOSE = '</details>'
const TECHNICAL_PAGE = 'Technical-Architecture.md'
const ALERT_RE = /^> \[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/m
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
  const pattern = /^```([^\r\n`]*)\r?\n[\s\S]*?^```\s*$/gm
  for (const match of text.matchAll(pattern)) {
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      language: match[1].trim().toLowerCase(),
      text: match[0],
    })
  }
  return blocks
}

function inside(index, spans) {
  return spans.some(([start, end]) => index > start && index < end)
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
  const exposed = fencedBlocks(formatted).filter((block) => !inside(block.start, detailSpans))

  for (const block of exposed.reverse()) {
    const replacement = [
      '> [!NOTE]',
      '> **Technical detail: concrete example.** Optional implementation detail; the surrounding section states the product behavior.',
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
    const leadIn = text.slice(Math.max(0, start - 500), start)
    if (!ALERT_RE.test(leadIn)) {
      findings.push({
        kind: 'uncoloured-technical-detail',
        page,
        detail: 'each <details> block needs a GitHub alert callout immediately before it',
      })
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
