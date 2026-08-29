// doubled-apostrophe-sweep.mjs — find agent-authored text where an apostrophe was
// SILENTLY DOUBLED by shell quoting before it was written to disk.
//
// Established 2026-08-26 16:xx PT, after finding 50 occurrences across 6 journals.
//
// WHY lost-interpolation-sweep CANNOT SEE THIS
// -----------------------------------------------------------------------------
// Both defects come from the same root cause the STOP banner in user-settings.md
// describes: building markdown inside a PowerShell string. But they fail in
// OPPOSITE directions, so the existing matcher structurally cannot catch this one.
//
//   lost-interpolation : a value is DELETED   `$150`  -> ``        (data lost)
//   doubled apostrophe : a quote is DUPLICATED `don't` -> `don''t`  (data intact)
//
// lost-interpolation-sweep looks for the tombstones left behind when something
// vanished (`~\-275`, a stray `\`, `****`). A doubled apostrophe leaves no
// tombstone — the text is longer, not shorter — so it reads as clean to that sweep
// and it read 0 while all 50 of these were on disk.
//
// MECHANISM: inside a PowerShell single-quoted string (including a single-quoted
// here-string, which the STOP banner correctly recommends for markdown), `''` is
// the escape for one literal apostrophe. Text assembled or re-quoted a second time
// keeps the escape instead of resolving it, so `don't` lands as `don''t`.
//
// WHY IT IS SAFE TO FLAG MECHANICALLY: `letter''letter` is never valid markdown.
// Markdown emphasis uses `*`/`_`, never a doubled apostrophe between two letters.
// Every occurrence found live was an ordinary contraction or possessive —
// don''t, that''s, I''ll, it''s, NOAA''s, Eisenhower''s.
//
// DELIBERATELY NO CODE-SPAN EXEMPTION. Writing *about* this defect needs literal
// examples, and those sit inside backticks — so the obvious-looking refinement is
// "ignore doubled apostrophes inside code spans." Do not add it. The corruption
// comes from PowerShell re-quoting the WHOLE string, so it lands inside a code span
// just as readily as in prose; exempting them would buy a real blind spot to
// silence a self-inflicted false positive. The fix runs the other way: keep the
// detector strict, and keep worked examples OUT of the journal corpus. They belong
// in `user-settings.md` (Hazard 3), which this sweep does not scan. This very file
// is not scanned either, which is why the examples above are safe to keep here.
//
// UNLIKE the lost-interpolation class, this one is FULLY RECOVERABLE: nothing was
// deleted, so the repair is a mechanical `$1'$2` and the original meaning is exact.
//
// SCOPE: only text BELOW the OVERNIGHT-AGENT sentinel is a finding. Above it is
// Shiv's own prose — reported separately, never counted, never repaired.

import fs from 'node:fs'
import path from 'node:path'

const PLANNER = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner'
const JOURNAL = path.join(PLANNER, 'journal')
const JSON_OUT = process.argv.includes('--json')

const SENTINEL = /^<!--\s*OVERNIGHT-AGENT\b.*-->\s*$/m
const BAD = /([A-Za-z])''([A-Za-z])/g

/**
 * Blank out fenced blocks and inline code spans, PRESERVING length so every index still
 * lines up with the original text and the sample snippets stay correct.
 *
 * WHY (added 2026-08-26 17:50 PT): this sweep flagged the very turn that ANNOUNCED the
 * new write-time guards, because that turn necessarily quotes `don''t` as an example of
 * what gets caught. `lib-lost-interpolation.mjs` — this sweep's sibling, same root cause
 * — already established the rule against the live corpus: "a detector that flags its own
 * postmortem is a detector that gets switched off", and real damage "sits in prose and
 * table cells, never inside backticks". This sweep simply never got the same treatment.
 * Two detectors for one defect class disagreeing about the same line is worse than
 * either verdict.
 *
 * ⚠️ The exemption is NOT a silent drop. Quoted occurrences are counted and reported on
 * their own line, exactly as text above the sentinel already is, so the exemption stays
 * visible and bounded rather than becoming a hole nobody can see into.
 *
 * ⚠️ KNOWN BLIND SPOT, stated rather than hidden: the defect can in principle land inside
 * a code span. It is unlikely in practice — code spans hold identifiers, paths and
 * commands, not prose contractions — but it is not impossible, which is exactly why the
 * quoted count is printed instead of discarded.
 */
function maskCode(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ')
  return text
    .replace(/```[\s\S]*?```/g, blank)   // fenced blocks
    .replace(/`[^`\n]*`/g, blank)        // inline code spans
}

function scan(dir) {
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    const full = path.join(dir, f)
    let content
    try {
      content = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const m = SENTINEL.exec(content)
    // No sentinel => whole file is agent-authored deliverable text.
    const cut = m ? m.index : 0
    const head = m ? content.slice(0, cut) : ''
    const tail = m ? content.slice(cut) : content
    const tailBare = maskCode(tail)

    const above = [...head.matchAll(BAD)].length
    const hits = [...tailBare.matchAll(BAD)]
    const quoted = [...tail.matchAll(BAD)].length - hits.length
    if (!hits.length && !above && !quoted) continue

    const samples = hits.slice(0, 4).map((h) => {
      const i = h.index
      return tail.slice(Math.max(0, i - 22), i + 12).replace(/\s+/g, ' ').trim()
    })
    out.push({ file: f, count: hits.length, aboveSentinel: above, quoted, samples })
  }
  return out
}

const rows = scan(JOURNAL)
const findings = rows.filter((r) => r.count > 0)
const total = findings.reduce((a, r) => a + r.count, 0)
const userSpace = rows.reduce((a, r) => a + r.aboveSentinel, 0)
const quotedTotal = rows.reduce((a, r) => a + (r.quoted || 0), 0)

if (JSON_OUT) {
  console.log(JSON.stringify({ findings, total, userSpace, quoted: quotedTotal }, null, 2))
} else {
  console.log('journals scanned                     :', (() => {
    try {
      return fs.readdirSync(JOURNAL).filter((f) => /^task-\d+\.md$/.test(f)).length
    } catch {
      return 0
    }
  })())
  console.log('FLAGGED - doubled apostrophe in agent text:', total, 'in', findings.length, 'file(s)')
  console.log('left alone (Shiv\'s own prose, above sentinel):', userSpace)
  console.log('left alone (quoted inside a code span/fence) :', quotedTotal)
  console.log('')
  if (!findings.length) {
    console.log('Clean. A NEW finding means a turn written this run doubled its')
    console.log("apostrophes - rewrite it using a single-quoted here-string or a file tool.")
  }
  for (const r of findings) {
    console.log('  ' + r.file + '  x' + r.count)
    for (const s of r.samples) console.log('      ... ' + s)
  }
}

process.exit(findings.length ? 1 : 0)
