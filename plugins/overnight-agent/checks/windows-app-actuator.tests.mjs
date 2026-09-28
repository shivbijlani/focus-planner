import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  captureSnapshot,
  descendantProcessIds,
  forceTerminate,
  launchExact,
  requestGracefulShutdown,
  sameIdentity,
  summariseSessionEvents,
  terminateVerifiedProcessTree,
  verifySchedulerAfterRestart,
} from "./windows-app-actuator.mjs";
import { assessActivity, validateConfig, commandAdapters, HARD_RESTART_AUTHORIZATION } from "./reliability-supervisor.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "windows-app-actuator-"));
  directories.push(directory);
  return directory;
}

async function databases(
  directory,
  {
    active = false,
    pendingHuman = false,
    terminal = false,
    settledTurn = false,
    activeTurn = false,
    pendingTool = false,
    oldPendingToolBeforeResume = false,
    resumeMode = null,
    postResumeSettled = false,
    postResumePendingTool = false,
    sessionRunning = false,
    dataSessionPresent = true,
    lockPid = null,
    due = false,
    omitNextRun = false,
    resumeAfterTerminal = false,
  } = {},
) {
  const { DatabaseSync } = await import("node:sqlite");
  const databasePath = join(directory, "data.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      enabled INTEGER
      ${omitNextRun ? "" : ", next_run_at TEXT"}
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      session_id TEXT,
      status TEXT,
      trigger TEXT,
      started_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      is_running INTEGER,
      updated_at TEXT
    );
  `);
  if (omitNextRun) {
    db.prepare("INSERT INTO workflows VALUES (?, ?)").run("workflow", 1);
  } else {
    db.prepare("INSERT INTO workflows VALUES (?, ?, ?)").run(
      "workflow",
      1,
      due ? "2026-09-14T19:00:00.000Z" : "2026-09-15T19:00:00.000Z",
    );
  }
  if (active) {
    db.prepare("INSERT INTO workflow_runs VALUES (?, ?, ?, ?, ?, ?)").run(
      "run",
      "workflow",
      "session",
      "running",
      "schedule",
      "2026-09-14T19:00:00.000Z",
    );
  }
  if (dataSessionPresent) {
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
      "session",
      sessionRunning ? 1 : 0,
      "2026-09-14T19:59:00.000Z",
    );
  }
  db.close();

  const sessionStorePath = join(directory, "session-store.db");
  const store = new DatabaseSync(sessionStorePath);
  store.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      host_type TEXT,
      branch TEXT,
      summary TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  store.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "session",
    directory,
    "fixture/repo",
    "local",
    "main",
    "fixture",
    "2026-09-14T19:00:00.000Z",
    "2026-09-14T19:59:00.000Z",
  );
  store.close();
  const sessionStateDirectory = join(directory, "session-state");
  const sessionDirectory = join(sessionStateDirectory, "session");
  await mkdir(sessionDirectory, { recursive: true });
  const events = [];
  if (oldPendingToolBeforeResume) {
    events.push({
      type: "tool.execution_start",
      data: { toolCallId: "old-process-tool" },
      timestamp: "2026-09-14T07:55:46.720Z",
    });
  }
  if (resumeMode) {
    const data = resumeMode === "inactive"
      ? { alreadyInUse: false, sessionWasActive: false }
      : resumeMode === "active"
        ? { alreadyInUse: true, sessionWasActive: true }
        : {};
    events.push({
      type: "session.resume",
      data,
      timestamp: "2026-09-14T16:08:55.767Z",
    });
  }
  if (postResumeSettled || postResumePendingTool) {
    events.push({
      type: "assistant.turn_start",
      data: { turnId: "post-resume" },
      timestamp: "2026-09-14T19:58:00.000Z",
    });
    events.push({
      type: "tool.execution_start",
      data: { toolCallId: "post-resume-tool" },
      timestamp: "2026-09-14T19:58:10.000Z",
    });
    if (!postResumePendingTool) {
      events.push({
        type: "tool.execution_complete",
        data: { toolCallId: "post-resume-tool" },
        timestamp: "2026-09-14T19:58:20.000Z",
      });
      events.push({
        type: "assistant.turn_end",
        data: { turnId: "post-resume" },
        timestamp: "2026-09-14T19:59:00.000Z",
      });
    }
  }
  if (settledTurn || activeTurn || pendingTool) {
    events.push({
      type: "assistant.turn_start",
      data: { turnId: "fixture-turn" },
      timestamp: "2026-09-14T19:58:00.000Z",
    });
  }
  if (settledTurn || pendingTool) {
    events.push({
      type: "assistant.turn_end",
      data: { turnId: "fixture-turn" },
      timestamp: "2026-09-14T19:59:00.000Z",
    });
  }
  if (pendingTool) {
    events.push({
      type: "tool.execution_start",
      data: { toolCallId: "fixture-tool" },
      timestamp: "2026-09-14T19:59:10.000Z",
    });
  }
  if (pendingHuman) {
    events.push({
      type: "hook.start",
      data: { hookInvocationId: "pending", hookType: "permissionRequest" },
      timestamp: "2026-09-14T19:59:00.000Z",
    });
  }
  if (terminal) {
    events.push({
      type: "session.shutdown",
      data: { shutdownType: "routine" },
      timestamp: "2026-09-14T19:59:30.000Z",
    });
  }
  if (resumeAfterTerminal) {
    events.push({
      type: "assistant.turn_start",
      data: { turnId: "after-terminal" },
      timestamp: "2026-09-14T19:59:45.000Z",
    });
  }
  await writeFile(
    join(sessionDirectory, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  if (lockPid) {
    await writeFile(join(sessionDirectory, `inuse.${lockPid}.lock`), "", "utf8");
  }
  return { databasePath, sessionStorePath, sessionStateDirectory };
}

const oldIdentity = {
  pid: 101,
  startTime: "2026-09-14T10:00:00.000Z",
  path: "C:\\Apps\\GitHubCopilot.exe",
  mainWindowHandle: 42,
};

function eventLog(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

test("permissions_changed is configuration evidence, not a pending permission request", () => {
  const summary = summariseSessionEvents(eventLog([{
    type: "session.permissions_changed",
    data: {
      previousAllowAllPermissions: false,
      allowAllPermissions: true,
      previousAllowAllPermissionMode: "off",
      allowAllPermissionMode: "on",
    },
    timestamp: "2026-09-15T03:44:35.480Z",
  }]));
  assert.equal(summary.pendingPermissionCount, 0);
  assert.equal(summary.pendingHuman, false);
  assert.equal(summary.activeExecution, false);
});

test("genuine permission request remains pending until its matching resolution", () => {
  const request = {
    type: "hook.start",
    data: { hookInvocationId: "permission-1", hookType: "permissionRequest" },
    timestamp: "2026-09-15T03:44:35.480Z",
  };
  const changed = {
    type: "session.permissions_changed",
    data: { allowAllPermissions: true },
    timestamp: "2026-09-15T03:44:36.000Z",
  };
  const pending = summariseSessionEvents(eventLog([request, changed]));
  assert.equal(pending.pendingPermissionCount, 1);
  assert.equal(pending.pendingHuman, true);

  const resolved = summariseSessionEvents(eventLog([
    request,
    changed,
    {
      type: "hook.end",
      data: { hookInvocationId: "permission-1", hookType: "permissionRequest", success: true },
      timestamp: "2026-09-15T03:44:37.000Z",
    },
  ]));
  assert.equal(resolved.pendingPermissionCount, 0);
  assert.equal(resolved.pendingHuman, false);
});

function processIdentity(pid) {
  try {
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop;` +
        `$c=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction Stop;` +
        `[pscustomobject]@{pid=[int]$p.Id;path=[string]$c.ExecutablePath;` +
        `startTime=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function existingProcessIds(pids) {
    const candidates = pids.filter(Number.isSafeInteger);
    if (candidates.length === 0) return new Set();
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `@(
          Get-Process -Id @(${candidates.join(",")}) -ErrorAction SilentlyContinue |
            ForEach-Object { [int]$_.Id }
        ) | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set((Array.isArray(parsed) ? parsed : [parsed]).map(Number));
}

function powershellAvailable(executable) {
  try {
    execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, deadlineMs = 5_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() <= deadline) {
    if (await condition()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return false;
}

test("snapshot uses live process and database evidence and exposes pending human work", async () => {
  const directory = await fixtureDirectory();
  const paths = await databases(directory, { active: true, pendingHuman: true, due: true });
  const snapshot = await captureSnapshot({
    ...paths,
    snapshotPath: join(directory, "snapshot.json"),
    processProvider: async () => [oldIdentity],
    processTableProvider: async () => [],
    now: () => Date.parse("2026-09-14T20:00:00.000Z"),
  });
  assert.equal(snapshot.app.running, true);
  assert.equal(snapshot.activity.complete, true);
  assert.equal(snapshot.activity.sessions[0].pendingHuman, true);
  assert.equal(snapshot.scheduler.workDue, true);
});

test("terminal session event excludes stale running workflow bookkeeping with retained evidence", async () => {
    const directory = await fixtureDirectory();
    const paths = await databases(directory, { active: true, terminal: true });
    const snapshot = await captureSnapshot({
      ...paths,
      snapshotPath: join(directory, "snapshot.json"),
      processProvider: async () => [oldIdentity],
      processTableProvider: async () => [],
      now: () => Date.parse("2026-09-14T20:20:00.000Z"),
    });
    assert.equal(snapshot.activity.complete, true);
    assert.equal(snapshot.activity.sessions[0].executionTerminal, true);
    assert.equal(snapshot.activity.sessions[0].evidence.events.terminalType, "session.shutdown");
    assert.equal(snapshot.activity.sessions[0].evidence.liveness.state, "unknown");
});

for (const scenario of [
      { name: "DB running", options: { sessionRunning: true } },
      { name: "missing DB session", options: { dataSessionPresent: false } },
    ]) {
      test(`${scenario.name} prevents terminal-event exclusion`, async () => {
        const directory = await fixtureDirectory();
        const paths = await databases(directory, {
          active: true,
          terminal: true,
          ...scenario.options,
        });
        const snapshot = await captureSnapshot({
          ...paths,
          snapshotPath: join(directory, "snapshot.json"),
          processProvider: async () => [oldIdentity],
          processTableProvider: async () => [],
        });
        assert.equal(snapshot.activity.sessions[0].executionTerminal, undefined);
        assert.equal(snapshot.activity.sessions[0].liveness, "unknown");
        assert.equal(snapshot.activity.sessions[0].evidence.events.pendingHuman, false);
      });
}

test("stale workflow row without terminal event or verified dead owner remains unknown", async () => {
    const directory = await fixtureDirectory();
    const paths = await databases(directory, { active: true });
    const snapshot = await captureSnapshot({
      ...paths,
      snapshotPath: join(directory, "snapshot.json"),
      processProvider: async () => [oldIdentity],
      processTableProvider: async () => [],
      now: () => Date.parse("2026-09-14T20:00:00.000Z"),
    });
    assert.equal(snapshot.activity.sessions[0].liveness, "unknown");
    assert.equal(snapshot.activity.sessions[0].executionTerminal, undefined);
});

test("database is_running true without lock or terminal evidence remains unknown", async () => {
      const directory = await fixtureDirectory();
      const paths = await databases(directory, { sessionRunning: true });
      const snapshot = await captureSnapshot({
        ...paths,
        snapshotPath: join(directory, "snapshot.json"),
        processProvider: async () => [oldIdentity],
        processTableProvider: async () => [],
      });
      assert.equal(snapshot.activity.sessions[0].liveness, "unknown");
      assert.equal(snapshot.activity.sessions[0].source, "uncorroborated-running-session-flag");
    });

test("live lock alone proves ownership but not execution activity", async () => {
      const directory = await fixtureDirectory();
      const paths = await databases(directory, { active: true, sessionRunning: false, lockPid: 700 });
      const snapshot = await captureSnapshot({
        ...paths,
        snapshotPath: join(directory, "snapshot.json"),
        processProvider: async () => [oldIdentity],
        processTableProvider: async () => [{
          pid: 700,
          parentPid: 101,
          name: "copilot.exe",
          path: "C:\\Fixture\\copilot.exe",
          startTime: "2026-09-14T19:00:00.000Z",
        }],
      });
      assert.equal(snapshot.activity.sessions[0].liveness, "unknown");
      assert.equal(snapshot.activity.sessions[0].evidence.liveness.state, "live");
});

test("idle resident CLI with DB idle and a settled balanced turn may accumulate quiet", async () => {
        const directory = await fixtureDirectory();
        const paths = await databases(directory, {
          sessionRunning: false,
          settledTurn: true,
          lockPid: 700,
        });
        const snapshot = await captureSnapshot({
          ...paths,
          snapshotPath: join(directory, "snapshot.json"),
          processProvider: async () => [oldIdentity],
          processTableProvider: async () => [{
            pid: 700,
            parentPid: 101,
            name: "copilot.exe",
            path: "C:\\Fixture\\copilot.exe",
            startTime: "2026-09-14T19:00:00.000Z",
          }],
          now: () => Date.parse("2026-09-14T20:00:00.000Z"),
        });
        assert.equal(snapshot.activity.sessions[0].status, "completed");
        assert.equal(snapshot.activity.sessions[0].source, "settled-turn-resident-owner");
        assert.equal(snapshot.activity.sessions[0].evidence.events.settledTurn, true);
});

test("two settled-resident snapshots reach idle only after the full continuous quiet window", async () => {
          const directory = await fixtureDirectory();
          const paths = await databases(directory, {
            sessionRunning: false,
            settledTurn: true,
            lockPid: 700,
          });
          const snapshotPath = join(directory, "snapshot.json");
          const providers = {
            processProvider: async () => [oldIdentity],
            processTableProvider: async () => [{
              pid: 700,
              parentPid: 101,
              name: "copilot.exe",
              path: "C:\\Fixture\\copilot.exe",
              startTime: "2026-09-14T19:00:00.000Z",
            }],
          };
          const first = await captureSnapshot({
            ...paths,
            ...providers,
            snapshotPath,
            now: () => Date.parse("2026-09-14T20:00:00.000Z"),
          });
          assert.equal(
            assessActivity(first.activity, validateConfig({}), Date.parse("2026-09-14T20:00:00.000Z")).verdict,
            "active",
          );
          const second = await captureSnapshot({
            ...paths,
            ...providers,
            snapshotPath,
            now: () => Date.parse("2026-09-14T20:20:00.000Z"),
          });
          const assessed = assessActivity(
            second.activity,
            validateConfig({}),
            Date.parse("2026-09-14T20:20:00.000Z"),
          );
          assert.equal(second.activity.sessions[0].residentOwner, true);
          assert.equal(second.activity.quietObservedSince, "2026-09-14T20:00:00.000Z");
          assert.equal(assessed.verdict, "idle");
});

test("explicit inactive resume clears prior-process tool debt before a settled current epoch", async () => {
  const directory = await fixtureDirectory();
  const paths = await databases(directory, {
    sessionRunning: false,
    lockPid: 700,
    oldPendingToolBeforeResume: true,
    resumeMode: "inactive",
    postResumeSettled: true,
  });
  const snapshot = await captureSnapshot({
    ...paths,
    snapshotPath: join(directory, "snapshot.json"),
    processProvider: async () => [oldIdentity],
    processTableProvider: async () => [{
      pid: 700,
      parentPid: 101,
      name: "copilot.exe",
      path: "C:\\Fixture\\copilot.exe",
      startTime: "2026-09-14T16:08:50.965Z",
    }],
  });
  const session = snapshot.activity.sessions[0];
  assert.equal(session.residentOwner, true);
  assert.equal(session.evidence.events.resumeState, "inactive");
  assert.equal(session.evidence.events.pendingToolCount, 0);
  assert.equal(session.evidence.events.settledTurn, true);
});

for (const scenario of [
  { name: "active resume", resumeMode: "active", pendingTool: false },
  { name: "resume missing inactivity flags", resumeMode: "unknown", pendingTool: false },
  { name: "current-epoch pending tool", resumeMode: "inactive", pendingTool: true },
]) {
  test(`${scenario.name} cannot become settled resident idle`, async () => {
    const directory = await fixtureDirectory();
    const paths = await databases(directory, {
      sessionRunning: false,
      lockPid: 700,
      oldPendingToolBeforeResume: true,
      resumeMode: scenario.resumeMode,
      postResumeSettled: !scenario.pendingTool,
      postResumePendingTool: scenario.pendingTool,
    });
    const snapshot = await captureSnapshot({
      ...paths,
      snapshotPath: join(directory, "snapshot.json"),
      processProvider: async () => [oldIdentity],
      processTableProvider: async () => [{
        pid: 700,
        parentPid: 101,
        name: "copilot.exe",
        path: "C:\\Fixture\\copilot.exe",
        startTime: "2026-09-14T16:08:50.965Z",
      }],
    });
    const session = snapshot.activity.sessions[0];
    assert.notEqual(session.residentOwner, true);
    assert.equal(session.evidence.events.settledTurn, false);
    if (scenario.pendingTool) assert.equal(session.evidence.events.pendingToolCount, 1);
  });
}

test("DB true plus settled resident turn remains unknown", async () => {
        const directory = await fixtureDirectory();
        const paths = await databases(directory, {
          sessionRunning: true,
          settledTurn: true,
          lockPid: 700,
        });
        const snapshot = await captureSnapshot({
          ...paths,
          snapshotPath: join(directory, "snapshot.json"),
          processProvider: async () => [oldIdentity],
          processTableProvider: async () => [{
            pid: 700,
            parentPid: 101,
            name: "copilot.exe",
            path: "C:\\Fixture\\copilot.exe",
            startTime: "2026-09-14T19:00:00.000Z",
          }],
        });
        assert.equal(snapshot.activity.sessions[0].liveness, "unknown");
        assert.equal(snapshot.activity.sessions[0].source, "db-running-settled-resident-owner");
      });

for (const scenario of [
        { name: "open assistant turn", options: { activeTurn: true }, field: "turnOpen" },
        { name: "pending tool", options: { pendingTool: true }, field: "pendingToolCount" },
        { name: "pending approval", options: { pendingHuman: true }, field: "pendingHuman" },
      ]) {
        test(`${scenario.name} vetoes idle even with a resident CLI and DB idle`, async () => {
          const directory = await fixtureDirectory();
          const paths = await databases(directory, {
            sessionRunning: false,
            lockPid: 700,
            ...scenario.options,
          });
          const snapshot = await captureSnapshot({
            ...paths,
            snapshotPath: join(directory, "snapshot.json"),
            processProvider: async () => [oldIdentity],
            processTableProvider: async () => [{
              pid: 700,
              parentPid: 101,
              name: "copilot.exe",
              path: "C:\\Fixture\\copilot.exe",
              startTime: "2026-09-14T19:00:00.000Z",
            }],
          });
          assert.equal(snapshot.activity.sessions[0].status, "running");
          assert.ok(snapshot.activity.sessions[0].evidence.events[scenario.field]);
        });
}

test("a resume after terminal evidence prevents stale-row exclusion", async () => {
      const directory = await fixtureDirectory();
      const paths = await databases(directory, {
        active: true,
        terminal: true,
        resumeAfterTerminal: true,
      });
      const snapshot = await captureSnapshot({
        ...paths,
        snapshotPath: join(directory, "snapshot.json"),
        processProvider: async () => [oldIdentity],
        processTableProvider: async () => [],
      });
      assert.equal(snapshot.activity.sessions[0].executionTerminal, undefined);
      assert.equal(snapshot.activity.sessions[0].liveness, "unknown");
      assert.equal(snapshot.activity.sessions[0].evidence.events.turnOpen, true);
});

test("missing scheduler columns report unknown rather than no-work-due", async () => {
    const directory = await fixtureDirectory();
    const paths = await databases(directory, { omitNextRun: true });
    const snapshot = await captureSnapshot({
      ...paths,
      snapshotPath: join(directory, "snapshot.json"),
      processProvider: async () => [oldIdentity],
      processTableProvider: async () => [],
    });
    assert.equal(snapshot.scheduler.evidence, "unknown");
    assert.equal(snapshot.scheduler.workDue, null);
  });

test("empty activity starts and then preserves a continuous quiet observation", async () => {
    const directory = await fixtureDirectory();
    const paths = await databases(directory);
    const snapshotPath = join(directory, "snapshot.json");
    const first = await captureSnapshot({
      ...paths,
      snapshotPath,
      processProvider: async () => [oldIdentity],
      processTableProvider: async () => [],
      now: () => Date.parse("2026-09-14T19:40:00.000Z"),
    });
    const second = await captureSnapshot({
      ...paths,
      snapshotPath,
      processProvider: async () => [oldIdentity],
      processTableProvider: async () => [],
      now: () => Date.parse("2026-09-14T20:00:00.000Z"),
    });
    assert.equal(first.activity.sessions.length, 0);
    assert.equal(first.activity.quietObservedSince, "2026-09-14T19:40:00.000Z");
    assert.equal(second.activity.quietObservedSince, first.activity.quietObservedSince);
});

test("global historical dead locks do not become phantom app sessions", async () => {
      const directory = await fixtureDirectory();
      const paths = await databases(directory, {
        sessionRunning: false,
        activeTurn: true,
        lockPid: 700,
      });
      for (let index = 0; index < 40; index += 1) {
        const historical = join(paths.sessionStateDirectory, `historical-${index}`);
        await mkdir(historical, { recursive: true });
        await writeFile(join(historical, `inuse.${800 + index}.lock`), "", "utf8");
        await writeFile(
          join(historical, "events.jsonl"),
          `${JSON.stringify({
            type: "assistant.turn_start",
            timestamp: "2026-08-01T00:00:00.000Z",
          })}\n`,
          "utf8",
        );
      }
      const providers = {
        processProvider: async () => [oldIdentity],
        processTableProvider: async () => [{
          pid: 700,
          parentPid: 101,
          name: "copilot.exe",
          path: "C:\\Fixture\\copilot.exe",
          startTime: "2026-09-14T19:00:00.000Z",
        }],
      };
      const first = await captureSnapshot({
        ...paths,
        ...providers,
        snapshotPath: join(directory, "snapshot.json"),
      });
      assert.deepEqual(first.activity.sessions.map((item) => item.id), ["session"]);
      assert.equal(first.activity.sessions[0].evidence.events.turnOpen, true);

      await writeFile(
        join(paths.sessionStateDirectory, "session", "events.jsonl"),
        [
          {
            type: "assistant.turn_start",
            timestamp: "2026-09-14T19:58:00.000Z",
          },
          {
            type: "assistant.turn_end",
            timestamp: "2026-09-14T19:59:00.000Z",
          },
        ].map((event) => JSON.stringify(event)).join("\n"),
        "utf8",
      );
      const second = await captureSnapshot({
        ...paths,
        ...providers,
        snapshotPath: join(directory, "snapshot.json"),
      });
      assert.deepEqual(second.activity.sessions.map((item) => item.id), ["session"]);
      assert.equal(second.activity.sessions[0].residentOwner, true);
});

test("unreadable database or process evidence fails closed", async () => {
  const directory = await fixtureDirectory();
  const snapshot = await captureSnapshot({
    databasePath: join(directory, "missing-data.db"),
    sessionStorePath: join(directory, "missing-session-store.db"),
    snapshotPath: join(directory, "snapshot.json"),
    processProvider: async () => {
      throw new Error("CIM denied");
    },
    processTableProvider: async () => {
      throw new Error("process table denied");
    },
  });
  assert.equal(snapshot.app.evidence, "unknown");
  assert.equal(snapshot.activity.complete, false);
  assert.equal(snapshot.scheduler.evidence, "unknown");
});

test("real unreadable activity collection still reaches hard force with a known GUI target", async () => {
    const directory = await fixtureDirectory();
    const snapshotPath = join(directory, "snapshot.json");
    const markerPath = join(directory, "force.json");
    const snapshot = await captureSnapshot({
      databasePath: join(directory, "missing-data.db"),
      sessionStorePath: join(directory, "missing-session-store.db"),
      sessionStateDirectory: join(directory, "missing-session-state"),
      snapshotPath,
      processProvider: async () => [oldIdentity],
      processTableProvider: async () => { throw new Error("activity census unreadable"); },
    });
    assert.equal(snapshot.app.evidence, "known");
    assert.equal(snapshot.app.running, true);
    assert.equal(snapshot.activity.complete, false);
    assert.ok(snapshot.errors.some(error => error.includes("activity census unreadable")));
    const after = { ...snapshot, app: { running: false, evidence: "known" } };
    const script = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'{}');` +
      `require('node:fs').writeFileSync(${JSON.stringify(snapshotPath)},${JSON.stringify(JSON.stringify(after))});` +
      "console.log('SUPERVISOR_ADAPTER_RESULT='+JSON.stringify({ok:true}))";
    const adapters = commandAdapters(validateConfig({
      commands: { forceTerminate: { file: process.execPath, args: ["-e", script] } },
    }), snapshotPath);
    const options = {
      expectedOldIdentity: oldIdentity, attemptId: "unreadable-activity",
      deadlineSeconds: 0, forceDeadlineSeconds: 5, forceAuthorization: HARD_RESTART_AUTHORIZATION,
    };
    const quiet = await adapters.awaitShutdown(options);
    assert.match(quiet.error, /vetoed by unknown activity/);
    await assert.rejects(readFile(markerPath), /ENOENT/);
    const hard = await adapters.forceShutdown(options);
    assert.equal(hard.ok, true, hard.error);
    assert.equal(hard.activityOverridden, true);
    assert.equal(await readFile(markerPath, "utf8"), "{}");
});

test("identity matching includes PID, executable path, and start time", () => {
  assert.equal(sameIdentity(oldIdentity, { ...oldIdentity }), true);
  assert.equal(sameIdentity(oldIdentity, { ...oldIdentity, startTime: "2026-09-14T11:00:00Z" }), false);
  assert.equal(sameIdentity(oldIdentity, { ...oldIdentity, path: "C:\\Other\\GitHubCopilot.exe" }), false);
});

test("graceful close verifies the specific old identity exited", async () => {
  const directory = await fixtureDirectory();
  let rows = [oldIdentity];
  let closePid = null;
  const outcome = await requestGracefulShutdown({
    expected: oldIdentity,
    deadlineSeconds: 1,
    snapshotPath: join(directory, "snapshot.json"),
    processProvider: async () => rows,
    close: async (pid) => {
      closePid = pid;
      rows = [];
      return true;
    },
    sleep: async () => {},
    attemptId: "attempt",
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.exited, true);
  assert.equal(closePid, oldIdentity.pid);
});

test("PID reuse or path mismatch blocks force termination", async () => {
  let terminated = false;
  const outcome = await forceTerminate({
    expected: oldIdentity,
    authorization: "explicit-user-approval:upstream-style-practical-baseline",
    processProvider: async () => [{ ...oldIdentity, path: "C:\\Other\\GitHubCopilot.exe" }],
    terminate: async () => {
      terminated = true;
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "pid-identity-mismatch");
  assert.equal(terminated, false);
});

test("authorized force fallback targets only the revalidated root and returned descendant PIDs", async () => {
  let terminatedIdentity = null;
  const outcome = await forceTerminate({
    expected: oldIdentity,
    authorization: "explicit-user-approval:upstream-style-practical-baseline",
    processProvider: async () => [oldIdentity],
    terminate: async (identity) => {
      terminatedIdentity = identity;
      return { terminatedPids: [303, 202, identity.pid] };
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(terminatedIdentity.pid, oldIdentity.pid);
  assert.equal(outcome.method, "verified-process-tree-force");
  assert.deepEqual(outcome.terminatedPids, [303, 202, oldIdentity.pid]);
  assert.equal(
    outcome.authorization,
    "explicit-user-approval:upstream-style-practical-baseline",
  );
});

test("process-tree ownership includes only descendants of the observed github.exe root", () => {
  const rows = [
    { pid: 101, parentPid: 1, name: "github.exe" },
    { pid: 202, parentPid: 101, name: "copilot.exe" },
    { pid: 303, parentPid: 202, name: "node.exe" },
    { pid: 404, parentPid: 1, name: "copilot.exe" },
    { pid: 505, parentPid: 1, name: "agency.exe" },
  ];
  assert.deepEqual(descendantProcessIds(rows, 101), [303, 202]);
  assert.equal(descendantProcessIds(rows, 101).includes(404), false);
  assert.equal(descendantProcessIds(rows, 101).includes(505), false);
  assert.deepEqual(
    descendantProcessIds([
      { pid: 202, parentPid: 101 },
      { pid: 101, parentPid: 202 },
    ], 101),
    [202],
  );
});

test("force implementation never uses process-name blanket termination", async () => {
  const source = await readFile(new URL("./windows-app-actuator.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Stop-Process\s+-Name/i);
  assert.doesNotMatch(source, /foreach\s*\(\$pid\b/i);
  assert.match(source, /Stop-Process -InputObject \$processHandle -Force/);
  assert.match(source, /ParentProcessId/);
  assert.match(source, /captured\.ExecutablePath/);
  assert.match(source, /captured\.CreationTime/);
});

test("exact relaunch rejects path drift and reports launch failure", async () => {
  const mismatch = await launchExact({
    executablePath: "C:\\Other\\GitHubCopilot.exe",
    expectedOldIdentity: oldIdentity,
    statFile: async () => ({}),
    launch: async () => 202,
  });
  assert.equal(mismatch.ok, false);
  await assert.rejects(
    launchExact({
      executablePath: oldIdentity.path,
      expectedOldIdentity: oldIdentity,
      statFile: async () => ({}),
      launch: async () => {
        throw new Error("launch refused");
      },
    }),
    /launch refused/,
  );
});

test("scheduler verification ignores unrelated rows and requires a fresh due-workflow dispatch", async () => {
    let nowMs = Date.parse("2026-09-14T20:00:00.000Z");
    const newIdentity = { ...oldIdentity, pid: 202, startTime: "2026-09-14T20:00:00.000Z" };
    const snapshots = [
      {
        observedAt: "2026-09-14T20:00:01.000Z",
        app: { identity: newIdentity },
        scheduler: {
          evidence: "known",
          workDue: true,
          latestScheduledRuns: {
            due: { id: "old-due", startedAt: "2026-09-14T19:00:00.000Z" },
            unrelated: { id: "new-unrelated", startedAt: "2026-09-14T20:00:01.000Z" },
          },
        },
      },
      {
        observedAt: "2026-09-14T20:00:02.000Z",
        app: { identity: newIdentity },
        scheduler: {
          evidence: "known",
          workDue: false,
          latestScheduledRuns: {
            due: { id: "new-due", startedAt: "2026-09-14T20:00:02.000Z" },
            unrelated: { id: "new-unrelated", startedAt: "2026-09-14T20:00:01.000Z" },
          },
        },
      },
    ];
    const result = await verifySchedulerAfterRestart({
      expectedNewIdentity: newIdentity,
      deadlineSeconds: 2,
      workWasDue: true,
      before: { due: { id: "old-due", startedAt: "2026-09-14T19:00:00.000Z" } },
      beforeDueWorkflows: ["due"],
      notBefore: "2026-09-14T20:00:00.000Z",
      capture: async () => snapshots.shift() ?? snapshots.at(-1),
      now: () => nowMs,
      sleep: async (delay) => {
        nowMs += delay;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.workflowId, "due");
    assert.equal(result.scheduledRun.id, "new-due");
  });

test("real database catch_up dispatch proves scheduler recovery but manual dispatch does not", async () => {
  const directory = await fixtureDirectory();
  const paths = await databases(directory, { due: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(paths.databasePath);
  try {
    db.prepare("INSERT INTO workflow_runs VALUES (?, ?, ?, ?, ?, ?)").run(
      "catchup-after-restart", "workflow", null, "completed", "catch_up", "2026-09-14T20:00:04.000Z",
    );
    db.prepare("INSERT INTO workflow_runs VALUES (?, ?, ?, ?, ?, ?)").run(
      "later-manual", "workflow", null, "completed", "manual", "2026-09-14T20:00:06.000Z",
    );
  } finally { db.close(); }
  const newIdentity = { ...oldIdentity, pid: 202, startTime: "2026-09-14T20:00:00.000Z" };
  const capture = () => captureSnapshot({
    ...paths, processProvider: async () => [newIdentity],
    now: () => Date.parse("2026-09-14T20:00:10.000Z"),
  });
  const observed = await capture();
  assert.equal(observed.scheduler.latestScheduledRuns.workflow.id, "catchup-after-restart");
  const result = await verifySchedulerAfterRestart({
    expectedNewIdentity: newIdentity, deadlineSeconds: 0, workWasDue: true,
    before: {}, beforeDueWorkflows: ["workflow"],
    notBefore: "2026-09-14T20:00:00.000Z", capture,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "resumed");
  assert.equal(result.scheduledRun.id, "catchup-after-restart");
});

test("scheduler no-work-due is readiness without manufactured progress", async () => {
    const newIdentity = { ...oldIdentity, pid: 202, startTime: "2026-09-14T20:00:00.000Z" };
    const result = await verifySchedulerAfterRestart({
      expectedNewIdentity: newIdentity,
      deadlineSeconds: 1,
      workWasDue: false,
      capture: async () => ({
        observedAt: "2026-09-14T20:00:01.000Z",
        app: { identity: newIdentity },
        scheduler: { evidence: "known", workDue: false, latestScheduledRuns: {} },
      }),
    });
    assert.equal(result.status, "ready-no-work-due");
    assert.equal(result.progressObserved, false);
});

test("hard actuator requires the dedicated authorization before any process call", async () => {
  let inspected = false;
  const result = await forceTerminate({
    expected: {}, restartMode: "hard-deadline", authorization: "quiet-approval",
    processProvider: async () => { inspected = true; return []; },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /authorization/);
  assert.equal(inspected, false);
});

for (const powershellExecutable of ["powershell.exe", "pwsh"]) {
  test(
    `real ${powershellExecutable} fixture observes graceful timeout and kills only the verified tree`,
    {
      skip:
        process.env.OA_RUN_DESTRUCTIVE_ACTUATOR_FIXTURES === "1" &&
        process.platform === "win32" && powershellAvailable(powershellExecutable)
          ? false
          : `real process termination fixture is opt-in (OA_RUN_DESTRUCTIVE_ACTUATOR_FIXTURES=1)`,
    },
    async () => {
      const directory = await fixtureDirectory();
      const childPidPath = join(directory, "child.pid");
      const snapshotPath = join(directory, "snapshot.json");
      const rootScript =
        `$childExe=(Get-Process -Id $PID -ErrorAction Stop).Path;` +
        `$children=@(1..20 | ForEach-Object { Start-Process -FilePath $childExe ` +
        `-ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300') -PassThru });` +
        `Set-Content -LiteralPath '${childPidPath.replaceAll("'", "''")}' -Value (($children.Id)-join ',') -Encoding ascii;` +
        "Start-Sleep -Seconds 300";
      const root = spawn(
        powershellExecutable,
        ["-NoProfile", "-NonInteractive", "-Command", rootScript],
        { windowsHide: true, stdio: "ignore" },
      );
      const unrelated = spawn(
        process.env.ComSpec,
        ["/d", "/c", "ping -n 300 127.0.0.1 >nul"],
        { windowsHide: true, stdio: "ignore" },
      );
      let childPids = [];
      try {
        assert.equal(
          await waitFor(async () => {
            try {
              childPids = (await readFile(childPidPath, "utf8"))
                .trim()
                .split(",")
                .map(Number)
                .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
              return childPids.length === 20;
            } catch {
              return false;
            }
          }),
          true,
          "fixture child did not start",
        );
        const expected = processIdentity(root.pid);
        assert.ok(expected?.path && expected?.startTime, "fixture root identity was unreadable");
        const graceful = await requestGracefulShutdown({
          expected,
          snapshotPath,
          processProvider: async () => {
            const current = processIdentity(root.pid);
            return current ? [current] : [];
          },
          close: async () => false,
          attemptId: `fixture-${powershellExecutable}`,
        });
        assert.equal(graceful.exited, false);
        assert.equal(graceful.requestOnly, true);
        const gracefulDeadlineStarted = Date.now();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        assert.ok(processIdentity(root.pid), "fixture root exited before the graceful deadline");
        assert.ok(Date.now() - gracefulDeadlineStarted >= 200);

        const dryRunStarted = Date.now();
        const planned = await terminateVerifiedProcessTree(expected, {
          powershellExecutable,
          deadlineSeconds: 15,
          dryRun: true,
        });
        const dryRunMs = Date.now() - dryRunStarted;
        assert.equal(planned.dryRun, true);
        assert.ok(planned.targetCount >= 21);
        assert.deepEqual(planned.terminatedPids, []);
        assert.ok(planned.diagnostics.censusMs >= 0);
        assert.ok(planned.diagnostics.validationMs >= 0);
        assert.ok(planned.diagnostics.totalMs >= planned.diagnostics.validationMs);
        assert.ok(dryRunMs < 15_000, `dry-run census took ${dryRunMs}ms`);
        assert.ok(processIdentity(root.pid), "dry-run terminated the fixture root");
        assert.ok(processIdentity(childPids[0]), "dry-run terminated a fixture child");

        const forced = await forceTerminate({
          expected,
          restartMode: "hard-deadline",
          authorization: HARD_RESTART_AUTHORIZATION,
          processProvider: async () => {
            const current = processIdentity(root.pid);
            return current ? [current] : [];
          },
          terminate: (identity, options) => terminateVerifiedProcessTree(identity, {
            ...options, powershellExecutable,
          }),
          deadlineSeconds: 15,
        });
        assert.equal(forced.ok, true);
        assert.equal(forced.restartMode, "hard-deadline");
        assert.equal(forced.rootPid, root.pid);
        assert.ok(forced.diagnostics.terminationMs >= 0);
        assert.ok(forced.diagnostics.totalMs >= forced.diagnostics.terminationMs);
        assert.ok(forced.terminatedPids.includes(root.pid));
        for (const childPid of childPids) assert.ok(forced.terminatedPids.includes(childPid));
        assert.equal(
          await waitFor(() => processIdentity(root.pid) === null),
          true,
          "fixture root survived force fallback",
        );
        assert.equal(
          await waitFor(() => existingProcessIds(childPids).size === 0),
          true,
          "fixture child survived force fallback",
        );
        assert.ok(processIdentity(unrelated.pid), "unrelated process was terminated");
      } finally {
        const candidates = [root.pid, ...childPids, unrelated.pid].filter(Number.isSafeInteger);
        const existing = existingProcessIds(candidates);
        const remaining = candidates.filter((pid) => existing.has(pid));
        if (remaining.length > 0) {
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Stop-Process -Id @(${remaining.join(",")}) -Force -ErrorAction SilentlyContinue`,
            ],
            { windowsHide: true, stdio: "ignore" },
          );
        }
      }
    },
  );
}
