import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'oa-dispatch.mjs'), 'utf8');
const suite = path.join(here, 'oa-dispatch.test.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-drain-mutants-'));
const mutations = [
  ['ignore width', 'if (!item.collect_wave && active.length >= limit) continue;', 'if (false) continue;', '^N=1'],
  ['never refill', "if (['completed', 'waiting_for_user'].includes(outcome)) item.state = outcome;", 'if (false) item.state = outcome;', '^N=1'],
  ['ignore cutoff', 'const expired = () => now() >= Date.parse(state.cutoff);', 'const expired = () => false;', '^at cutoff'],
  ['idle means complete', "if (evidence.turnEnded && data.activity?.status === 'idle'", "if (data.activity?.status === 'idle'", '^idle before accepted'],
  ['free after save failure', 'if (ACTIVE.has(item.state)) throw error;', 'if (false) throw error;', '^a post-send save'],
  ['disable native gate', 'if (!enrolled()) return;', 'if (true) return;', '^native hook denies'],
  ['ignore start buffer', '- startBufferMinutes * 60000', '- 0 * 60000', '^default buffer rejects'],
];
try {
  for (const [name, find, replace, test] of mutations) {
    if (source.split(find).length !== 2) throw new Error(`Mutation must match exactly once: ${name}`);
    const baseline = spawnSync(process.execPath, ['--test', `--test-name-pattern=${test}`, suite], { encoding: 'utf8', timeout: 30000 });
    if (baseline.status !== 0) throw new Error(`Baseline failed for ${name}\n${baseline.stdout}\n${baseline.stderr}`);
    const file = path.join(root, `${name.replaceAll(' ', '-')}.mjs`);
    fs.writeFileSync(file, source.replace(find, replace));
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${test}`, suite], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, OA_DRAIN_SUBJECT: file },
    });
    if (result.error || result.status !== 1 || !`${result.stdout}${result.stderr}`.includes('AssertionError')) {
      throw new Error(`Mutant did not fail the named assertion: ${name}\n${result.stdout}\n${result.stderr}`);
    }
    console.log(`KILLED ${name}`);
  }
  console.log(`${mutations.length}/${mutations.length} drain mutants killed by behavioral assertions.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
