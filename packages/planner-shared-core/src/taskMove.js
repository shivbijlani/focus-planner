import { resolveManagerPriority } from './taskSort.js'

export function computeMoveSet(rootId, priorities, links, activeIds, aliases = {}) {
  const moving = new Set()
  if (rootId == null || rootId === '') return moving
  moving.add(rootId)
  if (!Object.hasOwn(priorities, rootId)) return moving

  const ids = Array.isArray(activeIds) ? activeIds : Object.keys(activeIds)
  for (const id of ids) {
    if (id !== rootId && resolveManagerPriority(id, links, priorities, aliases)?.id === rootId) {
      moving.add(id)
    }
  }
  return moving
}

export function computeBrokenLinks(movingIds, links, nameLookup = {}, aliases = {}) {
  if (movingIds == null || links == null) return []
  const moving = new Set(movingIds)
  const broken = []
  for (const [fromId, toId] of Object.entries(links)) {
    if (moving.has(fromId)) continue
    if (moving.has(toId)) {
      broken.push({ fromId, fromName: nameLookup[fromId] || '', toId })
    } else if (moving.has(aliases[toId])) {
      broken.push({ fromId, fromName: nameLookup[fromId] || '', toId, resolvedToId: aliases[toId] })
    }
  }
  return broken
}
