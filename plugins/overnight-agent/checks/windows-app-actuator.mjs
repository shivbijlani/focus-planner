import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyTerminalEvidence, readSessionEvidence } from "./session-terminal-evidence.mjs";
import { HARD_RESTART_AUTHORIZATION } from "./reliability-supervisor.mjs";
export { summariseSessionEvents } from "./session-terminal-evidence.mjs";

const RESULT_PREFIX = "SUPERVISOR_ADAPTER_RESULT=";
const APP_NAMES = new Set(["github.exe", "githubcopilot.exe", "github copilot.exe"]);
const QUERY_LIMIT = 500;

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function validDate(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function samePath(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

export function sameIdentity(left, right) {
  return Number(left?.pid) === Number(right?.pid) &&
    validDate(left?.startTime) === validDate(right?.startTime) &&
    samePath(left?.path, right?.path);
}

async function atomicJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.new`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJson(path, fallback = {}) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function powershellJson(script, environment = {}, { timeoutMs = 30_000 } = {}) {
  const executable = environment.SUPERVISOR_POWERSHELL ?? "powershell.exe";
  const childEnvironment = { ...environment };
  delete childEnvironment.SUPERVISOR_POWERSHELL;
  const execution = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      env: { ...process.env, ...childEnvironment },
    },
  );
  if (execution.error) {
    const error = new Error(
      `PowerShell operation failed: ${execution.error.message}; last diagnostics: ${execution.stderr?.trim().slice(-2048) || "none"}`,
      { cause: execution.error },
    );
    error.code = execution.error.code;
    throw error;
  }
  if (execution.status !== 0) {
    throw new Error(`PowerShell process inspection failed: ${execution.stderr || execution.stdout}`);
  }

  const text = execution.stdout.trim().replace(/^\uFEFF/, "");
  return text ? JSON.parse(text) : [];
}

export async function listWindowsProcessTable(options = {}) {
  if (process.platform !== "win32") throw new Error("Windows process inspection is unavailable");
  const rows = powershellJson(`
$ErrorActionPreference='Stop'
@(
  Get-CimInstance Win32_Process | ForEach-Object {
    $start = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      name = [string]$_.Name
      path = [string]$_.ExecutablePath
      startTime = $start
    }
  }
) | ConvertTo-Json -Compress
`, options);
  return Array.isArray(rows) ? rows : rows ? [rows] : [];
}

export async function listCopilotProcesses() {
  if (process.platform !== "win32") throw new Error("Windows process inspection is unavailable");
  const rows = powershellJson(`
$ErrorActionPreference='Stop'
@(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -in @('github.exe','GitHubCopilot.exe','GitHub Copilot.exe') -or
      ($_.ExecutablePath -and (Split-Path -Leaf $_.ExecutablePath) -in @('github.exe','GitHubCopilot.exe','GitHub Copilot.exe'))
    } |
    ForEach-Object {
      $p = Get-Process -Id $_.ProcessId -ErrorAction Stop
      [pscustomobject]@{
        pid = [int]$_.ProcessId
        name = [string]$_.Name
        parentPid = [int]$_.ParentProcessId
        path = [string]$_.ExecutablePath
        startTime = $p.StartTime.ToUniversalTime().ToString('o')
        mainWindowHandle = [int64]$p.MainWindowHandle
      }
    }
) | ConvertTo-Json -Compress
`);
  return Array.isArray(rows) ? rows : rows ? [rows] : [];
}

function isCopilotGuiCandidate(item) {
  const name = String(item.name ?? basename(item.path ?? "")).toLowerCase();
  if (!APP_NAMES.has(name)) return false;
  if (name !== "github.exe") return true;
  return /[\\/]GitHub Copilot[\\/]/i.test(item.path ?? "");
}

export function descendantProcessIds(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    const parentPid = Number(row.parentPid);
    if (!children.has(parentPid)) children.set(parentPid, []);
    children.get(parentPid).push(Number(row.pid));
  }
  const ordered = [];
  const visited = new Set([Number(rootPid)]);
  const visit = (pid) => {
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      visit(child);
      ordered.push(child);
    }
  };
  visit(Number(rootPid));
  return [...new Set(ordered)];
}

export async function terminateVerifiedProcessTree(expected, options = {}) {
  const script = `
$ErrorActionPreference='Stop'
$rootPid = [int]$env:OA_ROOT_PID
$dryRun = $env:OA_DRY_RUN -eq 'true'
$timer = [Diagnostics.Stopwatch]::StartNew()
[Console]::Error.WriteLine('FORCE_PROGRESS phase=census')
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    ProcessId = [int]$_.ProcessId
    ParentProcessId = [int]$_.ParentProcessId
    ExecutablePath = [string]$_.ExecutablePath
    CreationTime = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
})
$byPid = @{}
foreach ($row in $rows) { $byPid[[int]$row.ProcessId] = $row }
$root = $byPid[$rootPid]
if (-not $root) {
  [pscustomobject]@{ ok=$true; dryRun=$dryRun; rootPid=$rootPid; targetCount=0; targetPids=@(); vanishedPids=@($rootPid); terminatedPids=@() } | ConvertTo-Json -Compress
  exit 0
}
$actualPath = [IO.Path]::GetFullPath([string]$root.ExecutablePath)
$expectedPath = [IO.Path]::GetFullPath([string]$env:OA_ROOT_PATH)
$actualStart = [string]$root.CreationTime
$expectedStartMs = ([datetimeoffset]::Parse($env:OA_ROOT_START)).ToUnixTimeMilliseconds()
if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'root path changed' }
$actualStartMs = ([datetimeoffset]::Parse($actualStart)).ToUnixTimeMilliseconds()
$startDeltaMs = [math]::Abs($actualStartMs - $expectedStartMs)
if ($startDeltaMs -gt 2000) { throw "root start time changed (actual=$actualStart expected=$($env:OA_ROOT_START) deltaMs=$startDeltaMs)" }
$depth = @{}
$depth[$rootPid] = 0
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($row in $rows) {
    $parent = [int]$row.ParentProcessId
    $candidatePid = [int]$row.ProcessId
    if ($depth.ContainsKey($parent) -and -not $depth.ContainsKey($candidatePid)) {
      $depth[$candidatePid] = [int]$depth[$parent] + 1
      $changed = $true
    }
  }
}
$targets = @($depth.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { [int]$_.Key })
$handles = @{}
$vanished = @()
$censusMs = $timer.Elapsed.TotalMilliseconds
[Console]::Error.WriteLine("FORCE_PROGRESS phase=validation targets=$($targets.Count)")
foreach ($candidatePid in $targets) {
  $captured = $byPid[$candidatePid]
  $processHandle = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
  if (-not $processHandle -or $processHandle.HasExited) {
    $vanished += $candidatePid
    continue
  }
  if (-not $captured -or
      [string]::IsNullOrWhiteSpace([string]$captured.ExecutablePath) -or
      [string]::IsNullOrWhiteSpace([string]$captured.CreationTime)) {
    throw "descendant identity unreadable for pid: $candidatePid"
  }
  if ($candidatePid -ne $rootPid) {
    $parent = $byPid[[int]$captured.ParentProcessId]
    if (-not $parent -or [string]::IsNullOrWhiteSpace([string]$parent.CreationTime)) {
      throw "descendant parent identity unreadable for pid: $candidatePid"
    }
    $childStartMs = ([datetimeoffset]::Parse([string]$captured.CreationTime)).ToUnixTimeMilliseconds()
    $parentStartMs = ([datetimeoffset]::Parse([string]$parent.CreationTime)).ToUnixTimeMilliseconds()
    if ($childStartMs + 2000 -lt $parentStartMs) {
      throw "descendant predates captured parent for pid: $candidatePid"
    }
  }
  try {
    $nativePath = [IO.Path]::GetFullPath([string]$processHandle.Path)
    $nativeStart = $processHandle.StartTime.ToUniversalTime().ToString('o')
  } catch {
    if ($processHandle.HasExited) {
      $vanished += $candidatePid
      continue
    }
    throw "native process identity unreadable for pid: $candidatePid"
  }
  if (-not $nativePath.Equals([IO.Path]::GetFullPath([string]$captured.ExecutablePath), [StringComparison]::OrdinalIgnoreCase) -or
      ([math]::Abs((([datetimeoffset]::Parse($nativeStart)).ToUnixTimeMilliseconds()) -
        (([datetimeoffset]::Parse([string]$captured.CreationTime)).ToUnixTimeMilliseconds())) -gt 2000)) {
    throw "native process identity changed for pid: $candidatePid"
  }
  $handles[$candidatePid] = $processHandle
}
$terminated = @()
$validationMs = $timer.Elapsed.TotalMilliseconds - $censusMs
if (-not $dryRun) {
  foreach ($candidatePid in $targets) {
    $processHandle = $handles[$candidatePid]
    if (-not $processHandle -or $processHandle.HasExited) {
      if ($vanished -notcontains $candidatePid) { $vanished += $candidatePid }
      continue
    }
    [Console]::Error.WriteLine("FORCE_PROGRESS phase=termination pid=$candidatePid completed=$($terminated.Count) elapsedMs=$($timer.ElapsedMilliseconds)")
    Stop-Process -InputObject $processHandle -Force -ErrorAction Stop
    $terminated += $candidatePid
  }
}
$terminationMs = $timer.Elapsed.TotalMilliseconds - $censusMs - $validationMs
[pscustomobject]@{
  ok=$true
  dryRun=$dryRun
  rootPid=$rootPid
  targetCount=$handles.Count
  targetPids=@($targets | Where-Object { $handles.ContainsKey($_) })
  vanishedPids=$vanished
  terminatedPids=$terminated
  diagnostics=@{ censusMs=$censusMs; validationMs=$validationMs; terminationMs=$terminationMs; totalMs=$timer.Elapsed.TotalMilliseconds }
} | ConvertTo-Json -Compress
`;
  return powershellJson(script, {
    OA_ROOT_PID: String(expected.pid),
    OA_ROOT_PATH: expected.path,
    OA_ROOT_START: expected.startTime,
    OA_DRY_RUN: options.dryRun === true ? "true" : "false",
    SUPERVISOR_POWERSHELL: options.powershellExecutable,
  }, {
    timeoutMs: Math.max(1_000, Number(options.deadlineSeconds ?? 30) * 1_000),
  });
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all().map((row) => row.name);
}

function pick(row, names, fallback = null) {
  for (const name of names) if (name in row && row[name] !== null) return row[name];
  return fallback;
}

async function sessionFileEvidence(
  sessionStateDirectory,
  sessionId,
  processByPid,
  appOwnedPids = new Set(),
) {
  if (!sessionId) {
    return {
      events: { readable: false, reason: "workflow run has no session id" },
      liveness: { state: "unknown", reason: "workflow run has no session id", locks: [] },
    };
  }
  const table = processByPid === null ? null : new Map([...processByPid].map(([pid, row]) =>
    [pid, { exists: true, name: row.name, startTimeMs: validDate(row.startTime) }]));
  const evidence = readSessionEvidence(sessionStateDirectory, sessionId, table);
  evidence.events ??= { readable: false, reason: "events missing" };
  evidence.liveness.locks = evidence.liveness.locks.map((lock) =>
    ({ ...lock, appOwned: appOwnedPids.has(lock.pid) }));
  return evidence;
}

async function residentSessionIds(sessionStateDirectory) {
  const entries = await readdir(sessionStateDirectory, { withFileTypes: true });
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let names;
    try {
      names = await readdir(join(sessionStateDirectory, entry.name));
    } catch {
      continue;
    }
    if (names.some((name) => /^inuse\.\d+\.lock$/.test(name))) ids.push(entry.name);
    if (ids.length > QUERY_LIMIT) {
      throw new Error(`resident session count exceeds inspection cap ${QUERY_LIMIT}`);
    }
  }
  return ids;
}

function schedulerState(db, workflowColumns, runColumns, nowMs) {
  const nextRunColumn = ["next_run_at", "nextRunAt"].find((name) => workflowColumns.includes(name));
  const enabledColumn = ["enabled", "is_enabled"].find((name) => workflowColumns.includes(name));
  if (
    !nextRunColumn ||
    !enabledColumn ||
    !["id", "task_id", "trigger", "started_at"].every((name) => runColumns.includes(name))
  ) {
    return {
      evidence: "unknown",
      workDue: null,
      dispatchSequence: null,
      reason: "required scheduler columns are missing",
    };
  }
  const enabledCount = Number(
    db.prepare(`SELECT COUNT(*) AS count FROM workflows WHERE "${enabledColumn}" != 0`).get().count,
  );
  if (enabledCount > QUERY_LIMIT) {
    return {
      evidence: "unknown",
      workDue: null,
      dispatchSequence: null,
      reason: `enabled workflow count ${enabledCount} exceeds inspection cap ${QUERY_LIMIT}`,
    };
  }
  const workflows = db.prepare(
    `SELECT id, "${nextRunColumn}" AS nextRunAt FROM workflows WHERE "${enabledColumn}" != 0 LIMIT ?`,
  ).all(QUERY_LIMIT);
  const dueWorkflowIds = workflows
    .filter((row) => validDate(row.nextRunAt) !== null && validDate(row.nextRunAt) <= nowMs)
    .map((row) => String(row.id));
  const latestScheduledRuns = {};
  for (const workflow of workflows) {
    const row = db.prepare(
      "SELECT id, started_at FROM workflow_runs WHERE task_id = ? AND trigger IN ('schedule', 'catch_up') " +
      "ORDER BY started_at DESC LIMIT 1",
    ).get(workflow.id);
    latestScheduledRuns[String(workflow.id)] = row
      ? { id: String(row.id), startedAt: row.started_at }
      : null;
  }
  const dispatchSequence = JSON.stringify(
    Object.fromEntries(dueWorkflowIds.map((id) => [id, latestScheduledRuns[id] ?? null])),
  );
  return {
    evidence: "known",
    workDue: dueWorkflowIds.length > 0,
    dueWorkflowIds,
    latestScheduledRuns,
    dispatchSequence,
  };
}

export async function inspectDatabases({
  databasePath = join(homedir(), ".copilot", "data.db"),
  sessionStorePath = join(homedir(), ".copilot", "session-store.db"),
  sessionStateDirectory = join(homedir(), ".copilot", "session-state"),
  processTableProvider = listWindowsProcessTable,
  appRootPid = null,
  nowMs = Date.now(),
  graceMinutes = 20,
  silenceMinutes = 15,
} = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const sessions = [];
  const exclusions = [];
  let scheduler = { evidence: "unknown", workDue: null, dispatchSequence: null };
  const errors = [];
  let processTable = [];
  let processCensusReadable = false;
  try {
    processTable = await processTableProvider();
    processCensusReadable = Array.isArray(processTable);
    if (!processCensusReadable) throw new Error("process table is not an array");
  } catch (error) {
    errors.push(`process table: ${error.message}`);
  }
  const processByPid = processCensusReadable ? new Map(processTable.map((item) => [Number(item.pid), item])) : null;
  const appOwnedPids = new Set(
    appRootPid === null ? [] : [Number(appRootPid), ...descendantProcessIds(processTable, appRootPid)],
  );
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
      );
      if (!tables.has("workflow_runs") || !tables.has("workflows")) {
        throw new Error("required workflow tables are missing");
      }
      if (!tables.has("sessions")) throw new Error("sessions table is missing");
      const runColumns = tableColumns(db, "workflow_runs");
      const activeRunCount = Number(
        db.prepare(
          "SELECT COUNT(*) AS count FROM workflow_runs WHERE status IN ('pending','running','starting','draining')",
        ).get().count,
      );
      if (activeRunCount > QUERY_LIMIT) {
        throw new Error(`non-terminal workflow run count ${activeRunCount} exceeds inspection cap ${QUERY_LIMIT}`);
      }
      const rows = db.prepare(
        "SELECT * FROM workflow_runs WHERE status IN ('pending','running','starting','draining') " +
        "ORDER BY started_at DESC LIMIT ?",
      ).all(QUERY_LIMIT);
      const logicalSessions = new Map();
      try {
        const store = new DatabaseSync(sessionStorePath, { readOnly: true });
        try {
          const readLogical = store.prepare("SELECT * FROM sessions WHERE id = ?");
          for (const row of rows) {
            if (row.session_id) logicalSessions.set(String(row.session_id), readLogical.get(row.session_id) ?? null);
          }
        } finally { store.close(); }
      } catch (error) {
        errors.push(`session-store.db projections: ${error.message}`);
      }
      const sessionColumns = tableColumns(db, "sessions");
      if (!sessionColumns.includes("is_running") || !sessionColumns.includes("updated_at")) {
        throw new Error("sessions activity columns are missing");
      }
      const dataSessions = new Map();
      const readDataSession = db.prepare(
        "SELECT * FROM sessions WHERE id = ? LIMIT 1",
      );
      for (const row of rows) {
        if (!row.session_id) continue;
        const dataSession = readDataSession.get(row.session_id);
        if (dataSession) dataSessions.set(String(row.session_id), dataSession);
      }
      for (const row of rows) {
        const status = String(pick(row, ["status"], "unknown")).toLowerCase();
        const sessionId = row.session_id ? String(row.session_id) : null;
        const dataSession = sessionId ? dataSessions.get(sessionId) : null;
        const files = await sessionFileEvidence(
          sessionStateDirectory,
          sessionId,
          processByPid,
          appOwnedPids,
        );
        const evidence = {
          workflowRunId: String(row.id),
          workflowStatus: status,
          sessionId,
          dataSession: dataSession
            ? { isRunning: Number(dataSession.is_running) !== 0, updatedAt: dataSession.updated_at }
            : null,
          events: files.events,
          liveness: files.liveness,
        };
        const terminalDecision = classifyTerminalEvidence({
          ...files, dataSession, logicalSession: logicalSessions.get(sessionId),
          startedAtMs: validDate(row.started_at), nowMs, graceMinutes, silenceMinutes,
        });
        evidence.terminalDecision = terminalDecision;
        if (
          files.events.pendingHuman ||
          (files.events.activeExecution &&
            (files.liveness.state === "live" || Number(dataSession?.is_running) !== 0))
        ) {
          sessions.push({
            id: sessionId ?? String(row.id),
            status: "running",
            liveness: "live",
            lastActivityAt: files.events.lastEventAt,
            pendingHuman: files.events.pendingHuman,
            liveTool: files.events.pendingToolCount > 0,
            backgroundWork: !files.events.pendingHuman,
            source: "session-state-events",
            evidence,
          });
        } else if (
          terminalDecision.repairable
        ) {
          exclusions.push({
            id: sessionId ?? String(row.id),
            status: terminalDecision.terminalStatus,
            liveness: files.liveness.state,
            lastActivityAt: files.events.terminalAt,
            executionTerminal: true,
            source: "session-state-events",
            evidence,
          });
        } else if (
          dataSession &&
          Number(dataSession.is_running) === 0 &&
          files.events.settledTurn
        ) {
          sessions.push({
            id: sessionId ?? String(row.id),
            status: "completed",
            liveness: "live",
            lastActivityAt: files.events.settledTurnAt,
            residentOwner: true,
            source: "settled-turn-resident-owner",
            evidence,
          });
        } else {
          sessions.push({
            id: sessionId ?? String(row.id),
            status,
            liveness: "unknown",
            lastActivityAt: files.events.lastEventAt ?? dataSession?.updated_at ?? row.started_at,
            source:
              dataSession && Number(dataSession.is_running) !== 0
                ? "uncorroborated-running-session-flag"
                : "uncorroborated-workflow-row",
            evidence,
          });
        }
      }
      const liveSessionCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE is_running != 0").get().count,
      );
      if (liveSessionCount > QUERY_LIMIT) {
        throw new Error(`running session count ${liveSessionCount} exceeds inspection cap ${QUERY_LIMIT}`);
      }
      const alreadyTracked = new Set(rows.map((row) => String(row.session_id ?? "")));
      const liveSessions = db.prepare(
        "SELECT id, is_running, updated_at FROM sessions WHERE is_running != 0 LIMIT ?",
      ).all(QUERY_LIMIT);
      for (const row of liveSessions) {
        if (alreadyTracked.has(String(row.id))) continue;
        alreadyTracked.add(String(row.id));
        const files = await sessionFileEvidence(
          sessionStateDirectory,
          String(row.id),
          processByPid,
          appOwnedPids,
        );
        const evidence = {
          workflowRunId: null,
          sessionId: String(row.id),
          dataSession: { isRunning: true, updatedAt: row.updated_at },
          events: files.events,
          liveness: files.liveness,
        };
        if (files.events.pendingHuman || files.events.activeExecution) {
          sessions.push({
            id: String(row.id),
            status: "running",
            liveness: "live",
            lastActivityAt: files.events.lastEventAt ?? row.updated_at,
            pendingHuman: files.events.pendingHuman,
            liveTool: files.events.pendingToolCount > 0,
            backgroundWork: !files.events.pendingHuman,
            source: "session-state-events",
            evidence,
          });
        } else if (files.events.settledTurn && files.liveness.state === "live") {
          sessions.push({
            id: String(row.id),
            status: "running",
            liveness: "unknown",
            lastActivityAt: files.events.settledTurnAt,
            source: "db-running-settled-resident-owner",
            evidence,
          });
        } else {
          sessions.push({
            id: String(row.id),
            status: "running",
            liveness: "unknown",
            lastActivityAt: files.events.lastEventAt ?? row.updated_at,
            source: "uncorroborated-running-session-flag",
            evidence,
          });
        }
      }
      const readAnyDataSession = db.prepare(
        "SELECT id, is_running, updated_at FROM sessions WHERE id = ? LIMIT 1",
      );
      for (const sessionId of await residentSessionIds(sessionStateDirectory)) {
        if (alreadyTracked.has(sessionId)) continue;
        alreadyTracked.add(sessionId);
        const dataSession = readAnyDataSession.get(sessionId) ?? null;
        const files = await sessionFileEvidence(
          sessionStateDirectory,
          sessionId,
          processByPid,
          appOwnedPids,
        );
        const plausibleAppOwner = files.liveness.locks.some(
          (lock) => lock.appOwned === true && ["live", "unknown"].includes(lock.state),
        );
        if (!plausibleAppOwner) continue;
        const evidence = {
          workflowRunId: null,
          sessionId,
          dataSession: dataSession
            ? { isRunning: Number(dataSession.is_running) !== 0, updatedAt: dataSession.updated_at }
            : null,
          events: files.events,
          liveness: files.liveness,
        };
        if (
          (files.events.pendingHuman || files.events.activeExecution) &&
          files.liveness.state === "live"
        ) {
          sessions.push({
            id: sessionId,
            status: "running",
            liveness: "live",
            lastActivityAt: files.events.lastEventAt ?? dataSession?.updated_at ?? null,
            pendingHuman: files.events.pendingHuman,
            liveTool: files.events.pendingToolCount > 0,
            backgroundWork: !files.events.pendingHuman,
            source: "session-state-events",
            evidence,
          });
        } else if (
          dataSession &&
          Number(dataSession.is_running) === 0 &&
          files.events.settledTurn
        ) {
          sessions.push({
            id: sessionId,
            status: "completed",
            liveness: "live",
            lastActivityAt: files.events.settledTurnAt,
            residentOwner: true,
            source: "settled-turn-resident-owner",
            evidence,
          });
        } else {
          sessions.push({
            id: sessionId,
            status: "running",
            liveness: "unknown",
            lastActivityAt: files.events.lastEventAt ?? dataSession?.updated_at ?? null,
            source: "resident-owner-without-idle-agreement",
            evidence,
          });
        }
      }
      const workflowColumns = tableColumns(db, "workflows");
      scheduler = schedulerState(db, workflowColumns, runColumns, nowMs);
    } finally {
      db.close();
    }
  } catch (error) {
    errors.push(`data.db: ${error.message}`);
  }

  try {
    const db = new DatabaseSync(sessionStorePath, { readOnly: true });
    try {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
      );
      if (!tables.has("sessions")) throw new Error("sessions table is missing");
      const columns = tableColumns(db, "sessions");
      for (const required of ["id", "created_at", "updated_at"]) {
        if (!columns.includes(required)) throw new Error(`sessions.${required} is missing`);
      }
      const projectionCount = Number(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count);
      if (projectionCount > 100_000) {
        throw new Error(`session projection count ${projectionCount} exceeds safety cap 100000`);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    errors.push(`session-store.db: ${error.message}`);
  }

  return {
    complete: errors.length === 0,
    sessions: [...sessions, ...exclusions],
    exclusions,
    scheduler: errors.some((value) => value.startsWith("data.db:"))
      ? { evidence: "unknown", workDue: null, dispatchSequence: null }
      : scheduler,
    errors,
  };
}

export async function captureSnapshot({
  snapshotPath,
  databasePath,
  sessionStorePath,
  sessionStateDirectory,
  processProvider = listCopilotProcesses,
  processTableProvider = listWindowsProcessTable,
  now = () => Date.now(),
} = {}) {
  const observedAt = iso(now());
  let processEvidence = "known";
  let processes = [];
  let guiProcesses = [];
  const errors = [];
  try {
    processes = (await processProvider()).filter(isCopilotGuiCandidate);
    if (processes.some((item) => !item.path || !item.startTime)) {
      processEvidence = "unknown";
      errors.push("process table: a GitHub Copilot candidate has unreadable identity");
    }
    guiProcesses = processes.filter((item) => Number(item.mainWindowHandle) !== 0);
  } catch (error) {
    processEvidence = "unknown";
    errors.push(`process table: ${error.message}`);
  }
  const database = await inspectDatabases({
    databasePath,
    sessionStorePath,
    sessionStateDirectory,
    processTableProvider,
    appRootPid:
      processEvidence === "known" && guiProcesses.length === 1
        ? guiProcesses[0].pid
        : null,
    nowMs: now(),
  });
  errors.push(...database.errors);
  const app = processEvidence === "known" && guiProcesses.length === 1
    ? { running: true, evidence: "known", startedAt: guiProcesses[0].startTime, identity: guiProcesses[0] }
    : processEvidence === "known" && processes.length === 0
      ? { running: false, evidence: "known", identity: null }
      : { running: false, evidence: "unknown", identity: null, candidates: guiProcesses.length };
  if (guiProcesses.length > 1) errors.push("process table: multiple GitHub Copilot GUI candidates");
  if (processes.length > 0 && guiProcesses.length === 0) {
    errors.push("process table: Copilot processes exist but no GUI identity is observable");
  }
  const admissionVersion = `${database.scheduler.dispatchSequence ?? "unknown"}|${database.sessions
    .map((item) => `${item.id}:${item.status}:${item.lastActivityAt ?? ""}:${item.executionTerminal === true}`)
    .sort()
    .join(",")}`;
  const idleCandidate =
    database.complete &&
    database.sessions.every(
      (item) => item.executionTerminal === true || item.residentOwner === true,
    );
  let previous = null;
  if (snapshotPath) {
    try {
      previous = await readJson(snapshotPath, null);
    } catch {
      previous = null;
    }
  }
  const quietObservedSince =
    idleCandidate &&
    previous?.activity?.admissionVersion === admissionVersion &&
    validDate(previous.activity.quietObservedSince) !== null
      ? previous.activity.quietObservedSince
      : idleCandidate
        ? observedAt
        : null;
  const snapshot = {
    version: 1,
    observedAt,
    app,
    activity: {
      complete:
        database.complete &&
        processEvidence === "known" &&
        (guiProcesses.length === 1 || processes.length === 0),
      admissionVersion,
      quietObservedSince,
      sessions: database.sessions,
    },
    scheduler: database.scheduler,
    errors,
  };
  if (snapshotPath) await atomicJsonWrite(snapshotPath, snapshot);
  return snapshot;
}

async function readCurrentIdentity(pid, processProvider) {
  const rows = await processProvider();
  return rows.find((item) => Number(item.pid) === Number(pid)) ?? null;
}

export async function revalidateIdentity(expected, processProvider = listCopilotProcesses) {
  const current = await readCurrentIdentity(expected.pid, processProvider);
  if (!current) return { ok: false, reason: "process-exited" };
  if (!sameIdentity(current, expected)) return { ok: false, reason: "pid-identity-mismatch", current };
  return { ok: true, current };
}

export async function requestGracefulShutdown({
  expected,
  snapshotPath,
  processProvider = listCopilotProcesses,
  close = async (pid) => {
    const result = powershellJson(`
$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop
[pscustomobject]@{ ok = [bool]$p.CloseMainWindow() } | ConvertTo-Json -Compress
`);
    return result.ok === true;
  },
  now = () => Date.now(),
  attemptId,
} = {}) {
  const checked = await revalidateIdentity(expected, processProvider);
  if (!checked.ok) return { ok: false, error: checked.reason };
  const closeIssued = await close(expected.pid);
  const current = await readCurrentIdentity(expected.pid, processProvider);
  const exited = !current || !sameIdentity(current, expected);
  await atomicJsonWrite(snapshotPath, {
    ...(await readJson(snapshotPath)),
    shutdownObserved: {
      attemptId,
      observedAt: iso(now()),
      oldIdentity: expected,
      exited,
    },
  });
  return {
    ok: true,
    method: closeIssued ? "CloseMainWindow" : "WM_CLOSE-unavailable",
    exited,
    requestOnly: !exited,
  };
}

export async function forceTerminate({
  expected,
  authorization,
  processProvider = listCopilotProcesses,
  terminate = terminateVerifiedProcessTree,
  deadlineSeconds,
  dryRun = false,
  restartMode = "quiet-opportunity",
} = {}) {
  if (!["quiet-opportunity", "hard-deadline"].includes(restartMode) ||
      (restartMode === "hard-deadline" && authorization !== HARD_RESTART_AUTHORIZATION)) {
    return { ok: false, error: "invalid preventive restart mode or hard-deadline authorization" };
  }
  const checked = await revalidateIdentity(expected, processProvider);
  if (!checked.ok) return { ok: false, error: checked.reason };
  const termination = await terminate(expected, { deadlineSeconds, dryRun });
  return {
    ok: true,
    method: dryRun ? "verified-process-tree-force-dry-run" : "verified-process-tree-force",
    identity: expected,
    authorization,
    restartMode,
    rootPid: expected.pid,
    terminatedPids: termination?.terminatedPids ?? [expected.pid],
    targetCount: termination?.targetCount ?? null,
    targetPids: termination?.targetPids ?? null,
    vanishedPids: termination?.vanishedPids ?? [],
    diagnostics: termination?.diagnostics ?? null,
    dryRun,
  };
}

export async function launchExact({
  executablePath,
  expectedOldIdentity,
  statFile = stat,
  launch = async (path) => {
    const child = spawn(path, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return child.pid;
  },
} = {}) {
  if (!samePath(executablePath, expectedOldIdentity?.path)) {
    return { ok: false, error: "launch path does not match the observed app executable" };
  }
  await statFile(executablePath);
  const pid = await launch(executablePath);
  return { ok: true, method: "exact-executable", requestedPid: pid, executablePath };
}

export async function verifySchedulerAfterRestart({
  expectedNewIdentity,
  deadlineSeconds,
  workWasDue,
  before = {},
  beforeDueWorkflows = [],
  notBefore,
  capture,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  const notBeforeMs = validDate(notBefore);
  const deadline = now() + deadlineSeconds * 1_000;
  let result = { ok: false, error: "scheduler verification deadline expired" };
  do {
    const snapshot = await capture();
    if (!sameIdentity(snapshot.app.identity, expectedNewIdentity)) {
      result = { ok: false, error: "scheduler snapshot does not match the new app identity" };
    } else if (snapshot.scheduler.evidence !== "known") {
      result = { ok: false, error: "scheduler evidence is unknown" };
    } else if (!workWasDue && snapshot.scheduler.workDue === false) {
      return {
        ok: true,
        status: "ready-no-work-due",
        progressObserved: false,
        observedAt: snapshot.observedAt,
      };
    } else if (workWasDue) {
      const dispatched = beforeDueWorkflows.find((workflowId) => {
        const prior = before[workflowId] ?? null;
        const current = snapshot.scheduler.latestScheduledRuns?.[workflowId] ?? null;
        return (
          current &&
          current.id !== prior?.id &&
          notBeforeMs !== null &&
          validDate(current.startedAt) !== null &&
          validDate(current.startedAt) >= notBeforeMs
        );
      });
      if (dispatched) {
        return {
          ok: true,
          status: "resumed",
          progressObserved: true,
          workflowId: dispatched,
          scheduledRun: snapshot.scheduler.latestScheduledRuns[dispatched],
          observedAt: snapshot.observedAt,
        };
      }
      result = { ok: false, error: "work was due but no fresh scheduled dispatch was observed" };
    }
    if (now() >= deadline) break;
    await sleep(Math.min(500, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return result;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    if (!name?.startsWith("--")) throw new Error(`unexpected argument ${name}`);
    values[name.slice(2)] = rest[index + 1];
  }
  return values;
}

function identityFromArgs(args, prefix = "old") {
  return {
    pid: Number(args[`${prefix}-pid`]),
    startTime: args[`${prefix}-start-time`],
    path: args[`${prefix}-path`] ?? args.path,
  };
}

async function cli(argv) {
  const args = parseArgs(argv);
  let result;
  if (args.command === "snapshot") {
    result = await captureSnapshot({
      snapshotPath: args.snapshot,
      databasePath: args.db,
      sessionStorePath: args["session-store"],
      sessionStateDirectory: args["session-state"],
    });
    result = { ok: true, observedAt: result.observedAt };
  } else if (args.command === "shutdown") {
    result = await requestGracefulShutdown({
      expected: identityFromArgs(args),
      deadlineSeconds: Number(args.deadline),
      snapshotPath: args.snapshot,
      attemptId: args.attempt,
    });
  } else if (args.command === "force") {
    result = await forceTerminate({
      expected: identityFromArgs(args),
      authorization: args.authorization,
      deadlineSeconds: Number(args.deadline),
      dryRun: args["dry-run"] === "true",
      restartMode: args["restart-mode"],
    });
  } else if (args.command === "launch") {
    result = await launchExact({
      executablePath: args.path,
      expectedOldIdentity: identityFromArgs(args),
    });
  } else if (args.command === "readiness") {
    const oldIdentity = identityFromArgs(args);
    const deadline = Date.now() + Number(args.deadline) * 1_000;
    result = { ok: false, error: "readiness deadline expired" };
    do {
      const snapshot = await captureSnapshot({
        snapshotPath: args.snapshot,
        databasePath: args.db,
        sessionStorePath: args["session-store"],
        sessionStateDirectory: args["session-state"],
      });
      if (
        snapshot.app.running &&
        snapshot.app.evidence === "known" &&
        !sameIdentity(snapshot.app.identity, oldIdentity) &&
        snapshot.activity.complete
      ) {
        result = {
          ok: true,
          ready: true,
          identity: snapshot.app.identity,
          observedAt: snapshot.observedAt,
          databaseReady: true,
        };
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    } while (Date.now() <= deadline);
  } else if (args.command === "scheduler") {
    const expectedNewIdentity = identityFromArgs(args, "new");
    const workWasDue = args["work-was-due"] === "true";
    let before = {};
    try {
      before = JSON.parse(args.before || "{}");
    } catch {
      before = {};
    }
    let beforeDueWorkflows = [];
    try {
      beforeDueWorkflows = JSON.parse(args["before-due-workflows"] || "[]");
    } catch {
      beforeDueWorkflows = [];
    }
    result = await verifySchedulerAfterRestart({
      expectedNewIdentity,
      deadlineSeconds: Number(args.deadline),
      workWasDue,
      before,
      beforeDueWorkflows,
      notBefore: args["not-before"],
      capture: () => captureSnapshot({
        snapshotPath: args.snapshot,
        databasePath: args.db,
        sessionStorePath: args["session-store"],
        sessionStateDirectory: args["session-state"],
      }),
    });
  } else {
    throw new Error(`unknown command ${args.command}`);
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  return result?.ok === false ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`windows-app-actuator: ${error.message}\n`);
      process.exitCode = 2;
    });
}
