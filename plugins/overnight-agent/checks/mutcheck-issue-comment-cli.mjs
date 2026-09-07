#!/usr/bin/env node
/**
 * mutcheck-issue-comment-cli.mjs -- proves the #505 entry point is load-bearing.
 *
 * WHY THIS NEEDS A MUTATION CHECK RATHER THAN TESTS
 *
 * `issue-comment.mjs` exists because a correct library was unreachable, and every failure it
 * prevents is SILENT AND SUCCESSFUL: an unmarked comment posts fine, exits 0, and only
 * duplicates a run later. So "the CLI posted a comment" passes on a CLI that has had its
 * stamping removed -- posting is what the broken version does too. A green assertion is not
 * evidence the guard is present; the only way to find out is to remove it and watch for red.
 *
 * THE ARMS ARE CHOSEN BY FAIL DIRECTION
 *
 * Each mutation is a plausible edit that leaves the CLI working in the happy path:
 *
 *   M1 bypass the library and post directly   -> comment lands UNMARKED (the #505 defect itself)
 *   M2 swallow the refusal into exit 0        -> a jammed issue reports success
 *   M3 make --dry-run write                   -> "let me check first" mutates the issue
 *   M4 accept an empty body                   -> an empty comment consumes the one agent slot
 *   M5 ignore an unrecognised argument        -> a typo'd flag silently uses a default
 *
 * M2 and M4 are the fail-OPEN directions, which is why they are here rather than left to the
 * happy-path assertions: both produce exit 0 and a plausible log line while doing the wrong
 * thing, and neither is visible to a caller reading the result instead of the subject.
 *
 * THE ABSENCE ARM
 *
 * Every arm works by replacing a literal anchor. If the anchor is gone the mutation is a no-op,
 * the assertions pass, and the check reports success at the exact moment its subject stopped
 * existing. A missing anchor is therefore a FAILURE, never a skip.
 *
 * MUTANTS ARE WRITTEN INTO THE CHECKS DIRECTORY, NOT A TEMP DIR
 *
 * The subject imports `./lib-issue-comments.mjs` by relative path, so a copy anywhere else
 * fails to resolve and every arm would "fail" for a reason unrelated to its mutation -- a green
 * result meaning nothing. Mutants live beside the original under a dotted name and are removed
 * in a finally block.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUBJECT = join(HERE, 'issue-comment.mjs')

let pass = 0
let fail = 0

function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`) }
  else { fail += 1; console.error(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`) }
}

const MARKER = '<!-- from: overnight-agent -->'

/**
 * A fake `gh`. Records every invocation, and resolves `-F body=@<path>` by reading the file the
 * real `defaultWriteFile` wrote -- so the body asserted on is the body that would have been
 * sent, not a body this harness constructed.
 */
function makeRun(comments) {
  const calls = []
  const run = (args) => {
    calls.push(args)
    const joined = args.join(' ')
    if (args[0] === 'api' && /issues\/\d+\/comments$/.test(args[1] ?? '') && !joined.includes('-X')) {
      return JSON.stringify(comments)
    }
    return JSON.stringify({ id: 4242 })
  }
  run.calls = calls
  run.writes = () => calls.filter((a) => a.includes('-X'))
  run.sentBody = () => {
    for (const a of calls) {
      const at = a.find((x) => typeof x === 'string' && x.startsWith('body=@'))
      if (at) return readFileSync(at.slice('body=@'.length), 'utf8')
      // Also recognise an inline `-f body=<text>`, which is how a bypass of the library is
      // most naturally written. Without this the M1 mutant would appear to send nothing and
      // the arm would pass on an absence rather than on the unmarked body it must catch.
      const inline = a.find((x) => typeof x === 'string' && x.startsWith('body=') && !x.startsWith('body=@'))
      if (inline) return inline.slice('body='.length)
    }
    return null
  }
  return run
}

const bodyFileWith = (text) => {
  const d = mkdtempSync(join(tmpdir(), 'mutcheck-ic-'))
  const p = join(d, 'body.md')
  writeFileSync(p, text, 'utf8')
  return p
}

const GOOD_BODY = bodyFileWith('A real write-up.\n')
const EMPTY_BODY = bodyFileWith('   \n\n')

const silent = () => {}

/**
 * The assertion suite. Returns a list of failure labels; empty means everything held.
 * Run against the original (must be empty) and against each mutant (must be non-empty).
 */
async function suite(modPath) {
  const mod = await import(pathToFileURL(modPath).href + `?v=${Date.now()}-${Math.random()}`)
  const failures = []
  const t = (label, cond) => { if (!cond) failures.push(label) }

  // A1 -- posting onto an issue with no marked comment stamps the body.
  {
    const run = makeRun([{ id: 1, body: 'a human comment' }])
    const code = mod.main({ argv: ['--repo', 'o/r', '--issue', '7', '--body-file', GOOD_BODY], run, log: silent, err: silent })
    const sent = run.sentBody()
    t('A1 posts stamped', code === 0 && sent !== null && sent.split(/\r?\n/)[0].trim() === MARKER)
    t('A1 posts, not patches', run.writes().some((a) => a.includes('POST')))
  }

  // A2 -- exactly one marked comment is EDITED in place, never duplicated.
  {
    const run = makeRun([{ id: 9, body: `${MARKER}\nprevious` }])
    const code = mod.main({ argv: ['--repo', 'o/r', '--issue', '7', '--body-file', GOOD_BODY], run, log: silent, err: silent })
    const w = run.writes()
    t('A2 edits in place', code === 0 && w.some((a) => a.includes('PATCH') && a.join(' ').includes('9')))
    t('A2 does not post', !w.some((a) => a.includes('POST')))
  }

  // A3 -- two marked comments refuse, with a non-zero exit and NO write at all.
  {
    const run = makeRun([{ id: 1, body: `${MARKER}\nx` }, { id: 2, body: `${MARKER}\ny` }])
    const code = mod.main({ argv: ['--repo', 'o/r', '--issue', '7', '--body-file', GOOD_BODY], run, log: silent, err: silent })
    t('A3 refuses non-zero', code !== 0)
    t('A3 writes nothing', run.writes().length === 0)
  }

  // A4 -- --dry-run reports without mutating.
  {
    const run = makeRun([{ id: 1, body: 'human' }])
    const code = mod.main({ argv: ['--repo', 'o/r', '--issue', '7', '--body-file', GOOD_BODY, '--dry-run'], run, log: silent, err: silent })
    t('A4 dry-run exit 0', code === 0)
    t('A4 dry-run writes nothing', run.writes().length === 0)
  }

  // A5 -- an empty body is refused before any write.
  {
    const run = makeRun([{ id: 1, body: 'human' }])
    const code = mod.main({ argv: ['--repo', 'o/r', '--issue', '7', '--body-file', EMPTY_BODY], run, log: silent, err: silent })
    t('A5 empty body refused', code === 2 && run.writes().length === 0)
  }

  // A6 -- an unrecognised argument is an error, not a silent default.
  {
    const run = makeRun([{ id: 1, body: 'human' }])
    const code = mod.main({ argv: ['--repo', 'o/r', '--issue', '7', '--body-file', GOOD_BODY, '--forse'], run, log: silent, err: silent })
    t('A6 bad flag refused', code === 2 && run.writes().length === 0)
  }

  return failures
}

const MUTATIONS = [
  {
    name: 'M1 bypass the library and post directly (comment lands unmarked)',
    find: 'res = writeAgenticComment({ repo: opts.repo, issue: opts.issue, body, run })',
    // The bypass a developer actually writes: reach for `gh` inline and skip the library. It
    // must stay synchronous and loadable, or the arm would be detected by the mutant failing to
    // import -- passing for a reason unrelated to the unmarked body it is supposed to expose.
    replace: 'run([\'api\', \'-X\', \'POST\', `repos/${opts.repo}/issues/${opts.issue}/comments`, ' +
             '\'-f\', `body=${body}`]), ' +
             'res = { action: \'post\', commentId: null, reason: \'mutant\' }',
  },
  {
    name: 'M2 swallow the refusal into exit 0',
    find: '    err(`REFUSED: ${e.message}`)\n    return 3',
    replace: '    err(`REFUSED: ${e.message}`)\n    return 0',
  },
  {
    name: 'M3 make --dry-run write anyway',
    find: '  if (opts.dryRun) {',
    replace: '  if (false) {',
  },
  {
    name: 'M4 accept an empty body',
    find: "  if (raw.trim() === '') {",
    replace: '  if (false) {',
  },
  {
    name: 'M5 ignore an unrecognised argument',
    find: '    throw new Error(`unrecognised argument \'${a}\'\\n\\n${USAGE}`)',
    replace: '    continue',
  },
]

async function run() {
  if (!existsSync(SUBJECT)) {
    console.error(`  FAIL subject missing -- ${SUBJECT}`)
    console.error('\n0 passed, 1 failed')
    process.exit(1)
  }

  // Normalised to LF before any anchor is matched. The file is CRLF on Windows, so a literal
  // anchor spanning a line break silently never matches -- the arm becomes a no-op and reports
  // "anchor not found" for a guard that is present and correct. Normalising here means every
  // future arm may span lines without inheriting that trap. (Found the honest way: M2's
  // two-line anchor failed on first run, and the absence arm caught it rather than passing.)
  const original = readFileSync(SUBJECT, 'utf8').replace(/\r\n/g, '\n')

  console.log('baseline -- the unmutated CLI must satisfy every assertion')
  const baseline = await suite(SUBJECT)
  check('baseline suite is green', baseline.length === 0, baseline.join('; '))

  console.log('\nmutations -- each must break at least one assertion')
  for (const [i, m] of MUTATIONS.entries()) {
    if (!original.includes(m.find)) {
      // Absence is failure, not a skip: a vanished anchor makes the arm a no-op that passes.
      check(m.name, false, `anchor not found -- the guard it mutates may have been removed: ${m.find.slice(0, 60)}...`)
      continue
    }
    const mutantPath = join(HERE, `.mutant-issue-comment-${i}.mjs`)
    try {
      writeFileSync(mutantPath, original.replace(m.find, m.replace), 'utf8')
      let failures
      try {
        failures = await suite(mutantPath)
      } catch (e) {
        // A mutant that cannot even load has been detected, which is the point of the arm.
        failures = [`threw: ${e.message.split('\n')[0]}`]
      }
      check(m.name, failures.length > 0, 'mutation survived -- nothing noticed')
    } finally {
      if (existsSync(mutantPath)) unlinkSync(mutantPath)
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => { console.error(e); process.exit(1) })
