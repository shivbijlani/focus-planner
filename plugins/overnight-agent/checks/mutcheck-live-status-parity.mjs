// mutcheck-live-status-parity.mjs — pin the TWO live-status implementations together.
//
// WHY THIS EXISTS (#202)
// ----------------------
// `liveStatus()` now exists twice, on purpose:
//
//   plugins/overnight-agent/checks/lib-live-status.mjs   (the sweeps)
//   packages/telegram-bridge/src/liveStatus.js            (the digest)
//
// Neither can import the other. The checks are deployed as FLAT files into
// `%LOCALAPPDATA%\overnight-agent\`, while the bridge runs from its repo checkout,
// so a relative import across the two resolves in the repo and breaks in the
// deployed copy — the "merged but not running" failure class that #196 exists for.
// That is why every sweep that needs bridge source reaches for it through the
// `BRIDGE_SRC` env var instead of importing it directly.
//
// A duplicate that nothing compares is a duplicate that drifts. This check is the
// thing that compares them: it loads BOTH and fails if they disagree on any
// fixture, or on any journal in the live corpus.
//
// It is a parity check, not a mutation check, and the distinction matters: the
// mutation checks for this logic already exist next door (`mutcheck-live-status`,
// `mutcheck-status-arbitration`) and prove the RULES are load-bearing. This proves
// the second copy still obeys them. Both are needed — the rules could be right in
// one file and absent from the other, and every existing check would still pass.
//
// Read-only. Usage:
//   BRIDGE_SRC=file:///V:/repos/focus-planner/packages/telegram-bridge/src \
//   [PLANNER_PATH=...] node mutcheck-live-status-parity.mjs
//
// Exits 1 on any disagreement.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { liveStatus as localLiveStatus, normaliseStatus as localNormalise, statusStampDate as localStamp } from './lib-live-status.mjs';

const SRC = process.env.BRIDGE_SRC;
if (!SRC) {
  console.error('set BRIDGE_SRC (file:/// url to packages/telegram-bridge/src)');
  process.exit(1);
}

const bridgeMod = await import(`${SRC}/liveStatus.js`);
const { liveStatus: bridgeLiveStatus, normaliseStatus: bridgeNormalise, statusStampDate: bridgeStamp } = bridgeMod;

if (typeof bridgeLiveStatus !== 'function') {
  console.error('BRIDGE_SRC/liveStatus.js does not export liveStatus()');
  process.exit(1);
}

const SENTINEL = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->';
const AGENT = '<!-- from: overnight-agent -->';
const USER = '<!-- from: me -->';

// Fixtures deliberately cover every arbitration branch, so parity is asserted on the
// interesting paths rather than only on the boring single-Status majority.
const FIXTURES = [
  ['empty', ''],
  ['no block at all', '# Task 9: nothing here\n\n- TODO:\n'],
  [
    'block only',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** proposed \u00b7 plan v1 \u00b7 2026-08-01\n`,
  ],
  [
    'turn newer than block',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** blocked \u00b7 2026-06-19\n\n## 2026-08-27\n\n${AGENT}\n\n**Status:** Done \u00b7 2026-08-27\n\ndone.\n`,
  ],
  [
    'block newer than turn',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** Done \u00b7 2026-08-30\n\n## 2026-08-01\n\n${AGENT}\n\n**Status:** in-progress \u00b7 2026-08-01\n\nworking.\n`,
  ],
  [
    'same date keeps the turn',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** blocked \u00b7 2026-08-27\n\n## 2026-08-27\n\n${AGENT}\n\n**Status:** Done \u00b7 2026-08-27\n\ndone.\n`,
  ],
  [
    'undated turn dated by its chat header',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** blocked \u00b7 2026-06-19\n\n## 2026-08-27\n\n${AGENT}\n\n**Status:** Done\n\ndone.\n`,
  ],
  [
    'human dialect with a space',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** In progress \u00b7 2026-08-27\n`,
  ],
  [
    'prose note that opens with the word Status',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** Done \u00b7 2026-08-25\n\n*Status line corrected 2026-08-25: an earlier turn said blocked.*\n`,
  ],
  [
    'historical sub-block below a rewritten block',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** Done \u00b7 2026-08-21\n\n### \u{1F319} Overnight Agent \u2014 2026-07-17\n\n**Status:** blocked \u00b7 2026-07-17\n`,
  ],
  [
    'user reply ends the agent turn',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** blocked \u00b7 2026-06-19\n\n## 2026-08-27\n\n${AGENT}\n\n**Status:** Done \u00b7 2026-08-27\n\ndone.\n\n## 2026-08-28\n\n${USER}\n\nthanks\n`,
  ],
  [
    'stamp date after a prose date',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** Done \u2014 shipped 2026-07-18 \u00b7 2026-08-22\n`,
  ],
  [
    'prose date after the stamp date',
    `# T\n\n---\n${SENTINEL}\n\n**Status:** Done \u00b7 2026-08-23 \u2014 trip completed 2026-08-01\n`,
  ],
  [
    'no status stated anywhere',
    `# T\n\n---\n${SENTINEL}\n\n## \u{1F319} Overnight Agent\n\nno status line here.\n`,
  ],
];

// The fields that carry meaning to a caller. `source`/`turnIndex` are included
// because a divergence there means the two picked DIFFERENT lines and happened to
// agree on the answer — which is drift that has not surfaced yet.
const FIELDS = ['status', 'raw', 'line', 'date', 'source', 'canonical', 'turnIndex', 'turnCount', 'effDate', 'arbitration'];

function diff(a, b) {
  const out = [];
  for (const f of FIELDS) {
    const av = a ? a[f] : undefined;
    const bv = b ? b[f] : undefined;
    if (av !== bv) out.push(`${f}: local=${JSON.stringify(av)} bridge=${JSON.stringify(bv)}`);
  }
  return out;
}

let checked = 0;
let failed = 0;

function compare(label, text) {
  checked += 1;
  const d = diff(localLiveStatus(text), bridgeLiveStatus(text));
  if (d.length) {
    failed += 1;
    console.log(`[DRIFT] ${label}`);
    for (const line of d) console.log(`         ${line}`);
  }
}

// --- 1. fixtures -----------------------------------------------------------
for (const [label, text] of FIXTURES) compare(`fixture: ${label}`, text);

// --- 2. the helper exports, which callers use directly ---------------------
const PHRASES = [
  'In progress', 'In-progress', 'in-progress', 'Done', 'Complete', 'Completed',
  'Skipped', 'skip', 'Proposed', 'Approved', 'Revise', 'blocked',
  'Done \u2014 shipped and merged', 'line corrected 2026-08-25', '', null,
];
for (const p of PHRASES) {
  checked += 1;
  const a = localNormalise(p);
  const b = bridgeNormalise(p);
  if (a !== b) {
    failed += 1;
    console.log(`[DRIFT] normaliseStatus(${JSON.stringify(p)}): local=${JSON.stringify(a)} bridge=${JSON.stringify(b)}`);
  }
}

const LINES = [
  '**Status:** Done \u2014 shipped 2026-07-18 \u00b7 2026-08-22',
  '**Status:** Done \u00b7 2026-08-23 \u2014 trip completed 2026-08-01',
  '**Status:** Proposed 2026-08-23',
  '**Status:** Proposed',
  '', null,
];
for (const l of LINES) {
  checked += 1;
  const a = localStamp(l);
  const b = bridgeStamp(l);
  if (a !== b) {
    failed += 1;
    console.log(`[DRIFT] statusStampDate(${JSON.stringify(l)}): local=${JSON.stringify(a)} bridge=${JSON.stringify(b)}`);
  }
}

// --- 3. the live corpus, when one is available -----------------------------
// Fixtures encode what we thought of; the corpus is what actually exists. Every
// rule in lib-live-status was falsified by this folder rather than by argument, so
// the corpus is the stronger half of this check whenever it can be reached.
const PLANNER = process.env.PLANNER_PATH;
let corpus = 0;
if (PLANNER) {
  const dir = path.join(PLANNER, 'journal');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!/^task-\d+\.md$/.test(f)) continue;
      let text;
      try { text = readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      corpus += 1;
      compare(`journal: ${f}`, text);
    }
  }
}

const where = PLANNER ? `${corpus} live journals` : 'no corpus (PLANNER_PATH unset)';
console.log(`\nmutcheck-live-status-parity: ${checked} comparisons (${FIXTURES.length} fixtures, ${where}), ${failed} disagreement(s).`);

if (failed) {
  console.log('\nThe two liveStatus implementations have drifted. They are deliberate twins:');
  console.log('  plugins/overnight-agent/checks/lib-live-status.mjs   (sweeps)');
  console.log('  packages/telegram-bridge/src/liveStatus.js            (digest)');
  console.log('Neither can import the other (flat-deployed checks vs repo-resident package),');
  console.log('so a change to one must be mirrored into the other.');
  process.exit(1);
}
