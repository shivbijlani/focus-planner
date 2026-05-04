export function parseManagerPriorities(lines) {
  const priorities = {}
  let order = 1
  for (const line of lines) {
    const trimmedLine = line.trim()
    const match = trimmedLine.match(/^\d+\.\s+(.+)$/)
    if (match) {
      priorities[match[1].trim()] = order
      order++
    }
  }
  return priorities
}

export function resolveManagerPriority(taskId, linkedIdMap, managerPriorities, maxDepth = 5) {
  let current = taskId
  for (let i = 0; i < maxDepth; i++) {
    if (!current) return null
    if (managerPriorities[current]) {
      return { id: current, order: managerPriorities[current] }
    }
    current = linkedIdMap[current] || null
  }
  return null
}

export function getChainDepthToManagerPriority(taskId, linkedIdMap, managerPriorities, maxDepth = 20) {
  let current = taskId
  const visited = new Set()
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!current || visited.has(current)) return null
    if (managerPriorities[current]) return depth
    visited.add(current)
    current = linkedIdMap[current] || null
  }
  return null
}

export function extractTaskId(row) {
  const idValue = row.ID
  if (typeof idValue === 'object') {
    const id = idValue.id
    const match = id.match(/\[?(\d+)\]?/)
    return match ? match[1] : null
  }

  const match = String(idValue).match(/^(\d+)$/)
  return match ? match[1] : null
}

export function sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities) {
  const priorityOrder = { '🔴': 0, '🐸': 1, '🟡': 2, '🔵': 3, '📖': 4, '⚪': 5, '✅': 6 }
  const priorityCol = headers.find(h => h.includes('🎯')) || '🎯'

  const getIcon = (row) => {
    const val = row[priorityCol] || '⚪'
    return Object.keys(priorityOrder).find(icon => val.includes(icon)) || '⚪'
  }

  const paired = rows.map((row, i) => ({ row, rawLine: rawLines[i] }))

  paired.sort((a, b) => {
    const aIcon = getIcon(a.row)
    const bIcon = getIcon(b.row)
    const aUrgent = aIcon === '🔴'
    const bUrgent = bIcon === '🔴'

    if (aUrgent !== bUrgent) return aUrgent ? -1 : 1

    const aTaskId = extractTaskId(a.row)
    const bTaskId = extractTaskId(b.row)
    const aManager = aTaskId ? resolveManagerPriority(aTaskId, linkedIdMap || {}, managerPriorities || {}) : null
    const bManager = bTaskId ? resolveManagerPriority(bTaskId, linkedIdMap || {}, managerPriorities || {}) : null
    const aManagerOrder = aManager ? aManager.order : Infinity
    const bManagerOrder = bManager ? bManager.order : Infinity

    if (aManagerOrder !== bManagerOrder) {
      return aManagerOrder - bManagerOrder
    }

    const aDepth = aTaskId
      ? getChainDepthToManagerPriority(aTaskId, linkedIdMap || {}, managerPriorities || {})
      : null
    const bDepth = bTaskId
      ? getChainDepthToManagerPriority(bTaskId, linkedIdMap || {}, managerPriorities || {})
      : null
    const aDepthRank = aDepth === null ? -1 : aDepth
    const bDepthRank = bDepth === null ? -1 : bDepth

    if (aDepthRank !== bDepthRank) {
      return bDepthRank - aDepthRank
    }

    const aPriorityRank = priorityOrder[aIcon] ?? 5
    const bPriorityRank = priorityOrder[bIcon] ?? 5

    return aPriorityRank - bPriorityRank
  })

  return {
    sortedRows: paired.map(p => p.row),
    sortedRawLines: paired.map(p => p.rawLine),
  }
}