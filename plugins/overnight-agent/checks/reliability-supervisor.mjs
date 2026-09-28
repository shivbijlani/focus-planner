import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const HARD_RESTART_AUTHORIZATION = "explicit-user-approval:hard-preventive-deadline";

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  preventiveRestart: {
    targetIntervalHours: 3,
    hardIntervalHours: 4,
    quietWindowMinutes: 15,
  },
  appRestart: {
    minIntervalMinutes: 60,
    forceTerminationAuthorization: "explicit-user-approval:upstream-style-practical-baseline",
  },
  supervisor: {
    enabled: true,
    checkIntervalSeconds: 900,
    heartbeatIntervalSeconds: 15,
    lockLeaseSeconds: 120,
    replacementDeadlineSeconds: 300,
    replacementRetrySeconds: 1,
    inputPath: null,
  },
  stuckRunRepair: {
    autoRepairStuckRuns: true,
    graceMinutes: 20,
    silenceMinutes: 15,
    confirmationMinutes: 60,
    firstEventDeadlineSeconds: 60,
    databasePath: null,
    sessionStateDirectory: null,
    sessionStorePath: null,
    backupDirectory: null,
  },
  startup: {
    shutdownDeadlineSeconds: 60,
    forceTerminationDeadlineSeconds: 180,
    readinessDeadlineSeconds: 120,
    schedulerVerificationDeadlineSeconds: 120,
    retryBackoffSeconds: 5,
    attemptBudget: 3,
    snapshotPollIntervalSeconds: 1,
  },
  evidence: {
    maxItems: 32,
    maxStringLength: 2_048,
    maxAttempts: 100,
  },
  commands: {
    snapshot: null,
    requestShutdown: null,
    forceTerminate: null,
    launch: null,
    readiness: null,
    verifyScheduler: null,
  },
});

const ACTIVE_FLAGS = [
  ["pendingHuman", "pending-human-interaction"],
  ["liveTool", "live-tool"],
  ["backgroundWork", "background-work"],
  ["startup", "startup"],
  ["newInteractiveTurn", "new-interactive-turn"],
];

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_RUN_STATES = new Set(["pending", "running", "starting", "draining"]);
const ACTIVITY_VERDICTS = new Set(["idle", "active", "unknown", "excluded"]);

const milliseconds = {
  minutes: (value) => value * 60_000,
  hours: (value) => value * 3_600_000,
  seconds: (value) => value * 1_000,
};

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeKnown(defaults, supplied, path = "config") {
  if (!plainObject(supplied)) throw new Error(`${path} must be an object`);
  const merged = {};
  for (const key of Object.keys(supplied)) {
    if (!(key in defaults)) throw new Error(`${path}.${key} is not supported`);
  }
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in supplied)) {
      merged[key] = clone(defaultValue);
    } else if (plainObject(defaultValue)) {
      merged[key] = mergeKnown(defaultValue, supplied[key], `${path}.${key}`);
    } else {
      merged[key] = supplied[key];
    }
  }
  return merged;
}

function finiteNumber(value, path, { min, max, integer = false }) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${path} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
}

function validateCommand(command, path) {
  if (command === null) return;
  if (
    !plainObject(command) ||
    typeof command.file !== "string" ||
    command.file.trim() === "" ||
    (command.args !== undefined &&
      (!Array.isArray(command.args) || command.args.some((item) => typeof item !== "string")))
  ) {
    throw new Error(`${path} must be null or { file, args?: string[] }`);
  }
}

function normalizeLegacyConfig(input) {
  const normalized = clone(input);
  let migrated = false;
  // These knobs only coordinated external helpers; the host never honored them.
  if (plainObject(normalized) && "drain" in normalized) {
    delete normalized.drain;
    migrated = true;
  }
  for (const name of ["acquireAdmissionLease", "renewAdmissionLease", "releaseAdmissionLease"]) {
    if (plainObject(normalized?.commands) && name in normalized.commands) {
      delete normalized.commands[name];
      migrated = true;
    }
  }
  if (plainObject(normalized?.preventiveRestart) && "enabled" in normalized.preventiveRestart) {
    if (typeof normalized.preventiveRestart.enabled !== "boolean") {
      throw new Error("config.preventiveRestart.enabled must be boolean");
    }
    delete normalized.preventiveRestart.enabled;
    migrated = true;
  }
  if (plainObject(normalized?.appRestart) && "allowForceTerminate" in normalized.appRestart) {
    if (typeof normalized.appRestart.allowForceTerminate !== "boolean") {
      throw new Error("config.appRestart.allowForceTerminate must be boolean");
    }
    delete normalized.appRestart.allowForceTerminate;
    migrated = true;
  }
  return { normalized, migrated };
}

export function validateConfig(input = {}) {
  const { normalized } = normalizeLegacyConfig(input);
  const config = mergeKnown(DEFAULT_CONFIG, normalized);
  if (config.version !== 1) throw new Error("config.version must be 1");
  if (
    typeof config.appRestart.forceTerminationAuthorization !== "string" ||
    config.appRestart.forceTerminationAuthorization.trim() === ""
  ) {
    throw new Error("config.appRestart.forceTerminationAuthorization must be a non-empty string");
  }
  if (typeof config.supervisor.enabled !== "boolean") {
    throw new Error("config.supervisor.enabled must be boolean");
  }
  if (typeof config.stuckRunRepair.autoRepairStuckRuns !== "boolean") {
    throw new Error("config.stuckRunRepair.autoRepairStuckRuns must be boolean");
  }
  finiteNumber(config.preventiveRestart.targetIntervalHours, "config.preventiveRestart.targetIntervalHours", {
    min: 1 / 60,
    max: 168,
  });
  if (!Object.hasOwn(normalized.preventiveRestart ?? {}, "hardIntervalHours")) {
    config.preventiveRestart.hardIntervalHours = Math.max(
      DEFAULT_CONFIG.preventiveRestart.hardIntervalHours,
      config.preventiveRestart.targetIntervalHours >= DEFAULT_CONFIG.preventiveRestart.hardIntervalHours
        ? config.preventiveRestart.targetIntervalHours + 2
        : DEFAULT_CONFIG.preventiveRestart.hardIntervalHours,
      config.appRestart.minIntervalMinutes / 60,
    );
  }
  finiteNumber(config.preventiveRestart.hardIntervalHours, "config.preventiveRestart.hardIntervalHours", {
    min: 1,
    max: 170,
  });
  if (config.preventiveRestart.hardIntervalHours <= config.preventiveRestart.targetIntervalHours) {
    throw new Error("config.preventiveRestart.hardIntervalHours must exceed targetIntervalHours");
  }
  finiteNumber(config.preventiveRestart.quietWindowMinutes, "config.preventiveRestart.quietWindowMinutes", {
    min: 5,
    max: 240,
  });
  finiteNumber(config.appRestart.minIntervalMinutes, "config.appRestart.minIntervalMinutes", {
    min: 1,
    max: 1_440,
  });
  if (config.preventiveRestart.hardIntervalHours * 60 < config.appRestart.minIntervalMinutes) {
    throw new Error("config.preventiveRestart.hardIntervalHours must cover the restart cooldown");
  }
  finiteNumber(config.supervisor.checkIntervalSeconds, "config.supervisor.checkIntervalSeconds", {
    min: 5,
    max: 3_600,
  });
  finiteNumber(
    config.supervisor.heartbeatIntervalSeconds,
    "config.supervisor.heartbeatIntervalSeconds",
    { min: 5, max: 300 },
  );
  finiteNumber(config.supervisor.lockLeaseSeconds, "config.supervisor.lockLeaseSeconds", {
    min: 15,
    max: 900,
  });
  finiteNumber(
    config.supervisor.replacementDeadlineSeconds,
    "config.supervisor.replacementDeadlineSeconds",
    { min: 5, max: 3_600 },
  );
  finiteNumber(
    config.supervisor.replacementRetrySeconds,
    "config.supervisor.replacementRetrySeconds",
    { min: 0.05, max: 30 },
  );
  finiteNumber(config.startup.shutdownDeadlineSeconds, "config.startup.shutdownDeadlineSeconds", {
    min: 5,
    max: 900,
  });
  finiteNumber(
    config.startup.forceTerminationDeadlineSeconds,
    "config.startup.forceTerminationDeadlineSeconds",
    { min: 1, max: 300 },
  );
  finiteNumber(config.startup.readinessDeadlineSeconds, "config.startup.readinessDeadlineSeconds", {
    min: 5,
    max: 900,
  });
  finiteNumber(
    config.startup.schedulerVerificationDeadlineSeconds,
    "config.startup.schedulerVerificationDeadlineSeconds",
    { min: 5, max: 900 },
  );
  finiteNumber(config.startup.retryBackoffSeconds, "config.startup.retryBackoffSeconds", {
    min: 0,
    max: 300,
  });
  finiteNumber(config.startup.attemptBudget, "config.startup.attemptBudget", {
    min: 1,
    max: 10,
    integer: true,
  });
  finiteNumber(
    config.startup.snapshotPollIntervalSeconds,
    "config.startup.snapshotPollIntervalSeconds",
    { min: 0.01, max: 30 },
  );
  finiteNumber(config.evidence.maxItems, "config.evidence.maxItems", {
    min: 1,
    max: 200,
    integer: true,
  });
  finiteNumber(config.evidence.maxStringLength, "config.evidence.maxStringLength", {
    min: 128,
    max: 32_768,
    integer: true,
  });
  finiteNumber(config.evidence.maxAttempts, "config.evidence.maxAttempts", {
    min: 10,
    max: 1_000,
    integer: true,
  });
  finiteNumber(config.stuckRunRepair.graceMinutes, "config.stuckRunRepair.graceMinutes", {
    min: 0,
    max: 1_440,
  });
  finiteNumber(config.stuckRunRepair.silenceMinutes, "config.stuckRunRepair.silenceMinutes", {
    min: 0,
    max: 1_440,
  });
  finiteNumber(config.stuckRunRepair.confirmationMinutes, "config.stuckRunRepair.confirmationMinutes", {
    min: 0.01,
    max: 1_440,
  });
  finiteNumber(
    config.stuckRunRepair.firstEventDeadlineSeconds,
    "config.stuckRunRepair.firstEventDeadlineSeconds",
    { min: 1, max: 86_400 },
  );
  for (const [name, value] of Object.entries({
    "config.supervisor.inputPath": config.supervisor.inputPath,
    "config.stuckRunRepair.databasePath": config.stuckRunRepair.databasePath,
    "config.stuckRunRepair.sessionStateDirectory": config.stuckRunRepair.sessionStateDirectory,
    "config.stuckRunRepair.sessionStorePath": config.stuckRunRepair.sessionStorePath,
    "config.stuckRunRepair.backupDirectory": config.stuckRunRepair.backupDirectory,
  })) {
    if (value !== null && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`${name} must be null or a non-empty path`);
    }
  }
  for (const [name, command] of Object.entries(config.commands)) {
    validateCommand(command, `config.commands.${name}`);
  }
  return config;
}

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]);

async function rawFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function concurrentWriteError(path) {
  const error = new Error(`refusing to overwrite concurrently changed JSON at ${path}`);
  error.code = "CONCURRENT_MODIFICATION";
  return error;
}

export function jsonSwapPaths(path) {
  return {
    backup: `${path}.swap-backup`,
    intent: `${path}.swap-intent`,
    writerLock: `${path}.writer.lock`,
  };
}

async function retryRename(
  source,
  destination,
  {
    renameFile,
    sleep,
    renameAttempts,
    retryDelayMs,
  },
) {
  let lastError;
  for (let attempt = 1; attempt <= renameAttempts; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt === renameAttempts) throw error;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

async function writeIntent(path, value) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoverJsonSwapUnderLock(
  path,
  {
    renameFile = rename,
    sleep = wait,
    renameAttempts = process.platform === "win32" ? 8 : 3,
    retryDelayMs = 25,
  } = {},
) {
  const paths = jsonSwapPaths(path);
  const canonical = await rawFile(path);
  const backup = await rawFile(paths.backup);
  const intentRaw = await rawFile(paths.intent);

  if (canonical === null && backup !== null) {
    await retryRename(paths.backup, path, {
      renameFile,
      sleep,
      renameAttempts,
      retryDelayMs,
    });
    await rm(paths.intent, { force: true });
    return { recovered: true, action: "restored-backup" };
  }
  if (canonical === null && intentRaw !== null) {
    const error = new Error(`interrupted JSON swap for ${path} has intent but no recoverable backup`);
    error.code = "SWAP_RECOVERY_FAILED";
    throw error;
  }
  if (canonical !== null && backup !== null) {
    let intent;
    try {
      intent = JSON.parse((intentRaw ?? "").replace(/^\uFEFF/, ""));
    } catch {
      intent = null;
    }
    const canonicalHash = createHash("sha256").update(canonical).digest("hex");
    if (!intent || intent.targetHash !== canonicalHash) {
      const error = new Error(
        `ambiguous interrupted JSON swap for ${path}; canonical and recovery backup were preserved`,
      );
      error.code = "SWAP_RECOVERY_AMBIGUOUS";
      throw error;
    }
    await rm(paths.backup, { force: true });
    await rm(paths.intent, { force: true });
    return { recovered: true, action: "completed-cleanup" };
  }
  if (intentRaw !== null) {
    await rm(paths.intent, { force: true });
    return { recovered: true, action: "cleared-unstarted-intent" };
  }
  return { recovered: false, action: null };
}

async function acquireJsonWriterLease(path, { sleep = wait, writerWaitMs = 20_000 } = {}) {
  const lockPath = jsonSwapPaths(path).writerLock;
  const deadline = Date.now() + writerWaitMs;
  for (;;) {
    try {
      return await acquireExclusiveLock(lockPath, {
        leaseSeconds: 15,
        owner: `json-writer-${process.pid}-${randomUUID()}`,
      });
    } catch (error) {
      if (!["LOCKED", "ENOENT"].includes(error?.code) || Date.now() >= deadline) throw error;
      await sleep(25);
    }
  }
}

export async function recoverInterruptedJsonSwap(path, options = {}) {
  const writer = await acquireJsonWriterLease(path, options);
  try {
    await writer.assertOwned();
    return await recoverJsonSwapUnderLock(path, options);
  } finally {
    await writer.release();
  }
}

export async function atomicJsonWrite(
  path,
  value,
  {
    expectedRaw,
    renameFile = rename,
    sleep = wait,
    renameAttempts = process.platform === "win32" ? 8 : 3,
    retryDelayMs = 25,
    writerWaitMs = 20_000,
  } = {},
) {
  await mkdir(dirname(path), { recursive: true });
  const writer = await acquireJsonWriterLease(path, { sleep, writerWaitMs });
  const swapPaths = jsonSwapPaths(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.new`;
  try {
    await writer.assertOwned();
    await recoverJsonSwapUnderLock(path, {
      renameFile,
      sleep,
      renameAttempts,
      retryDelayMs,
    });
    const observedRaw = expectedRaw === undefined ? await rawFile(path) : expectedRaw;
    if ((await rawFile(path)) !== observedRaw) throw concurrentWriteError(path);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await writer.assertOwned();
    if (observedRaw === null) {
      if ((await rawFile(path)) !== null) throw concurrentWriteError(path);
      await retryRename(temporary, path, {
        renameFile,
        sleep,
        renameAttempts,
        retryDelayMs,
      });
      return;
    }

    await writeIntent(swapPaths.intent, {
      version: 1,
      path,
      expectedHash: createHash("sha256").update(observedRaw).digest("hex"),
      targetHash: createHash("sha256").update(serialized).digest("hex"),
      startedAt: iso(Date.now()),
    });
    if ((await rawFile(path)) !== observedRaw) throw concurrentWriteError(path);
    await retryRename(path, swapPaths.backup, {
      renameFile,
      sleep,
      renameAttempts,
      retryDelayMs,
    });
    if ((await rawFile(swapPaths.backup)) !== observedRaw) {
      if ((await rawFile(path)) === null) {
        await retryRename(swapPaths.backup, path, {
          renameFile,
          sleep,
          renameAttempts,
          retryDelayMs,
        });
        await rm(swapPaths.intent, { force: true });
      }
      throw concurrentWriteError(path);
    }

    let installed = false;
    try {
      if ((await rawFile(path)) !== null) throw concurrentWriteError(path);
      await retryRename(temporary, path, {
        renameFile,
        sleep,
        renameAttempts,
        retryDelayMs,
      });
      installed = true;
    } catch (error) {
      if ((await rawFile(path)) === null) {
        try {
          await retryRename(swapPaths.backup, path, {
            renameFile,
            sleep,
            renameAttempts,
            retryDelayMs,
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `JSON swap failed and rollback could not restore ${path}; backup remains at ${swapPaths.backup}`,
          );
        }
      } else {
        throw new AggregateError(
          [error],
          `JSON swap encountered a concurrent replacement at ${path}; original backup remains at ${swapPaths.backup}`,
        );
      }
      throw error;
    } finally {
      if (installed) {
        await rm(swapPaths.backup, { force: true });
        await rm(swapPaths.intent, { force: true });
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    await writer.release();
  }
}

export async function loadConfig(path, { create = true } = {}) {
  try {
    await recoverInterruptedJsonSwap(path);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const { normalized, migrated } = normalizeLegacyConfig(parsed);
    const config = validateConfig(normalized);
    if (migrated || JSON.stringify(normalized) !== JSON.stringify(config)) {
      await atomicJsonWrite(path, config, { expectedRaw: raw });
    }
    return config;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`invalid supervisor config ${path}: ${error.message}`);
    const config = validateConfig({});
    if (create) await atomicJsonWrite(path, config, { expectedRaw: null });
    return config;
  }
}

export function initialState() {
  return {
    version: 1,
    attempts: [],
    activeAttempt: null,
    lastObservedApp: null,
    lastSuccessfulRestartAt: null,
    restartCycleStartedAt: null,
    updatedAt: null,
  };
}

export async function loadState(path) {
  try {
    const state = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (!plainObject(state) || state.version !== 1 || !Array.isArray(state.attempts)) {
      throw new Error("unsupported state shape");
    }
    if (state.restartCycleStartedAt != null && validDate(state.restartCycleStartedAt) === null) {
      throw new Error("restartCycleStartedAt must be a valid timestamp");
    }
    return { ...initialState(), ...state };
  } catch (error) {
    if (error?.code === "ENOENT") return initialState();
    throw new Error(`invalid supervisor state ${path}: ${error.message}`);
  }
}

function validDate(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

function bounded(value, config, depth = 0) {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") return value.slice(0, config.evidence.maxStringLength);
  if (Array.isArray(value)) {
    return value.slice(0, config.evidence.maxItems).map((item) => bounded(item, config, depth + 1));
  }
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, config.evidence.maxItems)
        .map(([key, item]) => [key, bounded(item, config, depth + 1)]),
    );
  }
  return value;
}

export function classifyActivity(item, { nowMs = Date.now(), quietWindowMinutes = 15 } = {}) {
  const id = item?.id ?? "unknown";
  if (!plainObject(item)) return { id, verdict: "unknown", reasons: ["invalid-evidence"] };

  for (const [field, reason] of ACTIVE_FLAGS) {
    if (item[field] === true) return { id, verdict: "active", reasons: [reason] };
  }

  if (item.activity === "active") return { id, verdict: "active", reasons: ["reported-active"] };
  if (item.activity === "unknown") return { id, verdict: "unknown", reasons: ["reported-unknown"] };
  if (item.executionTerminal === true) {
    return {
      id,
      verdict: "excluded",
      reasons: ["corroborated-terminal-session-event"],
      evidence: item.evidence ?? null,
    };
  }
  if (item.liveness === "unknown" || item.liveness === undefined || item.liveness === null) {
    return { id, verdict: "unknown", reasons: ["liveness-unknown"] };
  }

  const state = String(item.status ?? "unknown").toLowerCase();
  if (item.confirmedWedged === true) {
    if (item.safelyDisposed === true && item.eventCount === 0) {
      return {
        id,
        verdict: "excluded",
        reasons: ["confirmed-wedged-safely-disposed-zero-event"],
      };
    }
    return {
      id,
      verdict: item.safelyDisposed === true ? "unknown" : "active",
      reasons: [item.safelyDisposed === true ? "wedged-disposition-incomplete" : "wedged-work-not-safely-disposed"],
    };
  }

  if (ACTIVE_RUN_STATES.has(state) && item.ownerProvablyDead !== true) {
    return { id, verdict: "active", reasons: [`run-${state}`] };
  }
  if (!TERMINAL_RUN_STATES.has(state) && item.ownerProvablyDead !== true) {
    return { id, verdict: "unknown", reasons: [`run-state-${state}`] };
  }
  if (item.remainingWork === true || item.draftsPreserved === false) {
    return { id, verdict: "active", reasons: [item.remainingWork ? "remaining-work" : "drafts-not-preserved"] };
  }

  const lastActivityMs = validDate(item.lastActivityAt);
  if (lastActivityMs === null) return { id, verdict: "unknown", reasons: ["last-activity-unknown"] };
  const quietForMs = Math.max(0, nowMs - lastActivityMs);
  if (quietForMs < milliseconds.minutes(quietWindowMinutes)) {
    return { id, verdict: "active", reasons: ["inside-quiet-window"], quietForMs };
  }
  return { id, verdict: "idle", reasons: ["verified-quiet"], quietForMs };
}

export function assessActivity(snapshot, config, nowMs = Date.now()) {
  if (!plainObject(snapshot) || snapshot.complete !== true || !Array.isArray(snapshot.sessions)) {
    return {
      verdict: "unknown",
      reasons: ["activity-snapshot-unavailable"],
      items: [],
      exclusions: [],
      admissionVersion: snapshot?.admissionVersion ?? null,
    };
  }
  const items = snapshot.sessions.map((item) =>
    classifyActivity(item, {
      nowMs,
      quietWindowMinutes: config.preventiveRestart.quietWindowMinutes,
    }),
  );
  const exclusions = items.filter((item) => item.verdict === "excluded");
  const considered = items.filter((item) => item.verdict !== "excluded");
  let verdict = "idle";
  if (considered.some((item) => item.verdict === "active")) verdict = "active";
  else if (considered.some((item) => item.verdict === "unknown")) verdict = "unknown";
  const quietSinceMs = validDate(snapshot.quietObservedSince);
  const continuousQuietMs = quietSinceMs === null ? null : Math.max(0, nowMs - quietSinceMs);
  if (verdict === "idle" && quietSinceMs === null) {
    verdict = "unknown";
  } else if (
    verdict === "idle" &&
    continuousQuietMs < milliseconds.minutes(config.preventiveRestart.quietWindowMinutes)
  ) {
    verdict = "active";
  }
  return {
    verdict,
    reasons:
      verdict === "idle"
        ? ["all-activity-verified-continuously-quiet"]
        : quietSinceMs === null && considered.every((item) => item.verdict === "idle")
          ? ["continuous-quiet-start-unknown"]
          : continuousQuietMs !== null &&
              continuousQuietMs < milliseconds.minutes(config.preventiveRestart.quietWindowMinutes) &&
              considered.every((item) => item.verdict === "idle")
            ? ["continuous-quiet-window-not-reached"]
        : considered.filter((item) => item.verdict === verdict).flatMap((item) => item.reasons),
    items,
    exclusions,
    admissionVersion: snapshot.admissionVersion ?? null,
    quietObservedSince: snapshot.quietObservedSince ?? null,
    continuousQuietMs,
  };
}

export function restartCycleStatus(state, config) {
  const start = validDate(state.restartCycleStartedAt);
  if (start === null) return null;
  return {
    startedAt: iso(start),
    opportunityAt: iso(start + milliseconds.hours(config.preventiveRestart.targetIntervalHours)),
    hardDeadlineAt: iso(start + milliseconds.hours(config.preventiveRestart.hardIntervalHours)),
  };
}

function validIdentity(identity) {
  return plainObject(identity) && Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    validDate(identity.startTime) !== null && typeof identity.path === "string" &&
    /(?:^|[\\/])(?:github|githubcopilot|github copilot)\.exe$/i.test(identity.path);
}

function sameTarget(app, expected) {
  return app?.running === true && app.evidence === "known" && app.intentionalClosure !== true &&
    validIdentity(app.identity) && validIdentity(expected) &&
    app.identity.pid === expected.pid &&
    validDate(app.identity.startTime) === validDate(expected.startTime) &&
    resolve(app.identity.path).toLowerCase() === resolve(expected.path).toLowerCase();
}

export function determineReason(input, config, state, nowMs = Date.now()) {
  const app = input?.app;
  if (app?.intentionalClosure === true) {
    return { due: false, reason: null, blockedBy: "intentional-closure" };
  }
  if (!app?.running) {
    return { due: false, reason: null, blockedBy: "app-not-running" };
  }
  const observedStart = validDate(state.restartCycleStartedAt ?? app.startedAt);
  if (observedStart === null) {
    return { due: false, reason: null, blockedBy: "app-age-unknown" };
  }
  const ageMs = nowMs - observedStart;
  const requestReasons = Array.isArray(input?.recoveryRequest?.reasons)
    ? input.recoveryRequest.reasons.filter(Boolean)
    : [];
  const preventiveDue = ageMs >= milliseconds.hours(config.preventiveRestart.targetIntervalHours);
  if (!preventiveDue && requestReasons.length === 0) {
    return { due: false, reason: null, blockedBy: "target-age-not-reached", ageMs };
  }
  const hard = ageMs >= milliseconds.hours(config.preventiveRestart.hardIntervalHours);
  const reasons = [...new Set([
    ...requestReasons,
    ...(preventiveDue ? [hard ? "preventive-hard-deadline" : "preventive-quiet-opportunity"] : []),
  ])];
  const force = hard || requestReasons.includes("confirmed-stall") ||
    requestReasons.includes("consumer-urgent-recovery");
  return {
    due: true,
    reason: reasons.join("+"),
    reasons,
    requestId: input?.recoveryRequest?.id ?? null,
    trigger: requestReasons.length ? "durable-recovery-request" : hard ? "hard-deadline" : "quiet-opportunity",
    restartMode: force ? "hard-deadline" : "quiet-opportunity",
    ageMs,
  };
}

export function cooldownStatus(state, config, nowMs = Date.now()) {
  const latest = [...state.attempts]
    .filter((attempt) => attempt.restartIntentPersisted === true)
    .map((attempt) => validDate(attempt.restartIntentAt ?? attempt.attemptedAt))
    .filter((value) => value !== null)
    .sort((a, b) => b - a)[0];
  if (latest === undefined) return { allowed: true, remainingMs: 0 };
  const remainingMs = latest + milliseconds.minutes(config.appRestart.minIntervalMinutes) - nowMs;
  return { allowed: remainingMs <= 0, remainingMs: Math.max(0, remainingMs), lastAttemptMs: latest };
}

export function reclamationClaimPath(lockPath, observedRaw) {
  const fingerprint = createHash("sha256").update(observedRaw).digest("hex");
  return `${lockPath}.reclaim.${fingerprint}`;
}

function lockedError(message) {
  const error = new Error(message);
  error.code = "LOCKED";
  return error;
}

async function acquireReclamationClaim(
  claimPath,
  {
    owner,
    now,
    leaseSeconds,
    observedOwner,
    observedGeneration,
  },
) {
  const generation = randomUUID();
  const claimLeaseSeconds = Math.min(30, Math.max(5, leaseSeconds / 3));
  const claimRecord = () => ({
    owner,
    generation,
    observedOwner,
    observedGeneration,
    acquiredAt: iso(now()),
    expiresAt: iso(now() + milliseconds.seconds(claimLeaseSeconds)),
  });
  const createClaim = async () => {
    const handle = await open(claimPath, "wx");
    await handle.writeFile(`${JSON.stringify(claimRecord())}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return {
      owner,
      generation,
      async assertOwned() {
        const current = JSON.parse((await readFile(claimPath, "utf8")).replace(/^\uFEFF/, ""));
        if (current.owner !== owner || current.generation !== generation) {
          throw new Error("expired-lock reclamation claim ownership was lost");
        }
      },
      async release() {
        try {
          const current = JSON.parse((await readFile(claimPath, "utf8")).replace(/^\uFEFF/, ""));
          if (current.owner === owner && current.generation === generation) {
            await rm(claimPath, { force: true });
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      },
    };
  };

  for (let pass = 0; pass < 3; pass += 1) {
    try {
      return await createClaim();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let observedRaw;
    let observed;
    try {
      observedRaw = await readFile(claimPath, "utf8");
      observed = JSON.parse(observedRaw.replace(/^\uFEFF/, ""));
    } catch {
      throw lockedError("expired-lock reclamation claim is unreadable");
    }
    const legacyExpiry = (await stat(claimPath)).mtimeMs +
      milliseconds.seconds(claimLeaseSeconds);
    const expiresAt = validDate(observed.expiresAt) ?? legacyExpiry;
    if (expiresAt > now()) {
      throw lockedError("expired-lock reclamation is already claimed");
    }

    const claimFingerprint = createHash("sha256").update(observedRaw).digest("hex");
    const tombstone = `${claimPath}.expired.${claimFingerprint}.${randomUUID()}`;
    let verifiedTombstone = false;
    try {
      try {
        await rename(claimPath, tombstone);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      const movedRaw = await readFile(tombstone, "utf8");
      if (movedRaw !== observedRaw) {
        try {
          await rename(tombstone, claimPath);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        throw lockedError("expired-lock reclamation claim changed during takeover");
      }
      verifiedTombstone = true;
      try {
        return await createClaim();
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw lockedError("expired-lock reclamation was claimed concurrently");
        }
        throw error;
      }
    } finally {
      if (verifiedTombstone) await rm(tombstone, { force: true }).catch(() => {});
    }
  }
  throw lockedError("expired-lock reclamation could not acquire its claim");
}

export async function acquireExclusiveLock(path, {
  now = () => Date.now(),
  leaseSeconds = DEFAULT_CONFIG.supervisor.lockLeaseSeconds,
  owner = `${process.pid}-${randomUUID()}`,
} = {}) {
  await mkdir(dirname(path), { recursive: true });
  const generation = randomUUID();
  const acquiredAt = iso(now());
  const record = () => ({
    owner,
    generation,
    acquiredAt,
    expiresAt: iso(now() + milliseconds.seconds(leaseSeconds)),
  });

  const openOwnedLock = async () => {
    const handle = await open(path, "wx");
    const initial = `${JSON.stringify(record())}\n`;
    await handle.writeFile(initial, "utf8");
    await handle.sync();
    let released = false;
    let lostError = null;
    let renewal = Promise.resolve();
    const verifyOwnership = async () => {
      if (lostError) throw lostError;
      const current = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
      if (current.owner !== owner || current.generation !== generation) {
        throw new Error("supervisor lock ownership was lost");
      }
      return current;
    };
    const renew = async () => {
      if (released) return;
      try {
        await verifyOwnership();
        const content = Buffer.from(`${JSON.stringify(record())}\n`, "utf8");
        await handle.truncate(0);
        await handle.write(content, 0, content.length, 0);
        await handle.sync();
        await verifyOwnership();
      } catch (error) {
        lostError = error;
        throw error;
      }
    };
    const heartbeat = setInterval(() => {
      renewal = renewal.then(renew).catch((error) => {
        lostError = error;
      });
    }, Math.max(1_000, Math.floor(milliseconds.seconds(leaseSeconds) / 3)));
    heartbeat.unref?.();
    return {
      owner,
      generation,
      renew,
      async assertOwned() {
        await renewal;
        return verifyOwnership();
      },
      async release() {
        released = true;
        clearInterval(heartbeat);
        await renewal.catch(() => {});
        await handle.close();
        try {
          const current = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
          if (current.owner === owner && current.generation === generation) {
            await rm(path, { force: true });
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      },
    };
  };

  try {
    return await openOwnedLock();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let observedRaw;
  let existing;
  try {
    observedRaw = await readFile(path, "utf8");
    existing = JSON.parse(observedRaw.replace(/^\uFEFF/, ""));
  } catch {
    const details = await stat(path);
    existing = { expiresAt: iso(details.mtimeMs + milliseconds.seconds(leaseSeconds)) };
    observedRaw = null;
  }
  if ((validDate(existing.expiresAt) ?? Number.POSITIVE_INFINITY) > now()) {
    throw lockedError("supervisor lock is held");
  }
  if (!observedRaw || !existing.owner || !existing.generation) {
    throw lockedError("expired supervisor lock has no verifiable ownership token");
  }

  const fingerprint = createHash("sha256").update(observedRaw).digest("hex");
  const claimPath = reclamationClaimPath(path, observedRaw);
  const claim = await acquireReclamationClaim(claimPath, {
    owner,
    now,
    leaseSeconds,
    observedOwner: existing.owner,
    observedGeneration: existing.generation,
  });

  const tombstone = `${path}.expired.${fingerprint}.${randomUUID()}`;
  let tombstoneVerified = false;
  try {
    await claim.assertOwned();
    const currentRaw = await readFile(path, "utf8");
    if (currentRaw !== observedRaw) {
      throw lockedError("supervisor lock changed before expired-lock takeover");
    }
    await rename(path, tombstone);
    const movedRaw = await readFile(tombstone, "utf8");
    if (movedRaw !== observedRaw) {
      throw lockedError("expired-lock takeover moved an unexpected owner");
    }
    tombstoneVerified = true;
    await claim.assertOwned();
    try {
      return await openOwnedLock();
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw lockedError("supervisor lock is held");
      }
      throw error;
    }
  } finally {
    if (tombstoneVerified) await rm(tombstone, { force: true }).catch(() => {});
    await claim.release();
  }
}

function attemptPolicy(config) {
  return {
    preventiveBaseline: true,
    targetIntervalHours: config.preventiveRestart.targetIntervalHours,
    hardIntervalHours: config.preventiveRestart.hardIntervalHours,
    hardRestartAuthorization: HARD_RESTART_AUTHORIZATION,
    quietWindowMinutes: config.preventiveRestart.quietWindowMinutes,
    minIntervalMinutes: config.appRestart.minIntervalMinutes,
    startupAttemptBudget: config.startup.attemptBudget,
    forceTerminationAllowed: true,
    forceTerminationAuthorization: config.appRestart.forceTerminationAuthorization,
  };
}

function newAttempt(reason, trigger, config, input, nowMs) {
  return {
    id: randomUUID(),
    attemptedAt: iso(nowMs),
    completedAt: null,
    phase: "evaluating",
    outcome: "in-progress",
    restartIntentPersisted: false,
    reason,
    trigger,
    policy: attemptPolicy(config),
    activity: [],
    exclusions: [],
    oldIdentity: bounded(input.app?.identity ?? null, config),
    newIdentity: null,
    shutdown: null,
    startup: [],
    readiness: null,
    schedulerVerification: null,
    evidence: bounded(input.evidence ?? {}, config),
    error: null,
  };
}

async function saveState(path, state, config, nowMs) {
  state.updatedAt = iso(nowMs);
  if (state.attempts.length > config.evidence.maxAttempts) {
    state.attempts = state.attempts.slice(-config.evidence.maxAttempts);
  }
  await atomicJsonWrite(path, state);
}

async function appendAudit(path, attempt) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(attempt)}\n`, "utf8");
}

function updateAttempt(state, attempt) {
  const index = state.attempts.findIndex((item) => item.id === attempt.id);
  if (index === -1) state.attempts.push(attempt);
  else state.attempts[index] = attempt;
  state.activeAttempt = attempt.outcome === "in-progress" ? attempt.id : null;
}

function result(status, extra = {}) {
  return { status, ...extra };
}

function timeoutResult(value, label) {
  if (value === false || value?.ok === false) {
    throw new Error(value?.error ?? `${label} did not complete`);
  }
  return value ?? { ok: true };
}

async function wait(millisecondsToWait) {
  if (millisecondsToWait <= 0) return;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, millisecondsToWait));
}

export function createSupervisor({
  config,
  statePath,
  lockPath = resolve(dirname(statePath), "reliability-supervisor-action.lock"),
  auditPath = `${statePath}.audit.jsonl`,
  adapters,
  clock = { now: () => Date.now(), sleep: wait },
}) {
  const policy = validateConfig(config);
  let activeLock = null;
  const required = [
    "inspect",
    "requestShutdown",
    "awaitShutdown",
    "forceShutdown",
    "launch",
    "awaitReady",
    "verifyScheduler",
  ];
  for (const name of required) {
    if (typeof adapters?.[name] !== "function") throw new Error(`adapter ${name} is required`);
  }

  async function persist(state, attempt) {
    await activeLock?.assertOwned();
    updateAttempt(state, attempt);
    await saveState(statePath, state, policy, clock.now());
  }

  async function complete(state, attempt, outcome, error = null) {
    attempt.phase = "complete";
    attempt.outcome = outcome;
    attempt.completedAt = iso(clock.now());
    attempt.error = error ? String(error.message ?? error).slice(0, policy.evidence.maxStringLength) : null;
    await persist(state, attempt);
    await appendAudit(auditPath, attempt);
  }

  async function run(input = {}) {
    let lock;
    try {
      lock = await acquireExclusiveLock(lockPath, {
        now: clock.now,
        leaseSeconds: policy.supervisor.lockLeaseSeconds,
      });
      activeLock = lock;
      await lock.assertOwned();
    } catch (error) {
      if (error.code === "LOCKED") return result("locked");
      throw error;
    }

    try {
      const state = await loadState(statePath);
      const latestFailedReset = [...state.attempts].reverse().find((attempt) =>
        ["failed", "in-progress", "aborted-supervisor-crash"].includes(attempt.outcome) &&
        attempt.restartIntentPersisted === true &&
        validDate(attempt.cycleResetAt) !== null &&
        validDate(attempt.cycleBefore?.startedAt) !== null,
      );
      if (
        latestFailedReset &&
        validDate(state.restartCycleStartedAt) === validDate(latestFailedReset.cycleResetAt)
      ) {
        state.restartCycleStartedAt = latestFailedReset.cycleBefore.startedAt;
        await lock.assertOwned();
        await saveState(statePath, state, policy, clock.now());
      }
      const respond = (status, extra = {}) => result(status, {
        cycle: restartCycleStatus(state, policy), ...extra,
      });
      if (state.activeAttempt) {
        const active = state.attempts.find((item) => item.id === state.activeAttempt);
        if (active?.outcome === "in-progress") {
          // Owning the shared action lock proves no previous transaction still owns it.
          await complete(state, active, "aborted-supervisor-crash", new Error("previous action lock ownership ended"));
        }
      }
      const consumedRequest = input?.recoveryRequest?.id
        ? [...state.attempts].reverse().find((attempt) =>
          attempt.requestId === input.recoveryRequest.id && attempt.outcome === "succeeded")
        : null;
      if (consumedRequest) {
        return respond("request-already-consumed", { attempt: consumedRequest });
      }

      const inspection = await adapters.inspect(input);
      const combined = { ...input, ...inspection, app: inspection?.app ?? input.app };
      const currentAppStartedAt = validDate(combined.app?.startedAt);
      if (
        sameTarget(combined.app, combined.app?.identity) &&
        currentAppStartedAt !== null &&
        validDate(state.restartCycleStartedAt) !== currentAppStartedAt
      ) {
        state.restartCycleStartedAt = iso(currentAppStartedAt);
        await lock.assertOwned();
        await saveState(statePath, state, policy, clock.now());
      }
      if (combined.app?.running && combined.app?.identity) {
        state.lastObservedApp = {
          identity: bounded(combined.app.identity, policy),
          startedAt: combined.app.startedAt ?? null,
          observedAt: iso(clock.now()),
        };
        await lock.assertOwned();
        await saveState(statePath, state, policy, clock.now());
      }

      const reason = determineReason(combined, policy, state, clock.now());
      if (!reason.due) return respond("not-due", { blockedBy: reason.blockedBy, reason });

      const cooldown = cooldownStatus(state, policy, clock.now());
      if (!cooldown.allowed) return respond("cooldown", { reason, cooldown });

      const attempt = newAttempt(reason.reason, reason.trigger, policy, combined, clock.now());
      attempt.reasons = reason.reasons;
      attempt.requestId = reason.requestId;
      attempt.restartMode = reason.restartMode;
      attempt.cycleBefore = restartCycleStatus(state, policy);
      attempt.cycleResetAt = null;
      attempt.activityOverridden = false;
      state.attempts.push(attempt);
      state.activeAttempt = attempt.id;
      await lock.assertOwned();
      await saveState(statePath, state, policy, clock.now());

      try {
        const promoteHardDeadline = async () => {
          if (clock.now() >= validDate(attempt.cycleBefore?.hardDeadlineAt)) {
            attempt.restartMode = "hard-deadline";
            attempt.trigger = "hard-deadline";
          }
        };
        const beforeTerminate = async ({ activity } = {}) => {
          await lock.assertOwned();
          if (activity) {
            attempt.activity.push({ stage: "pre-force", ...bounded(activity, policy) });
            if (attempt.restartMode === "hard-deadline" && activity.verdict !== "idle") {
              attempt.activityOverridden = true;
            }
          }
          if (!attempt.restartIntentPersisted) {
            attempt.restartIntentAt = iso(clock.now());
            attempt.restartIntentPersisted = true;
          }
          attempt.phase = attempt.restartMode === "hard-deadline" ? "force-requested" : "shutdown-requested";
          await persist(state, attempt);
          await lock.assertOwned();
        };
        await lock.assertOwned();
        attempt.phase = "rechecking";
        await persist(state, attempt);
        const before = await adapters.inspect(input);
        await lock.assertOwned();
        const firstActivity = assessActivity(before.activity, policy, clock.now());
        attempt.activity.push({ stage: "under-action-lock", ...bounded(firstActivity, policy) });
        attempt.exclusions = bounded(firstActivity.exclusions, policy);
        await promoteHardDeadline();
        await persist(state, attempt);
        if (attempt.restartMode !== "hard-deadline" && firstActivity.verdict !== "idle") {
          await complete(state, attempt, `postponed-${firstActivity.verdict}`);
          return respond("postponed", { attempt, activity: firstActivity });
        }

        const after = await adapters.inspect({ ...input, recheck: true });
        await lock.assertOwned();
        const secondActivity = assessActivity(after.activity, policy, clock.now());
        attempt.activity.push({ stage: "pre-shutdown", ...bounded(secondActivity, policy) });
        await promoteHardDeadline();
        if (!sameTarget(before.app, attempt.oldIdentity) || !sameTarget(after.app, attempt.oldIdentity)) {
          await complete(state, attempt, "postponed-target-identity");
          return respond("postponed", { attempt, blockedBy: "target-identity-unknown-or-changed" });
        }
        const versionChanged =
          firstActivity.admissionVersion !== null &&
          secondActivity.admissionVersion !== null &&
          firstActivity.admissionVersion !== secondActivity.admissionVersion;
        if (attempt.restartMode !== "hard-deadline" && (versionChanged || secondActivity.verdict !== "idle")) {
          await complete(state, attempt, "postponed-new-work-race");
          return respond("postponed", {
            attempt,
            activity: secondActivity,
            blockedBy: versionChanged ? "admission-version-changed" : secondActivity.verdict,
          });
        }

        attempt.activityOverridden = attempt.restartMode === "hard-deadline" &&
          (firstActivity.verdict !== "idle" || secondActivity.verdict !== "idle" || versionChanged);
        await persist(state, attempt);
        await lock.assertOwned();
        const shutdownRequestedAt = iso(clock.now());
        const shutdownOptions = {
          attemptId: attempt.id,
          deadlineSeconds: policy.startup.shutdownDeadlineSeconds,
          notBefore: shutdownRequestedAt,
          expectedOldIdentity: attempt.oldIdentity,
          forceDeadlineSeconds: policy.startup.forceTerminationDeadlineSeconds,
          forceAuthorization: policy.appRestart.forceTerminationAuthorization,
          hardDeadlineAt: attempt.cycleBefore.hardDeadlineAt,
          onHardDeadline: promoteHardDeadline,
          beforeTerminate,
          assertActionOwned: () => lock.assertOwned(),
        };
        let shutdownCompletion;
        if (attempt.restartMode === "hard-deadline") {
          shutdownCompletion = timeoutResult(await adapters.forceShutdown({
            ...shutdownOptions, forceAuthorization: HARD_RESTART_AUTHORIZATION,
          }), "hard preventive shutdown");
        } else {
          attempt.shutdown = bounded(timeoutResult(
            await adapters.requestShutdown({ ...shutdownOptions, gracefulOnly: true }),
            "graceful shutdown request",
          ), policy);
          await persist(state, attempt);
          shutdownCompletion = timeoutResult(await adapters.awaitShutdown(shutdownOptions), "graceful shutdown");
        }
        if (!attempt.restartIntentPersisted) throw new Error("termination adapter did not persist restart intent");
        attempt.shutdown = bounded(
          { ...attempt.shutdown, completion: shutdownCompletion },
          policy,
        );
        await persist(state, attempt);
        await lock.assertOwned();

        let ready = null;
        let successfulLaunchRequestedAt = null;
        let lastError = null;
        for (let startupAttempt = 1; startupAttempt <= policy.startup.attemptBudget; startupAttempt += 1) {
          try {
            await lock.assertOwned();
            const launchRequestedAt = iso(clock.now());
            const launched = timeoutResult(
              await adapters.launch({
                attemptId: attempt.id,
                startupAttempt,
                expectedOldIdentity: attempt.oldIdentity,
              }),
              "app launch",
            );
            successfulLaunchRequestedAt = launchRequestedAt;
            attempt.startup.push({ attempt: startupAttempt, launch: bounded(launched, policy) });
            ready = timeoutResult(
              await adapters.awaitReady({
                attemptId: attempt.id,
                startupAttempt,
                deadlineSeconds: policy.startup.readinessDeadlineSeconds,
                notBefore: launchRequestedAt,
                expectedOldIdentity: attempt.oldIdentity,
              }),
              "application readiness",
            );
            await lock.assertOwned();
            attempt.newIdentity = bounded(ready.identity ?? launched.identity ?? null, policy);
            attempt.readiness = bounded(ready, policy);
            break;
          } catch (error) {
            lastError = error;
            attempt.startup.push({
              attempt: startupAttempt,
              error: String(error.message ?? error).slice(0, policy.evidence.maxStringLength),
            });
            await persist(state, attempt);
            if (startupAttempt < policy.startup.attemptBudget) {
              await clock.sleep(milliseconds.seconds(policy.startup.retryBackoffSeconds));
            }
          }
        }
        if (!ready) throw new Error(`startup attempt budget exhausted: ${lastError?.message ?? "unknown error"}`);

        attempt.phase = "verifying";
        await lock.assertOwned();
        attempt.schedulerVerification = bounded(
          timeoutResult(
            await adapters.verifyScheduler({
              attemptId: attempt.id,
              deadlineSeconds: policy.startup.schedulerVerificationDeadlineSeconds,
              whenWorkDue: combined.scheduler?.workDue === true,
              notBefore: successfulLaunchRequestedAt ?? ready.observedAt ?? iso(clock.now()),
              expectedNewIdentity: attempt.newIdentity,
              schedulerBefore: combined.scheduler ?? null,
            }),
            "scheduler verification",
          ),
          policy,
        );
        state.lastSuccessfulRestartAt = iso(clock.now());
        attempt.cycleResetAt = attempt.newIdentity?.startTime ?? state.lastSuccessfulRestartAt;
        state.restartCycleStartedAt = attempt.cycleResetAt;
        await complete(state, attempt, "succeeded");
        return respond("restarted", { attempt });
      } catch (error) {
        await complete(state, attempt, "failed", error);
        return respond("failed", { attempt, error: attempt.error });
      }
    } finally {
      activeLock = null;
      await lock.release();
    }
  }

  return { config: policy, run };
}

function commandWithTokens(command, tokens) {
  if (!command) throw new Error("required command is not configured");
  const replace = (value) =>
    value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key) =>
      key in tokens ? String(tokens[key]) : match,
    );
  return { file: replace(command.file), args: (command.args ?? []).map(replace) };
}

function adapterResult(commandResult, label) {
  const line = commandResult.stdout
    .split(/\r?\n/)
    .findLast((value) => value.startsWith("SUPERVISOR_ADAPTER_RESULT="));
  if (!line) throw new Error(`${label} command did not emit SUPERVISOR_ADAPTER_RESULT`);
  try {
    return JSON.parse(line.slice("SUPERVISOR_ADAPTER_RESULT=".length));
  } catch (error) {
    throw new Error(`${label} command emitted invalid JSON: ${error.message}`);
  }
}

export function runCommand(command, tokens = {}, { timeoutSeconds = 120 } = {}) {
  const prepared = commandWithTokens(command, tokens);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(prepared.file, prepared.args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const max = 16_384;
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-max);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-max);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new Error(`command timed out after ${timeoutSeconds}s; outcome unknown; helper PID ${child.pid} was not terminated`));
    }, milliseconds.seconds(timeoutSeconds));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`command exited ${code}: ${stderr || stdout}`));
      else resolvePromise({ ok: true, code, stdout, stderr });
    });
  });
}

export function commandAdapters(
  config,
  snapshotPath,
  clock = { now: () => Date.now(), sleep: wait },
) {
  async function snapshot() {
    return JSON.parse((await readFile(snapshotPath, "utf8")).replace(/^\uFEFF/, ""));
  }
  async function freshSnapshot(tokens = {}) {
    if (config.commands.snapshot) {
      const outcome = await runCommand(config.commands.snapshot, tokens);
      adapterResult(outcome, "activity snapshot");
    }
    const source = await snapshot();
    const observedAt = validDate(source.observedAt);
    // A coarser evaluation cadence must not relax last-moment evidence freshness.
    const maxAgeMs = milliseconds.seconds(
      Math.min(60, config.supervisor.checkIntervalSeconds) + config.startup.snapshotPollIntervalSeconds + 5,
    );
    if (observedAt === null || clock.now() - observedAt > maxAgeMs) {
      return {
        observedAt: source.observedAt ?? null,
        app: { running: false, evidence: "unknown" },
        activity: { complete: false, sessions: [] },
        scheduler: { evidence: "unknown" },
        snapshotError: "snapshot is stale or missing observedAt",
      };
    }
    return source;
  }
  const identityKey = (identity) => {
    if (!plainObject(identity)) return null;
    if (identity.pid === undefined || !identity.startTime) return null;
    return `${identity.pid}|${identity.startTime}`;
  };
  const freshForAttempt = (evidence, attemptId, notBefore) =>
    plainObject(evidence) &&
    evidence.attemptId === attemptId &&
    validDate(evidence.observedAt) !== null &&
    validDate(evidence.observedAt) >= (validDate(notBefore) ?? Number.POSITIVE_INFINITY);
  async function pollEvidence({ deadlineSeconds, label, read, refresh = false, refreshTokens = {} }) {
    const deadline = clock.now() + milliseconds.seconds(deadlineSeconds);
    let lastReason = `${label} evidence was unavailable`;
    do {
      try {
        const source = refresh ? await freshSnapshot(refreshTokens) : await snapshot();
        const outcome = await read(source);
        if (outcome?.ok) return outcome;
        if (outcome?.reason) lastReason = outcome.reason;
      } catch (error) {
        lastReason = `snapshot unreadable: ${error.message}`;
      }
      if (clock.now() >= deadline) break;
      await clock.sleep(
        Math.min(
          milliseconds.seconds(config.startup.snapshotPollIntervalSeconds),
          Math.max(0, deadline - clock.now()),
        ),
      );
    } while (clock.now() <= deadline);
    return { ok: false, error: `${label} deadline expired: ${lastReason}` };
  }
  async function forceAndVerify({
    attemptId, expectedOldIdentity, forceDeadlineSeconds, forceAuthorization,
    restartMode = "quiet-opportunity", assertActionOwned = async () => {},
    beforeTerminate = async () => {},
    hardDeadlineAt, onHardDeadline = async () => {},
  }) {
    let hard = restartMode === "hard-deadline";
    if (hard && forceAuthorization !== HARD_RESTART_AUTHORIZATION) {
      return { ok: false, error: "hard preventive shutdown requires explicit hard-deadline authorization" };
    }
    if (!config.commands.forceTerminate) {
      return { ok: false, error: "force fallback is not configured" };
    }
    const forceSnapshot = await freshSnapshot({ attemptId, recheck: "force" });
    // Collection can cross the original deadline after graceful waiting finished.
    const hardAt = validDate(hardDeadlineAt);
    if (!hard && hardAt !== null && clock.now() >= hardAt) {
      hard = true;
      restartMode = "hard-deadline";
      forceAuthorization = HARD_RESTART_AUTHORIZATION;
      await onHardDeadline();
    }
    const forceActivity = assessActivity(forceSnapshot.activity, config, clock.now());
    if (!hard && forceActivity.verdict !== "idle") {
      return { ok: false, error: `force fallback vetoed by ${forceActivity.verdict} activity evidence`,
        activity: forceActivity };
    }
    if (!sameTarget(forceSnapshot.app, expectedOldIdentity)) {
      return { ok: false, error: "force fallback vetoed because the old process identity is absent or changed" };
    }
    await assertActionOwned();
    await beforeTerminate({ activity: forceActivity });
    await assertActionOwned();
    const forceRequestedAt = iso(clock.now());
    const forced = await runCommand(config.commands.forceTerminate, {
      attemptId,
      oldPid: expectedOldIdentity.pid,
      oldStartTime: expectedOldIdentity.startTime,
      oldPath: expectedOldIdentity.path,
      authorization: forceAuthorization,
      restartMode,
      deadlineSeconds: forceDeadlineSeconds,
    // The helper bounds identity inspection separately (30s), before native force.
    }, { timeoutSeconds: forceDeadlineSeconds + 35 });
    const forceResult = adapterResult(forced, "force termination");
    if (forceResult.ok === false) return forceResult;
    const observed = await freshSnapshot({ attemptId, recheck: "true" });
    if (observed.app?.evidence !== "known") {
      return { ok: false, error: "force completed but old-process exit evidence is unknown" };
    }
    if (identityKey(observed.app?.identity) === identityKey(expectedOldIdentity)) {
      return { ok: false, error: "force fallback completed but the specific old process still exists" };
    }
    return {
      ok: true, method: forceResult.method ?? "verified-process-tree-force",
      restartMode, activityOverridden: hard && forceActivity.verdict !== "idle",
      authorization: forceAuthorization, activity: forceActivity, identity: expectedOldIdentity,
      rootPid: forceResult.rootPid ?? expectedOldIdentity.pid,
      terminatedPids: forceResult.terminatedPids ?? [expectedOldIdentity.pid],
      diagnostics: forceResult.diagnostics ?? null,
      observedAt: forceRequestedAt,
    };
  }
  return {
    inspect: ({ recheck } = {}) =>
      freshSnapshot({
        recheck: recheck === true ? "true" : "false",
      }),
    async requestShutdown({ attemptId, deadlineSeconds, expectedOldIdentity,
      beforeTerminate = async () => {}, hardDeadlineAt, onHardDeadline = async () => {},
    }) {
      if (validDate(hardDeadlineAt) !== null && clock.now() >= validDate(hardDeadlineAt)) {
        await onHardDeadline();
        return { ok: true, skippedForHardDeadline: true };
      }
      await beforeTerminate();
      const outcome = await runCommand(
        config.commands.requestShutdown,
        {
          attemptId,
          deadlineSeconds,
          oldPid: expectedOldIdentity?.pid ?? "",
          oldStartTime: expectedOldIdentity?.startTime ?? "",
          oldPath: expectedOldIdentity?.path ?? "",
        },
        { timeoutSeconds: 10 },
      );
      return adapterResult(outcome, "graceful shutdown");
    },
    async awaitShutdown({
      attemptId,
      deadlineSeconds,
      expectedOldIdentity,
      forceDeadlineSeconds,
      forceAuthorization,
      assertActionOwned = async () => {},
      beforeTerminate = async () => {},
      hardDeadlineAt,
      onHardDeadline = async () => {},
    }) {
      const expected = identityKey(expectedOldIdentity);
      const hardAt = validDate(hardDeadlineAt);
      const graceful = await pollEvidence({
        deadlineSeconds: hardAt === null ? deadlineSeconds :
          Math.min(deadlineSeconds, Math.max(0, (hardAt - clock.now()) / 1_000)),
        label: "graceful shutdown",
        refresh: true,
        refreshTokens: { attemptId, recheck: "shutdown" },
        read(source) {
          if (!expected) return { reason: "expected old process identity is invalid" };
          if (identityKey(source.app?.identity) === expected) {
            return { reason: "old process has not exited" };
          }
          if (source.app?.evidence !== "known") {
            return { reason: "process evidence is unknown" };
          }
          return { ok: true, identity: expectedOldIdentity, observedAt: source.observedAt };
        },
      });
      if (graceful.ok) return graceful;
      if (!config.commands.forceTerminate) {
        return { ok: false, error: `${graceful.error}; force fallback is not configured` };
      }
      const hard = hardAt !== null && clock.now() >= hardAt;
      if (hard) await onHardDeadline();
      return forceAndVerify({
        attemptId, expectedOldIdentity, forceDeadlineSeconds, assertActionOwned, beforeTerminate,
        hardDeadlineAt, onHardDeadline,
        forceAuthorization: hard ? HARD_RESTART_AUTHORIZATION : forceAuthorization,
        restartMode: hard ? "hard-deadline" : "quiet-opportunity",
      });
    },
    forceShutdown: (options) => forceAndVerify({ ...options, restartMode: "hard-deadline" }),
    async launch({ attemptId, startupAttempt, expectedOldIdentity }) {
      const current = await freshSnapshot({ attemptId, recheck: "pre-launch" });
      if (current.app?.evidence !== "known") {
        return { ok: false, error: "pre-launch process evidence is unknown" };
      }
      if (current.app?.running) {
        if (identityKey(current.app.identity) === identityKey(expectedOldIdentity)) {
          return { ok: false, error: "old app identity is still running before launch" };
        }
        return {
          ok: true,
          method: "existing-distinct-process",
          alreadyRunning: true,
          identity: current.app.identity,
        };
      }
      const outcome = await runCommand(config.commands.launch, {
        attemptId,
        startupAttempt,
        oldPid: expectedOldIdentity?.pid ?? "",
        oldStartTime: expectedOldIdentity?.startTime ?? "",
        oldPath: expectedOldIdentity?.path ?? "",
      });
      return adapterResult(outcome, "app launch");
    },
    async awaitReady({
      attemptId,
      startupAttempt,
      deadlineSeconds,
      notBefore,
      expectedOldIdentity,
    }) {
      if (config.commands.readiness) {
        const outcome = await runCommand(
          config.commands.readiness,
          {
            attemptId,
            startupAttempt,
            deadlineSeconds,
            oldPid: expectedOldIdentity?.pid ?? "",
            oldStartTime: expectedOldIdentity?.startTime ?? "",
            oldPath: expectedOldIdentity?.path ?? "",
          },
          { timeoutSeconds: deadlineSeconds },
        );
        return adapterResult(outcome, "application readiness");
      }
      const oldKey = identityKey(expectedOldIdentity);
      return pollEvidence({
        deadlineSeconds,
        label: "application readiness",
        read(source) {
          if (!oldKey) return { reason: "expected old process identity is invalid" };
          const evidence = plainObject(source.ready) ? source.ready : source.readiness;
          if (!freshForAttempt(evidence, attemptId, notBefore)) {
            return { reason: "readiness evidence is stale or belongs to another attempt" };
          }
          if (evidence.startupAttempt !== startupAttempt) {
            return { reason: "readiness evidence belongs to another startup attempt" };
          }
          const newKey = identityKey(evidence.identity);
          if (!newKey) return { reason: "readiness evidence has no valid process identity" };
          if (newKey === oldKey) return { reason: "readiness still reports the old process identity" };
          if (evidence.ready !== true) return { reason: "application is not ready" };
          return { ok: true, identity: evidence.identity, observedAt: evidence.observedAt };
        },
      });
    },
    async verifyScheduler({
      attemptId,
      deadlineSeconds,
      whenWorkDue,
      notBefore,
      expectedNewIdentity,
      schedulerBefore,
    }) {
      if (config.commands.verifyScheduler) {
        const outcome = await runCommand(
          config.commands.verifyScheduler,
          {
            attemptId,
            beforeSequence: schedulerBefore?.dispatchSequence ?? "",
            beforeDueWorkflows: JSON.stringify(schedulerBefore?.dueWorkflowIds ?? []),
            workWasDue: whenWorkDue ? "true" : "false",
            notBefore,
            deadlineSeconds,
            newPid: expectedNewIdentity?.pid ?? "",
            newStartTime: expectedNewIdentity?.startTime ?? "",
            newPath: expectedNewIdentity?.path ?? "",
          },
          { timeoutSeconds: deadlineSeconds },
        );
        return adapterResult(outcome, "scheduler verification");
      }
      if (!whenWorkDue) return { ok: true, status: "ready-no-work-due", progressObserved: false };
      const expected = identityKey(expectedNewIdentity);
      return pollEvidence({
        deadlineSeconds,
        label: "scheduler verification",
        read(source) {
          if (!expected) return { reason: "expected new process identity is invalid" };
          const evidence = source.schedulerVerification ?? source.scheduler;
          if (!freshForAttempt(evidence, attemptId, notBefore)) {
            return { reason: "scheduler evidence is stale or belongs to another attempt" };
          }
          if (identityKey(evidence.identity) !== expected) {
            return { reason: "scheduler evidence does not match the new process" };
          }
          if (evidence.resumed !== true) return { reason: "scheduler has not resumed" };
          return { ok: true, status: "resumed", observedAt: evidence.observedAt };
        },
      });
    },
  };
}

export function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument ${name}`);
    const key = name.slice(2);
    if (!["config", "state", "audit", "input"].includes(key)) {
      throw new Error(`unknown option ${name}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    output[key] = resolve(value);
  }
  for (const required of ["config", "state", "input"]) {
    if (!output[required]) throw new Error(`--${required} is required`);
  }
  return output;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await loadConfig(args.config);
  const supervisor = createSupervisor({
    config,
    statePath: args.state,
    auditPath: args.audit,
    adapters: commandAdapters(config, args.input),
  });
  const outcome = await supervisor.run();
  process.stdout.write(`SUPERVISOR_RESULT=${JSON.stringify(outcome)}\n`);
  return ["failed"].includes(outcome.status) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`reliability-supervisor: ${error.message}\n`);
      process.exitCode = 2;
    });
}
