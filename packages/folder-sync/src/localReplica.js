import { idbGet, idbSet, idbCompareAndSet } from './idb.js'
import { RECORD_CODECS } from './recordCodecs.js'
import { reconcileRecordsFile, sidecarPath, toCollection } from './records.js'
import { fingerprint, parseSidecar, serializeSidecar, stampDelete, stampWrite } from './merge.js'

const STORE = 'meta'
const key = name => `local:${name}`
const contentOf = entry => entry && !entry.deleted ? entry.content : null

export const readAppliedContent = name => idbGet(STORE, `applied:${name}`)
export const rememberAppliedContent = (name, content) => idbSet(STORE, `applied:${name}`, { content })

export async function preserveLocalConflict(name, content) {
  const suffix = `${fingerprint(content) >>> 0}-${content.length}`
  const conflictPath = `sync-conflicts/${name}.${suffix}.md`
  const existing = await idbGet(STORE, key(conflictPath))
  if (existing && contentOf(existing) !== content) {
    throw new Error(`Cannot preserve conflicting content for ${name}: backup name collision`)
  }
  if (!existing) {
    const saved = await idbCompareAndSet(STORE, [[key(conflictPath), undefined]], [
      [key(conflictPath), { content, mtime: Date.now() }],
    ])
    if (!saved) return preserveLocalConflict(name, content)
    console.warn(`[folder-sync] preserved differing content in ${conflictPath}`)
  }
  return conflictPath
}

export async function readLocalSnapshot(name) {
  const sc = sidecarPath(name)
  const [file, sidecar] = await Promise.all([
    idbGet(STORE, key(name)),
    idbGet(STORE, key(sc)),
  ])
  return { file, sidecar, content: contentOf(file), rawSidecar: contentOf(sidecar) }
}

export async function commitLocalSnapshot(name, snapshot, content, sidecar) {
  const now = Date.now()
  const writes = [[key(name), content == null
    ? { deleted: true, mtime: now }
    : { content, mtime: now }]]
  const expected = [[key(name), snapshot.file]]
  if (RECORD_CODECS[name]) {
    expected.push([key(sidecarPath(name)), snapshot.sidecar])
    writes.push([key(sidecarPath(name)), { content: sidecar, mtime: now }])
  }
  return idbCompareAndSet(STORE, expected, writes)
}

// Import/save into the durable replica with an optimistic retry. Only the delta
// of an explicit user operation produces tombstones; startup imports never do.
export async function saveLocalReplica(name, content, { previousContent, importing = false, now = Date.now() } = {}) {
  const codec = RECORD_CODECS[name]
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = await readLocalSnapshot(name)
    if (!codec) {
      if (importing && snapshot.content != null && content !== snapshot.content) {
        await preserveLocalConflict(name, snapshot.content)
      }
      if (await commitLocalSnapshot(name, snapshot, content)) return content
      continue
    }
    const meta = parseSidecar(snapshot.rawSidecar, { strict: true })
    const editClock = Object.values(meta).reduce((clock, entry) => Math.max(clock, entry.clock + 1), now)
    if (!importing) {
      const before = toCollection(codec, previousContent)
      const after = toCollection(codec, content)
      for (const [id, record] of Object.entries(after)) {
        if (fingerprint(record) !== fingerprint(before[id])) {
          stampWrite(meta, id, editClock)
          meta[id].fp = fingerprint(record)
        }
      }
      for (const id of Object.keys(before)) {
        if (!(id in after)) {
          if (!meta[id]) meta[id] = { clock: editClock, deleted: false, fp: fingerprint(before[id]) }
          stampDelete(meta, id, editClock)
        }
      }
    }
    let result
    try {
      result = await reconcileRecordsFile({
        path: name,
        codec,
        now: editClock,
        inferLocalDeletes: false,
        local: {
          readContent: async () => content,
          readSidecar: async () => serializeSidecar(meta, now),
          commitSnapshot: ({ content: merged, sidecar }) => commitLocalSnapshot(name, snapshot, merged, sidecar),
        },
        remote: {
          readContent: async () => snapshot.content,
          readSidecar: async () => snapshot.rawSidecar,
          writeContent: async () => {},
          writeSidecar: async () => {},
        },
      })
    } catch (error) {
      if (error.message === 'local-snapshot-changed') continue
      throw error
    }
    if (importing && content != null) {
      const incoming = codec.parse(content).records
      const retained = codec.parse(result.content).records
      if (Object.keys(incoming).some(id => !(id in retained))) await preserveLocalConflict(name, content)
    }
    return result.content
  }
  throw new Error(`Local replica changed repeatedly while saving ${name}; retry the save`)
}
