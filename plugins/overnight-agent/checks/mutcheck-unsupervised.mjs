// mutcheck-unsupervised.mjs — mutation check for `findUndecodedJson`.
//
// The standing rule in this suite: a guard that no corpus case exercises is
// DEFENSIVE, not tested, and must be documented as such rather than claimed as
// verified (cf. `CLOSER_ESCAPE` in lib-lost-interpolation.mjs).
//
// Method: re-implement the matcher with exactly ONE guard disabled, run the whole
// corpus through it, and require the verdict to change. If disabling a guard
// changes nothing, that guard is unexercised and this check says so out loud.
//
// CORPUS PROVENANCE — every positive case is VERBATIM LIVE DATA, not invented:
//   TP1  the real 116 KB victim, read from the 08:00 repair backup
//        (`repair-backup-20260826-0815\Resume-Building-ChatGPT-for-Work.md.orig`).
//        This is the file that motivated the whole sweep.
//   TN1  the SAME file after repair — the strongest possible negative, because it
//        is the same content differing only in the defect.
//   TN2..TN5  hand-built minimal negatives that isolate one guard each.

import fs from 'node:fs';
import path from 'node:path';
import { findUndecodedJson } from './lib-unsupervised.mjs';

const OA = path.join(process.env.LOCALAPPDATA, 'overnight-agent');
const ORIG = path.join(OA, 'repair-backup-20260826-0815', 'Resume-Building-ChatGPT-for-Work.md.orig');
const LIVE = path.join(process.env.OneDrive, 'Documents (Private)', 'Career', 'Resume', 'Resume-Building-ChatGPT-for-Work.md');

// --- corpus ------------------------------------------------------------------
const corpus = [];

if (fs.existsSync(ORIG)) {
  corpus.push({ id: 'TP1 live-victim(.orig)', text: fs.readFileSync(ORIG, 'utf8'), expect: true });
} else {
  console.log('WARN  TP1 skipped - repair backup absent (the only real specimen)');
}
if (fs.existsSync(LIVE)) {
  corpus.push({ id: 'TN1 same-file-repaired', text: fs.readFileSync(LIVE, 'utf8'), expect: false });
}

// TN2 — long JSON-looking line but only a handful of escapes: isolates MIN_ESCAPES.
corpus.push({ id: 'TN2 few-escapes', text: '"' + 'a'.repeat(1200) + '\\n b \\n c', expect: false });
// TN3 — many escapes but a SHORT line: isolates MIN_LINE_LEN.
corpus.push({ id: 'TN3 short-line', text: '"' + '\\n'.repeat(40), expect: false });
// TN4 — long, escape-dense, but plain prose: isolates JSON_OPENER. This is the
// realistic shape of a doc that TALKS about escape sequences.
corpus.push({ id: 'TN4 prose-not-json', text: 'The sequence ' + '\\n '.repeat(400) + 'x'.repeat(1200), expect: false });
// TN5 — a document about ESCAPING backslashes: every pair is `\\n`, an escaped
// backslash followed by n, which is not an escape sequence. Isolates the step-over.
corpus.push({ id: 'TN5 escaped-backslashes', text: '"' + '\\\\n'.repeat(400) + 'y'.repeat(1200), expect: false });

// --- reference run -----------------------------------------------------------
let fail = 0;
console.log('=== baseline (shipping matcher) ===');
for (const c of corpus) {
  const got = findUndecodedJson(c.text).length > 0;
  const ok = got === c.expect;
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.id}  expected=${c.expect} got=${got}`);
}

// --- mutants -----------------------------------------------------------------
// Each mutant disables exactly one guard. A guard is KILLED if some corpus case
// flips verdict, i.e. the guard is load-bearing.
function matcher({ minLen, minEsc, requireOpener, stepOverEscapedBackslash }) {
  return (text) => {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.length < minLen) continue;
      let escapes = 0;
      for (let j = 0; j < line.length - 1; j++) {
        if (line[j] !== '\\') continue;
        if (stepOverEscapedBackslash && line[j + 1] === '\\') { j++; continue; }
        if (line[j + 1] === 'n') escapes++;
      }
      if (escapes < minEsc) continue;
      if (requireOpener && !/^[[{]?\s*"/.test(line.trimStart())) continue;
      out.push(1);
    }
    return out;
  };
}

const base = { minLen: 1000, minEsc: 20, requireOpener: true, stepOverEscapedBackslash: true };
const mutants = [
  { name: 'MIN_LINE_LEN disabled', cfg: { ...base, minLen: 0 } },
  { name: 'MIN_ESCAPES disabled', cfg: { ...base, minEsc: 0 } },
  { name: 'JSON_OPENER disabled', cfg: { ...base, requireOpener: false } },
  { name: 'escaped-backslash step-over disabled', cfg: { ...base, stepOverEscapedBackslash: false } },
];

console.log('\n=== mutants (each must be KILLED by >=1 corpus case) ===');
for (const m of mutants) {
  const fn = matcher(m.cfg);
  const killers = corpus.filter((c) => (fn(c.text).length > 0) !== c.expect).map((c) => c.id);
  if (killers.length) {
    console.log(`  KILLED    ${m.name}  by ${killers.join(', ')}`);
  } else {
    console.log(`  SURVIVED  ${m.name}  <- UNEXERCISED: document as defensive, do not claim it as tested`);
    fail++;
  }
}

console.log(fail ? `\nFAILURES: ${fail}` : '\nall baseline cases pass; all guards mutation-killed');
process.exit(fail ? 1 : 0);
