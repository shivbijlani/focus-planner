#!/usr/bin/env node
// state-bom-sweep.mjs — a Node reader of the per-task state store must strip the UTF-8 BOM.
//
// THE DEFECT THIS PREVENTS. `oa-state.ps1` writes `%LOCALAPPDATA%\overnight-agent\state\task-*.json`
// from PowerShell, and PowerShell writes UTF-8 **with** a BOM. `JSON.parse` REJECTS a leading BOM:
//
//     JSON.parse('\uFEFF{"a":1}')   ->  SyntaxError: Unexpected token
//
// Measured on the live store 2026-09-25: **279 of 281** task files carry the BOM, and all 281
// parse cleanly once it is stripped. So a reader that forgets the strip does not fail loudly on
// one odd file — it fails on essentially EVERY file.
//
// AND THE FAILURE IS SILENT, which is the reason this is a guard rather than a note. The idiom in
// this directory is a per-file `try { ... } catch { continue }`, because an unreadable state file
// must not take down a sweep. Combine that with a BOM the reader cannot parse and the sweep
// completes, reports a confident `0`, and has examined nothing. That is #520/#632's class exactly:
// a check that COULD NOT LOOK reads identically to a check that looked and found nothing.
//
// It is not hypothetical. The measurement script written for #433 hit this on 2026-09-25 and
// reported `doc-bound tasks: 0 in state` against a store holding 106 live bindings. The number was
// wrong in the direction that looks like a clean result.
//
// WHY A GUARD RATHER THAN A SHARED HELPER. 35 production readers already strip it correctly, in at
// least five different spellings. Migrating them all to one helper is a large diff across working
// code, and the risk it removes is not "the existing readers are wrong" — they are right — it is
// "the next one forgets". A guard costs nothing and catches exactly that.
//
// Exit 0 = every live-store reader strips. Exit 1 = at least one cannot read the store it reads.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.OA_CHECKS_DIR || HERE;

// Reads the LIVE store, as opposed to a synthetic fixture under TEMP. The distinction is the whole
// accuracy of this sweep: a mutcheck that builds its own state files with fs.writeFileSync creates
// them WITHOUT a BOM, so it has nothing to strip and flagging it would be a false positive that
// gets the sweep switched off. Matching on the LOCALAPPDATA/overnight-agent/state path is what
// separates "reads what PowerShell wrote" from "reads what it wrote itself".
const LIVE_STORE_RE = /overnight-agent['"]\s*,\s*['"]state['"]|overnight-agent[\\/]+state/;
const STRIPS_RE = /\\uFEFF/;

// A file that reads the live store but never parses JSON has nothing to strip (it may only be
// listing filenames), so requiring the strip there would be noise.
const PARSES_RE = /JSON\.parse/;

function scan(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    // A sweep that cannot look must say so rather than exit 0 over an empty set — the same rule
    // this sweep exists to enforce, applied to itself.
    console.error(`state-bom-sweep: cannot read ${dir} (${err.message})`);
    process.exit(2);
  }
  const offenders = [];
  let readers = 0;
  for (const f of entries.filter((x) => /\.(mjs|cjs|js)$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!LIVE_STORE_RE.test(src) || !PARSES_RE.test(src)) continue;
    readers++;
    if (!STRIPS_RE.test(src)) offenders.push(f);
  }
  return { readers, offenders };
}

const { readers, offenders } = scan(DIR);

console.log(`state-bom-sweep: ${readers} file(s) parse JSON out of the live per-task state store`);
if (!readers) {
  // Zero readers means the match stopped matching, not that the risk went away.
  console.error('state-bom-sweep: found NO live-store readers, which means this sweep is measuring nothing');
  process.exit(2);
}
if (offenders.length) {
  console.error('');
  console.error('These parse the live state store without stripping the UTF-8 BOM oa-state.ps1 writes.');
  console.error('JSON.parse rejects a leading BOM, so each will throw on ~every file — and with the');
  console.error('usual per-file try/catch that reads as "nothing found" rather than as an error:');
  for (const f of offenders) console.error(`  ${f}`);
  console.error('');
  console.error("Fix: .replace(/^\\uFEFF/, '') on the text before JSON.parse.");
  process.exit(1);
}
console.log('clean - every live-store reader strips the BOM before parsing.');
process.exit(0);
