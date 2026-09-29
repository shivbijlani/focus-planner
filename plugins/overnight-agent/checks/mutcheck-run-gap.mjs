import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  detectRunGap, gapForAlert, gapHeadline, readRunLedger, recordRunStart,
} from '../skills/overnight-agent/run-ledger.mjs';

const temp = mkdtempSync(path.join(tmpdir(), 'oa-run-gap-'));
try {
  const ledger = path.join(temp, 'run-ledger.jsonl');
  const first = recordRunStart(ledger, {
    now: new Date('2026-09-29T00:00:00Z'), trigger: 'schedule', runId: 'run-1',
  });
  assert.equal(first.gap, undefined);
  recordRunStart(ledger, {
    now: new Date('2026-09-29T01:30:00Z'), trigger: 'catch_up', runId: 'run-2',
  });
  assert.equal(readRunLedger(ledger).length, 2);
  assert.equal(readRunLedger(ledger)[1].gap, undefined);
  assert.equal(gapForAlert(readRunLedger(ledger)[1], null), null);

  const outage = recordRunStart(ledger, {
    now: new Date('2026-09-29T04:00:00Z'), trigger: 'catch_up', runId: 'run-3',
  });
  assert.equal(outage.gap.missedSlots, 4);
  assert.equal(gapHeadline(outage.gap),
    '⚠ GAP: no runs from 2026-09-29T01:30:00.000Z to 2026-09-29T04:00:00.000Z (4 slots)');
  const pending = gapForAlert(outage, null);
  assert.equal(gapForAlert({ runId: 'run-4' }, pending), pending);
  assert.equal(gapForAlert({ runId: 'run-4' }, { ...pending, alertedAt: '2026-09-29T04:00:01Z' }), null);
  assert.throws(() => detectRunGap({ startedAt: 'bad' }, '2026-09-29T05:00:00Z'), /valid and increasing/);

  const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'skills', 'overnight-agent', 'run-ledger.mjs');
  const source = readFileSync(sourcePath, 'utf8');
  const mutations = [
    ['threshold', 'missedSlots <= MISSED_SLOT_THRESHOLD', 'missedSlots < MISSED_SLOT_THRESHOLD'],
    ['slot-count', 'Math.floor((toMs - fromMs) / cadenceMs) - 1',
      'Math.floor((toMs - fromMs) / cadenceMs)'],
    ['persistence', 'appendFileSync(file, `${JSON.stringify(entry)}\\n`, \'utf8\');', ''],
  ];
  for (const [name, find, replacement] of mutations) {
    assert.equal(source.split(find).length, 2, `${name}: mutation target`);
    const mutant = path.join(temp, `run-ledger-${name}.mjs`);
    writeFileSync(mutant, source.replace(find, replacement));
    const module = await import(`${pathToFileURL(mutant).href}?${name}`);
    const mutantLedger = path.join(temp, `${name}.jsonl`);
    let killed = false;
    try {
      module.recordRunStart(mutantLedger, {
        now: new Date('2026-09-29T00:00:00Z'), runId: `${name}-1`,
      });
      const boundary = module.recordRunStart(mutantLedger, {
        now: new Date('2026-09-29T01:30:00Z'), runId: `${name}-2`,
      });
      assert.equal(boundary.gap, undefined);
      const detected = module.recordRunStart(mutantLedger, {
        now: new Date('2026-09-29T04:00:00Z'), runId: `${name}-3`,
      });
      const rows = module.readRunLedger(mutantLedger);
      assert.equal(rows.length, 3);
      assert.equal(detected.gap.missedSlots, 4);
    } catch {
      killed = true;
    }
    assert.equal(killed, true, `${name}: mutant survived`);
  }

  console.log(`mutcheck-run-gap -- ${mutations.length} mutations killed`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
