/**
 * Per-task AI-assistance settings — a structured, planner-owned sidecar
 * (`task-settings.json`) that lives next to `planner.md` in the active
 * storage source, keyed by stable task ID.
 *
 * This is machine-owned metadata, not journal prose: today it only carries
 * two per-task opt-ins (AI-assisted, persistent session), but each task's
 * entry is an open object so future per-task toggles can be added to it
 * without a file-format migration. A task with no recorded entry — the
 * common case for every task that existed before this feature — is treated
 * as both opt-ins being off, so existing behavior is unchanged until a user
 * explicitly opts in.
 *
 * Mirrors the shape/pattern of ./settings.js (the mission-statement sidecar),
 * the established precedent for small planner-owned JSON files.
 */
import * as storage from './storage.js'

export const TASK_SETTINGS_FILE = 'task-settings.json'

const FILE_VERSION = 1

// Defaults for a single task's settings. Both opt-ins start disabled so a
// task with no recorded entry behaves exactly as it did before this feature.
export const DEFAULT_TASK_SETTINGS = {
  aiAssisted: false,
  persistentSession: false,
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateTaskSettingsFile(input) {
  if (!isPlainObject(input)) throw new Error(`${TASK_SETTINGS_FILE} must contain a JSON object.`)
  if (input.version !== undefined && !Number.isFinite(input.version)) {
    throw new Error(`${TASK_SETTINGS_FILE} has an invalid version.`)
  }
  if (input.tasks !== undefined && !isPlainObject(input.tasks)) {
    throw new Error(`${TASK_SETTINGS_FILE} must contain a "tasks" object.`)
  }
  for (const [taskId, entry] of Object.entries(input.tasks || {})) {
    if (!isPlainObject(entry)) throw new Error(`${TASK_SETTINGS_FILE} has invalid settings for task ${taskId}.`)
    if (entry.aiAssisted !== undefined && typeof entry.aiAssisted !== 'boolean') {
      throw new Error(`${TASK_SETTINGS_FILE} has a non-boolean aiAssisted value for task ${taskId}.`)
    }
    if (entry.persistentSession !== undefined && typeof entry.persistentSession !== 'boolean') {
      throw new Error(`${TASK_SETTINGS_FILE} has a non-boolean persistentSession value for task ${taskId}.`)
    }
  }
}

// Normalize a single task's settings entry: known opt-ins are coerced to
// booleans (defaulting when missing/malformed), while any other keys are
// preserved as-is so future per-task settings round-trip even before this
// module knows about them.
function normalizeTaskEntry(entry) {
  const input = isPlainObject(entry) ? entry : {}
  return {
    ...input,
    aiAssisted: typeof input.aiAssisted === 'boolean' ? input.aiAssisted : DEFAULT_TASK_SETTINGS.aiAssisted,
    persistentSession: typeof input.persistentSession === 'boolean'
      ? input.persistentSession
      : DEFAULT_TASK_SETTINGS.persistentSession,
  }
}

// Normalize the whole file shape: `{ version, tasks: { [taskId]: entry } }`.
// Tolerant of missing/malformed input (fresh install, corrupted JSON, etc.).
export function normalizeTaskSettingsFile(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const tasksInput = isPlainObject(input.tasks) ? input.tasks : {}
  const tasks = {}
  for (const [taskId, entry] of Object.entries(tasksInput)) {
    tasks[taskId] = normalizeTaskEntry(entry)
  }
  return {
    version: Number.isFinite(input.version) ? input.version : FILE_VERSION,
    tasks,
  }
}

// Lenient reads keep the board available; strict mutation reads protect a
// malformed sidecar from being overwritten with an empty settings map.
export function parseTaskSettingsFile(raw, { strict = false } = {}) {
  if (!raw) return normalizeTaskSettingsFile({})
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    if (strict) {
      throw new Error(`Cannot update ${TASK_SETTINGS_FILE}: the existing file is not valid JSON. Fix or restore it first.`, { cause: error })
    }
    return normalizeTaskSettingsFile({})
  }
  if (strict) validateTaskSettingsFile(parsed)
  return normalizeTaskSettingsFile(parsed)
}

export function serializeTaskSettingsFile(file) {
  return `${JSON.stringify(normalizeTaskSettingsFile(file), null, 2)}\n`
}

// Settings for a single task, with defaults applied when absent/malformed.
export function getTaskSettings(file, taskId) {
  const normalized = normalizeTaskSettingsFile(file)
  return normalizeTaskEntry(normalized.tasks[taskId])
}

// Pure merge helper: returns a *new* file object with `patch` merged into
// `taskId`'s entry (creating the entry if it doesn't exist yet). Does not
// mutate `file`.
export function withTaskSetting(file, taskId, patch) {
  const normalized = normalizeTaskSettingsFile(file)
  const current = normalizeTaskEntry(normalized.tasks[taskId])
  return {
    ...normalized,
    tasks: {
      ...normalized.tasks,
      [taskId]: normalizeTaskEntry({ ...current, ...patch }),
    },
  }
}

export function moveTaskSettingsEntries(sourceFile, targetFile, idMap) {
  const source = normalizeTaskSettingsFile(sourceFile)
  const target = normalizeTaskSettingsFile(targetFile)
  const nextSourceTasks = { ...source.tasks }
  const nextTargetTasks = { ...target.tasks }

  for (const [oldId, newId] of idMap) {
    const sourceId = String(oldId)
    if (!Object.prototype.hasOwnProperty.call(nextSourceTasks, sourceId)) continue
    nextTargetTasks[String(newId)] = nextSourceTasks[sourceId]
    delete nextSourceTasks[sourceId]
  }

  return {
    source: { ...source, tasks: nextSourceTasks },
    target: { ...target, tasks: nextTargetTasks },
  }
}

let storageAdapter = {
  read: (path) => storage.read(path),
  write: (path, content) => storage.write(path, content),
}

async function readWith(readFn) {
  let raw
  try {
    raw = await readFn(TASK_SETTINGS_FILE)
  } catch (error) {
    if (error?.name === 'NotFoundError') return normalizeTaskSettingsFile({})
    throw error
  }
  return parseTaskSettingsFile(raw, { strict: true })
}

async function writeWith(writeFn, file) {
  const next = normalizeTaskSettingsFile(file)
  await writeFn(TASK_SETTINGS_FILE, serializeTaskSettingsFile(next))
  return next
}

const mutationQueues = new Map()

function enqueueMutation(sourceKey, mutation) {
  const previous = mutationQueues.get(sourceKey) || Promise.resolve()
  const next = previous.catch(() => {}).then(mutation)
  mutationQueues.set(sourceKey, next)
  return next.finally(() => {
    if (mutationQueues.get(sourceKey) === next) mutationQueues.delete(sourceKey)
  })
}

export function withTaskSettingsMutationLock(sourceIds, mutation) {
  const keys = [...new Set(sourceIds.map(String))].sort()
  const acquire = (index) => index === keys.length
    ? mutation()
    : enqueueMutation(`source:${keys[index]}`, () => acquire(index + 1))
  return acquire(0)
}

// ── Active-source convenience API (mirrors storage/settings.js) ─────────

export async function readTaskSettings() {
  return readWith(storageAdapter.read)
}

export async function writeTaskSettings(file) {
  return writeWith(storageAdapter.write, file)
}

// Read-modify-write a single task's settings against the active source.
export async function setTaskSetting(taskId, patch) {
  return enqueueMutation('active', async () => {
    const file = await readTaskSettings()
    const next = withTaskSetting(file, taskId, patch)
    await writeTaskSettings(next)
    return next
  })
}

// ── Per-source variants ──────────────────────────────────────────────────
// The Combined view has no single "active" source — each row's task
// belongs to a specific registered source — so these route reads/writes
// there directly, the same way storage.readFromSource/writeToSource do for
// plan content.

export async function readTaskSettingsFromSource(sourceId) {
  return readWith((path) => storage.readFromSource(sourceId, path))
}

export async function writeTaskSettingsToSource(sourceId, file) {
  return writeWith((path, content) => storage.writeToSource(sourceId, path, content), file)
}

export async function setTaskSettingInSource(sourceId, taskId, patch) {
  return withTaskSettingsMutationLock([sourceId], async () => {
    const file = await readTaskSettingsFromSource(sourceId)
    const next = withTaskSetting(file, taskId, patch)
    await writeTaskSettingsToSource(sourceId, next)
    return next
  })
}

export const __testing = {
  DEFAULT_TASK_SETTINGS,
  setStorageAdapter(adapter) {
    mutationQueues.clear()
    storageAdapter = adapter || {
      read: (path) => storage.read(path),
      write: (path, content) => storage.write(path, content),
    }
  },
}
