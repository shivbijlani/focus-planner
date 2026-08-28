// mutcheck-installed-capability.mjs
//
// Mutation check for installed-capability-sweep.mjs.
//
// A sweep is only worth its exit code if each of its guards is LOAD-BEARING: neuter the guard,
// and the sweep must start giving a WRONG answer. A guard whose removal changes nothing was
// never doing anything -- the failure class user-settings.md records repeatedly ("the check
// answered a different question and the answer looked fine").
//
// Convention:
//   KILLED   = neutering the guard broke at least one case -> the guard is load-bearing. GOOD.
//   SURVIVED = the sweep still answered correctly without it -> the guard is decorative. BAD.
//   INERT    = the mutation did not change the source (a stale pattern) -> the check is blind
//              to its own target, which is itself a finding.
//
// Cases (all fixtures are throwaway copies; the live installed tree is never modified):
//   healthy   the current installed tree                          -> expect exit 0
//   reverted  tonight's ACTUAL reinstall output (origin/main copy) -> expect exit 1
//   missing   healthy tree with oa-state.ps1 deleted               -> expect exit 1
//
// The `reverted` fixture is the whole point: installed-skill-drift-sweep scores those exact
// bytes as MAIN / "no drift", because the fix is in the still-open PR #198. Provenance says
// healthy; capability says broken. Capability is right.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const SWEEP =
  process.env.OA_SWEEP ||
  join(homedir(), 'AppData', 'Local', 'overnight-agent', 'installed-capability-sweep.mjs');
const INSTALLED = join(homedir(), '.copilot', 'installed-plugins', 'focus-planner');
const SKILLREL = join('overnight-agent', 'skills', 'overnight-agent');
const ROOT = join(tmpdir(), 'mutcheck-installed-capability');

// Normalise to LF before mutating. The sweep file round-trips through Windows editors and is
// stored CRLF; the first cut of this harness wrote its patterns with \n and every mutation
// silently matched NOTHING, reporting INERT. That is the same "the host quietly means something
// other than what the source says" family as the BOM-less-.ps1 and $r/$R lessons already in
// user-settings.md -- and the only reason it was visible is that INERT is reported rather than
// counted as a pass.
const src = readFileSync(SWEEP, 'utf8').replace(/\r\n/g, '\n');

// --- fixtures -------------------------------------------------------------------------------
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

function buildFixture(name, mutate) {
  const dir = join(ROOT, name);
  cpSync(INSTALLED, dir, { recursive: true });
  if (mutate) mutate(join(dir, SKILLREL));
  return dir;
}

const backups = join(homedir(), 'AppData', 'Local', 'overnight-agent', 'backups');
const revertedFile = readdirSync(backups)
  .filter((f) => f.startsWith('oa-state.ps1.reverted-main-'))
  .sort()
  .pop();

if (!revertedFile) {
  console.log('SKIP: no reverted-main backup on this machine to use as the negative fixture.');
  console.log('      (It is written by the run that restores the fixed build.)');
  process.exit(0);
}

const F = {
  healthy: buildFixture('healthy', null),
  reverted: buildFixture('reverted', (skillDir) =>
    writeFileSync(join(skillDir, 'oa-state.ps1'), readFileSync(join(backups, revertedFile))),
  ),
  missing: buildFixture('missing', (skillDir) =>
    rmSync(join(skillDir, 'oa-state.ps1'), { force: true }),
  ),
};

const EXPECT = { healthy: 0, reverted: 1, missing: 1 };

function runSweep(sweepPath, fixture) {
  try {
    execFileSync('node', [sweepPath], {
      env: { ...process.env, OA_INSTALLED_PLUGIN: fixture },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return 0;
  } catch (e) {
    return e.status ?? 99;
  }
}

function evaluate(sweepPath) {
  const got = {};
  for (const [name, dir] of Object.entries(F)) got[name] = runSweep(sweepPath, dir);
  const wrong = Object.keys(EXPECT).filter((k) => got[k] !== EXPECT[k]);
  return { got, wrong };
}

// --- baseline -------------------------------------------------------------------------------
const base = evaluate(SWEEP);
console.log(`sweep    : ${SWEEP}`);
console.log(`fixtures : healthy, reverted (${revertedFile}), missing\n`);
console.log('case      expect  actual');
for (const k of Object.keys(EXPECT)) {
  console.log(`${k.padEnd(10)}${String(EXPECT[k]).padEnd(8)}${base.got[k]}  ${base.got[k] === EXPECT[k] ? '[PASS]' : '[FAIL]'}`);
}
if (base.wrong.length) {
  console.log(`\nFINDINGS: baseline is already wrong on: ${base.wrong.join(', ')}`);
  process.exit(1);
}
console.log('\nbaseline OK — the sweep separates a reverted build from a healthy one.\n');

// --- mutants --------------------------------------------------------------------------------
const MUTANTS = [
  {
    id: 'g1 ref-independence',
    note: 'make the sweep clear a capability when the file matches origin/main (i.e. behave like installed-skill-drift-sweep)',
    apply: (t) =>
      t.replace(
        'const missing = (cap.mustMatch ?? []).filter((re) => !re.test(text));',
        `const __onMain = (() => { try {
             const p = cap.file.split('skills\\\\overnight-agent\\\\').pop();
             const blob = execFileSync('git', ['show', 'origin/main:plugins/overnight-agent/skills/overnight-agent/' + p],
               { cwd: 'V:\\\\repos\\\\focus-planner', encoding: 'utf8', maxBuffer: 67108864 });
             return blob.replace(/\\r\\n/g, '\\n').trim() === text.replace(/\\r\\n/g, '\\n').trim();
           } catch { return false; } })();
         if (__onMain) { rows.push({ id: cap.id, verdict: 'OK', detail: '' }); continue; }
         const missing = (cap.mustMatch ?? []).filter((re) => !re.test(text));`,
      ),
    extraImport: true,
  },
  {
    id: 'g2 missing-target-is-a-finding',
    note: 'skip a capability whose file is absent instead of reporting it',
    apply: (t) =>
      t.replace(
        `  if (!existsSync(cap.file)) {
    const row = { id: cap.id, verdict: 'MISSING-FILE', detail: cap.file };
    rows.push(row);
    findings.push({ ...cap, ...row });
    continue;
  }`,
        `  if (!existsSync(cap.file)) {
    continue;
  }`,
      ),
  },
  {
    id: 'g3 non-empty manifest',
    note: 'let an empty manifest pass instead of failing loudly',
    apply: (t) =>
      t
        .replace(
          `if (!Array.isArray(MANIFEST) || MANIFEST.length === 0) {
  console.log('FINDINGS: capability manifest is empty -- this sweep would certify anything.');
  process.exit(1);
}`,
          '// guard removed by mutant',
        )
        // Model the scenario the guard defends against: the roster has been filtered to nothing
        // (the BRIDGE_SRC / mutcheck-glob failure class) AND the guard is gone. Emptied this way
        // rather than by rewriting the literal, because a mutant that fails to PARSE looks exactly
        // like a killed mutant while proving nothing.
        .replace('const MANIFEST = [', 'const MANIFEST = []; const __ORIGINAL_MANIFEST = ['),
  },
];

let killed = 0;
let invalid = 0;
let inert = 0;
for (const m of MUTANTS) {
  let mutated = m.apply(src);
  if (m.extraImport) {
    mutated = mutated.replace(
      "import { readFileSync, existsSync } from 'node:fs';",
      "import { readFileSync, existsSync } from 'node:fs';\nimport { execFileSync } from 'node:child_process';",
    );
  }
  if (mutated === src) {
    console.log(`INERT     ${m.id}\n          mutation did not change the source (stale pattern)`);
    inert++;
    continue;
  }
  const p = join(ROOT, `mutant-${m.id.split(' ')[0]}.mjs`);
  writeFileSync(p, mutated, 'utf8');

  // A mutant that does not PARSE exits non-zero on every fixture, which is indistinguishable
  // from a killed mutant -- it would certify a guard as load-bearing on the strength of a typo.
  // Validate syntax first and report it as INVALID, never as a kill.
  try {
    execFileSync('node', ['--check', p], { stdio: 'pipe' });
  } catch (e) {
    console.log(`INVALID   ${m.id}\n          mutant does not parse; not counted as a kill\n          ${String(e.stderr || '').split('\n')[0]}`);
    invalid++;
    continue;
  }

  const res = evaluate(p);
  if (res.wrong.length) {
    killed++;
    console.log(`KILLED    ${m.id}\n          ${m.note}\n          now wrong on: ${res.wrong.join(', ')}`);
  } else {
    console.log(`SURVIVED  ${m.id}\n          ${m.note}\n          sweep still answered correctly without it — guard is decorative`);
  }
}

console.log(`\nmutants killed: ${killed}/${MUTANTS.length}` + (inert ? `   INERT: ${inert}` : '') + (invalid ? `   INVALID: ${invalid}` : ''));
if (killed !== MUTANTS.length) {
  console.log('FINDINGS: at least one guard is not load-bearing (or its mutation is stale/unparseable).');
  process.exit(1);
}
console.log('all guards load-bearing.');
process.exit(0);
