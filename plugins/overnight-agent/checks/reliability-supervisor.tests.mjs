import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  DEFAULT_CONFIG,
  HARD_RESTART_AUTHORIZATION,
  acquireExclusiveLock,
  assessActivity,
  classifyActivity,
  commandAdapters,
  cooldownStatus,
  createSupervisor,
  determineReason,
  initialState,
  loadConfig,
  loadState,
  parseArgs,
  reclamationClaimPath,
  runCommand,
  validateConfig,
} from "./reliability-supervisor.mjs";

const CORE_SOURCE = readFileSync(new URL("./reliability-supervisor.mjs", import.meta.url), "utf8");

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "reliability-supervisor-"));
  directories.push(directory);
  return directory;
}

function fakeClock(start = "2026-09-14T20:00:00.000Z") {
  let nowMs = Date.parse(start);
  return {
    now: () => nowMs,
    sleep: async (delayMs) => {
      nowMs += delayMs;
    },
    advance: (delayMs) => {
      nowMs += delayMs;
    },
  };
}

function quietActivity(version = 1) {
  return {
    complete: true,
    admissionVersion: version,
    quietObservedSince: "2026-09-14T18:00:00.000Z",
    sessions: [
      {
        id: "completed-run",
        status: "completed",
        liveness: "dead",
        lastActivityAt: "2026-09-14T18:00:00.000Z",
        draftsPreserved: true,
      },
    ],
  };
}

function oldApp() {
  return {
    running: true,
    evidence: "known",
    startedAt: "2026-09-14T13:00:00.000Z",
    identity: { pid: 101, startTime: "2026-09-14T13:00:00.000Z", path: "C:\\Apps\\github.exe" },
  };
}

function adaptersFor({
  initial = {},
  underDrain = { activity: quietActivity(1) },
  preShutdown = underDrain,
  startupFailures = 0,
  holdInitial,
} = {}) {
  let inspections = 0;
  let launches = 0;
  const calls = [];
  return {
    calls,
    get launches() {
      return launches;
    },
    async inspect() {
      inspections += 1;
      calls.push(`inspect-${inspections}`);
      if (inspections === 1) {
        if (holdInitial) await holdInitial;
        return { app: oldApp(), activity: quietActivity(1), scheduler: { workDue: true }, ...initial };
      }
      return { app: initial.app ?? oldApp(), ...(inspections === 2 ? underDrain : preShutdown) };
    },
    async requestShutdown({ beforeTerminate }) {
      await beforeTerminate();
      calls.push("request-shutdown");
      return { ok: true, method: "graceful-request" };
    },
    async awaitShutdown() {
      calls.push("await-shutdown");
      return { ok: true };
    },
    async forceShutdown({ beforeTerminate, forceAuthorization, assertActionOwned }) {
      assert.equal(forceAuthorization, HARD_RESTART_AUTHORIZATION);
      await assertActionOwned();
      await beforeTerminate();
      calls.push("force-shutdown");
      return { ok: true, method: "fixture-force" };
    },
    async launch() {
      launches += 1;
      calls.push(`launch-${launches}`);
      return { ok: true, identity: { pid: 200 + launches } };
    },
    async awaitReady() {
      calls.push("await-ready");
      if (launches <= startupFailures) return { ok: false, error: `startup failure ${launches}` };
      return {
        ok: true,
        identity: { pid: 200 + launches, startTime: "2026-09-14T20:00:10.000Z" },
        observedAt: "2026-09-14T20:00:10.000Z",
      };
    },
    async verifyScheduler({ whenWorkDue }) {
      calls.push("verify-scheduler");
      if (!whenWorkDue) return { ok: true, status: "ready-no-work-due", progressObserved: false };
      return { ok: true, status: "resumed", dispatchSequence: 42 };
    },
  };
}

function hourConfig(overrides = {}) {
  return validateConfig({ ...overrides, preventiveRestart: {
    targetIntervalHours: 6, hardIntervalHours: 8, ...overrides.preventiveRestart,
  } });
}

async function fixture(options = {}) {
  const directory = await temporaryDirectory();
  const clock = options.clock ?? fakeClock();
  const config = hourConfig(options.config);
  const adapters = options.adapters ?? adaptersFor();
  const statePath = join(directory, "state.json");
  const auditPath = join(directory, "audit.jsonl");
  const supervisor = createSupervisor({
    config,
    statePath,
    auditPath,
    adapters,
    clock,
  });
  return { directory, clock, config, adapters, statePath, auditPath, supervisor };
}

test("durable validated defaults enable preventive recycling", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "config.json");
  const config = await loadConfig(path);
  assert.equal("enabled" in config.preventiveRestart, false);
  assert.equal(config.preventiveRestart.targetIntervalHours, 3);
  assert.equal(config.preventiveRestart.hardIntervalHours, 4);
  assert.equal(config.appRestart.minIntervalMinutes, 60);
  assert.equal(config.preventiveRestart.quietWindowMinutes, 15);
  assert.equal(config.supervisor.enabled, true);
  assert.equal(config.supervisor.checkIntervalSeconds, 900);
  assert.equal(config.supervisor.heartbeatIntervalSeconds, 15);
  assert.equal(config.supervisor.replacementDeadlineSeconds, 300);
  assert.equal(config.stuckRunRepair.autoRepairStuckRuns, true);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(
    persisted.appRestart.forceTerminationAuthorization,
    "explicit-user-approval:upstream-style-practical-baseline",
  );
  assert.equal("allowForceTerminate" in config.appRestart, false);
  assert.equal(
    config.appRestart.forceTerminationAuthorization,
    "explicit-user-approval:upstream-style-practical-baseline",
  );
  assert.equal(config.startup.forceTerminationDeadlineSeconds, 180);
  assert.equal(
    "allowForceTerminate" in validateConfig({ appRestart: { allowForceTerminate: false } }).appRestart,
    false,
  );
  assert.throws(() => validateConfig({ preventiveRestart: { quietWindowMinutes: 1 } }), /5 to 240/);
  assert.throws(() => validateConfig({ mystery: true }), /not supported/);
});

test("CLI emits a stable result contract and creates default config durably", async () => {
  const directory = await temporaryDirectory();
  const configPath = join(directory, "config.json");
  const statePath = join(directory, "state.json");
  const inputPath = join(directory, "input.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      app: {
        running: true,
        evidence: "known",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        identity: { pid: 101 },
      },
      activity: quietActivity(1),
    }),
    "utf8",
  );
  const execution = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./reliability-supervisor.mjs", import.meta.url)),
      "--config",
      configPath,
      "--state",
      statePath,
      "--input",
      inputPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(execution.status, 0, execution.stderr);
  const line = execution.stdout.trim();
  assert.match(line, /^SUPERVISOR_RESULT=/);
  assert.equal(JSON.parse(line.slice("SUPERVISOR_RESULT=".length)).status, "not-due");
  assert.equal("enabled" in JSON.parse(await readFile(configPath, "utf8")).preventiveRestart, false);
});

test("direct CLI shares the daemon action lock and cannot override it", async () => {
  const directory = await temporaryDirectory();
  const lock = await acquireExclusiveLock(join(directory, "reliability-supervisor-action.lock"));
  try {
    const execution = spawnSync(process.execPath, [
      fileURLToPath(new URL("./reliability-supervisor.mjs", import.meta.url)),
      "--config", join(directory, "config.json"),
      "--state", join(directory, "reliability-supervisor-state.json"),
      "--input", join(directory, "absent-snapshot.json"),
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(JSON.parse(execution.stdout.trim().slice("SUPERVISOR_RESULT=".length)).status, "locked");
    assert.throws(() => parseArgs(["--lock", "alternate.lock"]), /unknown option --lock/);
  } finally {
    await lock.release();
  }
});

test("coarse evaluation does not admit stale last-moment activity evidence", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "snapshot.json");
  const clock = fakeClock();
  await writeFile(path, JSON.stringify({
    observedAt: new Date(clock.now() - 120_000).toISOString(),
    app: oldApp(),
    activity: quietActivity(),
  }));
  const snapshot = await commandAdapters(validateConfig({}), path, clock).inspect();
  assert.equal(snapshot.activity.complete, false);
  assert.match(snapshot.snapshotError, /stale/);
});

for (const interval of [60, 75, 900]) {
  test(`policy migration preserves explicitly stored cadence ${interval}`, async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      supervisor: { checkIntervalSeconds: interval },
      drain: { leaseSeconds: 120, settleSeconds: 5 },
      commands: {
        acquireAdmissionLease: { file: "obsolete-command" },
        renewAdmissionLease: null,
        releaseAdmissionLease: null,
      },
    }));
    const config = await loadConfig(path);
    assert.equal(config.supervisor.checkIntervalSeconds, interval);
    assert.equal("drain" in config, false);
    assert.equal("acquireAdmissionLease" in config.commands, false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
    assert.deepEqual(await loadConfig(path), config);
  });
}

test("legacy preventive enablement is migrated into the permanent baseline", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      preventiveRestart: {
        enabled: false,
        targetIntervalHours: 8,
        quietWindowMinutes: 20,
      },
    }),
    "utf8",
  );

  const config = await loadConfig(path);
  assert.equal("enabled" in config.preventiveRestart, false);
  assert.equal(config.preventiveRestart.targetIntervalHours, 8);
  assert.equal(config.preventiveRestart.quietWindowMinutes, 20);
  assert.equal("enabled" in JSON.parse(await readFile(path, "utf8")).preventiveRestart, false);
  assert.equal(
    determineReason(
      { app: oldApp() },
      config,
      initialState(),
      Date.parse("2026-09-16T20:00:00Z"),
    ).reason,
    "preventive-hard-deadline",
    "a legacy false flag must not disable the permanent baseline",
  );
});

test("snapshot fallbacks poll for fresh attempt-scoped shutdown, readiness, and scheduler evidence", async () => {
  const directory = await temporaryDirectory();
  const snapshotPath = join(directory, "snapshot.json");
  const config = validateConfig({
    startup: { snapshotPollIntervalSeconds: 0.01 },
  });
  const adapters = commandAdapters(config, snapshotPath);
  const attemptId = "attempt-current";
  const oldIdentity = { pid: 101, startTime: "2026-09-14T10:00:00.000Z" };
  const newIdentity = { pid: 202, startTime: "2026-09-14T20:00:01.000Z" };
  const notBefore = new Date(Date.now() - 10).toISOString();

  await writeFile(
    snapshotPath,
    JSON.stringify({
      observedAt: new Date().toISOString(),
      app: { running: true, evidence: "known", identity: oldIdentity },
      shutdownObserved: {
        attemptId: "old-attempt",
        observedAt: "2026-09-14T10:00:00.000Z",
        oldIdentity,
        exited: true,
      },
    }),
    "utf8",
  );
  setTimeout(
    () =>
      writeFile(
        snapshotPath,
        JSON.stringify({
          observedAt: new Date().toISOString(),
          app: { running: false, evidence: "known", identity: null },
          shutdownObserved: {
            attemptId,
            observedAt: new Date().toISOString(),
            oldIdentity,
            exited: true,
          },
        }),
        "utf8",
      ),
    30,
  );
  assert.equal(
    (
      await adapters.awaitShutdown({
        attemptId,
        deadlineSeconds: 1,
        notBefore,
        expectedOldIdentity: oldIdentity,
      })
    ).ok,
    true,
  );

  await writeFile(snapshotPath, JSON.stringify({ ready: { attemptId: "old-attempt" } }), "utf8");
  setTimeout(
    () =>
      writeFile(
        snapshotPath,
        JSON.stringify({
          observedAt: "2026-09-14T20:00:00.000Z",
          app: { running: true, evidence: "known", identity: oldIdentity },
          ready: {
            attemptId,
            startupAttempt: 1,
            observedAt: new Date().toISOString(),
            identity: newIdentity,
            ready: true,
          },
        }),
        "utf8",
      ),
    30,
  );
  assert.deepEqual(
    (
      await adapters.awaitReady({
        attemptId,
        startupAttempt: 1,
        deadlineSeconds: 1,
        notBefore,
        expectedOldIdentity: oldIdentity,
      })
    ).identity,
    newIdentity,
  );

  await writeFile(snapshotPath, JSON.stringify({ scheduler: { attemptId: "old-attempt" } }), "utf8");
  setTimeout(
    () =>
      writeFile(
        snapshotPath,
        JSON.stringify({
          scheduler: {
            attemptId,
            observedAt: new Date().toISOString(),
            identity: newIdentity,
            resumed: true,
          },
        }),
        "utf8",
      ),
    30,
  );
  assert.equal(
    (
      await adapters.verifyScheduler({
        attemptId,
        deadlineSeconds: 1,
        whenWorkDue: true,
        notBefore,
        expectedNewIdentity: newIdentity,
      })
    ).status,
    "resumed",
  );
});

test("snapshot fallbacks reject stale evidence and mismatched process identity", async () => {
  const directory = await temporaryDirectory();
  const snapshotPath = join(directory, "snapshot.json");
  let nowMs = Date.parse("2026-09-14T20:00:00.000Z");
  const adapters = commandAdapters(
    validateConfig({ startup: { snapshotPollIntervalSeconds: 0.01 } }),
    snapshotPath,
    {
      now: () => nowMs,
      sleep: async (delay) => {
        nowMs += delay;
      },
    },
  );
  const oldIdentity = { pid: 101, startTime: "2026-09-14T10:00:00.000Z" };
  const newIdentity = { pid: 202, startTime: "2026-09-14T20:00:01.000Z" };
  await writeFile(
    snapshotPath,
    JSON.stringify({
      observedAt: "2026-09-14T20:00:00.000Z",
      app: { running: true, evidence: "known", identity: oldIdentity },
      shutdownObserved: {
        attemptId: "attempt-current",
        observedAt: "2026-09-14T19:00:00.000Z",
        oldIdentity,
        exited: true,
      },
      ready: {
        attemptId: "attempt-current",
        startupAttempt: 1,
        observedAt: "2026-09-14T20:00:01.000Z",
        identity: oldIdentity,
        ready: true,
      },
      scheduler: {
        attemptId: "attempt-current",
        observedAt: "2026-09-14T20:00:02.000Z",
        identity: oldIdentity,
        resumed: true,
      },
    }),
    "utf8",
  );
  const shutdown = await adapters.awaitShutdown({
    attemptId: "attempt-current",
    deadlineSeconds: 0.03,
    notBefore: "2026-09-14T20:00:00.000Z",
    expectedOldIdentity: oldIdentity,
  });
  assert.equal(shutdown.ok, false);
  assert.match(shutdown.error, /old process has not exited/);

  const ready = await adapters.awaitReady({
    attemptId: "attempt-current",
    startupAttempt: 1,
    deadlineSeconds: 0.03,
    notBefore: "2026-09-14T20:00:00.000Z",
    expectedOldIdentity: oldIdentity,
  });
  assert.equal(ready.ok, false);
  assert.match(ready.error, /old process identity/);

  const scheduler = await adapters.verifyScheduler({
    attemptId: "attempt-current",
    deadlineSeconds: 0.03,
    whenWorkDue: true,
    notBefore: "2026-09-14T20:00:00.000Z",
    expectedNewIdentity: newIdentity,
  });
  assert.equal(scheduler.ok, false);
  assert.match(scheduler.error, /does not match the new process/);
});

for (const protection of ["active", "action-lock-lost", "hard-action-lock-lost"]) {
test(`force fallback vetoes ${protection} immediately before tree termination`, async () => {
    const directory = await temporaryDirectory();
    const snapshotPath = join(directory, "snapshot.json");
    const markerPath = join(directory, "force-ran.txt");
    let nowMs = Date.parse("2026-09-14T20:00:00.000Z");
    const oldIdentity = {
      pid: 101,
      startTime: "2026-09-14T10:00:00.000Z",
      path: "C:\\Apps\\GitHubCopilot.exe",
    };
    await writeFile(
      snapshotPath,
      JSON.stringify({
        observedAt: "2026-09-14T20:00:00.000Z",
        app: { running: true, evidence: "known", identity: oldIdentity },
        activity: {
          complete: true,
          admissionVersion: 1,
          quietObservedSince: "2026-09-14T18:00:00.000Z",
          sessions: protection === "active"
            ? [{ id: "new-work", status: "running", liveness: "live", backgroundWork: true }]
            : quietActivity().sessions,
        },
        shutdownObserved: {
          attemptId: "attempt",
          observedAt: "2026-09-14T20:00:00.000Z",
          oldIdentity,
          exited: false,
        },
      }),
      "utf8",
    );
    const emitSuccess = "console.log('SUPERVISOR_ADAPTER_RESULT='+JSON.stringify({ok:true}))";
    const adapters = commandAdapters(
      validateConfig({
        startup: { snapshotPollIntervalSeconds: 0.01 },
        commands: {
          snapshot: { file: process.execPath, args: ["-e", emitSuccess] },
          forceTerminate: {
            file: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');${emitSuccess}`,
            ],
          },
        },
      }),
      snapshotPath,
      {
        now: () => nowMs,
        sleep: async (delay) => {
          nowMs += delay;
        },
      },
    );
    const pending = (protection === "hard-action-lock-lost" ? adapters.forceShutdown : adapters.awaitShutdown)({
      attemptId: "attempt",
      deadlineSeconds: 0.02,
      notBefore: "2026-09-14T20:00:00.000Z",
      expectedOldIdentity: oldIdentity,
      forceDeadlineSeconds: 1,
      forceAuthorization: protection === "hard-action-lock-lost" ? HARD_RESTART_AUTHORIZATION :
        "explicit-user-approval:upstream-style-practical-baseline",
      assertActionOwned: async () => { throw new Error("action lock ownership was lost"); },
    });
    if (protection !== "active") {
      await assert.rejects(pending, /action lock ownership was lost/);
    } else {
      const outcome = await pending;
      assert.equal(outcome.ok, false);
      assert.match(outcome.error, /vetoed by active activity/);
    }
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
});
}

test("authorized force fallback runs only after graceful timeout and quiet revalidation", async () => {
      const directory = await temporaryDirectory();
      const snapshotPath = join(directory, "snapshot.json");
      let nowMs = Date.parse("2026-09-14T20:00:00.000Z");
      const oldIdentity = {
        pid: 101,
        startTime: "2026-09-14T10:00:00.000Z",
        path: "C:\\Apps\\GitHubCopilot.exe",
      };
      const quiet = {
        complete: true,
        admissionVersion: 1,
        quietObservedSince: "2026-09-14T18:00:00.000Z",
        sessions: [{
          id: "done",
          status: "completed",
          liveness: "dead",
          lastActivityAt: "2026-09-14T18:00:00.000Z",
        }],
      };
      await writeFile(
        snapshotPath,
        JSON.stringify({
          observedAt: "2026-09-14T20:00:00.000Z",
          app: { running: true, evidence: "known", identity: oldIdentity },
          activity: quiet,
          shutdownObserved: {
            attemptId: "attempt",
            observedAt: "2026-09-14T20:00:00.000Z",
            oldIdentity,
            exited: false,
          },
        }),
        "utf8",
      );
      const emitSuccess = "console.log('SUPERVISOR_ADAPTER_RESULT='+JSON.stringify({ok:true}))";
      const replacement = {
        observedAt: "2026-09-14T20:00:00.020Z",
        app: {
          running: true,
          evidence: "known",
          identity: {
            pid: 202,
            startTime: "2026-09-14T20:00:00.020Z",
            path: oldIdentity.path,
          },
        },
        activity: quiet,
      };
      const forceScript =
        `require('node:fs').writeFileSync(${JSON.stringify(snapshotPath)},` +
        `${JSON.stringify(JSON.stringify(replacement))});` +
        "console.log('SUPERVISOR_ADAPTER_RESULT='+JSON.stringify({ok:true,method:'verified-process-tree-force',rootPid:101,terminatedPids:[202,101]}))";
      const adapters = commandAdapters(
        validateConfig({
          startup: { snapshotPollIntervalSeconds: 0.01 },
          commands: {
            snapshot: { file: process.execPath, args: ["-e", emitSuccess] },
            forceTerminate: { file: process.execPath, args: ["-e", forceScript] },
          },
        }),
        snapshotPath,
        {
          now: () => nowMs,
          sleep: async (delay) => {
            nowMs += delay;
          },
        },
      );
      const outcome = await adapters.awaitShutdown({
        attemptId: "attempt",
        deadlineSeconds: 0.02,
        notBefore: "2026-09-14T20:00:00.000Z",
        expectedOldIdentity: oldIdentity,
        forceDeadlineSeconds: 1,
        forceAuthorization: "explicit-user-approval:upstream-style-practical-baseline",
      });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.method, "verified-process-tree-force");
      assert.deepEqual(outcome.terminatedPids, [202, 101]);
      assert.equal(
        outcome.authorization,
        "explicit-user-approval:upstream-style-practical-baseline",
      );
      assert.equal(outcome.activity.verdict, "idle");
});

test("native launch adapter reuses an existing distinct app instead of launching a duplicate", async () => {
        const directory = await temporaryDirectory();
        const snapshotPath = join(directory, "snapshot.json");
        const markerPath = join(directory, "launch-ran.txt");
        const oldIdentity = {
          pid: 101,
          startTime: "2026-09-14T10:00:00.000Z",
          path: "C:\\Apps\\github.exe",
        };
        const newIdentity = {
          pid: 202,
          startTime: "2026-09-14T20:00:00.000Z",
          path: "C:\\Apps\\github.exe",
        };
        await writeFile(
          snapshotPath,
          JSON.stringify({
            observedAt: "2026-09-14T20:00:00.000Z",
            app: { running: true, evidence: "known", identity: newIdentity },
            activity: {
              complete: true,
              admissionVersion: "stable",
              quietObservedSince: "2026-09-14T19:00:00.000Z",
              sessions: [],
            },
            scheduler: { evidence: "known", workDue: false, dispatchSequence: "{}" },
          }),
          "utf8",
        );
        const emitSuccess = "console.log('SUPERVISOR_ADAPTER_RESULT='+JSON.stringify({ok:true}))";
        const adapters = commandAdapters(
          validateConfig({
            commands: {
              snapshot: { file: process.execPath, args: ["-e", emitSuccess] },
              launch: {
                file: process.execPath,
                args: [
                  "-e",
                  `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'ran');${emitSuccess}`,
                ],
              },
            },
          }),
          snapshotPath,
          { now: () => Date.parse("2026-09-14T20:00:01.000Z"), sleep: async () => {} },
        );
        const result = await adapters.launch({
          attemptId: "attempt",
          startupAttempt: 2,
          expectedOldIdentity: oldIdentity,
        });
        assert.equal(result.alreadyRunning, true);
        assert.equal(result.identity.pid, 202);
        await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
});

for (const activityKind of ["quiet", "active", "pending", "unknown", "slow-force"]) {
test(`core reaches command actuator with ${activityKind} activity and correct preventive mode`, async () => {
          const directory = await temporaryDirectory();
          const fixtureScript = join(directory, "actuator-fixture.mjs");
          const fixtureState = join(directory, "fixture-state.json");
          const snapshotPath = join(directory, "snapshot.json");
          const statePath = join(directory, "supervisor-state.json");
          const hard = activityKind !== "quiet";
          const oldStart = new Date(Date.now() - (hard ? 8 : 7) * 60 * 60 * 1_000).toISOString();
          await writeFile(
            fixtureState,
            JSON.stringify({ phase: "old", calls: [], oldStart, activityKind }),
            "utf8",
          );
          await writeFile(
            fixtureScript,
            `
        import { readFileSync, writeFileSync } from "node:fs";
        const [command, statePath, snapshotPath] = process.argv.slice(2);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        const oldIdentity = { pid: 101, startTime: state.oldStart, path: "C:\\\\Fixture\\\\github.exe" };
        const newIdentity = { pid: 202, startTime: new Date().toISOString(), path: oldIdentity.path };
        const save = () => writeFileSync(statePath, JSON.stringify(state));
        const emit = (value) => console.log("SUPERVISOR_ADAPTER_RESULT=" + JSON.stringify(value));
        if (command === "snapshot") {
          const app = state.phase === "old"
            ? { running: true, evidence: "known", startedAt: state.oldStart, identity: oldIdentity }
            : state.phase === "new"
              ? { running: true, evidence: "known", startedAt: newIdentity.startTime, identity: newIdentity }
              : { running: false, evidence: "known", identity: null };
          writeFileSync(snapshotPath, JSON.stringify({
            observedAt: new Date().toISOString(),
            app,
            activity: {
              complete: state.activityKind !== "unknown",
              admissionVersion: "quiet",
              quietObservedSince: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              sessions: ["active", "pending", "slow-force"].includes(state.activityKind) ? [{
                id: "busy", status: "running", liveness: "live",
                liveTool: state.activityKind !== "pending", pendingHuman: state.activityKind === "pending"
              }] : []
            },
            scheduler: {
              evidence: "known",
              workDue: true,
              dueWorkflowIds: ["due"],
              latestScheduledRuns: { due: { id: "old-run", startedAt: state.oldStart } },
              dispatchSequence: JSON.stringify({ due: { id: "old-run", startedAt: state.oldStart } })
            }
          }));
          emit({ ok: true });
        } else if (command === "shutdown") {
          state.calls.push("shutdown");
          save();
          emit({ ok: true, method: "graceful-request" });
        } else if (command === "force") {
          if (state.activityKind === "slow-force") await new Promise(resolve => setTimeout(resolve, 1250));
          const intent = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
          const attempt = intent.attempts.find(a => a.id === intent.activeAttempt);
          if (!attempt.restartIntentPersisted || intent.restartCycleStartedAt !== attempt.cycleBefore.startedAt) {
            throw new Error("original cycle and intent were not persisted before force");
          }
          if (process.argv[5] !== (state.activityKind === "quiet" ? "quiet-opportunity" : "hard-deadline")) {
            throw new Error("force command restartMode token was not wired");
          }
          state.calls.push("force");
          state.phase = "stopped";
          save();
          emit({ ok: true, method: "verified-process-tree-force", rootPid: 101, terminatedPids: [101] });
        } else if (command === "launch") {
          state.calls.push("launch");
          state.phase = "new";
          save();
          emit({ ok: true, identity: newIdentity });
        } else if (command === "readiness") {
          emit({ ok: true, identity: newIdentity, observedAt: new Date().toISOString() });
        } else if (command === "scheduler") {
          emit({ ok: true, status: "resumed", progressObserved: true, workflowId: "due" });
        } else {
          process.exitCode = 2;
        }
        `,
            "utf8",
          );
          const command = (name) => ({
            file: process.execPath,
            args: [fixtureScript, name, fixtureState, snapshotPath, "{restartMode}"],
          });
          const config = hourConfig({
            startup: {
              shutdownDeadlineSeconds: 5,
              forceTerminationDeadlineSeconds: activityKind === "slow-force" ? 1 : 5,
              readinessDeadlineSeconds: 5,
              schedulerVerificationDeadlineSeconds: 5,
              retryBackoffSeconds: 0,
              attemptBudget: 1,
              snapshotPollIntervalSeconds: 1,
            },
            commands: {
              snapshot: command("snapshot"),
              requestShutdown: command("shutdown"),
              forceTerminate: command("force"),
              launch: command("launch"),
              readiness: command("readiness"),
              verifyScheduler: command("scheduler"),
            },
          });
          const clock = fakeClock(new Date().toISOString());
          const supervisor = createSupervisor({
            config,
            statePath,
            adapters: commandAdapters(config, snapshotPath, clock),
            clock,
          });
          const outcome = await supervisor.run();
          assert.equal(outcome.status, "restarted");
          assert.equal(outcome.attempt.shutdown.completion.method, "verified-process-tree-force");
          assert.deepEqual(JSON.parse(await readFile(fixtureState, "utf8")).calls,
            hard ? ["force", "launch"] : ["shutdown", "force", "launch"]);
          assert.equal(outcome.attempt.restartMode, hard ? "hard-deadline" : "quiet-opportunity");
          assert.equal(outcome.attempt.activityOverridden, hard);
});
}

test("native force budget is bounded and preserves an explicitly configured value", () => {
  assert.equal(validateConfig({}).startup.forceTerminationDeadlineSeconds, 180);
  assert.equal(validateConfig({ startup: { forceTerminationDeadlineSeconds: 60 } }).startup.forceTerminationDeadlineSeconds, 60);
  assert.equal(validateConfig({ startup: { forceTerminationDeadlineSeconds: 300 } }).startup.forceTerminationDeadlineSeconds, 300);
  assert.throws(() => validateConfig({ startup: { forceTerminationDeadlineSeconds: 301 } }), /forceTerminationDeadlineSeconds/);
});

test("a command timeout reports unknown outcome instead of claiming no termination occurred", async () => {
  await assert.rejects(
    runCommand({ file: process.execPath, args: ["-e", "setTimeout(() => {}, 100)"] }, {}, { timeoutSeconds: 0.01 }),
    /outcome unknown; helper PID \d+ was not terminated/,
  );
});

test("activity is three-valued and human, tool, background, startup, and unknown are never idle", () => {
  const base = {
    id: "run",
    status: "completed",
    liveness: "dead",
    lastActivityAt: "2026-09-14T18:00:00.000Z",
  };
  for (const flag of ["pendingHuman", "liveTool", "backgroundWork", "startup"]) {
    assert.equal(classifyActivity({ ...base, [flag]: true }).verdict, "active", flag);
  }
  assert.equal(classifyActivity({ ...base, liveness: "unknown" }).verdict, "unknown");
  assert.equal(classifyActivity({ ...base, lastActivityAt: null }).verdict, "unknown");
  assert.equal(classifyActivity(base, { nowMs: Date.parse("2026-09-14T20:00:00Z") }).verdict, "idle");
});

test("only safely disposed confirmed zero-event runs are excluded", () => {
  const config = validateConfig({});
  const activity = assessActivity(
    {
      complete: true,
      quietObservedSince: "2026-09-14T18:00:00.000Z",
      sessions: [
        {
          id: "wedged",
          confirmedWedged: true,
          safelyDisposed: true,
          eventCount: 0,
          liveness: "dead",
          status: "running",
        },
      ],
    },
    config,
    Date.parse("2026-09-14T20:00:00Z"),
  );
  assert.equal(activity.verdict, "idle");
  assert.deepEqual(activity.exclusions[0].reasons, ["confirmed-wedged-safely-disposed-zero-event"]);
  assert.equal(
    classifyActivity({
      id: "unsafe",
      confirmedWedged: true,
      safelyDisposed: false,
      eventCount: 0,
      liveness: "live",
    }).verdict,
    "active",
  );
  assert.equal(
    assessActivity({ sessions: [] }, config, Date.parse("2026-09-14T20:00:00Z")).verdict,
    "unknown",
    "an incomplete empty snapshot is not proof of idleness",
  );
});

test("zero sessions require a continuously observed quiet window", () => {
  const config = validateConfig({});
  const now = Date.parse("2026-09-14T20:00:00.000Z");
  const freshEmpty = assessActivity(
    {
      complete: true,
      admissionVersion: "empty",
      quietObservedSince: "2026-09-14T19:59:00.000Z",
      sessions: [],
    },
    config,
    now,
  );
  assert.equal(freshEmpty.verdict, "active");
  assert.deepEqual(freshEmpty.reasons, ["continuous-quiet-window-not-reached"]);
  const sustainedEmpty = assessActivity(
    {
      complete: true,
      admissionVersion: "empty",
      quietObservedSince: "2026-09-14T19:40:00.000Z",
      sessions: [],
    },
    config,
    now,
  );
  assert.equal(sustainedEmpty.verdict, "idle");
});

test("corroborated terminal workflow evidence is excluded and retained", () => {
  const config = validateConfig({});
  const activity = assessActivity(
    {
      complete: true,
      admissionVersion: "terminal",
      quietObservedSince: "2026-09-14T18:00:00.000Z",
      sessions: [{
        id: "stale-run",
        executionTerminal: true,
        evidence: { events: { terminalType: "session.shutdown" } },
      }],
    },
    config,
    Date.parse("2026-09-14T20:00:00.000Z"),
  );
  assert.equal(activity.verdict, "idle");
  assert.equal(activity.exclusions[0].id, "stale-run");
  assert.equal(activity.exclusions[0].evidence.events.terminalType, "session.shutdown");
});

test("pending user interaction postpones without requesting shutdown", async () => {
  const adapters = adaptersFor({
    underDrain: {
      activity: {
        complete: true,
        admissionVersion: 1,
        sessions: [{ id: "approval", pendingHuman: true, status: "running", liveness: "live" }],
      },
    },
  });
  const { supervisor } = await fixture({
    config: {},
    adapters,
  });
  const outcome = await supervisor.run();
  assert.equal(outcome.status, "postponed");
  assert.equal(outcome.activity.verdict, "active");
  assert.equal(adapters.calls.includes("request-shutdown"), false);
});

test("unknown activity postpones rather than becoming idle", async () => {
  const adapters = adaptersFor({
    underDrain: {
      activity: {
        complete: true,
        admissionVersion: 1,
        sessions: [{ id: "silent", status: "running", liveness: "unknown" }],
      },
    },
  });

  const { supervisor } = await fixture({
    config: {},
    adapters,
  });
  const outcome = await supervisor.run();
  assert.equal(outcome.status, "postponed");
  assert.equal(outcome.activity.verdict, "unknown");
});

test("durable attempt policy records explicit user approval for the force baseline", async () => {
    const { supervisor } = await fixture();
    const outcome = await supervisor.run();
    assert.equal(outcome.status, "restarted");
    assert.equal(outcome.attempt.policy.forceTerminationAllowed, true);
    assert.equal(
      outcome.attempt.policy.forceTerminationAuthorization,
      "explicit-user-approval:upstream-style-practical-baseline",
    );
});

test("relaunch failure exhausts the bounded startup budget", async () => {
  const adapters = adaptersFor();
  adapters.launch = async () => {
    throw new Error("fixture launch failed");
  };
  const { supervisor } = await fixture({
    config: { startup: { attemptBudget: 2, retryBackoffSeconds: 0 } },
    adapters,
  });
  const outcome = await supervisor.run();
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /startup attempt budget exhausted/);
  assert.equal(outcome.attempt.startup.length, 2);
  assert.equal((await supervisor.run({ app: oldApp() })).status, "cooldown");
});

test("scheduler verification distinguishes readiness when no work is due", async () => {
  const adapters = adaptersFor({
    initial: { scheduler: { workDue: false } },
  });
  const { supervisor } = await fixture({ adapters });
  const outcome = await supervisor.run();
  assert.equal(outcome.status, "restarted");
  assert.equal(outcome.attempt.schedulerVerification.status, "ready-no-work-due");
  assert.equal(outcome.attempt.schedulerVerification.progressObserved, false);
});

test("scheduler verification uses the successful launch boundary, not later readiness time", async () => {
    const adapters = adaptersFor();
    let verification = null;
    const originalVerify = adapters.verifyScheduler;
    adapters.verifyScheduler = async (options) => {
      verification = options;
      return originalVerify(options);
    };
    const { supervisor } = await fixture({ adapters });
    const outcome = await supervisor.run();
    assert.equal(outcome.status, "restarted");
    assert.equal(verification.notBefore, "2026-09-14T20:00:00.000Z");
    assert.notEqual(verification.notBefore, outcome.attempt.readiness.observedAt);
});

test("new work racing the quiet check aborts under the action lock", async () => {
  const adapters = adaptersFor({
    underDrain: { activity: quietActivity(7) },
    preShutdown: { activity: quietActivity(8) },
  });
  const { supervisor } = await fixture({
    config: {},
    adapters,
  });
  const outcome = await supervisor.run();
  assert.equal(outcome.status, "postponed");
  assert.equal(outcome.blockedBy, "admission-version-changed");
  assert.equal(adapters.calls.includes("request-shutdown"), false);
});

for (const app of [
  { ...oldApp(), startedAt: "2026-09-14T19:00:00Z" },
  { running: false },
  { ...oldApp(), intentionalClosure: true },
]) {
  test(`legacy failure inputs cannot restart or launch: ${JSON.stringify(app)}`, async () => {
    const adapters = adaptersFor({ initial: { app } });
    const { supervisor } = await fixture({ adapters });
    const outcome = await supervisor.run({
      parkedScheduler: { confirmed: true },
      hungAliveRun: { confirmed: true },
      wedgedRuns: [{ id: "run-408", confirmed: true, recoveryRequired: true }],
    });
    assert.equal(outcome.status, "not-due");
    assert.equal(adapters.calls.includes("request-shutdown"), false);
    assert.equal(adapters.launches, 0);
  });
}

test("intentional closure is respected and missed windows create only one due opportunity", () => {
  const config = validateConfig({});
  const state = initialState();
  assert.equal(
    determineReason({ app: { ...oldApp(), intentionalClosure: true } }, config, state).blockedBy,
    "intentional-closure",
  );
  const due = determineReason({ app: oldApp() }, config, state, Date.parse("2026-09-16T20:00:00Z"));
  assert.equal(due.due, true);
  assert.equal(due.reason, "preventive-hard-deadline");
  assert.equal("missedCount" in due, false);
});

test("without an established cycle, actual app start bootstraps preventive age", () => {
  const config = validateConfig({});
  const now = Date.parse("2026-09-14T20:00:00Z");
  const reason = determineReason(
    {
      app: {
        running: true,
        startedAt: "2026-09-14T19:55:00Z",
        identity: { pid: 999 },
      },
    },
    config,
    initialState(),
    now,
  );
  assert.equal(reason.due, false);
  assert.equal(reason.blockedBy, "target-age-not-reached");
});

test("concurrent expired-lock reclamation elects exactly one owner", async () => {
  const directory = await temporaryDirectory();
  const lockPath = join(directory, "expired.lock");
  await writeFile(
    lockPath,
    JSON.stringify({
      owner: "crashed-owner",
      generation: "crashed-generation",
      acquiredAt: "2026-09-14T18:00:00.000Z",
      expiresAt: "2026-09-14T18:01:00.000Z",
    }),
    "utf8",
  );
  const now = () => Date.parse("2026-09-14T20:00:00.000Z");
  const contenders = await Promise.allSettled([
    acquireExclusiveLock(lockPath, { owner: "contender-a", now, leaseSeconds: 120 }),
    acquireExclusiveLock(lockPath, { owner: "contender-b", now, leaseSeconds: 120 }),
  ]);
  const winners = contenders.filter((entry) => entry.status === "fulfilled");
  const losers = contenders.filter((entry) => entry.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, "LOCKED");
  const onDisk = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(onDisk.owner, winners[0].value.owner);
  await winners[0].value.release();
});

test("orphaned reclamation claim expires and a later contender recovers the primary lock", async () => {
  const directory = await temporaryDirectory();
  const lockPath = join(directory, "orphaned-claim.lock");
  const expiredPrimary = `${JSON.stringify({
    owner: "crashed-primary",
    generation: "crashed-primary-generation",
    acquiredAt: "2026-09-14T18:00:00.000Z",
    expiresAt: "2026-09-14T18:01:00.000Z",
  })}\n`;
  await writeFile(lockPath, expiredPrimary, "utf8");
  const claimPath = reclamationClaimPath(lockPath, expiredPrimary);
  await writeFile(
    claimPath,
    `${JSON.stringify({
      owner: "crashed-reclaimer",
      generation: "crashed-claim-generation",
      observedOwner: "crashed-primary",
      observedGeneration: "crashed-primary-generation",
      acquiredAt: "2026-09-14T18:02:00.000Z",
      expiresAt: "2026-09-14T18:02:05.000Z",
    })}\n`,
    "utf8",
  );

  const recovered = await acquireExclusiveLock(lockPath, {
    owner: "later-contender",
    now: () => Date.parse("2026-09-14T20:00:00.000Z"),
    leaseSeconds: 120,
  });
  const current = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(current.owner, "later-contender");
  assert.equal(await readFile(claimPath, "utf8").catch((error) => error.code), "ENOENT");
  await recovered.release();
});

test("ownership loss is propagated and prevents the critical supervisor action", async () => {
  const directory = await temporaryDirectory();
  const lockPath = join(directory, "ownership.lock");
  const lock = await acquireExclusiveLock(lockPath, {
    owner: "original-owner",
    leaseSeconds: 120,
  });
  const foreign = {
    owner: "foreign-owner",
    generation: "foreign-generation",
    acquiredAt: "2026-09-14T20:00:00.000Z",
    expiresAt: "2026-09-14T21:00:00.000Z",
  };
  await writeFile(lockPath, JSON.stringify(foreign), "utf8");
  await assert.rejects(lock.renew(), /ownership was lost/);
  await assert.rejects(lock.assertOwned(), /ownership was lost/);
  await lock.release();
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), foreign);

  const statePath = join(directory, "state.json");
  const actionLockPath = join(directory, "action.lock");
  let shutdownRequested = false;
  const adapters = adaptersFor();
  const originalInspect = adapters.inspect;
  adapters.inspect = async (...args) => {
    const value = await originalInspect(...args);
    if (adapters.calls.filter((call) => call.startsWith("inspect-")).length === 1) {
      await writeFile(
        actionLockPath,
        JSON.stringify({
          owner: "stolen",
          generation: "stolen-generation",
          acquiredAt: "2026-09-14T20:00:00.000Z",
          expiresAt: "2026-09-14T21:00:00.000Z",
        }),
        "utf8",
      );
    }
    return value;
  };
  adapters.requestShutdown = async () => {
    shutdownRequested = true;
    return { ok: true };
  };
  const supervisor = createSupervisor({
    config: validateConfig({}),
    statePath,
    lockPath: actionLockPath,
    adapters,
    clock: fakeClock(),
  });
  await assert.rejects(supervisor.run(), /ownership was lost/);
  assert.equal(shutdownRequested, false);
});

test("exclusive lock closes cooldown races and failure shares preventive cooldown", async () => {
  let releaseInspection;
  const hold = new Promise((resolve) => {
    releaseInspection = resolve;
  });
  const directory = await temporaryDirectory();
  const clock = fakeClock();
  const config = validateConfig({});
  const statePath = join(directory, "state.json");
  const firstAdapters = adaptersFor({ holdInitial: hold });
  const first = createSupervisor({
    config,
    statePath,
    adapters: firstAdapters,
    clock,
  });
  const second = createSupervisor({
    config,
    statePath,
    adapters: adaptersFor(),
    clock,
  });

  const firstRun = first.run();
  let firstOwnsLock = false;
  for (let attempt = 0; attempt < 100 && !firstOwnsLock; attempt += 1) {
    firstOwnsLock = await readFile(join(directory, "reliability-supervisor-action.lock"), "utf8")
      .then(() => true)
      .catch(() => false);
    if (!firstOwnsLock) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(firstOwnsLock, true, "first supervisor never acquired the lock");
  const concurrent = await second.run();
  assert.equal(concurrent.status, "locked");
  releaseInspection();
  assert.equal((await firstRun).status, "restarted");

  const recovery = await second.run({ parkedScheduler: { confirmed: true } });
  assert.equal(recovery.status, "cooldown");
  assert.ok(cooldownStatus(await loadState(statePath), config, clock.now()).remainingMs > 0);
  assert.equal((await loadState(statePath)).attempts.length, 1);
});

test("supervisor crash is recovered without duplicate action and preserves cooldown", async () => {
  const directory = await temporaryDirectory();
  const statePath = join(directory, "state.json");
  const oldAttempt = {
    id: "crashed",
    attemptedAt: "2026-09-14T19:30:00.000Z",
    completedAt: null,
    phase: "shutdown-requested",
    outcome: "in-progress",
    restartIntentPersisted: true,
    reason: "preventive",
    trigger: "app-age",
    lease: { token: "obsolete-ignored", expiresAt: "2099-01-01T00:00:00.000Z" },
  };
  await writeFile(
    statePath,
    JSON.stringify({ ...initialState(), activeAttempt: "crashed", attempts: [oldAttempt] }),
    "utf8",
  );
  await writeFile(
    join(directory, "reliability-supervisor-action.lock"),
    JSON.stringify({
      owner: "crashed-supervisor",
      generation: "crashed-generation",
      acquiredAt: "2026-09-14T19:00:00.000Z",
      expiresAt: "2026-09-14T19:02:00.000Z",
    }),
    "utf8",
  );
  const clock = fakeClock();
  const adapters = adaptersFor();
  const supervisor = createSupervisor({
    config: validateConfig({}),
    statePath,
    adapters,
    clock,
  });
  const outcome = await supervisor.run({ parkedScheduler: { confirmed: true } });
  assert.equal(outcome.status, "cooldown");
  assert.equal(adapters.calls.includes("request-shutdown"), false);
  const state = await loadState(statePath);
  assert.equal(state.attempts[0].outcome, "aborted-supervisor-crash");
  assert.equal(state.activeAttempt, null);
});

test("core contains no process termination actuator", () => {
  assert.doesNotMatch(CORE_SOURCE, /\bchild\.kill\s*\(/);
  assert.doesNotMatch(CORE_SOURCE, /\btaskkill\b|\bStop-Process\b|\bTerminateProcess\b/i);
});

test("startup failure is bounded by the configured attempt budget", async () => {
  const adapters = adaptersFor({ startupFailures: 9 });
  const { supervisor } = await fixture({
    config: {
      startup: { attemptBudget: 3, retryBackoffSeconds: 1 },
    },
    adapters,
  });
  const outcome = await supervisor.run();
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /attempt budget exhausted/);
  assert.equal(adapters.launches, 3);
  assert.equal(outcome.attempt.startup.filter((entry) => entry.error).length, 3);
});

test("attempt is persisted before shutdown action", async () => {
  const directory = await temporaryDirectory();
  const statePath = join(directory, "state.json");
  const clock = fakeClock();
  let observed;
  const adapters = adaptersFor();
  const original = adapters.requestShutdown;
  adapters.requestShutdown = async (...args) => {
    await args[0].beforeTerminate();
    observed = await loadState(statePath);
    return original(...args);
  };
  const supervisor = createSupervisor({
    config: hourConfig(),
    statePath,
    adapters,
    clock,
  });
  assert.equal((await supervisor.run()).status, "restarted");
  assert.equal(observed.attempts[0].restartIntentPersisted, true);
  assert.equal(observed.attempts[0].phase, "shutdown-requested");
  assert.equal(observed.activeAttempt, observed.attempts[0].id);
});

test("audit record has bounded evidence and required recovery fields", async () => {
  const huge = "x".repeat(DEFAULT_CONFIG.evidence.maxStringLength + 500);
  const activityWithExclusion = {
    activity: {
      complete: true,
      admissionVersion: 1,
      quietObservedSince: "2026-09-14T18:00:00.000Z",
      sessions: [
        quietActivity(1).sessions[0],
        {
          id: "disposed-zero-event",
          confirmedWedged: true,
          safelyDisposed: true,
          eventCount: 0,
          liveness: "dead",
          status: "running",
        },
      ],
    },
  };
  const { supervisor, auditPath } = await fixture({
    config: {},
    adapters: adaptersFor({
      underDrain: activityWithExclusion,
      preShutdown: activityWithExclusion,
    }),
  });
  const outcome = await supervisor.run({
    evidence: { schedulerLogTail: [huge] },
    wedgedRuns: [
      {
        id: "disposed",
        confirmed: true,
        recoveryRequired: false,
      },
    ],
  });
  assert.equal(outcome.status, "restarted");
  const audit = JSON.parse((await readFile(auditPath, "utf8")).trim());
  for (const field of [
    "id",
    "attemptedAt",
    "completedAt",
    "reason",
    "policy",
    "activity",
    "exclusions",
    "oldIdentity",
    "newIdentity",
    "shutdown",
    "startup",
    "readiness",
    "schedulerVerification",
    "evidence",
    "outcome",
  ]) {
    assert.ok(field in audit, field);
  }
  assert.equal(audit.reason, "preventive-quiet-opportunity");
  assert.equal(audit.outcome, "succeeded");
  assert.equal(audit.exclusions[0].id, "disposed-zero-event");
  assert.ok(audit.evidence.schedulerLogTail[0].length <= DEFAULT_CONFIG.evidence.maxStringLength);
  assert.equal(audit.policy.preventiveBaseline, true);
  assert.equal(audit.policy.forceTerminationAllowed, true);
  assert.equal(
    audit.policy.forceTerminationAuthorization,
    "explicit-user-approval:upstream-style-practical-baseline",
  );
  assert.equal(audit.oldIdentity.pid, 101);
  assert.equal(audit.newIdentity.pid, 201);
  assert.equal(audit.readiness.ok, true);
  assert.equal(audit.schedulerVerification.status, "resumed");
  assert.equal(ACTIVITY_SHAPE_IS_VALID(audit.activity), true);
});

function ACTIVITY_SHAPE_IS_VALID(activity) {
  return (
    Array.isArray(activity) &&
    activity.length === 2 &&
    activity.every(
      (snapshot) =>
        ["idle", "active", "unknown"].includes(snapshot.verdict) &&
        snapshot.items.every((item) => ["idle", "active", "unknown", "excluded"].includes(item.verdict)),
    )
  );
}

test("10m/60m proof override retains cooldown until the exact hard boundary", async () => {
  const config = validateConfig({ preventiveRestart: { targetIntervalHours: 1 / 6, hardIntervalHours: 1 } });
  const epoch = oldApp().startedAt;
  const f = await fixture({ config, clock: fakeClock("2026-09-14T13:10:00Z") });
  await writeFile(f.statePath, JSON.stringify({
    ...initialState(), restartCycleStartedAt: epoch,
    attempts: [{ attemptedAt: "2026-09-14T12:55:00Z", restartIntentAt: epoch,
      restartIntentPersisted: true, outcome: "failed" }],
  }));
  const looking = await f.supervisor.run();
  assert.equal(looking.status, "cooldown");
  assert.equal(looking.cooldown.remainingMs, 50 * 60_000);
  assert.equal(looking.cycle.opportunityAt, "2026-09-14T13:10:00.000Z");
  assert.equal(looking.cycle.hardDeadlineAt, "2026-09-14T14:00:00.000Z");
  f.clock.advance(50 * 60_000 - 1);
  assert.equal((await f.supervisor.run()).cooldown.remainingMs, 1);
  assert.equal((await loadState(f.statePath)).restartCycleStartedAt, epoch);
  f.clock.advance(1);
  const hard = await f.supervisor.run();
  assert.equal(hard.status, "restarted");
  assert.equal(hard.attempt.restartMode, "hard-deadline");
  assert.equal(hard.attempt.cycleResetAt, "2026-09-14T20:00:10.000Z");
  assert.equal(f.adapters.calls.includes("request-shutdown"), false);
  assert.equal(f.adapters.calls.filter(call => call === "force-shutdown").length, 1);
});

test("the unchanged 15m quiet window constrains the first 10m opportunity", async () => {
  const config = validateConfig({ preventiveRestart: { targetIntervalHours: 1 / 6, hardIntervalHours: 1 } });
  const activity = {
    complete: true, admissionVersion: "quiet", quietObservedSince: oldApp().startedAt,
    sessions: [{ id: "idle", status: "completed", liveness: "dead", lastActivityAt: oldApp().startedAt }],
  };
  const adapters = adaptersFor({ initial: { activity }, underDrain: { activity } });
  const f = await fixture({ config, adapters, clock: fakeClock("2026-09-14T13:10:00Z") });
  const atM = await f.supervisor.run();
  assert.equal(atM.status, "postponed");
  assert.equal(atM.activity.verdict, "active");
  assert.equal(atM.cycle.startedAt, oldApp().startedAt);
  f.clock.advance(5 * 60_000);
  const quiet = await f.supervisor.run();
  assert.equal(quiet.status, "restarted");
  assert.equal(quiet.attempt.restartMode, "quiet-opportunity");
  assert.equal(quiet.attempt.cycleResetAt, "2026-09-14T20:00:10.000Z");
});

test("M/N validation preserves custom M and derives only a missing N", async () => {
  assert.equal(validateConfig({}).preventiveRestart.hardIntervalHours, 4);
  for (const [m, n] of [[1 / 6, 4], [0.5, 4], [6, 8], [12, 14], [168, 170]]) {
    const directory = await temporaryDirectory();
    const path = join(directory, "policy.json");
    await writeFile(path, JSON.stringify({ preventiveRestart: { targetIntervalHours: m } }));
    const config = await loadConfig(path);
    assert.equal(config.preventiveRestart.targetIntervalHours, m);
    assert.equal(config.preventiveRestart.hardIntervalHours, n);
    assert.deepEqual(await loadConfig(path), config);
  }
  assert.equal(validateConfig({ appRestart: { minIntervalMinutes: 1_440 } })
    .preventiveRestart.hardIntervalHours, 24);
  for (const hardIntervalHours of [0, 5, 6, null, "8", 171]) {
    assert.throws(() => validateConfig({ preventiveRestart: { targetIntervalHours: 6, hardIntervalHours } }), /hardIntervalHours/);
  }
  assert.throws(() => validateConfig({
    preventiveRestart: { hardIntervalHours: 8 }, appRestart: { minIntervalMinutes: 600 },
  }), /cooldown/);
});

test("confirmed-stall request bypasses M/N and coalesces a concurrent hard deadline", async () => {
  const f = await fixture({
    config: { preventiveRestart: { targetIntervalHours: 6, hardIntervalHours: 8 } },
    clock: fakeClock("2026-09-14T22:00:00Z"),
  });
  const outcome = await f.supervisor.run({
    recoveryRequest: { id: "request-465", reasons: ["confirmed-stall"], runIds: ["run-1"] },
  });
  assert.equal(outcome.status, "restarted");
  assert.equal(outcome.attempt.requestId, "request-465");
  assert.deepEqual(outcome.attempt.reasons, ["confirmed-stall", "preventive-hard-deadline"]);
  assert.equal(outcome.attempt.restartMode, "hard-deadline");
});

test("failed restart preserves the original M/N anchor while cooldown applies", async () => {
  const adapters = adaptersFor();
  adapters.forceShutdown = async ({ beforeTerminate }) => {
    await beforeTerminate();
    return { ok: false, error: "force wrapper timed out" };
  };
  const f = await fixture({ adapters, clock: fakeClock("2026-09-14T22:00:00Z") });
  const failed = await f.supervisor.run();
  assert.equal(failed.status, "failed");
  const state = await loadState(f.statePath);
  assert.equal(state.restartCycleStartedAt, oldApp().startedAt);
  assert.equal((await f.supervisor.run({ app: oldApp() })).status, "cooldown");
});

test("legacy failed pre-kill reset is restored from its recorded cycle", async () => {
  const f = await fixture({ clock: fakeClock("2026-09-14T19:30:00Z") });
  await writeFile(f.statePath, JSON.stringify({
    ...initialState(),
    restartCycleStartedAt: "2026-09-14T19:00:00.000Z",
    attempts: [{
      id: "failed-467",
      outcome: "failed",
      restartIntentPersisted: true,
      restartIntentAt: "2026-09-14T19:00:00.000Z",
      cycleResetAt: "2026-09-14T19:00:00.000Z",
      cycleBefore: { startedAt: oldApp().startedAt },
    }],
  }));
  await f.supervisor.run({ app: oldApp() });
  assert.equal((await loadState(f.statePath)).restartCycleStartedAt, oldApp().startedAt);
});

test("legacy in-progress pre-kill reset is restored before crash recovery", async () => {
  const f = await fixture({ clock: fakeClock("2026-09-14T19:30:00Z") });
  await writeFile(f.statePath, JSON.stringify({
    ...initialState(),
    activeAttempt: "crashed-467",
    restartCycleStartedAt: "2026-09-14T19:00:00.000Z",
    attempts: [{
      id: "crashed-467",
      outcome: "in-progress",
      restartIntentPersisted: true,
      restartIntentAt: "2026-09-14T19:00:00.000Z",
      cycleResetAt: "2026-09-14T19:00:00.000Z",
      cycleBefore: { startedAt: oldApp().startedAt },
    }],
  }));
  await f.supervisor.run({ app: oldApp() });
  const state = await loadState(f.statePath);
  assert.equal(state.restartCycleStartedAt, oldApp().startedAt);
  assert.equal(state.attempts[0].outcome, "aborted-supervisor-crash");
});

test("a distinct current app root start is the authoritative M/N anchor", async () => {
  const current = {
    running: true,
    evidence: "known",
    startedAt: "2026-09-17T19:37:42.889Z",
    identity: {
      pid: 40708,
      startTime: "2026-09-17T19:37:42.889Z",
      path: "C:\\Apps\\github.exe",
    },
  };
  const adapters = adaptersFor({ initial: { app: current } });
  const f = await fixture({ adapters, clock: fakeClock("2026-09-17T20:00:00Z") });
  await writeFile(f.statePath, JSON.stringify({
    ...initialState(),
    restartCycleStartedAt: "2026-09-17T18:34:45.359Z",
    lastObservedApp: { identity: oldApp().identity, startedAt: oldApp().startedAt },
  }));
  await f.supervisor.run();
  const state = await loadState(f.statePath);
  assert.equal(state.restartCycleStartedAt, current.startedAt);
});

test("a succeeded request ID is idempotently consumed without another restart", async () => {
  const f = await fixture({ clock: fakeClock("2026-09-14T22:00:00Z") });
  const request = { id: "request-once", reasons: ["confirmed-stall"] };
  assert.equal((await f.supervisor.run({ recoveryRequest: request })).status, "restarted");
  const launches = f.adapters.launches;
  const replay = await f.supervisor.run({ recoveryRequest: request });
  assert.equal(replay.status, "request-already-consumed");
  assert.equal(f.adapters.launches, launches);
});

test("an early graceful wait stops at N and force overrides newly unknown activity", async () => {
  const directory = await temporaryDirectory();
  const snapshotPath = join(directory, "snapshot.json");
  const hardAt = Date.parse("2026-09-14T21:00:00Z");
  const clock = fakeClock("2026-09-14T20:59:59.500Z");
  await writeFile(snapshotPath, JSON.stringify({
    observedAt: new Date(clock.now()).toISOString(), app: oldApp(), activity: { complete: false },
  }));
  const forcedSnapshot = {
    observedAt: new Date(hardAt).toISOString(), app: { running: false, evidence: "known" },
    activity: { complete: false },
  };
  const script = `require('node:fs').writeFileSync(${JSON.stringify(snapshotPath)},` +
    `${JSON.stringify(JSON.stringify(forcedSnapshot))});` +
    "console.log('SUPERVISOR_ADAPTER_RESULT='+JSON.stringify({ok:true}))";
  const adapters = commandAdapters(validateConfig({
    startup: { snapshotPollIntervalSeconds: 0.1 },
    commands: { forceTerminate: { file: process.execPath, args: ["-e", script] } },
  }), snapshotPath, clock);
  let promoted = false, committed = false;
  const result = await adapters.awaitShutdown({
    expectedOldIdentity: oldApp().identity, attemptId: "crossing", deadlineSeconds: 60,
    hardDeadlineAt: new Date(hardAt).toISOString(), forceDeadlineSeconds: 5,
    onHardDeadline: async () => { promoted = true; },
    beforeTerminate: async () => {
      assert.equal(promoted, true);
      assert.equal(clock.now(), hardAt);
      committed = true;
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.restartMode, "hard-deadline");
  assert.equal(result.activityOverridden, true);
  assert.equal(committed, true);
  assert.equal(clock.now(), hardAt);
});

for (const scenario of [
  { activity: "active", offset: -1 },
  { activity: "active", offset: 0 },
  { activity: "active", offset: 500 },
  { activity: "pending", offset: 0 },
  { activity: "pending", offset: 500 },
  { activity: "unknown", offset: 0 },
  { activity: "unknown", offset: 500 },
  { activity: "unknown", offset: 500, changedIdentity: true },
  { activity: "active", offset: 500, lostLock: true },
]) {
  test(`force snapshot deadline crossing ${JSON.stringify(scenario)}`, async () => {
    const directory = await temporaryDirectory();
    const statePath = join(directory, "state.json");
    const snapshotPath = join(directory, "snapshot.json");
    const clockPath = join(directory, "clock.txt");
    const markerPath = join(directory, "force.json");
    const lockPath = join(directory, "reliability-supervisor-action.lock");
    const hardAt = Date.parse("2026-09-14T21:00:00Z");
    const initialTime = hardAt - 5_500;
    await writeFile(clockPath, String(initialTime));
    const clock = {
      now: () => Number(readFileSync(clockPath, "utf8")),
      sleep: async ms => { await writeFile(clockPath, String(clock.now() + ms)); },
    };
    await writeFile(snapshotPath, JSON.stringify({
      observedAt: new Date(initialTime).toISOString(), app: oldApp(), activity: quietActivity(),
    }));
    const activity = scenario.activity === "unknown" ? { complete: false } : {
      complete: true, sessions: [{
        id: "new-work", status: "running", liveness: "live",
        liveTool: scenario.activity === "active", pendingHuman: scenario.activity === "pending",
      }],
    };
    const captureScript = `
      const fs = require('node:fs');
      if (process.argv[1] === 'force') {
        const now = ${hardAt + scenario.offset};
        fs.writeFileSync(${JSON.stringify(clockPath)}, String(now));
        const snapshot = JSON.parse(fs.readFileSync(${JSON.stringify(snapshotPath)}, 'utf8'));
        snapshot.observedAt = new Date(now).toISOString();
        snapshot.activity = ${JSON.stringify(activity)};
        if (${!!scenario.changedIdentity}) snapshot.app.identity.pid = 999;
        fs.writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify(snapshot));
        if (${!!scenario.lostLock}) fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({
          owner: 'foreign-fixture', generation: 'foreign-generation', expiresAt: '2099-01-01T00:00:00Z'
        }));
      }
      console.log('SUPERVISOR_ADAPTER_RESULT='+JSON.stringify({ok:true}));
    `;
    const forceScript = `
      const fs = require('node:fs');
      const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
      fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
        restartMode: process.argv[1], authorization: process.argv[2],
        cycle: state.restartCycleStartedAt, attempt: state.attempts.at(-1)
      }));
      const snapshot = JSON.parse(fs.readFileSync(${JSON.stringify(snapshotPath)}, 'utf8'));
      snapshot.app = { running: false, evidence: 'known' };
      fs.writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify(snapshot));
      console.log('SUPERVISOR_ADAPTER_RESULT='+JSON.stringify({ok:true,method:'fixture-force'}));
    `;
    const config = hourConfig({
      startup: { shutdownDeadlineSeconds: 5, snapshotPollIntervalSeconds: 1 },
      commands: {
        snapshot: { file: process.execPath, args: ["-e", captureScript, "{recheck}"] },
        forceTerminate: { file: process.execPath, args: ["-e", forceScript, "{restartMode}", "{authorization}"] },
      },
    });
    const adapters = adaptersFor();
    adapters.awaitShutdown = commandAdapters(config, snapshotPath, clock).awaitShutdown;
    const supervisor = createSupervisor({ config, statePath, adapters, clock });
    if (scenario.lostLock) {
      await assert.rejects(supervisor.run(), /ownership was lost/);
      await assert.rejects(readFile(markerPath), /ENOENT/);
    } else {
      const outcome = await supervisor.run();
      const shouldForce = scenario.offset >= 0 && !scenario.changedIdentity;
      assert.equal(outcome.status, shouldForce ? "restarted" : "failed", outcome.error);
      if (shouldForce) {
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        assert.equal(marker.restartMode, "hard-deadline");
        assert.equal(marker.authorization, HARD_RESTART_AUTHORIZATION);
        assert.equal(marker.attempt.restartMode, "hard-deadline");
        assert.equal(marker.attempt.trigger, "hard-deadline");
        assert.equal(marker.attempt.activityOverridden, true);
        assert.equal(marker.attempt.cycleBefore.hardDeadlineAt, new Date(hardAt).toISOString());
        assert.equal(marker.cycle, oldApp().startedAt);
        assert.equal(marker.attempt.cycleResetAt, null);
        assert.equal(outcome.attempt.shutdown.completion.restartMode, "hard-deadline");
      } else {
        assert.match(outcome.error, scenario.changedIdentity ? /identity/ : /vetoed by active/);
        await assert.rejects(readFile(markerPath), /ENOENT/);
      }
    }
    const state = await loadState(statePath);
    assert.equal(
      state.restartCycleStartedAt,
      scenario.offset >= 0 && !scenario.changedIdentity && !scenario.lostLock
        ? "2026-09-14T20:00:10.000Z"
        : oldApp().startedAt,
    );
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].restartIntentAt, new Date(initialTime).toISOString());
  });
}

test("promotion during an early graceful transaction does not reset its cycle twice", async () => {
  const f = await fixture();
  f.adapters.awaitShutdown = async ({ hardDeadlineAt, onHardDeadline, beforeTerminate }) => {
    f.clock.advance(Date.parse(hardDeadlineAt) - f.clock.now());
    await onHardDeadline();
    await beforeTerminate({ activity: { verdict: "unknown" } });
    return { ok: true, restartMode: "hard-deadline" };
  };
  const outcome = await f.supervisor.run();
  assert.equal(outcome.status, "restarted");
  assert.equal(outcome.attempt.restartMode, "hard-deadline");
  assert.equal(outcome.attempt.cycleResetAt, "2026-09-14T20:00:10.000Z");
  assert.equal(outcome.cycle.startedAt, outcome.attempt.cycleResetAt);
});

test("before M and busy M..N preserve the cycle across supervisor replacements", async () => {
  const busy = { complete: true, sessions: [{ id: "tool", liveTool: true }] };
  const adapters = adaptersFor({ initial: { activity: busy }, underDrain: { activity: busy } });
  const f = await fixture({ clock: fakeClock("2026-09-14T18:00:00Z"), adapters });
  const first = await f.supervisor.run();
  assert.equal(first.status, "not-due");
  assert.equal(first.cycle.startedAt, oldApp().startedAt);
  f.clock.advance(2 * 3_600_000);
  const replacement = createSupervisor({
    config: f.config, statePath: f.statePath, adapters, clock: f.clock,
  });
  assert.equal((await replacement.run()).status, "postponed");
  assert.equal((await replacement.run()).status, "postponed");
  assert.equal((await loadState(f.statePath)).restartCycleStartedAt, oldApp().startedAt);
  assert.equal(adapters.calls.includes("request-shutdown"), false);
  f.clock.advance(3_600_000);
  const forced = await replacement.run();
  assert.equal(forced.status, "restarted");
  assert.equal(forced.attempt.trigger, "hard-deadline");
  assert.equal(forced.attempt.activityOverridden, true);
  assert.equal(forced.cycle.startedAt, "2026-09-14T20:00:10.000Z");
  assert.equal(adapters.calls.filter(c => c === "force-shutdown").length, 1);
  assert.equal(adapters.calls.includes("request-shutdown"), false);
});

for (const app of [
  { ...oldApp(), evidence: "unknown" },
  { ...oldApp(), identity: { ...oldApp().identity, pid: 999 } },
  { ...oldApp(), identity: { ...oldApp().identity, path: "C:\\Apps\\foreign.exe" } },
  { ...oldApp(), identity: { pid: 101 } },
  { running: false, evidence: "known" },
  { ...oldApp(), intentionalClosure: true },
]) {
  test(`hard deadline protects unknown/changed/closed target ${JSON.stringify(app)}`, async () => {
    const adapters = adaptersFor({ preShutdown: { app, activity: { complete: false } } });
    const f = await fixture({ clock: fakeClock("2026-09-14T21:00:00Z"), adapters });
    const outcome = await f.supervisor.run();
    assert.equal(outcome.status, "postponed");
    assert.equal(outcome.blockedBy, "target-identity-unknown-or-changed");
    assert.equal(adapters.calls.includes("force-shutdown"), false);
    assert.equal((await loadState(f.statePath)).restartCycleStartedAt, oldApp().startedAt);
  });
}

for (const hard of [false, true]) {
  test(`failed ${hard ? "hard force" : "graceful close"} preserves the original cycle and cooldown`, async () => {
    const f = await fixture({ clock: fakeClock(hard ? "2026-09-14T21:00:00Z" : "2026-09-14T20:00:00Z") });
    const action = hard ? "forceShutdown" : "requestShutdown";
    let committed;
    f.adapters[action] = async ({ beforeTerminate }) => {
      assert.equal((await loadState(f.statePath)).restartCycleStartedAt, oldApp().startedAt);
      f.clock.advance(1234);
      await beforeTerminate();
      committed = await loadState(f.statePath);
      assert.equal(committed.restartCycleStartedAt, oldApp().startedAt);
      assert.equal(committed.attempts.at(-1).restartIntentAt, new Date(f.clock.now()).toISOString());
      f.clock.advance(5678);
      throw new Error("fixture termination failed after durable intent");
    };
    const result = await f.supervisor.run();
    assert.equal(result.status, "failed");
    assert.match(result.error, /fixture termination failed/);
    const state = await loadState(f.statePath);
    assert.equal(state.restartCycleStartedAt, committed.restartCycleStartedAt);
    assert.equal(state.lastSuccessfulRestartAt, null);
    assert.equal(f.adapters.launches, 0);
    assert.equal((await f.supervisor.run({ app: oldApp() })).status, "cooldown");
    assert.ok(cooldownStatus(state, f.config, f.clock.now()).remainingMs > 0);
    // Simulate a crash after the durable boundary, not another shutdown attempt.
    state.attempts.at(-1).outcome = "in-progress";
    state.activeAttempt = state.attempts.at(-1).id;
    await writeFile(f.statePath, JSON.stringify(state));
    const recovered = await f.supervisor.run();
    assert.equal(recovered.status, "cooldown");
    const recoveryState = await loadState(f.statePath);
    assert.equal(recoveryState.attempts.at(-1).outcome, "aborted-supervisor-crash");
    assert.equal(recoveryState.restartCycleStartedAt, committed.restartCycleStartedAt);
  });
}

test("hard deadline cannot bypass the legacy persisted cooldown", async () => {
  const f = await fixture({ clock: fakeClock("2026-09-14T21:00:00Z") });
  await writeFile(f.statePath, JSON.stringify({
    ...initialState(),
    attempts: [{ attemptedAt: "2026-09-14T20:30:00Z", restartIntentPersisted: true, outcome: "failed" }],
  }));
  assert.equal((await f.supervisor.run()).status, "cooldown");
  assert.equal(f.adapters.calls.includes("force-shutdown"), false);
});

test("concurrent hard deadlines share exactly one restart transaction", async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ clock: fakeClock("2026-09-14T21:00:00Z") });
  const inspect = f.adapters.inspect;
  f.adapters.inspect = async (...args) => {
    entered();
    await gate;
    return inspect(...args);
  };
  const first = f.supervisor.run();
  await started;
  try {
    const other = createSupervisor({ config: f.config, statePath: f.statePath,
      adapters: adaptersFor(), clock: f.clock });
    assert.equal((await other.run()).status, "locked");
  } finally {
    release();
  }
  assert.equal((await first).status, "restarted");
  assert.equal(f.adapters.calls.filter(c => c === "force-shutdown").length, 1);
});

test("cooldown only counts durable restart intents, not quiet-window postponements", () => {
  const state = initialState();
  state.attempts.push(
    {
      attemptedAt: "2026-09-14T19:55:00Z",
      restartIntentPersisted: false,
      outcome: "postponed-active",
    },
    {
      attemptedAt: "2026-09-14T18:00:00Z",
      restartIntentPersisted: true,
      outcome: "succeeded",
    },
  );
  assert.equal(
    cooldownStatus(
      state,
      validateConfig({}),
      Date.parse("2026-09-14T20:00:00Z"),
    ).allowed,
    true,
  );
});
