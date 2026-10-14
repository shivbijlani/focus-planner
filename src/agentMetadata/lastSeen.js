/** "5 min ago" / "3 h ago" / "2 days ago" for the 🤖 link's stale tooltip. */
export function lastSeenText(lastSeenMs, now = Date.now()) {
  const min = Math.max(0, Math.round((now - lastSeenMs) / 60000))
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
