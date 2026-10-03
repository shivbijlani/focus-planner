// node --test plugins/overnight-agent/tests/write-turn-port/g20-lanes.test.mjs
//
// G20 names agent-lanes.json as a protected target in both engines (docs/spec/Domain-lanes.md):
// the lane mapping is the user's, and an agent that could write it could give itself any task. A
// journal that is a link to the planner's agent-lanes.json is refused with exit 2, the finding
// names the file, and the file is byte-identical afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'overnight-agent');
const PWSH = process.env.CHAR_PWSH || 'pwsh';
const LANES = '{\n  "schema": "fp-agent-lanes@1"\n}\n';

const engines = {
  node: (args, env) => spawnSync(process.execPath, [path.join(SKILL, 'write-turn.mjs'), ...args], { encoding: 'utf8', env }),
  ps: (args, env) => spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'write-turn.ps1'), ...args], { encoding: 'utf8', env }),
};

for (const [name, run] of Object.entries(engines)) {
  test(`${name}: a journal linked to agent-lanes.json is refused by G20 and the file is untouched`, (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'oa-g20-lanes-'));
    try {
      const journal = path.join(root, 'data', 'journal');
      fs.mkdirSync(journal, { recursive: true });
      const lanes = path.join(root, 'data', 'agent-lanes.json');
      fs.writeFileSync(lanes, LANES);
      try { fs.symlinkSync(lanes, path.join(journal, 'task-5.md'), 'file'); } catch { t.skip('symlinks need privileges on this host'); return; }
      fs.writeFileSync(path.join(root, 'body.md'), '## \u{1F319} Overnight Agent \u2014 2020-03-09\n\n<!-- from: overnight-agent -->\n\n**Status:** In progress\n\nDid the thing.\n\n**Needs from you:** nothing.\n');
      const env = { ...process.env, WRITE_TURN_OA_HOME: path.join(root, 'oa-home'), WRITE_TURN_HOST: 't' };
      delete env.OVERNIGHT_AGENT_PLANNER_DIR;
      delete env.OA_SANDBOX_ROOT;
      const r = run(['-JournalDir', journal, '-Id', '5', '-Ask', 'none', '-BodyFile', path.join(root, 'body.md')], env);
      assert.equal(r.status, 2, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /G20 line 1: the target resolves to agent-lanes\.json\./);
      assert.equal(fs.readFileSync(lanes, 'utf8'), LANES);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
