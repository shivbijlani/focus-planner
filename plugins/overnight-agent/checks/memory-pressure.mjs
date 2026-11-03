export const MEMORY_POLICY = Object.freeze({
  highPercent: 85,
  criticalPercent: 95,
  minimumAppBytes: 1024 ** 3,
  minimumAppShare: 0.1,
  sampleMaxAgeMs: 90_000,
  maximumGapMs: 150_000,
  sustainedMs: 60_000,
  pollMs: 60_000,
  cooldownMinutes: 10,
});

export const MEMORY_RESTART_AUTHORIZATION = "explicit-user-approval:critical-memory-pressure";

function identityKey(identity) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0 ||
      typeof identity.path !== "string" || !identity.path ||
      !Number.isFinite(Date.parse(identity.startTime))) return null;
  return `${identity.pid}|${Date.parse(identity.startTime)}|${identity.path.toLowerCase()}`;
}

export function assessMemory(sample, app, nowMs = Date.now()) {
  const unknown = error => ({ level: "unknown", error });
  if (!sample || sample.error) return unknown(sample?.error ?? "memory sample unavailable");
  const at = Date.parse(sample.observedAt);
  if (!Number.isFinite(at) || at > nowMs || nowMs - at > MEMORY_POLICY.sampleMaxAgeMs) {
    return unknown("memory sample stale or timestamp invalid");
  }
  const key = identityKey(app?.identity);
  if (app?.running !== true || app.evidence !== "known" || app.intentionalClosure ||
      !key || key !== identityKey(sample.appIdentity)) return unknown("memory target identity unknown or changed");
  const { committedBytes, commitLimitBytes, appPrivateBytes } = sample;
  if (![committedBytes, commitLimitBytes, appPrivateBytes].every(value =>
    Number.isSafeInteger(value) && value >= 0) || commitLimitBytes === 0 ||
      committedBytes > commitLimitBytes || appPrivateBytes > committedBytes) {
    return unknown("memory counters invalid");
  }
  const percent = committedBytes / commitLimitBytes * 100;
  const attributed = appPrivateBytes >= MEMORY_POLICY.minimumAppBytes &&
    appPrivateBytes >= committedBytes * MEMORY_POLICY.minimumAppShare;
  const level = !attributed || percent < MEMORY_POLICY.highPercent ? "normal" :
    percent >= MEMORY_POLICY.criticalPercent ? "critical" : "high";
  return { level, percent, attributed, observedAt: sample.observedAt, identityKey: key,
    committedBytes, commitLimitBytes, appPrivateBytes };
}

// Only separate, fresh observations count. Gaps, recovery, or a new app reset confirmation.
export function observeMemory(sample, app, previous, nowMs = Date.now()) {
  const reading = assessMemory(sample, app, nowMs);
  if (!["high", "critical"].includes(reading.level)) return { ...reading, confirmed: false };
  const at = Date.parse(reading.observedAt);
  const last = Date.parse(previous?.observedAt);
  const continuous = previous?.identityKey === reading.identityKey &&
    ["high", "critical"].includes(previous?.level) && Number.isFinite(last) &&
    at >= last && at - last <= MEMORY_POLICY.maximumGapMs;
  const highSince = continuous ? previous.highSince : reading.observedAt;
  const criticalSince = continuous && previous.level === "critical" && reading.level === "critical"
    ? previous.criticalSince : reading.level === "critical" ? reading.observedAt : null;
  const since = Date.parse(reading.level === "critical" ? criticalSince : highSince);
  return { ...reading, highSince, criticalSince,
    confirmed: Number.isFinite(since) && at > last && at - since >= MEMORY_POLICY.sustainedMs };
}

export function memoryRestartReason(input, config, state, nowMs) {
  if (!config.memoryPressure?.enabled) return null;
  const reading = assessMemory(input.memory, input.app, nowMs);
  const history = state.memoryPressure;
  if (!history?.confirmed || history.level !== reading.level ||
      history.identityKey !== reading.identityKey || history.observedAt !== reading.observedAt) return null;
  if (!["high", "critical"].includes(reading.level)) return null;
  return {
    due: true, reason: `memory-${reading.level}`, reasons: [`memory-${reading.level}`],
    trigger: "memory-pressure", requestId: null,
    restartMode: reading.level === "critical" ? "memory-critical" : "quiet-opportunity",
  };
}

export function memoryStillRequiresRestart(sample, app, mode, nowMs) {
  const level = assessMemory(sample, app, nowMs).level;
  return mode === "memory-critical" ? level === "critical" : ["high", "critical"].includes(level);
}
