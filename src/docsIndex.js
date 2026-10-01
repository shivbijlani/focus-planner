// Focus Planner's view of Docs (plans/docs-app-design.md §3.2): which tasks have a
// catch-up doc, and whether it carries an unread revision or a needs-you disposition.
//
// Everything is gated on docs/index.json existing in the source: no index → no 📄 and
// no extra reads beyond that one file, so folders without Docs see no change.
import { useEffect, useState } from 'react'
import {
  DOCS_INDEX, parseIndex, reviewPath, responsePath, parseReview, parseResponse, deriveDocState, docHref,
} from '../packages/docs-core/src/index.js'
import { onLocalChange } from './storage/storage.js'

let cache = new WeakMap() // provider → Promise<{ index, tasks } | null>
const listeners = new Set()

async function loadTaskDocs(provider) {
  const read = async (p) => { try { return (await provider.read(p)) || '' } catch { return '' } }
  const index = parseIndex(await read(DOCS_INDEX))
  if (!index) return null
  const tasks = {}
  await Promise.all(Object.entries(index.tasks || {}).map(async ([taskId, docId]) => {
    const entry = index.docs?.[docId]
    if (!entry) return
    const [r, s] = await Promise.all([read(reviewPath(docId)), read(responsePath(docId))])
    const st = deriveDocState({ entry, review: parseReview(r), response: parseResponse(s) })
    tasks[String(taskId)] = { docId, unread: st.unread, needsYou: st.needsYou, rev: st.rev, title: entry.title }
  }))
  return { index, tasks }
}

export function getTaskDocs(provider) {
  if (!provider) return Promise.resolve(null)
  let p = cache.get(provider)
  if (!p) {
    p = loadTaskDocs(provider).catch(() => null)
    cache.set(provider, p)
  }
  return p
}

export function invalidateTaskDocs() {
  cache = new WeakMap()
  for (const fn of listeners) { try { fn() } catch { /* ignore */ } }
}

let subscribed = false
function ensureSubscribed() {
  if (subscribed || typeof document === 'undefined') return
  subscribed = true
  try {
    onLocalChange((name) => { if (String(name || '').startsWith('docs/')) invalidateTaskDocs() })
  } catch { /* no engine yet */ }
  // Coming back from the Docs app (readRev moved) should clear the badge.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') invalidateTaskDocs()
  })
  window.addEventListener('pageshow', (e) => { if (e.persisted) invalidateTaskDocs() })
}

/** Docs app URL for a doc (same origin, separate entry point). */
export function docsAppHref(docId) {
  const base = import.meta.env?.BASE_URL || '/'
  return `${base}docs.html${docHref(docId)}`
}

/** { docId, unread, needsYou, href } for a task's primary doc, or null. */
export function useTaskDoc(provider, taskId) {
  const [state, setState] = useState({ key: null, doc: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    ensureSubscribed()
    const on = () => setTick((t) => t + 1)
    listeners.add(on)
    return () => { listeners.delete(on) }
  }, [])
  const enabled = !!provider && taskId != null && taskId !== ''
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    getTaskDocs(provider).then((res) => {
      if (cancelled) return
      const t = res?.tasks?.[String(taskId)]
      setState({ key: { provider, taskId }, doc: t ? { ...t, href: docsAppHref(t.docId) } : null })
    })
    return () => { cancelled = true }
  }, [enabled, provider, taskId, tick])
  if (!enabled || state.key?.provider !== provider || state.key?.taskId !== taskId) return null
  return state.doc
}

/** Parse the planner's `#journal=<taskId>` deep link (used by the Docs task chip). */
export function journalDeepLink(hash) {
  const m = String(hash || '').match(/^#journal=(\d+)$/)
  return m ? Number(m[1]) : null
}
