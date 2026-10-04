// The lane chip's tooltip text (docs/spec/Domain-lanes.md, "Row chip").
import { lastSeenText } from '../agentMetadata/lastSeen.js'

function sourceText(view) {
  if (view.source === 'tag') return 'from its #lane: tag'
  if (view.source === 'map') return 'assigned in Devices & lanes'
  if (view.source === 'inherited') return `inherited from task ${view.from}`
  return ''
}

export function laneChipTitle(view, now = Date.now()) {
  if (view.status === 'problem') {
    const names = view.candidates.map((c) => (c === '' ? '(empty)' : c)).join(', ')
    return view.problem === 'conflict'
      ? `Conflicting lanes (${names}) — no PC works this task until one is removed`
      : `Invalid lane name (${names}) — no PC works this task until it is fixed`
  }
  const base = `Lane ${view.lane} (${sourceText(view)})`
  if (view.status === 'served') return `${base} — worked by ${view.servedBy.map((d) => d.name).join(', ')}`
  if (!view.assigned.length) return `No PC serves lane ${view.lane} — assign one in Settings → Devices & lanes`
  const who = view.assigned.map((a) => (a.lastSeenMs ? `${a.name}, last seen ${lastSeenText(a.lastSeenMs, now)}` : `${a.name}, not seen`)).join('; ')
  return `Waiting for a PC that serves lane ${view.lane} — ${who}`
}
