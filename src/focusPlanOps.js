/**
 * Pure content-transformation operations on focus-plan.md.
 *
 * Each function takes (content, ...args) and returns a new content string
 * (or a small object describing extra side-effects that the caller must
 * perform — e.g. completed-task entries to write to a different file).
 *
 * Keeping these pure lets us reuse the exact same algorithms from both the
 * single-source FocusPlanView and the multi-source Combined view (where
 * each operation routes to whichever source the rawLine belongs to).
 */
import { isPrioritiesSection } from './focusPlanShared.js'

const PRIORITY_HEADING = '## Priorities'

// ── Section moves / row mutations ────────────────────────────────────

export function opMoveBetweenSections(content, rawLine, fromSection, toSection) {
  const lines = content.split('\n')
  let inFromSection = false
  let inToSection = false
  let toSectionInsertIndex = -1
  let lineToRemoveIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      const sectionName = line.replace('## ', '').trim()
      inFromSection = sectionName === fromSection
      inToSection = sectionName === toSection
    }
    if (inToSection && line.trim().startsWith('|') && line.includes('---')) {
      toSectionInsertIndex = i + 1
    }
    if (inFromSection && line.trim() === rawLine) {
      lineToRemoveIndex = i
    }
  }
  if (lineToRemoveIndex === -1 || toSectionInsertIndex === -1) return content
  const removed = lines.splice(lineToRemoveIndex, 1)[0]
  if (lineToRemoveIndex < toSectionInsertIndex) toSectionInsertIndex--
  lines.splice(toSectionInsertIndex, 0, removed)
  return lines.join('\n')
}

export function opChangePriority(content, rawLine, oldPriority, newPriority) {
  const newLine = rawLine.replace(oldPriority, newPriority)
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line.trim() === rawLine)
  if (lineIndex === -1) return content
  lines[lineIndex] = newLine
  return lines.join('\n')
}

export function opDeleteTask(content, rawLine) {
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line.trim() === rawLine)
  if (lineIndex === -1) return content
  lines.splice(lineIndex, 1)
  return lines.join('\n')
}

export function opRenameTask(content, rawLine, newTaskName) {
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line === rawLine)
  if (lineIndex === -1) return content
  const parts = rawLine.split('|')
  if (parts.length < 4) return content
  parts[3] = ` ${newTaskName} `
  lines[lineIndex] = parts.join('|')
  return lines.join('\n')
}

export function opChangeLinkedId(content, rawLine, newLinkedId) {
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line === rawLine)
  if (lineIndex === -1) return content
  const parts = rawLine.split('|')
  if (parts.length < 7) return content
  parts[6] = ` ${newLinkedId || ''} `
  lines[lineIndex] = parts.join('|')
  return lines.join('\n')
}

export function opLinkToAdoBugDb(content, rawLine, adoLink) {
  const lines = content.split('\n')
  const lineIndex = lines.findIndex(line => line === rawLine)
  if (lineIndex === -1) return content
  const parts = rawLine.split('|')
  if (parts.length < 3) return content
  const currentId = parts[1].trim()
  const commaIdx = currentId.indexOf(',[')
  const localId = commaIdx !== -1 ? currentId.substring(0, commaIdx) : currentId
  if (adoLink) {
    parts[1] = ` ${localId},[${adoLink.id}](${adoLink.url}) `
  } else {
    parts[1] = ` ${localId} `
  }
  lines[lineIndex] = parts.join('|')
  return lines.join('\n')
}

// ── Add / promote ────────────────────────────────────────────────────

function extractTicketIdFromUrl(url) {
  const endMatch = url.match(/\/(\d+)\/?(?:[?#].*)?$/)
  if (endMatch) return endMatch[1]
  const midMatch = url.match(/\/(\d{5,})\//)
  if (midMatch) return midMatch[1]
  return null
}

function findInsertAndMaxId(lines, section) {
  let inTargetSection = false
  let insertIndex = -1
  let maxId = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      inTargetSection = line.replace('## ', '').trim() === section
    }
    if (inTargetSection && insertIndex === -1 && line.trim().startsWith('|') && line.includes('---')) {
      insertIndex = i + 1
    }
    if (line.trim().startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim())
      if (cells.length >= 1 && cells[0] !== 'ID' && !/^[-:]+$/.test(cells[0])) {
        const numMatch = cells[0].match(/^(\d+)/)
        if (numMatch) maxId = Math.max(maxId, parseInt(numMatch[1], 10))
      }
    }
  }
  return { insertIndex, maxId }
}

export function opAddTask(content, { task, priority, linkedTask, section }, baselineMaxId = 0) {
  const lines = content.split('\n')
  const { insertIndex, maxId } = findInsertAndMaxId(lines, section)
  if (insertIndex === -1) return content
  const newId = Math.max(maxId, baselineMaxId) + 1
  const today = new Date().toISOString().split('T')[0]
  const trimmedLinked = linkedTask ? linkedTask.trim() : ''
  const isUrl = /^https?:\/\//.test(trimmedLinked)
  let row
  if (isUrl) {
    const adoId = extractTicketIdFromUrl(trimmedLinked)
    if (adoId) {
      row = `| ${newId},[${adoId}](${trimmedLinked.replace(/\/$/, '')}) | ${priority} | ${task} | - | ${today} | |`
    } else {
      row = `| ${newId} | ${priority} | ${task} | - | ${today} | ${trimmedLinked} |`
    }
  } else {
    row = `| ${newId} | ${priority} | ${task} | - | ${today} | ${trimmedLinked} |`
  }
  lines.splice(insertIndex, 0, row)
  return { content: lines.join('\n'), newId }
}

export function opPromoteTodoToTask(content, todoText, parentTaskId, baselineMaxId = 0) {
  const lines = content.split('\n')
  const { insertIndex, maxId } = findInsertAndMaxId(lines, 'Today')
  if (insertIndex === -1) return content
  const newId = Math.max(maxId, baselineMaxId) + 1
  const today = new Date().toISOString().split('T')[0]
  const cleanText = todoText.replace(/^TODO:\s*/i, '').trim()
  const row = `| ${newId} | 🟡 | ${cleanText} | - | ${today} | ${parentTaskId} |`
  lines.splice(insertIndex, 0, row)
  return { content: lines.join('\n'), newId }
}

export function opAddAndPrioritize(content, taskName, prioritySectionTitle, baselineMaxId = 0) {
  const lines = content.split('\n')
  const { insertIndex, maxId } = findInsertAndMaxId(lines, 'Today')
  if (insertIndex === -1) return content
  const newId = Math.max(maxId, baselineMaxId) + 1
  const today = new Date().toISOString().split('T')[0]
  lines.splice(insertIndex, 0, `| ${newId} | 🟡 | ${taskName} | - | ${today} | |`)

  let inPriority = false
  let lastNumIndex = -1
  let numCount = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      if (inPriority) break
      inPriority = line.replace('## ', '').trim() === prioritySectionTitle
    }
    if (inPriority && /^\d+\.\s+/.test(line.trim())) {
      lastNumIndex = i
      numCount++
    }
  }
  const priorityLine = `${numCount + 1}. ${newId}`
  if (lastNumIndex >= 0) {
    lines.splice(lastNumIndex + 1, 0, priorityLine)
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ') && lines[i].replace('## ', '').trim() === prioritySectionTitle) {
        lines.splice(i + 1, 0, priorityLine)
        break
      }
    }
  }
  return { content: lines.join('\n'), newId }
}

// ── Manager priorities (Priorities section) ──────────────────────────

function findPrioritiesRange(lines) {
  let start = -1
  let end = lines.length
  let title = null
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('## ')) {
      const t = trimmed.replace(/^##\s+/, '')
      if (start === -1 && isPrioritiesSection(t)) {
        start = i
        title = t
      } else if (start !== -1) {
        end = i
        break
      }
    }
  }
  return { start, end, title }
}

export function opUpdateManagerPriorities(content, newPriorityLines) {
  const lines = content.split('\n')
  const { start, end, title } = findPrioritiesRange(lines)
  if (start === -1) {
    // No Priorities section yet — append one.
    return content.trimEnd() + '\n\n' + PRIORITY_HEADING + '\n\n' + newPriorityLines.join('\n') + '\n'
  }
  const before = lines.slice(0, start)
  const after = lines.slice(end)
  // Always normalize the heading to "## Priorities".
  const heading = title === 'Priorities' ? lines[start] : '## Priorities'
  const out = [...before, heading, '', ...newPriorityLines, '', ...after]
  return out.join('\n')
}

export function opPromoteToManagerPriority(content, taskId) {
  const lines = content.split('\n')
  const { start, end } = findPrioritiesRange(lines)
  if (start === -1) {
    return content.trimEnd() + '\n\n' + PRIORITY_HEADING + '\n\n1. ' + taskId + '\n'
  }
  let lastNumIndex = -1
  let maxNum = 0
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].trim().match(/^(\d+)\.\s+/)
    if (m) {
      lastNumIndex = i
      maxNum = Math.max(maxNum, parseInt(m[1], 10))
    }
  }
  const newLine = `${maxNum + 1}. ${taskId}`
  if (lastNumIndex >= 0) {
    lines.splice(lastNumIndex + 1, 0, newLine)
  } else {
    lines.splice(start + 1, 0, newLine)
  }
  return lines.join('\n')
}

export function opRemoveFromManagerPriority(content, taskId) {
  const lines = content.split('\n')
  const { start, end } = findPrioritiesRange(lines)
  if (start === -1) return content
  const before = lines.slice(0, start + 1)
  const sectionBody = lines.slice(start + 1, end).filter(line => {
    const m = line.trim().match(/^\d+\.\s+(.+)$/)
    return !(m && m[1].trim() === taskId)
  })
  let num = 1
  const renumbered = sectionBody.map(line => {
    const m = line.trim().match(/^\d+\.\s+(.+)$/)
    if (m) return `${num++}. ${m[1]}`
    return line
  })
  const after = lines.slice(end)
  return [...before, ...renumbered, ...after].join('\n')
}

// ── Move-to-completed ───────────────────────────────────────────────
//
// Splits the work between two files — focus-plan.md (remove the row) and
// focus-plan-completed.md (append the row, possibly creating a weekly
// section). Each file edit is returned so the caller can write them in
// the right order to the right source.

export function opRemoveTaskFromFocusPlan(content, rawLine, fromSection) {
  const lines = content.split('\n')
  let inFromSection = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      inFromSection = line.replace('## ', '').trim() === fromSection
    }
    if (inFromSection && line.trim() === rawLine) {
      lines.splice(i, 1)
      return lines.join('\n')
    }
  }
  return content
}

export function buildCompletedRow({ taskId, taskName, priority, todoItems = [] }) {
  const today = new Date().toISOString().split('T')[0]
  let displayName = (taskName || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  if (todoItems.length > 0) displayName += ' - ' + todoItems.join(' - ')
  return `| ${taskId || '-'} | ✅ | ${displayName} | ${priority || '-'} | ${today} |`
}

export function opAppendToCompleted(completedContent, completedRow) {
  const lines = (completedContent || '# Completed Tasks\n').split('\n')
  const now = new Date()
  const dayOfWeek = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7))
  const weekLabel = `${monday.getMonth() + 1}/${monday.getDate()}/${monday.getFullYear()}`
  const weekHeader = `## Week of ${weekLabel}`
  let insertIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === weekHeader) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith('|') && lines[j].includes('---')) {
          insertIndex = j + 1
          break
        }
      }
      break
    }
  }
  if (insertIndex === -1) {
    let headerIndex = lines.findIndex(l => l.startsWith('# Completed Tasks'))
    if (headerIndex === -1) headerIndex = 0
    lines.splice(headerIndex + 1, 0,
      '',
      weekHeader,
      '',
      '| # | 🎯 | Task | Work Priority | Completed Date |',
      '|---|---|------|---------------|----------------|',
      completedRow,
    )
  } else {
    lines.splice(insertIndex, 0, completedRow)
  }
  return lines.join('\n')
}
