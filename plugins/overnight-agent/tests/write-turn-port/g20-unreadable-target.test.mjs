// node --test plugins/overnight-agent/tests/write-turn-port/g20-unreadable-target.test.mjs
//
// G20's refusal must not depend on the file it protects being readable. CI saw
// sw/g20/path-in-id-refused exit 1 instead of 2 once (main 2a05ba3, passed on rerun): the -Id
// `x/../../agent-gate` resolves to the planner's agent-gate.md, and the destination guards (doc
// meta, G17, G12, G22) opened it BEFORE G20 refused. A transient lock on that file (AV, sync,
// indexer) threw -- ErrorAction Stop in PowerShell, EBUSY in Node -- and the tool exited 1 with
// nothing on stdout. Reproduced by holding a share-deny lock on it; both engines exited 1.
//
// A lock is timing-dependent, so this pins the same route deterministically: agent-gate.md is a
// DIRECTORY, which every read fails on. Both engines must still refuse with G20 and exit 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'overnight-agent');
const PWSH = process.env.CHAR_PWSH || 'pwsh';

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'oa-g20-unreadable-'));
  mkdirSync(path.join(root, 'data', 'journal'), { recursive: true });
  mkdirSync(path.join(root, 'data', 'agent-gate.md'));
  writeFileSync(path.join(root, 'body.md'), '## \u{1F319} Overnight Agent \u2014 2020-03-09\n\n<!-- from: overnight-agent -->\n\n**Status:** In progress\n\nDid the thing.\n\n**Needs from you:** nothing.\n');
  return root;
}

const engines = {
  node: (args, env) => spawnSync(process.execPath, [path.join(SKILL, 'write-turn.mjs'), ...args], { encoding: 'utf8', env }),
  ps: (args, env) => spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'write-turn.ps1'), ...args], { encoding: 'utf8', env }),
};

for (const [name, run] of Object.entries(engines)) {
  for (const id of ['x/../../agent-gate', 'x\\..\\..\\agent-gate']) {
    test(`${name}: G20 refuses -Id ${id} with exit 2 although the target cannot be read`, () => {
      const root = sandbox();
      try {
        const env = { ...process.env, WRITE_TURN_OA_HOME: path.join(root, 'oa-home'), WRITE_TURN_HOST: 't' };
        delete env.OVERNIGHT_AGENT_PLANNER_DIR;
        delete env.OA_SANDBOX_ROOT;
        const r = run(['-JournalDir', path.join(root, 'data', 'journal'), '-Id', id, '-Ask', 'none', '-BodyFile', path.join(root, 'body.md')], env);
        assert.equal(r.status, 2, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert.match(r.stdout, /G20 line 1: -Id must be a task id, not a path\./);
        assert.doesNotMatch(r.stdout, /\bG(12|17|22) line/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
