// node --test plugins/overnight-agent/tests/e2e/lib/test-path-leak.test.mjs
//
// The sandbox must not TELL the subject where its tests are. Measured on
// 20261003-203652-candidate-828-rebased: the coordinator read the seeded user-settings.md
// ("Synthetic settings for an end-to-end sandbox run (plugins/overnight-agent/tests/e2e)") and globbed
// that folder as its 4th call. lib\sandbox.ps1 Find-TestPathLeaks scans every seeded, sandbox-visible
// text before a run; run-sandbox.ps1 calls Assert-NoTestPathLeak (CI's -SeedOnly run exercises it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pwsh = process.env.CHAR_PWSH || 'pwsh';

// Builds a minimal sandbox: the real settings template, a planner journal, the harness MCP server copy,
// and a product copy whose source comments cite `tests/e2e/run-sandbox.ps1` (legitimate). `edits`
// mutate it; returns the leak list Find-TestPathLeaks reports.
function leaks(edits = {}, { settingsLine = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'oa-leak-'));
  try {
    const root = path.join(dir, 'sandbox');
    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `. '${path.join(here, 'sandbox.ps1')}'`,
      `. '${path.join(here, 'planner.ps1')}'`,
      `$L = Get-SandboxLayout '${root}'`,
      `New-SandboxDirs $L`,
      `$s = New-SandboxSettingsText $L 'proj-1' 1`,
      settingsLine ? `$s = $s.Replace('Synthetic settings for an end-to-end sandbox run. Every path', '${settingsLine}')` : '',
      `Write-Utf8 (Join-Path $L.Planner 'user-settings.md') $s`,
      `Write-Utf8 (Join-Path $L.Planner 'journal\\task-1.md') "# Task 1: x\`n"`,
      `New-Item -ItemType Directory -Force -Path (Join-Path $L.Root 'harness') | Out-Null`,
      `Copy-Item '${path.join(here, 'sandbox-app-mcp.mjs')}' (Join-Path $L.Root 'harness')`,
      `Write-Utf8 (Join-Path $L.SkillDir 'SKILL.md') "# skill\`n"`,
      `Write-Utf8 (Join-Path $L.SkillDir 'write-turn.mjs') "// Sandbox mode (tests/e2e/run-sandbox.ps1): inert unless set\`n"`,
      ...Object.entries(edits).map(([rel, text]) => `Write-Utf8 (Join-Path $L.Root '${rel}') '${text.replace(/'/g, "''")}'`),
      `$h = Find-TestPathLeaks $L`,
      `ConvertTo-Json -InputObject @($h) -Compress`,
    ].filter(Boolean).join('\n');
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return JSON.parse(r.stdout.trim() || '[]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the shipped harness seeds nothing that names the tests (settings template, MCP server copy, product comments)', () => {
  assert.deepEqual(leaks(), []);
});

const mutations = {
  'MUTATION: the measured user-settings line is put back': [{}, { settingsLine: 'Synthetic settings for an end-to-end sandbox run (plugins/overnight-agent/tests/e2e). Every path' }],
  'a relative tests/e2e mention in harness-written settings': [{}, { settingsLine: 'Synthetic settings (see tests/e2e for scoring). Every path' }],
  'an MCP tool description naming tests\\e2e': [{ 'harness\\sandbox-app-mcp.mjs': "description: 'scored by tests\\e2e\\lib\\scenarios.ps1'" }, {}],
  'a planner AGENTS.md naming the plugin tests': [{ 'home\\OneDrive\\Apps\\Focus Planner\\AGENTS.md': 'see plugins/overnight-agent/tests' }, {}],
  'a SKILL.md copy naming the plugin tests': [{ 'repo\\plugins\\overnight-agent\\skills\\overnight-agent\\SKILL.md': 'goldens live in plugins\\overnight-agent\\tests\\characterization' }, {}],
  'the OA home naming the plugin tests': [{ 'home\\AppData\\Local\\overnight-agent\\notes.md': 'plugins/overnight-agent/tests/e2e/README.md' }, {}],
};
for (const [name, [edits, opts]] of Object.entries(mutations)) {
  test(`leak is caught: ${name}`, () => {
    const h = leaks(edits, opts);
    assert.ok(h.length >= 1, `expected a leak, got none`);
  });
}

test('a product source comment citing tests/e2e/run-sandbox.ps1 is not a leak', () => {
  assert.deepEqual(leaks({ 'repo\\plugins\\overnight-agent\\checks\\x.ps1': '# Sandbox mode (tests/e2e/run-sandbox.ps1): inert unless set' }), []);
});

test('run-sandbox.ps1 asserts it before any precheck or model call', () => {
  const src = readFileSync(path.join(here, '..', 'run-sandbox.ps1'), 'utf8');
  const a = src.indexOf('Assert-NoTestPathLeak $L');
  const p = src.indexOf('$prechecks = @(Invoke-Prechecks');
  assert.ok(a > 0 && p > a, 'Assert-NoTestPathLeak must run before the prechecks (and so before the copilot call)');
});
