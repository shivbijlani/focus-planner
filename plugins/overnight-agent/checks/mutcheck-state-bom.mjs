#!/usr/bin/env node
// mutcheck-state-bom.mjs — proves state-bom-sweep.mjs actually detects a blind reader (GH #681).
//
// The sweep's whole value is that it fails when someone forgets the BOM strip. A sweep that
// prints "clean" unconditionally would look identical on the day it stops working, which is the
// defect class it was written to prevent — so it is asserted here rather than trusted.
//
// Hermetic: every arm builds a synthetic checks/ directory under TEMP and points the REAL sweep
// at it with OA_CHECKS_DIR. The live store is never read and nothing is written outside TEMP.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWEEP = process.env.OA_SWEEP || path.join(HERE, 'state-bom-sweep.mjs');
if (!fs.existsSync(SWEEP)) {
  console.error(`cannot locate state-bom-sweep.mjs (tried ${SWEEP})`);
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-683-'));
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`); fail++; }
}

function run(files) {
  const dir = fs.mkdtempSync(path.join(root, 'c-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
  const r = spawnSync(process.execPath, [SWEEP], {
    encoding: 'utf8',
    env: { ...process.env, OA_CHECKS_DIR: dir },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A reader shaped exactly like the 36 real ones: resolves the live store, parses JSON, strips.
const GOOD = `
import fs from 'node:fs'; import path from 'node:path';
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
const st = JSON.parse(fs.readFileSync(path.join(stateDir, 'task-1.json'), 'utf8').replace(/^\\uFEFF/, ''));
console.log(st);
`;
// The same reader with the strip forgotten. This is the mutant the sweep exists to kill.
const BLIND = GOOD.replace(".replace(/^\\uFEFF/, '')", '');

console.log('');
console.log('DETECTS -- a reader that cannot parse what PowerShell wrote');

let r = run({ 'blind.mjs': BLIND, 'good.mjs': GOOD });
check('a blind reader fails the sweep', r.code === 1, `exit=${r.code}`);
check('and is named, so the fix has an address', /blind\.mjs/.test(r.out), r.out.slice(0, 120));
check('while the correct reader beside it is not accused', !/good\.mjs/.test(r.out.split('Fix:')[0] || ''), r.out.slice(0, 160));

console.log('');
console.log('QUIET -- what it must not flag');

r = run({ 'good.mjs': GOOD });
check('an all-correct directory passes', r.code === 0, `exit=${r.code} ${r.out.slice(0, 100)}`);

// A mutcheck writing its OWN fixtures creates them with fs.writeFileSync, so they carry no BOM
// and there is nothing to strip. Flagging it would be a false positive, and a sweep that cries
// wolf on 7 hermetic harnesses gets switched off.
const FIXTURE = `
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
fs.writeFileSync(path.join(dir, 'task-1.json'), JSON.stringify({ id: '1' }));
const st = JSON.parse(fs.readFileSync(path.join(dir, 'task-1.json'), 'utf8'));
console.log(st);
`;
r = run({ 'mutcheck-thing.mjs': FIXTURE, 'good.mjs': GOOD });
check('a harness reading its own TEMP fixtures is not flagged', r.code === 0, `exit=${r.code} ${r.out.slice(0, 120)}`);

// Listing filenames in the store is not parsing them; demanding a strip there is noise.
const LISTS_ONLY = `
import fs from 'node:fs'; import path from 'node:path';
const stateDir = path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state');
console.log(fs.readdirSync(stateDir).length);
`;
r = run({ 'lists.mjs': LISTS_ONLY, 'good.mjs': GOOD });
check('a reader that only lists the store is not flagged', r.code === 0, `exit=${r.code}`);

console.log('');
console.log('CANNOT-LOOK -- the sweep applies its own rule to itself');

// A sweep that matches nothing must not exit 0. That is the exact failure it was written to
// catch, so reporting "clean" over an empty set would make it an instance of its own defect.
r = run({ 'unrelated.mjs': 'console.log("hello")\n' });
check('a directory with no live-store readers exits 2, not 0', r.code === 2, `exit=${r.code}`);
check('and says the sweep is measuring nothing', /measuring nothing/.test(r.out), r.out.slice(0, 140));

const gone = spawnSync(process.execPath, [SWEEP], {
  encoding: 'utf8',
  env: { ...process.env, OA_CHECKS_DIR: path.join(root, 'does-not-exist') },
});
check('an unreadable directory exits 2, not 0', gone.status === 2, `exit=${gone.status}`);

console.log('');
console.log('THE PREMISE -- JSON.parse really does reject a BOM');

// If this ever stops being true the whole sweep is obsolete, and it should fail loudly here
// rather than keep guarding a problem that no longer exists.
let threw = false;
try { JSON.parse('\uFEFF{"a":1}'); } catch { threw = true; }
check('JSON.parse throws on a leading BOM', threw);
check('and succeeds once it is stripped', JSON.parse('\uFEFF{"a":1}'.replace(/^\uFEFF/, '')).a === 1);

fs.rmSync(root, { recursive: true, force: true });
console.log('');
if (fail) {
  console.log(`FAILED: ${fail} arm(s) disagreed, ${pass} passed.`);
  process.exit(1);
}
console.log(`OK: ${pass} arms agreed. A reader that cannot parse the store is caught.`);
process.exit(0);
