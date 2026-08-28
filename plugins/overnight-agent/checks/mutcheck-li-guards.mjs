// mutcheck-li-guards.mjs — prove the false-positive guards in
// lib-lost-interpolation.mjs are LOAD-BEARING, not decorative.
//
// Named `mutcheck-*` deliberately: run-sweeps.ps1 auto-discovers that prefix
// under -IncludeMutchecks, so this harness runs with the suite instead of
// becoming another script that only executes when someone remembers it.
//
// WHY THIS EXISTS
// -----------------------------------------------------------------------------
// `lib-lost-interpolation.mjs` already carries one guard annotated
// "UNEXERCISED as of 2026-08-26: removing this guard changes neither the
// mutation corpus nor the live corpus". That honesty is good, but it only
// happened because someone checked. A guard nobody re-measures is a guard that
// silently rots into a comment.
//
// So for each guard: neuter it in a temp copy of the library, re-run the
// negatives it was written for, and require that at least one of them starts
// flagging again. A guard whose removal changes nothing is reported as
// UNEXERCISED so it is never cited as tested.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'lib-lost-interpolation.mjs');
// Normalise EOLs before anchoring. The library is CRLF on this machine, so an
// anchor written with `\n` silently matches nothing — which presents as three
// SKIPs rather than a failure, i.e. the harness would quietly measure nothing.
// Exactly the class of blind check this suite keeps rediscovering.
const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

// The negatives each guard exists to protect, verbatim from live journals.
// All four path shapes hang off the single `inPathToken` guard now that the
// narrower doubled-backslash guard was proved redundant and removed.
const CASES = {
  pathToken: [
    'Wrote 4 JD-tailored resumes to OneDrive\\\\...\\\\Applications\\\\GitHub-2026-06-20\\\\<req>\\\\Shiv-Bijlani-Resume.md (PARS voice rules respected).',
    'PDFs ready on disk under Applications\\\\GitHub-2026-06-20\\\\<req>\\\\. Awaiting user to enter email + consent.',
    'wrote 2 draft record-request emails (Pacific Perio, Crown Hill) in accident\\\\draft-emails\\\\. Only PIP=State Farm at-fault.',
    'Explained skills live in .github\\skills\\<name>\\ with a SKILL.md and are invoked by /name (like /dance-church).',
  ],
  starEscape: [
    '- From inbox: you replied twice on the review thread — *"I was expecting it all in the email"* and *"\\*Sections"*.',
  ],
};

// Each mutation removes exactly one guard and nothing else.
const MUTATIONS = [
  {
    id: 'pathToken',
    label: 'guard 1a — inPathToken() (separator inside a path-shaped token)',
    find: '    if (inPathToken(line, i)) continue;\n',
    replace: '',
  },
  {
    id: 'starEscape',
    label: "guard 4 — `\\*` is an escape unless it closes bold",
    find: "      if (after !== '*' && !priced) continue;\n",
    replace: '',
  },
];

// A guard must not only fire on its own negatives, it must leave the POSITIVES
// alone. Re-run a slice of the real positive corpus under every mutation too,
// so a guard that "works" by blinding the detector is caught.
const POSITIVES = [
  '- Price **~\\**, market cap **~\\**. 52-week range **\\.57 – \\** — so it is down ~55%',
  '| **Ayres Hotel Mission Viejo** | ~5.5 mi | \\–\\ | **~\\–\\,392** | **Cheapest.** |',
  '**Turo NV3500HD \\**  (add Turo protection)',
  '- 6/20 Northgate Market — \\.92',
  'Would you take **\\ shipped**? Can pay + arrange right away.',
];

let failures = 0;
const tmp = [];

async function load(file) {
  return import(url.pathToFileURL(file).href + `?t=${Date.now()}${Math.random()}`);
}

const base = await load(SRC);

// Sanity: with all guards in place every negative must be clean and every
// positive must still flag. If this fails the rest is meaningless.
for (const [id, lines] of Object.entries(CASES)) {
  for (const line of lines) {
    if (base.findTombstones(base.stripCode(line)).length !== 0) {
      console.log(`BASELINE BROKEN: ${id} negative still flags with all guards in place`);
      failures++;
    }
  }
}
for (const line of POSITIVES) {
  if (base.findTombstones(base.stripCode(line)).length === 0) {
    console.log('BASELINE BROKEN: a known positive does not flag with all guards in place');
    failures++;
  }
}

for (const m of MUTATIONS) {
  if (!source.includes(m.find)) {
    console.log(`SKIP      ${m.label}\n          (anchor not found — the guard was renamed or removed)`);
    failures++;
    continue;
  }
  const mutated = source.replace(m.find, m.replace);
  const file = path.join(HERE, `.mutguard-${m.id}.mjs`);
  fs.writeFileSync(file, mutated, 'utf8');
  tmp.push(file);

  const mod = await load(file);
  const revived = CASES[m.id].filter(
    (line) => mod.findTombstones(mod.stripCode(line)).length > 0,
  ).length;
  const positivesKept = POSITIVES.every(
    (line) => mod.findTombstones(mod.stripCode(line)).length > 0,
  );

  if (revived === 0) {
    console.log(`UNEXERCISED ${m.label}`);
    console.log('            removing it changed nothing — do NOT cite this guard as tested');
    failures++;
  } else {
    console.log(`LOAD-BEARING ${m.label}`);
    console.log(`             removing it re-flags ${revived}/${CASES[m.id].length} of its live negatives`);
  }
  if (!positivesKept) {
    console.log('             note: this mutation also drops a known positive');
  }
}

for (const f of tmp) fs.rmSync(f, { force: true });

console.log('');
console.log(failures ? `mutguard: ${failures} problem(s)` : 'mutguard: all guards load-bearing, positives intact');
process.exit(failures ? 1 : 0);
