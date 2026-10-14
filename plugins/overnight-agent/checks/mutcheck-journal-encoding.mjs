// mutcheck-journal-encoding.mjs
//
// Proves journal-encoding-invariant.mjs is LOAD-BEARING.
//
// A checker that passes on a good build tells you nothing unless it also fails on a bad
// one. This file reintroduces the historical defect into a COPY of oa-state.ps1 and
// asserts the sweep goes red. M1 is the literal regression that destroyed 593 lines of
// task-448.md on 2026-08-27.
//
// exit 1 = a mutant survived (the sweep is blind to a defect it claims to guard).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SWEEP = join(HERE, 'journal-encoding-invariant.mjs');
const argTarget = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const LIVE =
  argTarget ||
  process.env.OA_STATE_PS1 ||
  'C:\\Users\\shiv\\.copilot\\installed-plugins\\focus-planner\\overnight-agent\\skills\\overnight-agent\\oa-state.ps1';

const src = readFileSync(LIVE, 'utf8');

const isNodeTarget = LIVE.endsWith('.mjs');

function runNodeInvariant(target) {
  const tmp = mkdtempSync(join(tmpdir(), 'oa-enc-node-'));
  const jdir = join(tmp, 'journal');
  const sdir = join(tmp, 'state');
  mkdirSync(jdir);
  mkdirSync(sdir);
  const id = '999001';
  const journal = join(jdir, `task-${id}.md`);
  const original = [
    `# Task ${id}: encoding invariant fixture`,
    '',
    'Shiv note — with “curly quotes” and an emoji 🌙.',
    '',
    '---',
    '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->',
    '',
    '## 🌙 Overnight Agent',
    '',
    '**Status:** In-progress — plan v1',
    '',
  ].join('\n');
  try {
    writeFileSync(journal, Buffer.from(original, 'utf8'));
    const before = readFileSync(journal);
    execFileSync('node', [target, 'seed', '-Force', '-JournalDir', jdir, '-StateDir', sdir], { stdio: 'pipe' });
    execFileSync('node', [target, 'mark', '-Id', id, '-Status', 'done', '-JournalDir', jdir, '-StateDir', sdir], { stdio: 'pipe' });
    const after = readFileSync(journal);
    const prefix = Buffer.from(original.trimEnd(), 'utf8');
    if (!after.subarray(0, prefix.length).equals(prefix)) return { ok: false, detail: 'prefix bytes changed' };
    const scan = JSON.parse(execFileSync('node', [target, 'scan', '-JournalDir', jdir, '-StateDir', sdir], { encoding: 'utf8' }));
    const row = (Array.isArray(scan) ? scan : [scan]).find((r) => String(r.id) === id);
    if (row?.reopened === true) return { ok: false, detail: 'self-reopened after mark' };
    if (!after.includes(Buffer.from('🌙', 'utf8')) || after.includes(Buffer.from([0xc3, 0xb0, 0xc5, 0xb8]))) {
      return { ok: false, detail: 'encoding marker missing or fingerprint present' };
    }
    return { ok: true, detail: 'prefix preserved; no self-reopen' };
  } catch (e) {
    return { ok: false, detail: e.message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function nodeMutant(name, find, replace, root) {
  const bundle = join(root, `mutant-${name}`);
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, basename(LIVE)), readFileSync(LIVE));
  cpSync(join(dirname(LIVE), 'oa-state-lib'), join(bundle, 'oa-state-lib'), { recursive: true });
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith('.mjs')) files.push(p);
    }
  };
  walk(bundle);
  const hits = files.filter((p) => readFileSync(p, 'utf8').includes(find));
  if (hits.length !== 1) throw new Error(`node mutant ${name}: expected one anchor, found ${hits.length}`);
  writeFileSync(hits[0], readFileSync(hits[0], 'utf8').replace(find, replace), 'utf8');
  return join(bundle, basename(LIVE));
}

if (isNodeTarget) {
  const tmp = mkdtempSync(join(tmpdir(), 'oa-mut-node-'));
  let survived = 0;
  try {
    const rows = [];
    const base = runNodeInvariant(LIVE);
    rows.push({ verdict: base.ok ? 'PASS' : 'FAIL', name: 'baseline (unmutated)', detail: base.detail });
    if (!base.ok) survived++;

    rows.push({ verdict: 'NO-TWIN', name: 'M1/M3: PowerShell host asymmetry (Get-Content/Set-Content)', detail: 'Node has one UTF-8 file path, so the PS host-pair mutant has no meaningful JS twin; M2 covers the shared decode invariant.' });

    const m2 = nodeMutant(
      'M2',
      "return new TextDecoder('utf-8').decode(buf);",
      "return Buffer.from(buf).toString('latin1');",
      tmp,
    );
    const r2 = runNodeInvariant(m2);
    const killed = !r2.ok;
    rows.push({ verdict: killed ? 'KILLED' : 'SURVIVED', name: 'M2: readAllText decodes as latin1 instead of UTF-8', detail: r2.detail });
    if (!killed) survived++;

    for (const r of rows) {
      console.log(`${r.verdict.padEnd(9)} ${r.name}`);
      if (r.detail) console.log(`          ${r.detail}`);
    }
    console.log('\nmutants killed: 1/1 node-applicable (2 PowerShell-only twins reported)');
    if (survived) process.exit(1);
    process.exit(0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const MUTANTS = [
  {
    name: 'baseline (unmutated)',
    expect: 'pass',
    apply: (s) => s,
  },
  {
    name: 'M1: Add-TurnTerminator reads with Get-Content -Raw (the 593-line regression)',
    expect: 'fail',
    apply: (s) => s.replace('$content = Read-JournalText $path', '$content = Get-Content -Raw -Path $path'),
  },
  {
    name: 'M2: Read-JournalText decodes as ANSI instead of UTF-8',
    expect: 'fail',
    // MUTATE THE DECODER, NOT THE FIRST LOOK-ALIKE (GH #602).
    //
    // `[IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false)))` appears THREE
    // times in oa-state.ps1, and `String.prototype.replace` with a non-global regex rewrites
    // only the FIRST. That one is at line 1209; `Read-JournalText` is at 2130. So this arm
    // has always mutated a different function than the one it names, leaving the decoder
    // untouched -- and no guard, however good, could have killed it.
    //
    // It therefore reported SURVIVED on main and was read as "the sweep is blind", when the
    // real fault was that the mutant never applied where it claimed. A mutation arm that
    // does not mutate its subject cannot prove anything about a guard, which is this suite's
    // own defect class arriving inside the suite.
    //
    // Anchored on the function so it cannot drift onto a sibling call site again.
    apply: (s) => {
      const at = s.search(/function\s+Read-JournalText/);
      if (at === -1) throw new Error('M2: Read-JournalText not found');
      const head = s.slice(0, at);
      const tail = s.slice(at);
      const mutatedTail = tail.replace(
        /\[IO\.File\]::ReadAllText\(\$path,\s*\(New-Object\s+Text\.UTF8Encoding\(\$false\)\)\)/,
        '[IO.File]::ReadAllText($path, [Text.Encoding]::Default)'
      );
      if (mutatedTail === tail) throw new Error('M2: decoder call site not found inside Read-JournalText');
      return head + mutatedTail;
    },
  },
  {
    name: 'M3: turn-end write re-encodes via Set-Content (ANSI read path restored)',
    expect: 'fail',
    apply: (s) =>
      s
        .replace('$content = Read-JournalText $path', '$content = Get-Content -Raw -Path $path')
        .replace(
          '[IO.File]::WriteAllText($path, $out, (New-Object Text.UTF8Encoding($false)))',
          'Set-Content -Path $path -Value $out -Encoding UTF8'
        ),
  },
];

function runSweep(scriptPath) {
  try {
    const out = execFileSync('node', [SWEEP], {
      encoding: 'utf8',
      env: { ...process.env, OA_STATE_PS1: scriptPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'oa-mut-'));
let survived = 0;
const rows = [];

try {
  for (const m of MUTANTS) {
    const mutated = m.apply(src);
    if (m.expect === 'fail' && mutated === src) {
      rows.push({ name: m.name, verdict: 'INERT', detail: 'mutation did not change the source' });
      survived++;
      continue;
    }
    const dir = join(tmp, `m${rows.length}`);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'oa-state.ps1');
    writeFileSync(p, mutated, 'utf8');

    const r = runSweep(p);
    const wentRed = r.code === 1;
    const ok = m.expect === 'fail' ? wentRed : !wentRed;
    if (!ok) survived++;

    const first = (r.out.split('\n').find((l) => l.trim().startsWith('- ')) || '').trim();
    rows.push({
      name: m.name,
      verdict: ok ? (m.expect === 'fail' ? 'KILLED' : 'PASS') : 'SURVIVED',
      detail: m.expect === 'fail' ? first || `exit ${r.code}` : `exit ${r.code}`,
    });
  }

  for (const r of rows) {
    console.log(`${r.verdict.padEnd(9)} ${r.name}`);
    if (r.detail) console.log(`          ${r.detail}`);
  }

  const killed = rows.filter((r) => r.verdict === 'KILLED').length;
  const total = MUTANTS.filter((m) => m.expect === 'fail').length;
  console.log(`\nmutants killed: ${killed}/${total}`);

  if (survived) {
    console.log('FINDINGS: the sweep is blind to at least one defect it claims to guard.');
    process.exit(1);
  }
  console.log('all guards are load-bearing.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
