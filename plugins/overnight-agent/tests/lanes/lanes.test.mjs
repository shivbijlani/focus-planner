// Lanes contract tests (docs/spec/Domain-lanes.md): every resolution, validation and served-here
// vector in vectors.json, run against oa-state-lib/plan/lanes.mjs (the Node engine). The PowerShell
// engine's twin runs through the characterization goldens (cases/lanes.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLanes, readLanesFile, laneFacts, readDeviceKey, assertLaneServed, LanesFile,
} from '../../skills/overnight-agent/oa-state-lib/plan/lanes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(fs.readFileSync(path.join(here, 'vectors.json'), 'utf8'));

function sandbox({ lanes = V.lanesFile, deviceId = null, deviceRaw = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-lanes-'));
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  const state = path.join(home, 'state');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(data, 'planner.md'), V.board.join('\n'));
  if (lanes !== null) fs.writeFileSync(path.join(data, LanesFile), typeof lanes === 'string' ? lanes : JSON.stringify(lanes, null, 2));
  if (deviceRaw !== null) fs.writeFileSync(path.join(home, 'device.json'), deviceRaw);
  else if (deviceId) fs.writeFileSync(path.join(home, 'device.json'), JSON.stringify({ schema: 'fp-agent-device@1', id: deviceId, createdAt: '2026-10-02T21:00:00.000Z' }));
  const ctx = { p: { PlannerBoard: path.join(data, 'planner.md'), StateDir: state } };
  return { root, ctx, file: path.join(data, LanesFile) };
}

test('resolution vectors R1-R25', () => {
  const { ctx } = sandbox({ deviceId: V.devices.A.id });
  const lanes = readLanes(ctx);
  for (const r of V.resolution) {
    const f = laneFacts(lanes, r.id);
    assert.deepEqual(
      { lane: f.lane, source: f.source, from: f.from, problem: f.problem, candidates: f.candidates },
      { lane: r.lane, source: r.source, from: r.from, problem: r.problem, candidates: r.candidates },
      `${r.v} (task ${r.id})`,
    );
  }
});

test('device keys match the per-device metadata derivation', () => {
  for (const [name, d] of Object.entries(V.devices)) {
    const { ctx } = sandbox({ deviceId: d.id });
    assert.deepEqual(readDeviceKey(ctx.p.StateDir), { state: 'ok', key: d.key }, name);
  }
});

test('served-here vectors for devices A, B, C', () => {
  for (const [name, d] of Object.entries(V.devices)) {
    const { ctx } = sandbox({ deviceId: d.id });
    const lanes = readLanes(ctx);
    const served = V.resolution.filter((r) => laneFacts(lanes, r.id).served).map((r) => r.id).sort();
    assert.deepEqual(served, [...V.served[name]].sort(), `device ${name}`);
  }
});

test('no lanes file: lanes are off (readLanes is null, the guard is a no-op)', () => {
  const { ctx } = sandbox({ lanes: null, deviceId: V.devices.A.id });
  assert.equal(readLanes(ctx), null);
  assert.doesNotThrow(() => assertLaneServed(ctx, '20'));
});

test('validation vectors C1-C19', () => {
  for (const c of V.validation) {
    const { file } = sandbox({ lanes: null });
    if (c.file === null) {
      assert.equal(readLanesFile(file), null, c.v);
      continue;
    }
    let bytes;
    if (c.raw !== undefined) bytes = Buffer.from(c.raw, 'utf8');
    else if (c.oversize) bytes = Buffer.from(`{"schema":"fp-agent-lanes@1","pad":"${'x'.repeat(256 * 1024)}"}`);
    else if (c.manyDevices) {
      const devices = {};
      for (let i = 0; i < c.manyDevices; i++) devices[i.toString(16).padStart(32, '0')] = {};
      bytes = Buffer.from(JSON.stringify({ schema: 'fp-agent-lanes@1', devices }));
    } else if (c.manyTasks) {
      const tasks = {};
      for (let i = 1; i <= c.manyTasks; i++) tasks[String(i)] = 'ado';
      bytes = Buffer.from(JSON.stringify({ schema: 'fp-agent-lanes@1', tasks }));
    } else bytes = Buffer.from(JSON.stringify(c.doc, null, 2), 'utf8');
    if (c.bom) bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
    fs.writeFileSync(file, bytes);
    const r = readLanesFile(file);
    assert.equal(r.state, c.verdict, c.v);
    if (c.reason) assert.equal(r.reason, c.reason, c.v);
    if (c.serves) for (const [k, l] of Object.entries(c.serves)) assert.deepEqual(r.devices[k].lanes, l, c.v);
  }
});

test('an invalid file serves nothing; rows still resolve from tags', () => {
  const { ctx } = sandbox({ lanes: 'not json', deviceId: V.devices.B.id });
  const lanes = readLanes(ctx);
  assert.equal(lanes.state, 'invalid');
  const f20 = laneFacts(lanes, '20');
  assert.equal(f20.lane, 'home');
  assert.equal(f20.served, false);
  assert.equal(laneFacts(lanes, '21').served, false);
  assert.throws(() => assertLaneServed(ctx, '21'), /^Error: session_lanes_config_invalid: /);
});

test('no device.json: unassigned, so catch-all', () => {
  const { ctx } = sandbox();
  const lanes = readLanes(ctx);
  assert.equal(lanes.device, null);
  assert.equal(lanes.assigned, false);
  assert.equal(laneFacts(lanes, '21').served, true);
  assert.equal(laneFacts(lanes, '10').served, false);
});

test('corrupt device.json: serves nothing', () => {
  const { ctx } = sandbox({ deviceRaw: '{ "schema": "nope" }' });
  const lanes = readLanes(ctx);
  assert.equal(lanes.state, 'device_identity_corrupt');
  assert.equal(laneFacts(lanes, '21').served, false);
  assert.throws(() => assertLaneServed(ctx, '21'), /^Error: session_lane_not_served: this PC's device identity is unreadable/);
});

test('the dispatch guard names the lane, where it came from and what this PC serves', () => {
  const { ctx } = sandbox({ deviceId: V.devices.A.id });
  assert.doesNotThrow(() => assertLaneServed(ctx, '10'));
  assert.throws(() => assertLaneServed(ctx, '20'),
    /^Error: session_lane_not_served: task 20 is in lane 'home' \(from its #lane: tag\); this PC serves 'ado'\. /);
  assert.throws(() => assertLaneServed(ctx, '31'), /inherited from task 20/);
  assert.throws(() => assertLaneServed(ctx, '21'), /task 21 has no lane \(none set\); this PC serves 'ado'\./);
  assert.throws(() => assertLaneServed(ctx, '24'), /^Error: session_lane_conflict: task 24 has conflicting lanes \(ado, home\)/);
  assert.throws(() => assertLaneServed(ctx, '27'), /^Error: session_lane_invalid: task 27 names an invalid lane \(a_b\)/);
});

test('the walk stops after 16 levels', () => {
  const rows = ['## Today', '', '| ID | 🎯 | Task | Work Priority | Added | Linked ID |', '|---|---|---|---|---|---|'];
  rows.push('| 100 | 🟡 | Root #lane:home | - | 2026-09-01 | |');
  for (let i = 101; i <= 120; i++) rows.push(`| ${i} | 🟡 | Level ${i - 100} | - | 2026-09-01 | ${i - 1} |`);
  const { ctx } = sandbox({ lanes: { schema: 'fp-agent-lanes@1' } });
  fs.writeFileSync(ctx.p.PlannerBoard, rows.join('\n'));
  const lanes = readLanes(ctx);
  assert.equal(laneFacts(lanes, '116').lane, 'home', '16 levels up is reached');
  assert.equal(laneFacts(lanes, '117').lane, null, '17 levels up is not');
});
