#!/usr/bin/env node
/**
 * Mutation check for the PHASE 1 direct-dispatch concurrency and liveness rules (#728, #761).
 *
 * The dispatcher is an instruction protocol rather than executable coordinator code. Pin the
 * active accepted-send counter and failure behavior in the actual skill text, then mutate each
 * rule back to attempt-count behavior and require the corresponding assertion to fail.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(resolve(here, '..'), 'skills', 'overnight-agent', 'SKILL.md');
const source = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf("### PHASE 1 — Dispatch approved plans to each task's own session");
const end = source.indexOf('\n### PHASE 2', start);

function failures(text) {
  if (start < 0 || end < 0) return ['phase1-section: direct-dispatch section not found'];
  const phase = text.slice(start, end).replace(/\r\n/g, '\n');
  const out = [];
  if (!phase.includes("Count only this run's sends accepted by `send_session_message` toward the limit; a failed delivery does")) {
    out.push('A_accepted-send-count: only accepted sends consume concurrency')
  }
  if (!phase.includes('Only accepted sends\n      count toward the active-send limit.')) {
    out.push('B_failed-send-does-not-count: failed delivery leaves budget available')
  }
  if (!phase.includes('Fill openings from the current scan until the accepted-send count **from this run** reaches the limit of active')) {
    out.push('C_fill-on-accepted-count: capacity counts active accepted sends')
  }
  if (!phase.includes('Silence is not death (#761)') ||
      !phase.includes('A delivery that\n      **could not be confirmed** is not a rejection: report uncertainty, keep the binding') ||
      !phase.includes('Do not infer death from unchanged `updated_at`, journal mtime,')) {
    out.push('D_silence-not-death: silence and unconfirmed delivery preserve the binding')
  }
  if (!phase.includes('Sessions busy before this run are not in\n   the tracked active-send set and do not occupy its openings.')) {
    out.push('E_previous-run-not-capacity: previous sends do not occupy this run')
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
    find: "Count only this run's sends accepted by `send_session_message` toward the limit; a failed delivery does",
    replace: 'Count each send attempt toward the limit.',
  },
  {
    name: 'M2_failed-send-consumes-slot',
    expect: 'B_failed-send-does-not-count',
    find: 'Only accepted sends\n      count toward the active-send limit.',
    replace: 'A failed send consumes one attempt.',
  },
  {
    name: 'M3_fill-on-attempt-count',
    expect: 'C_fill-on-accepted-count',
    find: 'Fill openings from the current scan until the accepted-send count **from this run** reaches the limit of active',
    replace: 'Fill openings from the current scan until the send-attempt count reaches the limit of active',
  },
  {
    name: 'M4_unconfirmed-means-dead',
    expect: 'D_silence-not-death',
    find: 'A delivery that\n      **could not be confirmed** is not a rejection: report uncertainty, keep the binding',
    replace: 'A delivery that could not be confirmed marks the binding dead',
  },
  {
    name: 'M5_silence-means-dead',
    expect: 'D_silence-not-death',
    find: 'Do not infer death from unchanged `updated_at`, journal mtime,',
    replace: 'Infer death from unchanged `updated_at`, journal mtime,',
  },
  {
    name: 'M6_previous-run-holds-slot',
    expect: 'E_previous-run-not-capacity',
    find: 'Sessions busy before this run are not in\n   the tracked active-send set and do not occupy its openings.',
    replace: 'Sessions busy before this run occupy its openings.',
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
