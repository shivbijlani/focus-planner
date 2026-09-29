#!/usr/bin/env node
/**
 * The coordinator is an instruction protocol, so pin the run boundary in SKILL.md:
 * non-dispatch work precedes the terminal drain, the hard end is absolute, and
 * task-specific skills belong to task sessions.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(resolve(here, '..'), 'skills', 'overnight-agent', 'SKILL.md');
const source = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');

const rules = [
  [
    'non-dispatch-before-drain',
    'Complete PHASE 0, PHASE 0.7, PHASE 2,\n> PHASE 2.5 and PHASE 3 before entering PHASE 1.',
  ],
  [
    'drain-is-terminal',
    "PHASE 1 is the final phase: once its\n> drain loop starts, do no inbox follow-up",
  ],
  [
    'cutoff-ends-run',
    'At the dispatch cutoff, write the wrap-up and end the run.',
  ],
  [
    'hard-end-derived',
    '`hard_end = next_run - 1 minute`',
  ],
  [
    'hard-end-stops-current-step',
    'the one-line\n> wrap-up `cut short at <step>`, then exit.',
  ],
  [
    'hard-end-outranks-cleanup',
    'This deadline outranks every phase,\n> retry, cleanup, email mark-read, mirror and ordinary wrap-up requirement.',
  ],
  [
    'coordinator-does-not-load-task-skill',
    "The coordinator never loads, invokes or inspects a task's skill.",
  ],
  [
    'telegram-before-drain',
    'mirror journals\nafter PHASE 2 preparation and before entering PHASE 1',
  ],
  [
    'telegram-turn-hash-dedupe',
    'the bridge deduplicates by turn hash',
  ],
];

function failures(text) {
  return rules.filter(([, rule]) => !text.includes(rule)).map(([name]) => name);
}

const baseline = failures(source);
if (baseline.length) throw new Error(`baseline failed: ${baseline.join(', ')}`);

for (const [name, rule] of rules) {
  if (source.split(rule).length !== 2) {
    throw new Error(`${name}: expected exactly one mutation target`);
  }
  const caught = failures(source.replace(rule, `removed-${name}`));
  if (caught.length !== 1 || caught[0] !== name) {
    throw new Error(`${name}: mutation was not caught by its own rule (${caught.join(', ')})`);
  }
  console.log(`  [KILLED] ${name}`);
}

console.log(`mutcheck-coordinator-run-boundary -- ${rules.length} mutations killed`);
