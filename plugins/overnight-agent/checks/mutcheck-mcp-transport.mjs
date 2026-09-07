#!/usr/bin/env node
/**
 * mutcheck-mcp-transport.mjs -- proves mcp-transport-sweep.mjs is load-bearing (GH #570).
 *
 * A guard with no mutation check is prose wearing a code row's costume. Each arm below breaks
 * the detector in one specific, plausible way and asserts the detector then FAILS to catch the
 * real #570 config. If an arm passes, the detector was not doing the thing that arm removed.
 *
 * THE ARM THAT MATTERS
 *
 * M1 widens the recognised set to include "local". That is not a hypothetical: "local" is
 * exactly what was in Shiv's config for weeks, and the tempting "fix" when this check first
 * fires on a working machine is to add the offending value to the allow-list to quiet it. M1
 * is the standing argument against doing that.
 *
 * BASELINE uses the verbatim #570 config -- google-workspace with type "local" alongside a
 * healthy stdio server -- so this file is also the regression fixture for the original bug.
 */

import { evaluate, RECOGNISED } from './mcp-transport-sweep.mjs';

// The real config as measured on 2026-09-06, reduced to the two servers that matter.
const REAL_570 = {
  mcpServers: {
    'google-workspace': { type: 'local', command: 'uvx.exe', args: ['workspace-mcp'] },
    email: { type: 'stdio', command: 'node.exe', args: ['index.js'] },
    canva: { type: 'http', url: 'https://example.invalid' },
  },
};

const CLEAN = {
  mcpServers: {
    'google-workspace': { type: 'stdio', command: 'uvx.exe', args: ['workspace-mcp'] },
    email: { type: 'stdio', command: 'node.exe', args: ['index.js'] },
  },
};

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

/** Re-implements evaluate() with one behaviour removed, to prove that behaviour is load-bearing. */
function mutated(cfg, arm) {
  const servers = cfg.mcpServers || {};
  const findings = [];
  for (const name of Object.keys(servers)) {
    const type = servers[name].type;

    // M1: someone quiets the check by allowing the very value that caused #570.
    const set = arm === 'M1' ? [...RECOGNISED, 'local'] : RECOGNISED;

    // M2: the check only looks at the first server and stops.
    if (arm === 'M2' && findings.length > 0) break;

    // M3: an absent type is treated as fine rather than reported.
    if (type === undefined || type === '') {
      if (arm !== 'M3') findings.push({ server: name, type: null, kind: 'missing' });
      continue;
    }

    if (!set.includes(type)) findings.push({ server: name, type, kind: 'unrecognised' });
  }
  return findings;
}

console.log('\nBASELINE');

const base = evaluate(REAL_570);
check(
  'the real #570 config is a finding, not a pass',
  base.findings.some((f) => f.server === 'google-workspace' && f.kind === 'unrecognised'),
  `findings=${JSON.stringify(base.findings)}`
);
check(
  'the healthy stdio server beside it is NOT flagged',
  base.ok.some((s) => s.server === 'email'),
  'a guard that flags working servers gets ignored'
);
check(
  'http is accepted as well as stdio',
  base.ok.some((s) => s.server === 'canva'),
  'canva is http and loads; flagging it would be a false positive'
);
check('a clean config yields no findings', evaluate(CLEAN).findings.length === 0);

check(
  'a disabled server is not flagged',
  evaluate({
    mcpServers: { dead: { type: 'local' } },
    disabledMcpServers: ['dead'],
  }).findings.length === 0,
  'a server Shiv turned off is not a defect'
);

check(
  'a missing type is reported, at a lower key',
  (() => {
    const r = evaluate({ mcpServers: { x: { command: 'a' } } });
    return r.findings.length === 1 && r.findings[0].kind === 'missing';
  })(),
  'ambiguity must not read as a pass'
);

console.log('\nMUTATIONS');

check(
  'M1 killed -- allow-listing "local" hides the original bug',
  mutated(REAL_570, 'M1').every((f) => f.server !== 'google-workspace'),
  'M1 did not change the verdict, so the recognised set is not load-bearing'
);

check(
  'M2 killed -- stopping after the first finding misses later servers',
  (() => {
    const cfg = {
      mcpServers: {
        a: { type: 'local' },
        'google-workspace': { type: 'local' },
      },
    };
    return mutated(cfg, 'M2').length < evaluate(cfg).findings.length;
  })(),
  'iteration over every server is not load-bearing'
);

check(
  'M3 killed -- swallowing an absent type loses the ambiguous case',
  mutated({ mcpServers: { x: { command: 'a' } } }, 'M3').length === 0
    && evaluate({ mcpServers: { x: { command: 'a' } } }).findings.length === 1,
  'the missing-type branch is not load-bearing'
);

console.log('\nABSENCE');

check(
  'an empty config is not a silent pass for a server that exists',
  evaluate({}).findings.length === 0 && evaluate({}).ok.length === 0,
  'an empty config must report nothing rather than assert health'
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
