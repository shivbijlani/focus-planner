// mutcheck-basename-collision.mjs
//
// Proves every guard in basename-collision-sweep.mjs is load-bearing.
//
// Two things are established, and the second is the one that matters:
//
//   1. POSITIVE/NEGATIVE -- each guard produces the right verdict on its own fixture and stays
//      quiet on the legitimate case that most resembles it.
//   2. LOAD-BEARING -- disabling one guard must break EXACTLY its own fixture and nothing else.
//      A guard that can be deleted with every test still green is decoration, and the sweep it
//      belongs to is a check that cannot fail. This repo has already shipped one of those: a
//      detector that reported `157` every night and passed anyway.
//
// The sweep is run as a CHILD PROCESS against real throwaway git repos, so what is measured is
// the actual script against real `git ls-files` output -- not a function lifted out of it.
//
// Usage: node mutcheck-basename-collision.mjs
// Exit:  0 all assertions hold - 1 a guard is not doing what it claims.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SWEEP = path.join(HERE, 'basename-collision-sweep.mjs');

const failures = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-mut-'));

function git(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

// Build a throwaway repo whose plugins/overnight-agent/ tree contains exactly `files`.
function makeRepo(name, files) {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'mut@example.invalid']);
  git(root, ['config', 'user.name', 'mutcheck']);
  git(root, ['config', 'core.autocrlf', 'false']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

// Run a (possibly mutated) sweep against a fixture repo. Returns { code, out }.
function runSweep(sweepPath, repo) {
  try {
    const out = execFileSync(process.execPath, [sweepPath], {
      encoding: 'utf8',
      env: { ...process.env, OA_REPO: repo },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const C = 'plugins/overnight-agent/checks';
const S = 'plugins/overnight-agent/skills/overnight-agent';
const BODY = '# a script\nWrite-Host "hello"\n';

// --- fixtures -------------------------------------------------------------------------
// Each names the guard(s) it exercises. `expect` is a predicate over the sweep output.
//
// WHY SOME FIXTURES DECLARE TWO OWNERS
// ------------------------------------
// A BOM-only or CRLF-only difference IS an identical pair, so its verdict can only be
// observed at all while g1 is reporting identical collisions. Giving those fixtures a
// genuine content difference to "isolate g2" would delete the very condition under test.
// So they declare g1 AND g2 rather than pretending to isolate one -- the same call
// mutcheck-write-turn.ps1 makes for its g4-stray-marker fixture. A fixture that hides a
// real dependency reports a cleaner matrix and a less honest one.

const fixtures = [
  {
    name: 'g1-identical-collision-is-still-a-finding',
    guards: ['g1'],
    files: { [`${C}/dup.ps1`]: BODY, [`${S}/dup.ps1`]: BODY },
    expect: (r) => r.code === 1 && /COLLISION\s+dup\.ps1\s+\[IDENTICAL\]/.test(r.out),
    why: 'byte-identical copies are refused by sync-oa-home exactly as differing ones are',
  },
  {
    name: 'g2-bom-only-difference-reads-IDENTICAL',
    guards: ['g1', 'g2'],
    files: { [`${C}/bom.ps1`]: `\uFEFF${BODY}`, [`${S}/bom.ps1`]: BODY },
    expect: (r) => r.code === 1 && /COLLISION\s+bom\.ps1\s+\[IDENTICAL\]/.test(r.out),
    why: 'a UTF-8 BOM is an encoding artifact; calling it DIVERGENT invents a merge decision',
  },
  {
    name: 'g2-crlf-only-difference-reads-IDENTICAL',
    guards: ['g1', 'g2'],
    files: { [`${C}/crlf.ps1`]: BODY.replace(/\n/g, '\r\n'), [`${S}/crlf.ps1`]: BODY },
    expect: (r) => r.code === 1 && /COLLISION\s+crlf\.ps1\s+\[IDENTICAL\]/.test(r.out),
    why: 'line endings are an encoding artifact for the same reason',
  },
  {
    name: 'g2-real-difference-still-reads-DIVERGENT',
    guards: ['g2'],
    files: { [`${C}/real.ps1`]: BODY, [`${S}/real.ps1`]: `${BODY}Write-Host "extra"\n` },
    expect: (r) => r.code === 1 && /COLLISION\s+real\.ps1\s+\[DIVERGENT\]/.test(r.out),
    why: 'normalisation must not launder a genuine content difference into IDENTICAL',
  },
  {
    name: 'g3-two-README.md-are-not-a-finding',
    guards: ['g3'],
    files: {
      'plugins/overnight-agent/README.md': '# top\n',
      [`${C}/README.md`]: '# checks\n',
      [`${C}/only.ps1`]: BODY,
    },
    expect: (r) => r.code === 0 && /PASS - 0 collisions/.test(r.out),
    why: 'a directory documenting itself is legitimate; flagging it is permanent unfixable noise',
  },
  {
    name: 'negative-no-collision-passes',
    guards: [],
    files: { [`${C}/a.ps1`]: BODY, [`${S}/b.ps1`]: BODY },
    expect: (r) => r.code === 0 && /PASS - 0 collisions/.test(r.out),
    why: 'distinct basenames must never be reported',
  },
];

// --- baseline -------------------------------------------------------------------------
console.log('--- baseline (real sweep on each fixture) ---');
const repos = {};
for (const f of fixtures) {
  repos[f.name] = makeRepo(f.name, f.files);
  const r = runSweep(SWEEP, repos[f.name]);
  const ok = f.expect(r);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${f.name}`);
  if (!ok) failures.push(`baseline ${f.name}: exit=${r.code}\n${r.out}`);
}

// --- mutations ------------------------------------------------------------------------
// Each mutation removes ONE guard from a copy of the sweep. The fixtures owned by that guard
// must break; every other fixture must stay green (collateral damage means the fixtures are
// not isolating what they claim to).

const src = fs.readFileSync(SWEEP, 'utf8');

const mutations = [
  {
    guard: 'g1',
    label: 'only report a collision when the copies DIFFER',
    apply: (s) => s.replace(
      'findings.push({ name, paths, verdict: allSame ? \'IDENTICAL\' : \'DIVERGENT\' });',
      'if (!allSame) findings.push({ name, paths, verdict: \'DIVERGENT\' });',
    ),
  },
  {
    guard: 'g2',
    label: 'stop stripping the BOM',
    apply: (s) => s.replace(".replace(/^\\uFEFF/, '')", ''),
  },
  {
    guard: 'g2',
    label: 'stop normalising CRLF',
    apply: (s) => s.replace(".replace(/\\r\\n/g, '\\n')", ''),
  },
  {
    guard: 'g3',
    label: 'stop excluding docs from the deployable set',
    apply: (s) => s.replace(
      "const DEPLOYABLE = new Set(['.ps1', '.mjs', '.js']);",
      "const DEPLOYABLE = new Set(['.ps1', '.mjs', '.js', '.md']);",
    ),
  },
];

console.log('');
console.log('--- mutation (disable one guard at a time) ---');
for (const m of mutations) {
  const mutPath = path.join(tmpRoot, `sweep-${m.guard}-${mutations.indexOf(m)}.mjs`);
  const mutated = m.apply(src);
  if (mutated === src) {
    failures.push(`mutation "${m.guard}: ${m.label}" changed nothing - the anchor no longer matches the source`);
    console.log(`  FAIL ${m.guard}: ${m.label} -> NO-OP (anchor drifted)`);
    continue;
  }
  fs.writeFileSync(mutPath, mutated, 'utf8');

  const broke = [];
  for (const f of fixtures) {
    const r = runSweep(mutPath, repos[f.name]);
    if (!f.expect(r)) broke.push(f.name);
  }

  const own = fixtures.filter((f) => f.guards.includes(m.guard)).map((f) => f.name);
  const brokeOwn = broke.filter((b) => own.includes(b));
  const collateral = broke.filter((b) => !own.includes(b));

  const loadBearing = brokeOwn.length > 0 && collateral.length === 0;
  console.log(`  ${m.guard} (${m.label}) -> broke [${broke.join(',')}] collateral [${collateral.join(',')}]  ${loadBearing ? 'LOAD-BEARING' : 'NOT LOAD-BEARING'}`);
  if (brokeOwn.length === 0) failures.push(`${m.guard} (${m.label}) is NOT load-bearing: disabling it broke none of its own fixtures [${own.join(',')}]`);
  if (collateral.length > 0) failures.push(`${m.guard} (${m.label}) caused collateral damage: [${collateral.join(',')}]`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('');
if (failures.length === 0) {
  console.log(`PASS - ${fixtures.length} fixtures, ${mutations.length} mutations, every guard load-bearing.`);
  process.exit(0);
}
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(1);
