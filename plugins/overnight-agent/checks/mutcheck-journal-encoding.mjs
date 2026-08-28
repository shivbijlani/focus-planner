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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SWEEP = join(HERE, 'journal-encoding-invariant.mjs');
const LIVE =
  'C:\\Users\\shiv\\.copilot\\installed-plugins\\focus-planner\\overnight-agent\\skills\\overnight-agent\\oa-state.ps1';

const src = readFileSync(LIVE, 'utf8');

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
    apply: (s) =>
      s.replace(
        /\[IO\.File\]::ReadAllText\(\$path,\s*\(New-Object\s+Text\.UTF8Encoding\(\$false\)\)\)/,
        '[IO.File]::ReadAllText($path, [Text.Encoding]::Default)'
      ),
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
