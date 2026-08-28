/**
 * Mutation check for the #188 Skills-section guards.
 *
 * A test that passes proves nothing unless it also *fails* when the behaviour
 * it guards is broken. This applies one targeted mutation at a time, re-runs
 * the suite, and asserts the suite goes red — then restores the file.
 *
 * Run from the repo root: node scripts/mutcheck-skills-section.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const MUTANTS = [
  {
    name: 'criterion 5 — a missing Skills section still renders',
    file: 'src/skillsSection.js',
    from: "  return sections.find(s => s && isSkillsSection(s.title)) || null",
    to: "  return sections.find(s => s && isSkillsSection(s.title)) || { title: 'Skills', lines: [] }",
  },
  {
    name: 'criterion 2 — a row action button creeps into the read-only table',
    file: 'src/SkillsSection.jsx',
    from: "        Skills\n        <span className=\"skills-count\">{rows.length}</span>",
    to: "        Skills\n        <button type=\"button\">edit</button>\n        <span className=\"skills-count\">{rows.length}</span>",
  },
  {
    name: 'criterion 4 — refs stop being keyboard-reachable',
    file: 'src/SkillsSection.jsx',
    from: '            role="button"\n            tabIndex={0}',
    to: '',
  },
  {
    name: 'criterion 4 — navigation passes "#357" instead of the bare id',
    file: 'src/skillsSection.js',
    from: "    out.push({ type: 'ref', value: m[1] })",
    to: "    out.push({ type: 'ref', value: m[0] })",
  },
  {
    name: 'criterion 6 — a board write re-serializes and drops unknown sections',
    file: 'src/focusPlanOps.js',
    from: "export function opChangePriority(content, rawLine, oldPriority, newPriority) {\n  const newLine = rawLine.replace(oldPriority, newPriority)\n  const lines = content.split('\\n')",
    to: "export function opChangePriority(content, rawLine, oldPriority, newPriority) {\n  const newLine = rawLine.replace(oldPriority, newPriority)\n  const lines = content.split('\\n').filter(l => !l.startsWith('## Skills'))",
  },
  {
    name: 'parser — skill columns get task-board renaming applied',
    file: 'src/skillsSection.js',
    from: "      headers.push(...cells)",
    to: "      headers.push(...cells.map(c => (c === 'Picked up by' ? 'Age' : c)))",
  },
]

const TESTS = 'src/skillsSection.test.js src/SkillsSection.test.jsx'
let failures = 0

for (const m of MUTANTS) {
  const original = readFileSync(m.file, 'utf8')
  // Files in this repo are CRLF; the anchors above are written with \n. Work on
  // an LF-normalised copy and restore the original bytes verbatim afterwards.
  const crlf = original.includes('\r\n')
  const normalised = crlf ? original.replace(/\r\n/g, '\n') : original
  if (!normalised.includes(m.from)) {
    console.log(`  ?? SKIP  ${m.name}\n         (anchor not found in ${m.file})`)
    failures++
    continue
  }
  const mutated = normalised.replace(m.from, m.to)
  writeFileSync(m.file, crlf ? mutated.replace(/\n/g, '\r\n') : mutated)
  let caught = false
  try {
    execSync(`npx vitest run ${TESTS}`, { stdio: 'pipe' })
  } catch {
    caught = true
  } finally {
    writeFileSync(m.file, original)
  }
  if (caught) {
    console.log(`  OK     ${m.name}`)
  } else {
    console.log(`  SURVIVED  ${m.name}  <-- guard is not load-bearing`)
    failures++
  }
}

console.log(`\n${MUTANTS.length - failures}/${MUTANTS.length} mutants killed`)
process.exit(failures ? 1 : 0)
