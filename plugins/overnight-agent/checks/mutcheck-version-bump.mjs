// mutcheck-version-bump.mjs
//
// Proves every guard in version-bump-sweep.mjs is load-bearing.
//
// Two things are established, and the second is the one that matters:
//
//   1. POSITIVE/NEGATIVE -- each guard produces the right verdict on its own fixture and
//      stays quiet on the legitimate case that most resembles it.
//   2. LOAD-BEARING -- disabling one guard must break EXACTLY its own fixture and nothing
//      else. A guard that can be deleted with every test still green is decoration, and
//      the sweep it belongs to is a check that cannot fail.
//
// The sweep is run as a CHILD PROCESS against real throwaway git repos with real commit
// history, so what is measured is the actual script against real `git log` output -- not a
// function lifted out of it. That matters more than usual here, because every guard in this
// sweep is a statement about git history semantics.
//
// Usage: node mutcheck-version-bump.mjs
// Exit:  0 all assertions hold - 1 a guard is not doing what it claims.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SWEEP = path.join(HERE, 'version-bump-sweep.mjs');

const failures = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vbs-mut-'));

const PLUGIN_JSON = 'plugins/overnight-agent/plugin.json';
const SKILL = 'plugins/overnight-agent/skills/overnight-agent/oa-state.ps1';

function git(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function pluginJson(version, description = 'the plugin') {
  return `${JSON.stringify({ name: 'overnight-agent', description, version }, null, 2)}\n`;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

/**
 * Build a throwaway repo and replay `commits` in order. Each commit is
 * { files: {rel: content}, msg }. Nothing is committed unless it is listed, so a
 * fixture can deliberately leave plugin.json untracked.
 */
function makeRepo(name, commits) {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'mut@example.invalid']);
  git(root, ['config', 'user.name', 'mutcheck']);
  git(root, ['config', 'core.autocrlf', 'false']);
  for (const c of commits) {
    for (const [rel, content] of Object.entries(c.files)) write(root, rel, content);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', c.msg]);
  }
  return root;
}

function runSweep(sweepPath, repo) {
  try {
    const out = execFileSync(process.execPath, [sweepPath], {
      encoding: 'utf8',
      env: { ...process.env, OA_PLUGIN_REPO: repo },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// --- fixtures -------------------------------------------------------------------------

const fixtures = [
  {
    // The core negative. Bumping in the SAME commit as the change is the correct
    // workflow, and it must read clean or the sweep is unusable.
    name: 'g1-bump-with-the-change-is-clean',
    guards: ['g1'],
    commits: [
      { msg: 'init', files: { [PLUGIN_JSON]: pluginJson('1.0.0'), [SKILL]: 'a\n' } },
      { msg: 'fix + bump', files: { [PLUGIN_JSON]: pluginJson('1.0.1'), [SKILL]: 'b\n' } },
    ],
    expect: (r) => r.code === 0 && /OK - nothing under the plugin has changed/.test(r.out),
    why: 'the normal, correct release shape must not be reported',
  },
  {
    // The live #283 shape: a plugin change merged after the bump, with no bump.
    name: 'g1-change-after-bump-is-flagged',
    guards: ['g1'],
    commits: [
      { msg: 'init', files: { [PLUGIN_JSON]: pluginJson('1.0.0'), [SKILL]: 'a\n' } },
      { msg: 'bump', files: { [PLUGIN_JSON]: pluginJson('1.0.1') } },
      { msg: 'fix without bump', files: { [SKILL]: 'b\n' } },
    ],
    expect: (r) => r.code === 1
      && /FLAGGED - plugin content changed WITHOUT a version bump: 1 file/.test(r.out)
      && /oa-state\.ps1/.test(r.out),
    why: 'this is the defect the sweep exists for',
  },
  {
    // Isolates g1 precisely. A commit that TOUCHES plugin.json without changing the
    // version is not a release. "last commit that touched plugin.json" would pick this
    // commit as the bump and report clean, hiding a real content change.
    name: 'g1-touching-plugin-json-without-changing-version-is-not-a-bump',
    guards: ['g1'],
    commits: [
      { msg: 'init', files: { [PLUGIN_JSON]: pluginJson('1.0.0'), [SKILL]: 'a\n' } },
      { msg: 'bump', files: { [PLUGIN_JSON]: pluginJson('1.0.1') } },
      { msg: 'reword description only', files: { [PLUGIN_JSON]: pluginJson('1.0.1', 'reworded') } },
    ],
    expect: (r) => r.code === 1 && /FLAGGED - plugin content changed WITHOUT a version bump/.test(r.out),
    why: 'a description edit is deployed content; only a version VALUE change is a release',
  },
  {
    // The false-positive that would get this sweep switched off in a week.
    name: 'g4-changes-outside-the-plugin-are-ignored',
    guards: ['g4'],
    commits: [
      { msg: 'init', files: { [PLUGIN_JSON]: pluginJson('1.0.0'), [SKILL]: 'a\n' } },
      { msg: 'bump', files: { [PLUGIN_JSON]: pluginJson('1.0.1') } },
      { msg: 'unrelated web app work', files: { 'src/App.jsx': 'export default 1;\n' } },
    ],
    expect: (r) => r.code === 0 && /OK - nothing under the plugin has changed/.test(r.out),
    why: 'the version gates the PLUGIN; the rest of the repo ships on its own cadence',
  },
  {
    // Isolates the pathspec on the `log` call specifically. Without it the VERDICT is
    // still right (the diff is scoped), but the reported commit list names unrelated
    // work -- which sends whoever reads it to the wrong PR. A misleading report is a
    // defect, so it gets its own fixture rather than being left to the other pathspec.
    name: 'g4b-reported-commits-exclude-unrelated-work',
    // Declares TWO owners on purpose. Its assertion checks the file COUNT as well as the
    // commit list, so it genuinely depends on the diff pathspec (g4) too. Weakening the
    // assertion to "isolate g4b" would delete the check that the verdict is still right.
    // Same call mutcheck-basename-collision.mjs makes for its BOM/CRLF fixtures: a fixture
    // that hides a real dependency reports a cleaner matrix and a less honest one.
    guards: ['g4', 'g4b'],
    commits: [
      { msg: 'init', files: { [PLUGIN_JSON]: pluginJson('1.0.0'), [SKILL]: 'a\n' } },
      { msg: 'bump', files: { [PLUGIN_JSON]: pluginJson('1.0.1') } },
      { msg: 'unrelated web app work', files: { 'src/App.jsx': 'export default 1;\n' } },
      { msg: 'plugin fix without bump', files: { [SKILL]: 'b\n' } },
    ],
    expect: (r) => r.code === 1
      && /FLAGGED - plugin content changed WITHOUT a version bump: 1 file/.test(r.out)
      && !/unrelated web app work/.test(r.out),
    why: 'the commit list must name only commits that actually touched the plugin',
  },
  {
    // Blindness must not read as health -- the BRIDGE_SRC lesson.
    name: 'g2-unlocatable-repo-is-a-finding-not-a-pass',
    guards: ['g2'],
    commits: null, // built as a bare directory below
    expect: (r) => r.code === 1 && /CANNOT MEASURE/.test(r.out),
    why: 'six sweeps once silently measured nothing and reported clean',
  },
  {
    // The other blindness: a repo whose plugin.json has no committed history at all.
    name: 'g3-no-version-history-is-a-finding-not-a-pass',
    guards: ['g3'],
    commits: [{ msg: 'init without plugin.json', files: { 'README.md': 'hi\n' } }],
    extra: (root) => write(root, PLUGIN_JSON, pluginJson('1.0.0')), // present but untracked
    expect: (r) => r.code === 1 && /no version-change commit/.test(r.out),
    why: 'nothing to compare against is not the same as nothing wrong',
  },
];

// --- baseline -------------------------------------------------------------------------
console.log('--- baseline (real sweep on each fixture) ---');
const repos = {};
for (const f of fixtures) {
  if (f.commits === null) {
    const root = path.join(tmpRoot, f.name);
    fs.mkdirSync(root, { recursive: true });
    repos[f.name] = root;
  } else {
    repos[f.name] = makeRepo(f.name, f.commits);
    if (f.extra) f.extra(repos[f.name]);
  }
  const r = runSweep(SWEEP, repos[f.name]);
  const ok = f.expect(r);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${f.name}`);
  if (!ok) failures.push(`baseline ${f.name}: exit=${r.code}\n${r.out}`);
}

// --- mutations ------------------------------------------------------------------------

// The sweep source is read with line endings NORMALISED to LF. The repo has
// core.autocrlf=true and no .gitattributes, so these files are CRLF on disk here and
// LF on a Linux runner. A multi-line anchor written with \n therefore matches on one
// host and silently no-ops on the other -- and a no-op mutation reports "guard is not
// load-bearing", i.e. it fails in the alarming direction rather than the silent one.
// Normalising makes the mutation set host-independent. (Found the hard way: the first
// run of this file reported g2 and g3 as anchor-drifted purely because of CRLF.)
const src = fs.readFileSync(SWEEP, 'utf8').replace(/\r\n/g, '\n');

const mutations = [
  {
    guard: 'g1',
    label: 'treat the last commit that TOUCHED plugin.json as the bump',
    apply: (s) => s.replace(
      'if (cur !== prev) return { commit: c, from: prev, to: cur };',
      'return { commit: c, from: prev, to: cur };',
    ),
  },
  {
    guard: 'g2',
    label: 'pass when the repo cannot be located',
    apply: (s) => s.replace(
      "console.log('  see must not report clean.');\n  process.exit(1);",
      "console.log('  see must not report clean.');\n  process.exit(0);",
    ),
  },
  {
    guard: 'g3',
    label: 'pass when no version-change commit exists',
    apply: (s) => s.replace(
      "console.log('compared against. Treated as a finding, not a pass.');\n  process.exit(1);",
      "console.log('compared against. Treated as a finding, not a pass.');\n  process.exit(0);",
    ),
  },
  {
    guard: 'g4b',
    label: 'drop the plugin-dir pathspec when listing commits since the bump',
    apply: (s) => s.replace(
      "['log', '--first-parent', '--format=%H', `${bump.commit}..${head}`, '--', PLUGIN_DIR]",
      "['log', '--first-parent', '--format=%H', `${bump.commit}..${head}`]",
    ),
  },
  {
    guard: 'g4',
    label: 'drop the plugin-dir pathspec when listing changed files',
    apply: (s) => s.replace(
      "['diff', '--name-only', `${bump.commit}..${head}`, '--', PLUGIN_DIR]",
      "['diff', '--name-only', `${bump.commit}..${head}`]",
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
