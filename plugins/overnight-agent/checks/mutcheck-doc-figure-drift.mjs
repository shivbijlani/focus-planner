#!/usr/bin/env node
/**
 * mutcheck-doc-figure-drift.mjs -- proves the #594 sweep is load-bearing.
 *
 * ACCEPTANCE CRITERION #4 OF #594, WHICH IS THE ONE THAT MATTERS
 * --------------------------------------------------------------
 * "A mutation arm asserting that a doc with a stale figure is a FINDING, not a clean run.
 *  Absence of a finding must not be producible by the checker simply not looking."
 *
 * That criterion exists because this sweep's failure mode is silence, and silence is exactly
 * what success looks like. Two of the mutants below were REAL BUGS in the first working copy,
 * caught by running it against the live #468 document rather than against a fixture:
 *
 *   M3  `[\d,]*` let the digit class end on a separator, so "81 of 89, up from 5" yielded the
 *       figure "89," -- which hashes differently from the identical "89" elsewhere. A figure
 *       restated FOUR times reported as 3 + 1, and the RESTATED count, the one number this
 *       class exists to produce, was wrong on the only document it had ever read.
 *
 *   M7  the live state store writes every task-*.json UTF-8 WITH A BOM, so a bare JSON.parse
 *       threw on all 266 of them. The catch swallowed it and the sweep published `0 of 1` --
 *       having read nothing. That is #346/#502 exactly: a check that cannot look returns the
 *       same bytes as one that looked and found nothing. It is an ABSENCE arm because the
 *       defect lives in the effect path.
 *
 * The fixtures are the real document's sentences, not invented ones, because both live bugs
 * were invisible to plausible-looking fixtures and visible immediately to real prose.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBJECT = join(HERE, 'doc-figure-drift-sweep.mjs');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`    ok   ${label}`);
  else {
    failures++;
    console.log(`    FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
  return cond;
}

// Verbatim from the #468 catch-up doc, 2026-09-07. Four live restatements of `81 of 89` (live
// value that day: 89 of 89), and one HISTORICAL `83 of 88` that must never be touched.
const DOC = [
  '| Doc coverage | Every open task has a catch-up doc. | In progress -- 81 of 89, up from 5; both halves built. |',
  '',
  '## Coverage: why a wake does not produce a doc',
  '',
  'Bound now: 81 of 89 live rows, measured 7 September, up from 5 when this page was first written.',
  '',
  'It would have refused turns on 83 of 88 rows the night it was armed -- a guard that always fires.',
  '',
  'That is the number now moving: 81 of 89, from 5 a few days ago, with nobody working a list.',
  '',
  '**81 of 89, up from 5, unattended.** Both halves are merged and running.',
].join('\n');

const LIVE = () => ({
  coverage: {
    n: 89,
    m: 89,
    label: 'bound catch-up docs of open board rows',
    anchors: [/\bbound\s+now\b/i, /\bdoc\s+coverage\b/i, /\blive\s+rows\b/i, /\bcatch-up\s+doc\b/i],
  },
});

async function suite(modPath) {
  const mod = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
  const { extractFigures, findDrift, coverageFrom } = mod;

  const figs = extractFigures(DOC);
  const findings = findDrift(figs, LIVE());
  const restated = findings.filter((f) => f.kind === 'RESTATED');
  const stale = findings.filter((f) => f.kind === 'STALE');

  // A1 -- THE FIGURE IS PARSED WHOLE. The M3 bug: a trailing comma joined the number, splitting
  // one restated figure into two distinct ones. Without this arm the headline count is wrong and
  // nothing says so.
  check(
    'A1 "81 of 89" parses without swallowing the trailing comma',
    figs.filter((f) => f.text === '81 of 89').length === 4,
    `got ${JSON.stringify(figs.map((f) => f.text))}`
  );

  // A2 -- ALL FOUR RESTATEMENTS ARE ONE FINDING WITH COUNT 4. The whole point of the class: four
  // copies are four chances to drift, and correcting only the ones a reader notices leaves the
  // document contradicting itself (#492).
  check('A2 restatement is reported once, with count 4', restated.length === 1 && restated[0].count === 4,
    `got ${JSON.stringify(restated)}`);

  // A3 -- HISTORY IS NOT DRIFT. `83 of 88` records what was true the night the guard was armed.
  // Flagging it invites someone to "correct" a number whose correctness is that it is old.
  check('A3 the historical 83 of 88 is excluded', !findings.some((f) => String(f.said).startsWith('83')),
    `got ${JSON.stringify(findings.map((f) => f.said))}`);

  // A4 -- `up from` IS NOT A HISTORY MARKER. It sits beside three of the four live restatements,
  // so reading it as history suppresses precisely the findings this sweep exists to raise. This
  // arm is the one that stops the M2 "just make it stricter" reflex.
  check('A4 "up from" does not silence a live figure', restated.length === 1 && stale.length > 0,
    `restated=${restated.length} stale=${stale.length}`);

  // A5 -- STALE FIRES ON THE ANCHORED OCCURRENCES, AND ONLY THOSE. Anchoring must be SELECTIVE:
  // some restatements name a quantity we hold a live value for, others are bare. Asserting an
  // exact count here would pin the test to how densely this fixture packs its anchors -- so the
  // property is "at least two, but not all of them", which is what selectivity means.
  check('A5 anchored occurrences are STALE, unanchored ones are not',
    stale.length >= 2 && stale.length < figs.filter((f) => f.text === '81 of 89').length
      && stale.every((f) => f.actual === '89 of 89'),
    `got ${stale.length} stale of ${figs.filter((f) => f.text === '81 of 89').length} occurrences`);

  // A6 -- AN UNANCHORED FIGURE IS NEVER CALLED STALE. The sweep must not assert that a number
  // about a different question is wrong; that finding is unactionable and gets checks ignored.
  const unanchored = findDrift(extractFigures('We shipped 3 of 7 arms this week.'), LIVE());
  check('A6 unanchored figures are not STALE', unanchored.filter((f) => f.kind === 'STALE').length === 0,
    `got ${JSON.stringify(unanchored)}`);

  // A7 -- A CORRECT, SINGLY-STATED FIGURE IS CLEAN. The convergence property. A check that cannot
  // reach silence is one that gets switched off (#433).
  const clean = findDrift(extractFigures('Bound now: 89 of 89 live rows.'), LIVE());
  check('A7 a correct single figure is clean', clean.length === 0, `got ${JSON.stringify(clean)}`);

  // A8 -- BOTH HALVES OF THE FIGURE ARE CHECKED. The live numerator (89) equalled the doc's stale
  // DENOMINATOR (89), so a comparison that comes to rest on either half alone reads the drifted
  // sentence as correct. That near-coincidence was live on the real document.
  const halfOnly = findDrift(extractFigures('Bound now: 89 of 125 live rows.'), LIVE());
  check('A8 a matching numerator with a wrong denominator is STALE',
    halfOnly.some((f) => f.kind === 'STALE'), `got ${JSON.stringify(halfOnly)}`);

  // A9 -- TWO OCCURRENCES ALREADY COUNT. Restating a live figure twice is the same hazard as
  // four times; a threshold tuned to the instance that produced the issue misses the next one.
  const twice = findDrift(extractFigures('Bound now: 81 of 89 live rows. Later: 81 of 89 again.'), LIVE());
  check('A9 two occurrences are a restatement', twice.some((f) => f.kind === 'RESTATED' && f.count === 2),
    `got ${JSON.stringify(twice)}`);

  // A10 -- THE LIVE VALUE COUNTS THE OPEN BOARD, NOT THE FILE SYSTEM. Terminal rows are excluded
  // and unbound rows are counted in the denominator; getting this wrong publishes a figure that
  // answers a different question, which is the denominator error #594 is itself about.
  const cov = coverageFrom([
    { status: 'in-progress', docId: 'a' },
    { status: 'proposed', docId: '' },
    { status: 'done', docId: '' },
    { status: 'skip', docId: 'z' },
  ]);
  check('A10 coverage counts open rows only', cov.n === 1 && cov.m === 2, `got ${JSON.stringify(cov)}`);

  return failures;
}

const MUTATIONS = [
  {
    id: 'M1',
    what: 'the history test is disabled, so a past measurement reads as a live one',
    why: 'the sweep starts demanding that "it would have refused turns on 83 of 88 rows the night it was armed" be updated to today\'s number -- destroying a record whose whole value is that it is old, and telling a reader the document is wrong where it is uniquely right. Killed by A3.',
    find: '      historical: HISTORY_MARKERS.some((rx) => rx.test(hist)),',
    replace: '      historical: false,',
  },
  {
    id: 'M2',
    what: '"up from" is added to the history markers',
    why: 'the plausible-looking tightening, and it is the worst change available: "up from 5" sits beside three of the four live restatements, so this silences the exact findings the sweep exists to raise while looking MORE careful. Killed by A2/A4.',
    find: '  /\\bwould\\s+have\\b/i,',
    replace: '  /\\bwould\\s+have\\b/i,\n  /\\bup\\s+from\\b/i,',
  },
  {
    id: 'M3',
    what: 'the digit class is allowed to end on a separator again',
    why: 'THE REAL BUG. "81 of 89, up from 5" yields the figure "89,", which hashes apart from the identical "89" elsewhere, so four restatements report as 3 + 1 and the headline count is wrong on the only document it ever read. Killed by A1/A2.',
    find: '  const re = /(\\d(?:[\\d,]*\\d)?)\\s+of\\s+(\\d(?:[\\d,]*\\d)?)/g;',
    replace: '  const re = /(\\d[\\d,]*)\\s+of\\s+(\\d[\\d,]*)/g;',
  },
  {
    id: 'M4',
    what: 'the restatement threshold is raised so only three or more count',
    why: 'tuned to the instance that produced the issue. A figure written twice drifts exactly as easily, and the sweep would report the next document clean while it contradicts itself. Killed by A9.',
    find: '    if (at.length < 2) continue;',
    replace: '    if (at.length < 3) continue;',
  },
  {
    id: 'M5',
    what: 'the anchor requirement is dropped, so every live figure is compared to every quantity',
    why: 'the sweep asserts that numbers about entirely different questions are stale -- unactionable findings on ordinary prose, which is how a check earns its way onto an ignore list in one run (#433). Killed by A6/A7.',
    find: '      if (!q.anchors.some((rx) => rx.test(f.context))) continue;',
    replace: '',
  },
  {
    id: 'M6',
    what: 'staleness is decided on the numerator alone',
    why: 'live NEAR-COINCIDENCE on the real document: the live numerator (89) equalled the doc\'s stale denominator (89), so a numerator-only comparison reads the drifted sentence as correct and reports the primary surface clean. Killed by A8.',
    find: '      if (f.n === q.n && f.m === q.m) break;',
    replace: '      if (f.n === q.n) break;',
  },
  {
    id: 'M7',
    kind: 'absence',
    what: 'the BOM is not stripped before JSON.parse of the state files',
    why: 'THE OTHER REAL BUG. Every task-*.json is UTF-8 WITH a BOM, so a bare parse throws on all 266, the catch swallows it, and the sweep publishes a live figure having read nothing -- reporting `0 of 1`. #346/#502 exactly, inside the tool built to catch that family.',
    find: ".replace(/^\\uFEFF/, '')",
  },
  {
    id: 'M8',
    kind: 'absence',
    what: 'a document that could not be fetched is counted as clean',
    why: 'the same conflation one level up: an unreadable doc and a doc with no drifted figures would produce identical output, so a broken Google transport would report the whole fleet healthy. The exit code must carry it.',
    find: 'unreadable++;',
  },
  {
    id: 'M9',
    kind: 'absence',
    what: 'the live universe is taken from the state directory rather than the planner board',
    why: 'task-*.json holds rows that have fallen off the board, so counting files answers a different question than the doc\'s sentence asks -- 89 of 125 instead of 89 of 89. Publishing that as the live value commits the denominator error #594 is about, inside the fix for it.',
    find: "board.matchAll(/^\\|\\s*(\\d+)[,\\s|]/gm)",
  },
  {
    id: 'M10',
    kind: 'schedule',
    what: 'the sweep is not registered in run-sweeps.ps1',
    why: 'the failure this repo has already had: a guard that is written, tested, merged and invoked by NOTHING. It passes review, it passes its own mutcheck, and it never runs once. Membership in the schedule is part of the deliverable, so it is asserted here rather than assumed.',
    find: "@{ n = 'doc-figure-drift-sweep'; bridge = $false }",
  },
];

async function run() {
  console.log('mutcheck-doc-figure-drift (#594)');
  const original = readFileSync(SUBJECT, 'utf8');
  const lf = original.replace(/\r\n/g, '\n');

  console.log('\nBASELINE');
  const baseFailures = await suite(SUBJECT);
  if (baseFailures > 0) {
    console.log(`\nBASELINE FAILED with ${baseFailures} failure(s) -- the fix is not in place.`);
    process.exit(1);
  }

  let survivors = 0;
  const mutantPath = join(HERE, '.mutant-doc-figure-drift.mjs');

  for (const m of MUTATIONS) {
    console.log(`\n${m.id}  ${m.what}`);
    console.log(`    why: ${m.why}`);

    if (m.kind === 'schedule') {
      let sched = '';
      try { sched = readFileSync(join(HERE, 'run-sweeps.ps1'), 'utf8'); } catch { /* reported below */ }
      if (sched.includes(m.find)) console.log('    ok   registered in run-sweeps.ps1');
      else {
        survivors++;
        console.log(`    SURVIVED -- not scheduled, so the sweep would never run: ${m.find}`);
      }
      continue;
    }

    if (m.kind === 'absence') {
      if (lf.includes(m.find)) console.log('    ok   guard present in source');
      else {
        survivors++;
        console.log(`    SURVIVED -- guard missing: ${m.find.trim()}`);
      }
      continue;
    }

    if (!lf.includes(m.find)) {
      survivors++;
      console.log(`    SURVIVED -- anchor not found, so this arm tested nothing: ${m.find.trim().slice(0, 70)}`);
      continue;
    }
    let mutated = lf.replace(m.find, m.replace);
    if (m.tail) {
      if (!mutated.includes(m.tail.find)) {
        survivors++;
        console.log('    SURVIVED -- tail anchor not found, so this arm tested nothing.');
        continue;
      }
      mutated = mutated.replace(m.tail.find, m.tail.replace);
    }
    writeFileSync(mutantPath, mutated, 'utf8');
    failures = 0;
    const got = await suite(mutantPath);
    if (got === 0) {
      survivors++;
      console.log('    SURVIVED -- the suite passed with this mutation in place.');
    } else {
      console.log(`    killed by ${got} assertion failure(s)`);
    }
    try { unlinkSync(mutantPath); } catch { /* best effort */ }
  }

  failures = 0;
  console.log('');
  if (survivors) {
    console.log(`${survivors} mutation(s) SURVIVED -- the guard does not hold.`);
    process.exit(1);
  }
  console.log(`all ${MUTATIONS.length} mutations killed.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
