import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const OWNER_PROCESS_NAMES = ["copilot"];
export const START_TIME_SKEW_MS = 5000;

export function parseLockFilename(filename) {
  const match = /^inuse\.(\d+)\.lock$/.exec(filename);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function classifyLock(lock, probe, options = {}) {
  const { pid } = lock;
  if (lock.unreadable || !Number.isFinite(lock.mtimeMs)) {
    return { state: "unknown", reason: "lock metadata unreadable", pid };
  }
  if (!probe || typeof probe.exists !== "boolean") {
    return { state: "unknown", reason: "process census unreadable", pid };
  }
  if (!probe.exists) return { state: "dead", reason: `pid ${pid} is not running`, pid };
  if (!Number.isFinite(probe.startTimeMs)) {
    return { state: "unknown", reason: `pid ${pid} start time unreadable`, pid };
  }
  if (probe.startTimeMs > lock.mtimeMs + (options.skewMs ?? START_TIME_SKEW_MS)) {
    return { state: "dead", reason: `pid ${pid} started after lock (reused pid)`, pid };
  }
  const name = String(probe.name ?? "").toLowerCase().replace(/\.exe$/, "");
  if (!(options.ownerNames ?? OWNER_PROCESS_NAMES).some((owner) => owner.toLowerCase() === name)) {
    return { state: "unknown", reason: `pid ${pid} is "${probe.name}", not a session owner`, pid };
  }
  return { state: "live", reason: `pid ${pid} (${probe.name}) still holds the session`, pid };
}

export function classifyLiveness(locks, probe, options = {}) {
  if (!Array.isArray(locks) || !locks.length) {
    return { state: "unknown", reason: "no inuse lock present", locks: [] };
  }
  const classified = locks.map((lock) => ({ ...lock, ...classifyLock(lock, probe(lock.pid), options) }));
  const strongest = classified.find((lock) => lock.state === "live") ??
    classified.find((lock) => lock.state === "unknown");
  return {
    state: strongest?.state ?? "dead",
    reason: strongest?.reason ?? classified.map((lock) => lock.reason).join("; "),
    locks: classified,
  };
}

const date = (value) => typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
const iso = (value) => Number.isFinite(value) ? new Date(value).toISOString() : null;
export const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * One ordered lifecycle parser for the sweep and supervisor. A shutdown ends an
 * epoch, not necessarily a task. Resumed execution invalidates previous completion.
 * Damaged/undatable logs remain observable, but cannot authorize reconciliation.
 */
export function summariseSessionEvents(text) {
  let eventCount = 0;
  let last = NaN;
  let terminal = null;
  let complete = false;
  let damaged = false;
  let turnOpen = false;
  let settled = null;
  let resumeState = null;
  let pendingHuman = false;
  let abandoned = false;
  let epoch = 0;
  let postTerminalActivity = false;
  const abandonedEpochs = [];
  const tools = new Set();
  const hooks = new Set();
  const permissions = new Set();
  const humanTools = new Set();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { damaged = true; continue; }
    eventCount++;
    if (!event || typeof event.type !== "string") { damaged = true; continue; }
    const at = date(event.timestamp);
    if (!Number.isFinite(at) || (Number.isFinite(last) && at < last)) damaged = true;
    const type = event.type;
    // Permission catalog refresh is not progress and does not resolve an approval.
    if (type === "session.permissions_changed") continue;
    if (Number.isFinite(at)) last = Math.max(Number.isFinite(last) ? last : at, at);
    const active = /^(session\.(resume|start)|assistant\.(turn_start|message)|user\.message|tool\.|hook\.)/.test(type);
    if (active && terminal) {
      terminal = null;
      complete = false;
      abandoned = false;
      settled = null;
      epoch++;
      postTerminalActivity = true;
    }
    if (type === "session.resume") {
      complete = false;
      abandoned = false;
      epoch++;
      if (event.data?.alreadyInUse === false && event.data?.sessionWasActive === false) {
        if (tools.size || hooks.size || turnOpen) abandonedEpochs.push({
          epoch, at: iso(at), reason: "inactive resume discarded prior execution",
          tools: tools.size, hooks: hooks.size, turnOpen,
        });
        tools.clear(); hooks.clear(); permissions.clear(); humanTools.clear();
        pendingHuman = false;
        turnOpen = false;
        resumeState = "inactive";
      } else {
        resumeState = typeof event.data?.alreadyInUse === "boolean" &&
          typeof event.data?.sessionWasActive === "boolean" ? "active" : "unknown";
        turnOpen = true;
      }
      settled = null;
    }
    if (["assistant.turn_start", "user.message", "session.start"].includes(type)) {
      complete = false;
      turnOpen = true;
      settled = null;
      if (type === "user.message") pendingHuman = false;
    }
    if (type === "assistant.turn_end") { turnOpen = false; settled = iso(at); }
    const toolId = event.data?.toolCallId ?? event.data?.tool_call_id ?? `anonymous-${eventCount}`;
    if (["tool.execution_start", "tool.execution_begin"].includes(type)) {
      complete = false;
      tools.add(toolId);
      if (/ask[_-]?user|elicitation/i.test(event.data?.toolName ?? event.data?.tool_name ?? "")) humanTools.add(toolId);
    }
    if (type === "tool.execution_complete") { tools.delete(toolId); humanTools.delete(toolId); }
    const hookId = event.data?.hookInvocationId ?? `anonymous-${eventCount}`;
    if (type === "hook.start") {
      hooks.add(hookId);
      if (event.data?.hookType === "permissionRequest") permissions.add(hookId);
      if (event.data?.hookType === "userPromptSubmitted") { turnOpen = true; complete = false; }
    }
    if (type === "hook.end") { hooks.delete(hookId); permissions.delete(hookId); }
    if (/awaiting[_-]?(input|user)|ask[_-]?user|elicitation/i.test(`${type} ${event.data?.status ?? ""}`)) {
      pendingHuman = true;
    }
    if (type === "session.task_complete") complete = true;
    if (type === "session.shutdown") {
      abandoned ||= tools.size > 0 || hooks.size > 0 || (turnOpen && !complete);
      if (abandoned) abandonedEpochs.push({
        epoch, at: iso(at), reason: "shutdown interrupted execution",
        tools: tools.size, hooks: hooks.size, turnOpen,
      });
      terminal = { at: iso(at), type, complete: complete && !abandoned };
      turnOpen = false;
      tools.clear(); hooks.clear();
      // A shutdown is not a human response. Keep unresolved approval evidence.
      resumeState = "shutdown";
      postTerminalActivity = false;
    }
  }
  pendingHuman ||= permissions.size > 0 || humanTools.size > 0;
  const activeExecution = turnOpen || tools.size > 0 || hooks.size > 0 ||
    pendingHuman || resumeState === "active" || resumeState === "unknown";
  const settledTurn = !damaged && !activeExecution && settled !== null && !terminal;
  const currentComplete = complete && !abandoned && !activeExecution;
  return {
    readable: !damaged,
    reason: damaged ? "malformed event or invalid/non-monotonic timestamp" : null,
    eventCount, lastEventAt: iso(last), lastEventAtMs: Number.isFinite(last) ? last : null,
    terminalAt: !damaged ? terminal?.at ?? null : null,
    terminalType: !damaged ? terminal?.type ?? null : null,
    hasTaskComplete: terminal ? terminal.complete && !pendingHuman : currentComplete,
    pendingHuman, pendingPermissionCount: permissions.size,
    pendingToolCount: tools.size, pendingHookCount: hooks.size,
    turnOpen, activeExecution, settledTurn, settledTurnAt: settledTurn ? settled : null,
    resumeState, epoch, abandonedExecution: abandoned, abandonedEpochs, postTerminalActivity,
  };
}

/** No lock alone is unknown, never proof of process death. */
export function classifyTerminalEvidence({
  events, liveness, directoryReadable = false, processCensusReadable = false,
  dataSession = null, logicalSession = null, startedAtMs, nowMs, graceMinutes = 20, silenceMinutes = 15,
}) {
  const reject = (reason) => ({ verdict: "unknown", repairable: false, terminalStatus: null, reason });
  if (!events?.readable || !directoryReadable || !processCensusReadable) return reject("terminal evidence unreadable");
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs) ||
      !Number.isFinite(events.lastEventAtMs) || events.lastEventAtMs < startedAtMs) return reject("invalid run/event timestamps");
  if (nowMs - startedAtMs < graceMinutes * 60_000) return reject("terminal grace window");
  if (nowMs - events.lastEventAtMs < silenceMinutes * 60_000) return reject("terminal silence window");
  if (!dataSession || dataSession.is_running !== 0 || !Number.isFinite(date(dataSession.updated_at)) ||
      date(dataSession.updated_at) > events.lastEventAtMs) return reject("DB session not corroborated idle");
  if (!logicalSession || !Number.isFinite(date(logicalSession.created_at)) ||
      !Number.isFinite(date(events.terminalAt)) ||
      date(logicalSession.created_at) > date(events.terminalAt) ||
      (logicalSession.updated_at !== undefined && (!Number.isFinite(date(logicalSession.updated_at)) ||
        date(logicalSession.updated_at) > events.lastEventAtMs))) return reject("logical session missing, undatable or newer than final lifecycle");
  if (["awaiting_input", "pending_approval", "pending_human", "awaiting_user"].some((key) => dataSession[key]) ||
      /awaiting|approval|pending.user/i.test(dataSession.status ?? "")) return reject("DB approval pending");
  if (events.pendingHuman || events.activeExecution) return reject("current execution or approval pending");
  if (events.terminalType !== "session.shutdown" || !events.terminalAt) return reject("no final shutdown");
  if (liveness?.state === "live") return reject("live owner");
  if (!liveness || (liveness.state !== "dead" && liveness.locks?.length !== 0)) return reject("owner unknown");
  return {
    verdict: "terminal-shutdown", repairable: true,
    terminalStatus: events.hasTaskComplete ? "completed" : "failed",
    reason: "final shutdown, idle DB session, readable owner census and observed silence",
  };
}

const identity = (stat) => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, size: stat.size });

/** Read-only evidence capture. Fingerprints bind bytes, inode, directory and owners. */
export function readSessionEvidence(sessionStateDirectory, sessionId, processTable) {
  const directory = join(sessionStateDirectory, sessionId);
  try {
    const before = identity(statSync(directory));
    const eventPath = join(directory, "events.jsonl");
    const eventIdentity = () => {
      try { return identity(statSync(eventPath)); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    };
    const eventBefore = eventIdentity();
    const text = eventBefore ? readFileSync(eventPath, "utf8") : null;
    const names = readdirSync(directory).sort();
    const locks = names.filter((name) => /^inuse\./.test(name)).map((name) => {
      const pid = parseLockFilename(name);
      try {
        return { name, pid, ...identity(statSync(join(directory, name))), unreadable: pid === null };
      } catch { return { name, pid, unreadable: true }; }
    });
    const processCensusReadable = processTable instanceof Map;
    const owners = locks.map((lock) => [lock.pid, processTable?.get(lock.pid) ?? null]);
    const liveness = classifyLiveness(locks, (pid) => processCensusReadable
      ? processTable.get(pid) ?? { exists: false } : null);
    const after = identity(statSync(directory));
    const eventAfter = eventIdentity();
    const stable = fingerprint(before) === fingerprint(after) && fingerprint(eventBefore) === fingerprint(eventAfter);
    let events = text === null ? null : summariseSessionEvents(text);
    if (!stable) events = { ...events, readable: false, reason: "session files changed during capture" };
    return {
      events, liveness, directoryReadable: stable, processCensusReadable,
      cursor: {
        eventIdentity: eventBefore,
        byteLength: text === null ? 0 : Buffer.byteLength(text, "utf8"),
        contentHash: text === null ? null : fingerprint(text),
        directoryIdentity: before,
      },
      owners: owners.map(([pid, processIdentity]) => ({ pid, processIdentity })),
      fingerprint: fingerprint({ before, eventBefore, text, locks, owners, processCensusReadable }),
    };
  } catch (error) {
    return {
      events: { readable: false, reason: `session evidence unreadable: ${error.message}` },
      liveness: { state: "unknown", reason: "session evidence unreadable", locks: [] },
      directoryReadable: false, processCensusReadable: processTable instanceof Map, fingerprint: null,
    };
  }
}
