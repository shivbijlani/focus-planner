// Small pure helpers shared by the Docs screens.

export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Focus Planner deep link that opens a task's journal (handled in App.jsx). */
export function plannerJournalHref(taskId, base = '/') {
  return `${base}#journal=${encodeURIComponent(taskId)}`
}

export function excerpt(text, n = 90) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * Library tabs (plans/docs-app-design.md §7): Needs you = unread revision, a
 * needs-you disposition, or unsent drafts. Recent = updated in the last 14 days.
 */
export function filterLibrary(cards, tab, query = '', now = Date.now()) {
  const q = query.trim().toLowerCase().replace(/^#/, '')
  const matches = (c) => !q || c.title.toLowerCase().includes(q) || (c.task != null && String(c.task).includes(q))
  const byUpdated = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  let list = cards.filter(matches)
  if (tab === 'needs') list = list.filter((c) => c.unread || c.needsYou > 0 || c.drafts > 0)
  if (tab === 'recent') list = list.filter((c) => now - Date.parse(c.updatedAt || 0) < 14 * 86400e3)
  return list.sort(byUpdated)
}
