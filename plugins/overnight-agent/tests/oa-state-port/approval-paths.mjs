#!/usr/bin/env node
// approval-paths.mjs -- his real approval paths still count under the default approval channels
// (#815, item 4 step 5).
//
// Step 5 lets agent-gate.md's `## Approvals` switch channels off, so it must be shown not to drop
// an approval he gives today. He approves through three writers, and every one of them lands in
// the JOURNAL as a dated `<!-- from: me -->` entry -- the `app` channel:
//   - the app composer                    src/journalChat.js            appendJournalMessage
//   - a task-paper comment box            packages/task-paper           runs that SAME function,
//                                                                       embedded verbatim (its own
//                                                                       test pins the embedding)
//   - a Telegram reply folded by the bridge packages/telegram-bridge   appendUserReply
// This drives the REAL writers (imported, not re-typed), then asks `consent` on BOTH engines under:
//   no agent-gate.md, the live shape (no ## Approvals), and the documented defaults written out.
// Every case must grant. A control switches `app: off` and every case must then refuse, which
// proves the test reaches the channel rule rather than passing around it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendJournalMessage } from '../../../../src/journalChat.js';
import { appendUserReply } from '../../../../packages/telegram-bridge/src/journal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', '..', 'skills', 'overnight-agent');
const ENGINES = { ps: path.join(SKILL, 'oa-state.ps1'), node: path.join(SKILL, 'oa-state.mjs') };
const DAY = '2026-10-02';

const base = '# Task 970: approval paths\n\nUser notes.\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\n' +
  '## \u{1F319} Overnight Agent \u2014 2026-10-01\n\n<!-- from: overnight-agent -->\n<!-- oa-ask: blocking -->\n**Status:** Proposed\n\n' +
  '### Proposed plan (v1)\n1. [gated] Order the part, $40 on the card on file.\n\n**Needs from you:** reply `approve` to place the order.\n<!-- /overnight-agent turn-end -->\n';
const writers = {
  'app composer': (t) => appendJournalMessage(t, 'approve', DAY),
  'task-paper comment': (t) => appendJournalMessage(t, 'approve', DAY),
  'telegram fold': (t) => appendUserReply(t, { text: 'approve', date: DAY }),
  'app composer, same-day follow-up': (t) => appendJournalMessage(appendJournalMessage(t, 'one question first', DAY), 'ok, approve', DAY),
};
const gateBody = '# Agent gate\n\n## Do not gate these (reversible)\n\n- Reading files\n\n## Always ask (safety floor)\n\n- Spending money\n';
const gates = {
  'no agent-gate.md': null,
  'live shape (no ## Approvals)': gateBody,
  'defaults written out': gateBody + '\n## Approvals\n- app: editor\n- telegram: sender-id\n- teams: no-signature + not-in-sent-ledger\n- mail: no-signature + not-in-sent-ledger\n- google-doc: no-signature + not-in-sent-ledger\n',
};
const control = gateBody + '\n## Approvals\n- app: off\n';

function consent(engine, journal, gate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-approval-paths-'));
  try {
    fs.mkdirSync(path.join(root, 'journal'), { recursive: true });
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'journal', 'task-970.md'), journal);
    if (gate !== null) fs.writeFileSync(path.join(root, 'agent-gate.md'), gate);
    const args = ['consent', '-Id', '970', '-JournalDir', path.join(root, 'journal'), '-StateDir', path.join(root, 'state'),
      '-GatePath', path.join(root, 'agent-gate.md'), '-PlannerBoard', path.join(root, 'planner.md')];
    const r = engine === 'ps'
      ? spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ENGINES.ps, ...args], { encoding: 'utf8' })
      : spawnSync(process.execPath, [ENGINES.node, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${engine} consent exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let failures = 0;
let checks = 0;
for (const [wname, write] of Object.entries(writers)) {
  const journal = write(base);
  const lf = journal.replace(/\r\n/g, '\n');
  const markers = lf.match(/^<!-- from: [^>]*-->$/gm) || [];
  if (markers.at(-1) !== '<!-- from: me -->' || !/approve\n?$/.test(lf)) {
    console.log(`FAIL ${wname}: the writer did not produce a <!-- from: me --> approval at the bottom`);
    failures++;
  }
  for (const engine of Object.keys(ENGINES)) {
    for (const [gname, gate] of Object.entries(gates)) {
      checks++;
      const v = consent(engine, journal, gate);
      const ok = v.consent_ok === true && v.reason === 'human-authored-affirmative';
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${engine.padEnd(4)} ${wname} | ${gname}: consent_ok=${v.consent_ok} reason=${v.reason}`);
    }
    checks++;
    const c = consent(engine, journal, control);
    const refused = c.consent_ok === false && c.reason === 'approvals-channel-off:app';
    if (!refused) failures++;
    console.log(`${refused ? 'PASS' : 'FAIL'} ${engine.padEnd(4)} ${wname} | control app: off: consent_ok=${c.consent_ok} reason=${c.reason}`);
  }
}
console.log(`approval-paths: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
