#!/usr/bin/env node
/**
 * Mutation check for the PHASE 1 direct-dispatch concurrency rule (#728).
 *
 * The dispatcher is an instruction protocol rather than executable coordinator code. Pin the
 * accepted-send counter and failure behavior in the actual skill text, then mutate each rule back
 * to the former attempt-count behavior and require the corresponding assertion to fail.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(resolve(here, '..'), 'skills', 'overnight-agent', 'SKILL.md');
const source = readFileSync(skillPath, 'utf8');
const start = source.indexOf("### PHASE 1 — Dispatch approved plans to each task's own session");
const end = source.indexOf('\n### PHASE 2', start);

function failures(text) {
  if (start < 0 || end < 0) return ['phase1-section: direct-dispatch section not found'];
  const phase = text.slice(start, end);
  const out = [];
  if (!phase.includes('Count only sends accepted by `send_session_message` toward the limit; a failed delivery does')) {
    out.push('A_accepted-send-count: only accepted sends consume concurrency')
  }
  if (!phase.includes('A failed send does not count toward the limit.')) {
    out.push('B_failed-send-does-not-count: failed delivery leaves budget available')
  }
  if (!phase.includes('Stop after the accepted-send count reaches the limit')) {
    out.push('C_stop-on-accepted-count: stop condition uses accepted sends')
  }
  return out;
}

const baseline = failures(source);
if (baseline.length) {
  console.error(`FAIL baseline -- ${baseline.join('; ')}`);
  process.exit(1);
}
console.log('mutcheck-direct-dispatch-budget -- GH #728 accepted sends alone consume concurrency');
console.log('  [baseline] OK -- failed delivery leaves the dispatch slot available');

const mutants = [
  {
    name: 'M1_count-send-attempts',
    expect: 'A_accepted-send-count',
    find: 'Count only sends accepted by `send_session_message` toward the limit; a failed delivery does',
    replace: 'Count each send attempt toward the limit.',
  },
  {
    name: 'M2_failed-send-consumes-slot',
    expect: 'B_failed-send-does-not-count',
    find: 'A failed send does not count toward the limit.',
    replace: 'A failed send consumes one attempt.',
  },
  {
    name: 'M3_stop-on-attempt-count',
    expect: 'C_stop-on-accepted-count',
    find: 'Stop after the accepted-send count reaches the limit',
    replace: 'Stop after the send-attempt count reaches the limit',
  },
];

let failed = false;
for (const mutant of mutants) {
  if (!source.includes(mutant.find)) {
    console.error(`  [ERROR] ${mutant.name} target not found`);
    failed = true;
    continue;
  }
  const changed = source.replace(mutant.find, mutant.replace);
  const detected = failures(changed).some((failure) => failure.startsWith(mutant.expect));
  if (detected) console.log(`  [KILLED] ${mutant.name} by ${mutant.expect}`);
  else {
    console.error(`  [SURVIVED] ${mutant.name} expected ${mutant.expect}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('  All declared mutations killed.');
