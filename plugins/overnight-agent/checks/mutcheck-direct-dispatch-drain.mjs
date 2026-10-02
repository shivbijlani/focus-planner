#!/usr/bin/env node
/**
 * The coordinator is a skill protocol, not executable code. Mutate the PHASE 1 instructions
 * to ensure the refill, cheap idle poll, per-task deduplication and cutoff rules are load-bearing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(resolve(here, '..'), 'skills', 'overnight-agent', 'SKILL.md'), 'utf8')
  .replace(/\r\n/g, '\n');
const start = source.indexOf("### PHASE 1 — Dispatch approved plans to each task's own session");
const end = source.indexOf('\n### PHASE 2', start);
if (start < 0 || end < 0) throw new Error('PHASE 1 dispatch section not found');

const phase = source.slice(start, end);
const rules = [
  ['refill', 'When an opening frees, re-run\n   `oa-state.mjs scan -Compact`'],
  ['native-idle-poll', 'call the native app tool **`get_sessions_status`** about every 60 seconds, **once per\n   interval**'],
  ['idle-frees-opening', 'an\n   `idle` session has finished and frees one opening'],
  ['no-repeat', 'skip every task ID already attempted this run'],
  ['cutoff', '**start no send at or after the cutoff**'],
  ['do-not-wait', 'Do not wait for\n   running sessions at the end'],
  ['failed-send-frees', 'Only accepted sends\n      count toward the active-send limit.'],
  ['refusal-frees', 'A reported refusal or user pause also frees\n   its opening immediately'],
];

function failures(text) {
  const errors = rules.filter(([, rule]) => !text.includes(rule)).map(([name]) => name);
  if (text.includes('no completion-based refill')) errors.push('obsolete-no-refill');
  return errors;
}

const baseline = failures(phase);
if (baseline.length) throw new Error(`baseline failed: ${baseline.join(', ')}`);

for (const [name, rule] of rules) {
  if (phase.split(rule).length !== 2) throw new Error(`${name}: expected exactly one target`);
  const mutant = phase.replace(rule, `removed-${name}`);
  const caught = failures(mutant);
  if (caught.length !== 1 || caught[0] !== name) {
    throw new Error(`${name}: mutation was not caught by its own rule (${caught.join(', ')})`);
  }
  console.log(`  [KILLED] ${name}`);
}
const obsolete = failures(`${phase}\nno completion-based refill`);
if (obsolete.length !== 1 || obsolete[0] !== 'obsolete-no-refill') {
  throw new Error('obsolete-no-refill: regression not caught');
}
console.log('  [KILLED] obsolete-no-refill');
console.log('mutcheck-direct-dispatch-drain -- 9 mutations killed');
