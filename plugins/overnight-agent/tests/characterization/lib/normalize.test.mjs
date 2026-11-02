// node --test plugins/overnight-agent/tests/characterization/lib/normalize.test.mjs
//
// The minute-precision `yyyyMMdd-HHmm` stamp (write-turn's backup name) must normalise the same
// way however the case clock T0 and the write fall around a minute boundary. Before, a stamp
// from T0's own minute was <STAMP-5m> and one written after the minute rolled over (or with T0
// in a minute's first second) was <STAMP+0m>, so four goldens flaked on every PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeNormalizer } from './normalize.mjs';
import { expandTokens } from './fixture.mjs';
import { jsonDateOrNull } from '../../../skills/overnight-agent/oa-state-lib/core/psdate.mjs';

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};
const norm = (t0, writeMs) => makeNormalizer({ t0, pathTokens: [] }).text(`task-1.bak-${stampOf(writeMs)}.md`);

const base = new Date(2026, 9, 2, 10, 0, 0, 0).getTime();
const offsetsInMinute = [0, 1, 400, 999, 1200, 30000, 59000, 59999];

test('a stamp written during the case is always <STAMP-5m>, whatever second T0 falls on', () => {
  for (const s of offsetsInMinute) {
    const t0 = base + s;
    for (const afterMs of [0, 1, 500, 2000, 61000, 125000, 3 * 60000 + 59000 - s]) {
      assert.equal(norm(t0, t0 + afterMs), 'task-1.bak-<STAMP-5m>.md', `T0+${s}ms, write +${afterMs}ms`);
    }
  }
});

test('the minute before T0 is still the same bucket (a clock read just before T0)', () => {
  assert.equal(norm(base + 100, base - 30000), 'task-1.bak-<STAMP-5m>.md');
});

test('stamps far from T0 still land in their own buckets', () => {
  assert.equal(norm(base, base + 10 * 60000), 'task-1.bak-<STAMP+5m>.md');
  assert.equal(norm(base, base - 3 * 60000), 'task-1.bak-<STAMP-10m>.md');
  assert.equal(norm(base, base + 90 * 86400000), `task-1.bak-${stampOf(base + 90 * 86400000)}.md`);
});

test('ISO timestamps keep their own bucketing (only minute stamps changed)', () => {
  const t0 = base + 30000;
  const n = makeNormalizer({ t0, pathTokens: [] });
  assert.equal(n.text(new Date(t0 + 1000).toISOString()), '<NOW+0m>');
});

test('doc freshness fixture ages survive invariant rendering in summer, winter and DST transition days', () => {
  const fixtures = [
    ['mc-doc-binding', '905', -30],
    ['mc-doc-channel-provenance', '921', -30],
    ['mc-doc-channel-provenance', '922', -360],
    ['mc-observe-bound-docs', '930', -360],
    ['mc-observe-bound-docs', '931', -360],
  ];
  for (const [month, day] of [[0, 15], [6, 15], [2, 8], [10, 1]]) {
    const t0 = new Date(2026, month, day, 12).getTime();
    for (const [fixture, id, minutes] of fixtures) {
      const source = readFileSync(new URL(`../fixtures/${fixture}/state/task-${id}.json`, import.meta.url), 'utf8');
      const observedAt = JSON.parse(expandTokens(source, { t0, root: '' })).doc.observed_at;
      assert.equal(Date.parse(observedAt) - t0, minutes * 60000);
      const rendered = jsonDateOrNull(observedAt).toInvariantString();
      const n = makeNormalizer({ t0, pathTokens: [] });
      assert.equal(n.text(rendered), `<INVTIME${minutes}m>`, `${fixture}/${id} at ${new Date(t0).toISOString()}`);
    }
  }
});
