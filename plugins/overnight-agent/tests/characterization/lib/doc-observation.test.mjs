import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeNormalizer } from './normalize.mjs';
import { materialize } from './fixture.mjs';
import { jsonDateOrNull } from '../../../skills/overnight-agent/oa-state-lib/core/psdate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.dirname(here);
const cases = [
  ['mc-doc-binding.json', 'mc/doc-binding/scan-reports-doc-fields'],
  ['mc-doc-channel-provenance.json', 'mc/doc-channel-provenance/scan-distinguishes-unread-fresh-stale'],
  ['mc-doc-channel-provenance.json', 'mc/doc-channel-provenance/freshness-threshold-env-overrides'],
  ['mc-doc-channel-provenance.json', 'mc/doc-channel-provenance/unparseable-observed-at-is-unread'],
  ['mc-observe-bound-docs.json', 'mc/observe-bound-docs/unreadable-observe-does-not-refresh'],
];

function sources(root) {
  const dir = path.join(root, 'lad', 'overnight-agent', 'state');
  return new Map(fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    return [String(record.id), record];
  }));
}

// Each subprocess controls its own zone; neither the machine nor concurrent tests are changed.
if (process.env.DOC_OBSERVATION_TEST_CHILD !== '1') {
  for (const zone of ['America/Los_Angeles', 'UTC']) {
    test(`doc-observation synthetic-clock controls in ${zone}`, () => {
      execFileSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
        env: { ...process.env, TZ: zone, DOC_OBSERVATION_TEST_CHILD: '1' },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    });
  }
} else {
  for (const clock of ['2026-07-15T20:00:00Z', '2026-11-03T20:00:00Z']) {
    for (const [file, id] of cases) {
      test(`${clock}: ${id} normalization replay`, () => {
        const doc = JSON.parse(fs.readFileSync(path.join(harness, 'cases', file), 'utf8'));
        const kase = doc.cases.find((entry) => entry.id === id);
        assert.ok(kase);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-doc-clock-'));
        const t0 = Date.parse(clock);
        try {
          materialize({ fixturesDir: path.join(harness, 'fixtures'), fixture: doc.fixture, root, t0, files: kase.files });
          const before = sources(root);
          const golden = JSON.parse(fs.readFileSync(path.join(harness, 'golden', `${id.replaceAll('/', '__')}.json`), 'utf8'));
          const output = structuredClone(golden.steps[0].json);
          let checked = 0;
          for (const row of Array.isArray(output) ? output : [output]) {
            const iso = before.get(String(row.id))?.doc?.observed_at;
            if (typeof iso !== 'string' || !iso.endsWith('Z') || new Date(iso).getUTCFullYear() !== 2026) continue;
            const field = Array.isArray(output) ? 'doc_observed_at' : 'observed_at';
            row[field] = jsonDateOrNull(iso).toInvariantString();
            checked++;
          }
          assert.ok(checked > 0, 'must replay a real UTC-derived observation from this fixture');
          const n = makeNormalizer({ t0, pathTokens: [] });
          const normalized = n.docOutput(output, {
            command: Array.isArray(output) ? 'scan' : 'doc', before, after: before,
          });
          assert.deepEqual(normalized, golden.steps[0].json);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }

    test(`${clock}: Local, Unspecified and offset-bearing observations retain their semantics`, () => {
      const t0 = Date.parse(clock);
      const n = makeNormalizer({ t0, pathTokens: [] });
      const instant = new Date(t0 - 30 * 60000);
      const pad = (v) => String(v).padStart(2, '0');
      const local = `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}:${pad(instant.getSeconds())}`;
      const offsetMinutes = -instant.getTimezoneOffset();
      const offset = `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
      for (const iso of [local, local + offset]) {
        const invariant = jsonDateOrNull(iso).toInvariantString();
        const records = new Map([['1', { doc: { doc_id: 'D1', observed_at: iso } }]]);
        assert.equal(n.docOutput({ id: '1', doc_id: 'D1', observed_at: invariant }, {
          command: 'doc', before: records, after: records,
        }).observed_at, '<INVTIME-30m>');
        assert.equal(n.value({ observed_at: invariant }).observed_at, '<INVTIME-30m>');
      }
      assert.equal(n.text(instant.toISOString()), '<NOW-30m>');
    });

    test(`${clock}: missing, changed, mismatched and malformed provenance cannot authorize UTC parsing`, () => {
      const t0 = Date.parse(clock);
      const n = makeNormalizer({ t0, pathTokens: [] });
      const iso = new Date(t0 - 30 * 60000).toISOString();
      const invariant = jsonDateOrNull(iso).toInvariantString();
      const row = { id: '1', doc_id: 'D1', doc_observed_at: invariant };
      const records = new Map([['1', { doc: { doc_id: 'D1', observed_at: iso } }]]);
      for (const after of [
        new Map(),
        new Map([['1', { doc: { doc_id: 'D2', observed_at: iso } }]]),
        new Map([['1', { doc: { doc_id: 'D1', observed_at: new Date(t0).toISOString() } }]]),
      ]) {
        assert.deepEqual(n.docOutput([row], { command: 'scan', before: records, after }), n.value([row]));
      }
      assert.deepEqual(n.docOutput([{ ...row, id: '2' }], {
        command: 'scan', before: records, after: records,
      }), n.value([{ ...row, id: '2' }]));
      assert.deepEqual(n.docOutput([{ ...row, doc_observed_at: 'not-a-date' }], {
        command: 'scan', before: records, after: records,
      }), n.value([{ ...row, doc_observed_at: 'not-a-date' }]));
    });
  }
}
