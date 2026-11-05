import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessMemory, observeMemory, MEMORY_POLICY, MEMORY_RESTART_AUTHORIZATION,
} from "./memory-pressure.mjs";
import {
  commandAdapters, createSupervisor, initialState, loadState, validateConfig,
} from "./reliability-supervisor.mjs";
import { collectMemoryPressure, forceTerminate, summarizeMemoryCounters } from "./windows-app-actuator.mjs";
import { applyReliabilityPolicy, nextEvaluationDelay, reconcileConsumerConfig, supervisorPaths,
  runConsumerSupervisor } from "./consumer-reliability-supervisor.mjs";
import { parseReliabilityPolicy } from "./oa-user-settings.mjs";

const start = Date.parse("2026-11-03T20:00:00Z");
const gb = 1024 ** 3;
const identity = { pid: 101, path: "C:\\Programs\\GitHub Copilot\\github.exe",
  startTime: new Date(start - 30 * 60_000).toISOString() };
const app = { running: true, evidence: "known", identity, startedAt: identity.startTime };
const stamp = at => new Date(at).toISOString();
const sample = (at = start, percent = 96) => ({
  observedAt: stamp(at), appIdentity: identity, committedBytes: 20 * gb * percent / 100,
  commitLimitBytes: 20 * gb, appPrivateBytes: 4 * gb,
  topConsumers: [{ pid: 102, name: "copilot-runtime.exe", privateBytes: 4 * gb, belongsToApp: true }],
});
// Use integral counters, just as the Windows provider does.
const memory = (at, percent) => {
  const result = sample(at, percent);
  result.committedBytes = Math.round(result.committedBytes);
  return result;
};
const config = validateConfig({ memoryPressure: { enabled: true } });
const quiet = { complete: true, admissionVersion: "1", quietObservedSince: stamp(start - 20 * 60_000), sessions: [] };
const active = { complete: false, sessions: [] };

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "oa-memory-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("memory thresholds use committed bytes, not available RAM or process working set", () => {
  for (const [percent, level] of [[84, "normal"], [85, "high"], [94, "high"], [95, "critical"], [100, "critical"]]) {
    assert.equal(assessMemory(memory(start, percent), app, start).level, level);
  }
  assert.equal(assessMemory({ ...memory(start, 99), appPrivateBytes: gb - 1 }, app, start).level, "normal");
  assert.equal(assessMemory({ ...memory(start, 99), appPrivateBytes: 1.5 * gb }, app, start).level, "normal");
});

test("unreadable, invalid, stale, future and mismatched evidence cannot authorize recovery", () => {
  for (const change of [
    { error: "access denied" }, { observedAt: stamp(start - 90_001) }, { observedAt: stamp(start + 1) },
    { commitLimitBytes: 0 }, { committedBytes: null }, { appPrivateBytes: -1 },
    { committedBytes: 30 * gb }, { appPrivateBytes: 30 * gb },
    { appIdentity: { ...identity, startTime: stamp(start) } },
    { appIdentity: { ...identity, path: "C:\\Other\\github.exe" } },
  ]) {
    assert.equal(assessMemory({ ...memory(start, 99), ...change }, app, start).level, "unknown");
  }
  assert.equal(assessMemory(memory(start, 99), { ...app, intentionalClosure: true }, start).level, "unknown");
});

test("confirmation needs distinct sustained observations and resets on recovery, gaps or identity changes", () => {
  const first = observeMemory(memory(start, 96), app, null, start);
  assert.equal(first.confirmed, false);
  assert.equal(observeMemory(memory(start, 96), app, first, start).confirmed, false);
  assert.equal(observeMemory(memory(start + 59_999, 96), app, first, start + 59_999).confirmed, false);
  assert.equal(observeMemory(memory(start + 60_000, 96), app, first, start + 60_000).confirmed, true);
  assert.equal(observeMemory(memory(start + 150_001, 96), app, first, start + 150_001).confirmed, false);
  const recovered = observeMemory(memory(start + 60_000, 70), app, first, start + 60_000);
  assert.equal(observeMemory(memory(start + 120_000, 96), app, recovered, start + 120_000).confirmed, false);
  const high = observeMemory(memory(start, 86), app, null, start);
  assert.equal(observeMemory(memory(start + 60_000, 96), app, high, start + 60_000).confirmed, false);
  const replaced = { ...app, identity: { ...identity, startTime: stamp(start) } };
  assert.equal(observeMemory({ ...memory(start + 60_000, 96), appIdentity: replaced.identity },
    replaced, first, start + 60_000).confirmed, false);
});

test("collector attributes descendants without counting foreign or recycled-parent processes", async () => {
  const root = { ...identity, name: "github.exe", parentPid: 1, privateBytes: gb };
  const counters = { committedBytes: 19 * gb, commitLimitBytes: 20 * gb, processes: [
    root, { pid: 102, parentPid: 101, name: "copilot-runtime.exe", startTime: stamp(start), privateBytes: 3 * gb },
    { pid: 103, parentPid: 102, name: "node.exe", startTime: stamp(start), privateBytes: gb },
    { pid: 104, parentPid: 999, name: "copilot-runtime.exe", startTime: stamp(start), privateBytes: 2 * gb },
    { pid: 105, parentPid: 101, name: "foreign.exe", startTime: stamp(start - 3_600_000), privateBytes: 2 * gb },
  ] };
  const result = summarizeMemoryCounters(counters, identity, stamp(start));
  assert.equal(result.appPrivateBytes, 5 * gb);
  assert.equal(result.topConsumers.find(row => row.pid === 104).belongsToApp, false);
  assert.equal(result.topConsumers.find(row => row.pid === 105).belongsToApp, false);
  assert.throws(() => summarizeMemoryCounters(counters, { ...identity, pid: 999 }, stamp(start)), /identity/);
  assert.deepEqual(await collectMemoryPressure(identity, { read: () => counters, now: () => start }), result);
  await assert.rejects(collectMemoryPressure(identity, { read: () => { throw Error("counter failure"); } }), /counter failure/);
});

async function recoveryFixture(t, { percent = 96, activity = active, enabled = true, recheck, failed = false } = {}) {
  const root = await directory(t);
  let now = start;
  let calls = [];
  let inspections = 0;
  const adapters = {
    async inspect() {
      inspections++;
      return { app, memory: recheck && inspections > 2 ? recheck(now) : memory(now, percent),
        activity, scheduler: { evidence: "known", workDue: false } };
    },
    async requestShutdown(options) {
      calls.push("graceful");
      await options.beforeTerminate();
      return { ok: !failed, error: failed ? "fixture failure" : null };
    },
    async awaitShutdown(options) {
      calls.push("await");
      if (percent >= 95) {
        assert.equal(options.forceAuthorization, MEMORY_RESTART_AUTHORIZATION);
        assert.equal(options.restartMode, "memory-critical");
        assert.equal(options.deadlineSeconds, 15);
      }
      return { ok: true };
    },
    async forceShutdown() { throw Error("memory recovery must request graceful close first"); },
    async launch() { calls.push("launch"); return { ok: true }; },
    async awaitReady() { return { ok: true, identity: { ...identity, pid: 202, startTime: stamp(now) } }; },
    async verifyScheduler() { calls.push("verified"); return { ok: true }; },
  };
  const statePath = join(root, "state.json");
  const auditPath = join(root, "audit.jsonl");
  const supervisor = createSupervisor({ config: validateConfig({ memoryPressure: { enabled } }),
    statePath, lockPath: join(root, "lock"), auditPath, adapters,
    clock: { now: () => now, sleep: async ms => { now += ms; } } });
  return { supervisor, statePath, auditPath, calls, advance: ms => { now += ms; } };
}

test("opt-in critical recovery bypasses app age, records evidence and uses the existing restart transaction", async t => {
  const f = await recoveryFixture(t);
  assert.equal((await f.supervisor.run()).status, "not-due");
  assert.deepEqual(f.calls, []);
  f.advance(60_000);
  const result = await f.supervisor.run();
  assert.equal(result.status, "restarted");
  assert.equal(result.attempt.reason, "memory-critical");
  assert.equal(result.attempt.activityOverridden, true);
  assert.deepEqual(f.calls, ["graceful", "await", "launch", "verified"]);
  const audit = JSON.parse((await readFile(f.auditPath, "utf8")).trim());
  assert.equal(audit.evidence.memory.topConsumers[0].name, "copilot-runtime.exe");
  assert.equal(audit.evidence.memoryConfirmation.confirmed, true);
  assert.equal(audit.outcome, "succeeded");
});

test("memory recovery is off by default and high pressure never overrides activity", async t => {
  const off = await recoveryFixture(t, { enabled: false });
  await off.supervisor.run(); off.advance(60_000);
  assert.equal((await off.supervisor.run()).status, "not-due");
  const high = await recoveryFixture(t, { percent: 86 });
  await high.supervisor.run(); high.advance(60_000);
  assert.equal((await high.supervisor.run()).status, "postponed");
  assert.deepEqual(high.calls, []);
  const idle = await recoveryFixture(t, { percent: 86, activity: quiet });
  await idle.supervisor.run(); idle.advance(60_000);
  assert.equal((await idle.supervisor.run()).status, "restarted");
  assert.deepEqual(idle.calls, ["graceful", "await", "launch", "verified"]);
});

test("memory recovery rechecks pressure and target before touching processes", async t => {
  for (const recheck of [
    now => memory(now, 60), now => ({ error: "unreadable" }),
    now => ({ ...memory(now, 96), appIdentity: { ...identity, pid: 999 } }),
  ]) {
    const f = await recoveryFixture(t, { recheck });
    await f.supervisor.run(); f.advance(60_000);
    assert.equal((await f.supervisor.run()).status, "postponed");
    assert.deepEqual(f.calls, []);
  }
});

test("recovered pressure on the second shutdown recheck cancels the restart", async t => {
  const root = await directory(t);
  let now = start;
  let inspections = 0;
  let shutdowns = 0;
  const statePath = join(root, "state.json");
  const run = createSupervisor({ config, statePath, lockPath: join(root, "lock"),
    clock: { now: () => now, sleep: async ms => { now += ms; } },
    adapters: {
      inspect: async () => ({ app, activity: quiet, memory: memory(now, ++inspections >= 4 ? 60 : 96) }),
      requestShutdown: async () => { shutdowns++; throw Error("must not shut down"); },
      awaitShutdown: async () => { throw Error("must not wait for shutdown"); },
      forceShutdown: async () => { throw Error("must not force"); },
      launch: async () => { throw Error("must not launch"); },
      awaitReady: async () => { throw Error("must not await readiness"); },
      verifyScheduler: async () => { throw Error("must not verify scheduler"); },
    } });
  await run.run(); now += 60_000;
  assert.equal((await run.run()).status, "postponed");
  assert.equal(shutdowns, 0);
  const state = await loadState(statePath);
  assert.equal(state.attempts[0].restartIntentPersisted, false);
});

test("failed recovery persists cooldown, independent of the longer timed restart cooldown", async t => {
  const f = await recoveryFixture(t, { failed: true });
  await f.supervisor.run(); f.advance(60_000);
  assert.equal((await f.supervisor.run()).status, "failed");
  f.advance(60_000);
  const blocked = await f.supervisor.run();
  assert.equal(blocked.status, "cooldown");
  assert.equal(blocked.cooldown.remainingMs, 9 * 60_000);
  for (let i = 0; i < 9; i++) { f.advance(60_000); await f.supervisor.run(); }
  assert.equal(f.calls.length, 2);
});

test("force path requires fresh critical attribution, the opt-in and dedicated authorization", async t => {
  const root = await directory(t);
  const snapshotPath = join(root, "snapshot.json");
  const marker = join(root, "forced.txt");
  const forceScript = join(root, "force.mjs");
  await writeFile(forceScript, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join('|'));
writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({ observedAt: ${JSON.stringify(stamp(start))},
  app: { running: false, evidence: 'known' }, activity: { complete: true, sessions: [] } }));
console.log('SUPERVISOR_ADAPTER_RESULT=' + JSON.stringify({ ok: true }));
`);
  const setup = async (sampleValue, enabled = true) => {
    await writeFile(snapshotPath, JSON.stringify({ observedAt: stamp(start), app, activity: active, memory: sampleValue }));
    return commandAdapters(validateConfig({ memoryPressure: { enabled }, commands: {
      forceTerminate: { file: process.execPath, args: [forceScript, "{restartMode}", "{authorization}"] },
    } }), snapshotPath, { now: () => start, sleep: async () => {} });
  };
  const options = { attemptId: "test", deadlineSeconds: 0, expectedOldIdentity: identity,
    forceDeadlineSeconds: 5, memoryRecovery: true, restartMode: "memory-critical",
    forceAuthorization: MEMORY_RESTART_AUTHORIZATION };
  for (const sampleValue of [memory(start, 90), { error: "counter failed" }, memory(start - 90_001, 96)]) {
    const adapter = await setup(sampleValue);
    assert.equal((await adapter.awaitShutdown(options)).ok, false);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
  assert.equal((await (await setup(memory(start, 96), false)).awaitShutdown(options)).ok, false);
  assert.equal((await (await setup(memory(start, 96))).awaitShutdown({ ...options, forceAuthorization: "wrong" })).ok, false);
  const result = await (await setup(memory(start, 96))).awaitShutdown(options);
  assert.equal(result.ok, true);
  assert.equal(result.activityOverridden, true);
  assert.equal(await readFile(marker, "utf8"), `memory-critical|${MEMORY_RESTART_AUTHORIZATION}`);
  const denied = await forceTerminate({ restartMode: "memory-critical", authorization: "wrong",
    processProvider: () => { throw Error("must not inspect"); } });
  assert.equal(denied.ok, false);
});

test("settings and cadence wire memory opt-in without changing M/N or auto-apply policy", async t => {
  assert.equal(applyReliabilityPolicy(config, {}).memoryPressure.enabled, false);
  const policy = parseReliabilityPolicy("## Tray reliability supervision\n| Memory pressure recovery | `on` |\n");
  const applied = applyReliabilityPolicy(config, policy.values);
  assert.equal(applied.memoryPressure.enabled, true);
  assert.equal(applied.preventiveRestart.targetIntervalHours, 3);
  assert.equal(applied.preventiveRestart.hardIntervalHours, 4);
  assert.equal(nextEvaluationDelay(applied, { checkedAt: stamp(start), actuator: {} }, start), MEMORY_POLICY.pollMs);
  const paths = supervisorPaths(await directory(t));
  const wired = await reconcileConsumerConfig(paths, { policy });
  assert.deepEqual(wired.commands.snapshot.args.slice(-2), ["--memory", "true"]);
  const disabled = await reconcileConsumerConfig(paths, { policy: { values: {} } });
  assert.equal(disabled.commands.snapshot.args.includes("--memory"), false);
  assert.throws(() => parseReliabilityPolicy("## Tray reliability supervision\n| Memory pressure recovery | maybe |"), /on.*off/);
});

test("detect-only reports memory but cannot persist confirmation or restart", async t => {
  const paths = supervisorPaths(await directory(t));
  await writeFile(paths.config, JSON.stringify(config));
  const state = initialState();
  await writeFile(paths.state, JSON.stringify(state));
  const result = await runConsumerSupervisor({ paths, noAct: true, clock: { now: () => start },
    adapters: { inspect: async () => ({ app, memory: memory(start, 96), activity: active }) } });
  assert.equal(result.status, "detect-only");
  assert.equal(result.memory.level, "critical");
  assert.equal(Date.parse(result.nextEvaluationAt) - start, 60_000);
  assert.deepEqual(await loadState(paths.state), state);
});
