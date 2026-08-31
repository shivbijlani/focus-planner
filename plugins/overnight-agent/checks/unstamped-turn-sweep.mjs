// unstamped-turn-sweep.mjs — find agent turns that never stamped their own provenance,
// which is what let the CONSENT gate authorise the agent on its own words (#272).
//
// Established 2026-08-30, after the gate was measured failing OPEN on live task #442.
//
// THE DEFECT
// -----------------------------------------------------------------------------
// `oa-state.ps1` attributes trailing text POSITIONALLY: a `<!-- from: … -->` marker owns
// the text that follows it. An agent turn appended WITHOUT its own
// `<!-- from: overnight-agent -->` stamp therefore inserts no boundary, so the marker
// above keeps owning it. When that marker is the user's, the agent's prose is read back
// as the user's speech — and any affirmative inside it (`approve`, `yes`, `go ahead`)
// becomes the user's approval for an irreversible action.
//
// Measured live on #442: the region the reader called human-authored was 15,473 chars.
// The user's share was one question — "should watchdog agent be doing reaps?" — and the
// other 15,400 chars were an unmarked agent turn containing `approve`, `approved` and
// `yes` ×2. The verdict came back `consent_ok: true`.
//
// TWO CLASSES, REPORTED SEPARATELY — the distinction is the point
// -----------------------------------------------------------------------------
//   unstamped : a `## 🌙` turn with no provenance marker beneath it. A latent authoring
//               defect. 114 of 238 journals were in this state when #272 was filed, which
//               is the evidence that "remember to add the marker" is not a mechanism.
//   trapped   : an unstamped turn that also sits BELOW a `<!-- from: me -->` marker in the
//               same trailing region. This is the subset the reader actually mis-attributes,
//               so it is the one that exits non-zero. 5 journals when #272 was filed.
//
// Reporting only the dangerous subset would hide the population it is drawn from; reporting
// only the population would bury the five that matter. Both, separately.
//
// RELATIONSHIP TO THE OTHER TWO HALVES OF THE FIX
// -----------------------------------------------------------------------------
//   write-turn.ps1 G7 : refuses to CREATE a new one (mutcheck-write-turn.ps1)
//   oa-state.ps1      : a `## ` heading now ends a marker's ownership, so an unstamped turn
//                       reads as 'unknown' rather than as the human (mutcheck-consent-authorship.ps1)
//   this sweep        : reports the ones already on disk, so the backlog is visible instead
//                       of assumed drained
//
// The reader fix means a trapped journal is no longer *exploitable*; it does not mean the
// journal is *correct*. Attribution there is still guesswork, so they stay findings.
//
// SCOPE: only content below the OVERNIGHT-AGENT sentinel is examined. Above it is the
// user's own space and is never a finding.

import fs from 'node:fs'
import path from 'node:path'

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner'
const JOURNAL = process.env.SWEEP_JOURNAL_DIR || path.join(PLANNER, 'journal')
const JSON_OUT = process.argv.includes('--json')

const SENTINEL = /^<!--\s*OVERNIGHT-AGENT\b.*-->\s*$/m
const TURN_END = /^<!--\s*\/overnight-agent turn-end\s*-->\s*$/gm
const MOON = '\u{1F319}'

// A heading line, and the provenance markers. Matched line-exactly: `user-settings.md`
// records a false positive caused by using `.includes()` where the real parser matches a
// whole line, so a marker QUOTED inside prose must not count as a marker.
const H2 = /^[ \t]*##[ \t]+\S/
const AGENT_MARK = /^[ \t]*<!--[ \t]*from:[ \t]*overnight-agent[ \t]*-->[ \t]*$/
const HUMAN_MARK = /^[ \t]*<!--[ \t]*from:[ \t]*me[ \t]*-->[ \t]*$/

function isMoonHeading(line) {
  if (!H2.test(line) || /^[ \t]*###/.test(line)) return false
  return line.replace(/^[ \t]*##[ \t]+/, '').startsWith(MOON)
}

/** Index of the last turn-end stamp, which is where the trailing region begins. */
function trailingStart(text) {
  let last = -1
  TURN_END.lastIndex = 0
  let m
  while ((m = TURN_END.exec(text)) !== null) last = m.index + m[0].length
  return last
}

function analyse(text) {
  const s = SENTINEL.exec(text)
  if (!s) return null
  const managed = text.slice(s.index)
  const lines = managed.split(/\r?\n/)

  // Fenced blocks are quotation — a heading or marker inside one is an example, not
  // structure. Same exemption write-turn.ps1's guards use.
  const fenced = new Array(lines.length).fill(false)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*```/.test(lines[i])) { fenced[i] = true; inFence = !inFence; continue }
    fenced[i] = inFence
  }

  const turns = []
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || !isMoonHeading(lines[i])) continue
    let stamped = false
    for (let k = i + 1; k < lines.length; k++) {
      if (fenced[k]) continue
      if (H2.test(lines[k]) && !/^[ \t]*###/.test(lines[k])) break
      if (AGENT_MARK.test(lines[k])) { stamped = true; break }
    }
    turns.push({ line: i, stamped, heading: lines[i].trim().slice(0, 70) })
  }
  if (!turns.length) return null

  const newest = turns[turns.length - 1]
  if (newest.stamped) return null

  // Trapped = the unstamped newest turn sits below a human marker in the trailing region,
  // so the reader would hand the agent's text to the user.
  const tStart = trailingStart(text)
  const region = tStart >= 0 ? text.slice(tStart) : managed
  const regionLines = region.split(/\r?\n/)
  let sawHuman = false
  let trapped = false
  for (const l of regionLines) {
    if (HUMAN_MARK.test(l)) { sawHuman = true; continue }
    if (sawHuman && isMoonHeading(l)) { trapped = true; break }
  }

  return {
    heading: newest.heading,
    turns: turns.length,
    unstampedTurns: turns.filter((t) => !t.stamped).length,
    trapped,
  }
}

function scan(dir) {
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => /^task-\d+\.md$/.test(f)) } catch { return { rows: [], scanned: 0 } }
  const rows = []
  for (const f of files) {
    let text
    try { text = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
    const r = analyse(text)
    if (r) rows.push({ file: f, ...r })
  }
  return { rows, scanned: files.length }
}

const { rows, scanned } = scan(JOURNAL)
const trapped = rows.filter((r) => r.trapped)

if (JSON_OUT) {
  console.log(JSON.stringify({ scanned, unstamped: rows.length, trapped: trapped.length, rows }, null, 2))
} else {
  console.log('journals scanned                              :', scanned)
  console.log('newest agent turn carries NO provenance stamp :', rows.length)
  console.log('FLAGGED - trapped (below a user reply, so mis-attributable):', trapped.length)
  console.log('')
  if (!trapped.length) {
    console.log('Clean. A NEW finding means a turn written this run omitted its')
    console.log('`<!-- from: overnight-agent -->` stamp - append a correctly-stamped')
    console.log('turn to fix the boundary (do NOT rewrite the journal).')
  }
  for (const r of trapped) console.log('  ' + r.file + '  ' + r.heading)
  if (rows.length > trapped.length) {
    console.log('')
    console.log('unstamped but not yet trapped (latent, no user reply above):')
    for (const r of rows.filter((x) => !x.trapped)) console.log('  ' + r.file)
  }
}

process.exit(trapped.length ? 1 : 0)
