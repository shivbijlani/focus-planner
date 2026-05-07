import { useState, useEffect, useRef } from 'react'
import './App.css'
import * as storage from './storage/storage.js'
import { setActiveProvider, getActiveProvider, PROVIDERS, getProviderName, getAvailableProviders } from './storage/storage.js'
import { LocalStorageProvider } from './storage/localstorage-provider.js'
import { migrate, resumePendingMigration, hasPendingMigration, makeProvider } from './storage/migrate.js'
import {
  loadSources, migrateLegacy, getSources, getActiveSourceId, setActiveSource,
  addSource, renameSource, removeSource, getProvider, restoreSource,
  availableProviderTypesForAdd,
  beginAddCloudSource, consumePendingAdd, abortPendingAdd,
} from './storage/sources.js'
import { extractTaskId, parseManagerPriorities, resolveManagerPriority, sortTasksByPriority } from './taskSort.js'
import { StoragePicker } from './StoragePicker.jsx'

// ── Multi-source path helpers ───────────────────────────────────────
// In single-source mode all paths are plain ("focus-plan.md").
// In multi-source mode paths are namespaced ("s2::focus-plan.md") so the
// sidebar tree, selectedFile state and the dispatcher can tell sources apart.
// The "combined" sourceId is virtual — it has no provider; reads are
// synthesized from every real source.
const COMBINED_ID = 'combined'

function splitSourcePath(qualified) {
  if (!qualified) return { sourceId: null, path: '' }
  const idx = qualified.indexOf('::')
  if (idx === -1) return { sourceId: null, path: qualified }
  return { sourceId: qualified.slice(0, idx), path: qualified.slice(idx + 2) }
}

function joinSourcePath(sourceId, path) {
  return sourceId ? `${sourceId}::${path}` : path
}

function prefixTreePaths(items, sourceId) {
  return items.map(item => {
    if (item.type === 'directory') {
      return {
        ...item,
        path: joinSourcePath(sourceId, item.path),
        children: item.children ? prefixTreePaths(item.children, sourceId) : [],
      }
    }
    return { ...item, path: joinSourcePath(sourceId, item.path) }
  })
}

// Context Menu component
function ContextMenu({ x, y, options, onClose }) {
  const menuRef = useRef(null)
  
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])
  
  return (
    <div 
      ref={menuRef}
      className="context-menu"
      style={{ top: y, left: x }}
    >
      {options.map((option, i) => (
        <button
          key={i}
          className="context-menu-item"
          onClick={() => {
            option.action()
            onClose()
          }}
        >
          {option.icon && <span className="context-menu-icon">{option.icon}</span>}
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ADO Link Dialog component
function AdoLinkDialog({ onClose, onSave, currentUrl }) {
  const [url, setUrl] = useState(currentUrl || '')

  const handleSave = () => {
    const trimmed = url.trim()
    if (!trimmed) {
      onSave(null)
      onClose()
      return
    }
    // Extract ticket/incident ID from URL — try end-of-path first (ADO),
    // then any 5+ digit segment in the path (ICM, Jira, GitHub, etc.)
    const extractId = (url) => {
      const endMatch = url.match(/\/(\d+)\/?(?:[?#].*)?$/)
      if (endMatch) return endMatch[1]
      const midMatch = url.match(/\/(\d{5,})\//)
      if (midMatch) return midMatch[1]
      return null
    }
    const extractedId = extractId(trimmed)
    if (extractedId) {
      onSave({ id: extractedId, url: trimmed.replace(/\/$/, '') })
    } else {
      // If it looks like just a number, ask for full URL
      if (/^\d+$/.test(trimmed)) {
        alert('Please paste a full URL, not just the ID')
        return
      }
      onSave({ id: '?', url: trimmed })
    }
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>🔗 External Link</h3>
        <p className="dialog-hint">Paste a ticket URL — the ticket number will be extracted and shown as a clickable badge. Works with Azure DevOps, Jira, GitHub Issues, Linear, Shortcut, and more.</p>
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://..."
          autoFocus
          onKeyDown={e => {
            if (e.key === 'Enter') handleSave()
            if (e.key === 'Escape') onClose()
          }}
        />
        <div className="dialog-actions">
          {currentUrl && <button className="dialog-remove-btn" onClick={() => { onSave(null); onClose() }}>Remove Link</button>}
          <button onClick={onClose}>Cancel</button>
          <button className="dialog-save-btn" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}

// Priority Dropdown component
function PriorityDropdown({ currentPriority, onChangePriority }) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef(null)
  
  const priorities = [
    { icon: '🔴', label: 'Urgent & Important' },
    { icon: '🟡', label: 'Important' },
    { icon: '🔵', label: 'Urgent, Not Important' },
    { icon: '⚪', label: 'Low Priority' },
    { icon: '🐸', label: 'Frog (eat first)' },
    { icon: '📖', label: 'Learning' },
  ]
  
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])
  
  const handleSelect = (icon) => {
    onChangePriority(icon)
    setIsOpen(false)
  }
  
  return (
    <div className="priority-dropdown" ref={dropdownRef}>
      <span 
        className="priority-icon-btn"
        onClick={() => setIsOpen(!isOpen)}
        title="Click to change priority"
      >
        {currentPriority}
      </span>
      {isOpen && (
        <div className="priority-dropdown-menu">
          {priorities.map(({ icon, label }) => (
            <button
              key={icon}
              className={`priority-option ${icon === currentPriority ? 'selected' : ''}`}
              onClick={() => handleSelect(icon)}
            >
              <span className="priority-option-icon">{icon}</span>
              <span className="priority-option-label">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Add Task Dialog component
function AddTaskDialog({ section, onClose, onAdd, taskLookup, activeTaskIds, sources, defaultSourceId }) {
  const [task, setTask] = useState('')
  const [priority, setPriority] = useState('🟡')
  const [linkedTask, setLinkedTask] = useState('')
  const [sourceId, setSourceId] = useState(defaultSourceId || (sources && sources[0]?.id) || '')
  const dialogRef = useRef(null)
  const inputRef = useRef(null)
  
  useEffect(() => {
    inputRef.current?.focus()
    const handleClickOutside = (e) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target)) {
        onClose()
      }
    }
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])
  
  const handleSubmit = (e) => {
    e.preventDefault()
    if (task.trim()) {
      onAdd({ task: task.trim(), priority, linkedTask: linkedTask.trim(), section, sourceId })
      onClose()
    }
  }
  
  const allTaskIds = activeTaskIds || (taskLookup ? Object.keys(taskLookup) : [])
  
  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} className="add-task-dialog">
        <h3>Add Task to {section}</h3>
        <form onSubmit={handleSubmit}>
          {sources && sources.length > 0 && (
            <div className="form-field">
              <label>Source</label>
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                {sources.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-field">
            <label>Task</label>
            <input
              ref={inputRef}
              type="text"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Task description..."
            />
          </div>
          <div className="form-row">
            <div className="form-field">
              <label>Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="🔴">🔴 Urgent & Important</option>
                <option value="🟡">🟡 Important</option>
                <option value="🔵">🔵 Urgent, Not Important</option>
                <option value="⚪">⚪ Low Priority</option>
                <option value="🐸">🐸 Frog</option>
                <option value="📖">📖 Learning</option>
              </select>
            </div>
            <div className="form-field">
              <label title="Works with Azure DevOps, Jira, GitHub Issues, Linear, Shortcut, and more — paste any ticket URL">External Ticket <span className="label-hint">ℹ</span></label>
              <input
                type="text"
                list="add-task-linked-ids"
                value={linkedTask}
                onChange={(e) => setLinkedTask(e.target.value)}
                placeholder="Paste a ticket URL or task ID…"
              />
              <datalist id="add-task-linked-ids">
                {allTaskIds.map(tid => (
                  <option key={tid} value={tid}>{taskLookup[tid]}</option>
                ))}
              </datalist>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn-cancel">Cancel</button>
            <button type="submit" className="btn-add">Add Task</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function FileTree({ items, onSelect, selectedPath, defaultOpen = false }) {
  return (
    <ul className="file-tree">
      {items.map((item) => (
        <li key={item.path}>
          {item.type === 'directory' ? (
            <details open={defaultOpen}>
              <summary className="folder">📁 {item.name}</summary>
              {item.children && (
                <FileTree items={item.children} onSelect={onSelect} selectedPath={selectedPath} defaultOpen={defaultOpen} />
              )}
            </details>
          ) : (
            <button
              className={`file ${selectedPath === item.path ? 'selected' : ''}`}
              onClick={() => onSelect(item.path)}
            >
              📄 {item.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

// Calculate days since a date
function daysSince(dateStr) {
  if (!dateStr || dateStr === '-') return null
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffTime = today - date
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
  return diffDays
}

// Parse markdown table into structured data
function displayHeader(h) {
  if (h === 'Mngr Priority' || h === 'Work Priority') return 'Priority'
  return h
}

function parseMarkdownTable(lines) {
  const rows = []
  const rawLines = []
  let headerParsed = false
  let headers = []
  let linkedIdIndex = -1
  
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
    
    if (!headerParsed) {
      headers = cells
      // Find and remove "Linked ID" column
      linkedIdIndex = headers.findIndex(h => h.includes('Linked'))
      if (linkedIdIndex !== -1) {
        headers.splice(linkedIdIndex, 1)
      }
      // Replace "Added" column with "Age" (Added date shown on hover)
      const addedIndex = headers.indexOf('Added')
      if (addedIndex !== -1) {
        headers.splice(addedIndex, 1, 'Age')
      }
      headerParsed = true
      continue
    }
    
    // Skip separator row
    if (cells.every(c => /^[-:]+$/.test(c))) continue
    
    const row = {}
    let cellIndex = 0
    const linkedIdValue = linkedIdIndex !== -1 ? cells[linkedIdIndex] : ''
    
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i]
      if (h === 'Age') {
        // Read the Added date from the cell, store it, and calculate age
        if (linkedIdIndex !== -1 && cellIndex === linkedIdIndex) {
          cellIndex++
        }
        const addedValue = cells[cellIndex] || ''
        cellIndex++
        row['Added'] = addedValue
        const days = daysSince(addedValue)
        row[h] = days !== null ? `${days}d` : ''
      } else if (h === 'ID') {
        // Parse ID cell — may contain comma-separated local ID and ADO link
        // Format: "localId,[adoId](url)" or just "localId"
        const idValue = cells[cellIndex] || ''
        let localId = idValue
        let adoLink = null
        const commaIdx = idValue.indexOf(',[')
        if (commaIdx !== -1) {
          localId = idValue.substring(0, commaIdx)
          const adoPart = idValue.substring(commaIdx + 1)
          const adoMatch = adoPart.match(/\[(\d+)\]\(([^)]+)\)/)
          if (adoMatch) {
            adoLink = { id: adoMatch[1], url: adoMatch[2] }
          }
        }
        if (linkedIdValue && linkedIdValue !== '-') {
          row[h] = { id: localId, linkedId: linkedIdValue, adoLink }
        } else {
          row[h] = { id: localId, linkedId: null, adoLink }
        }
        cellIndex++
        // Skip over the linked ID cell index
        if (linkedIdIndex !== -1 && cellIndex === linkedIdIndex) {
          cellIndex++
        }
      } else {
        // Skip linked ID column when reading cells
        if (linkedIdIndex !== -1 && cellIndex === linkedIdIndex) {
          cellIndex++
        }
        row[h] = cells[cellIndex] || ''
        cellIndex++
      }
    }
    rows.push(row)
    rawLines.push(trimmed)
  }
  
  return { headers, rows, rawLines }
}

// Parse markdown links and render as clickable
function parseLinks(text, onNavigate) {
  if (!text) return text
  
  const parts = []
  let lastIndex = 0
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  let match
  
  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    
    const linkText = match[1]
    const href = match[2]
    
    // Check if it's an internal journal link
    if (href.startsWith('journal/') || href.endsWith('.md')) {
      parts.push(
        <a
          key={match.index}
          href="#"
          className="internal-link"
          onClick={(e) => {
            e.preventDefault()
            onNavigate(href)
          }}
        >
          {linkText}
        </a>
      )
    } else {
      parts.push(
        <a
          key={match.index}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="external-link"
        >
          {linkText}
        </a>
      )
    }
    
    lastIndex = match.index + match[0].length
  }
  
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  
  return parts.length > 0 ? parts : text
}

// Icon tooltip descriptions
const iconTooltips = {
  '🔴': 'Urgent & Important',
  '🟡': 'Important, Not Urgent',
  '🔵': 'Urgent, Not Important',
  '⚪': 'Not Urgent, Not Important',
  '✅': 'Done',
  '🐸': 'Frog (eat first)',
  '📖': 'Learning'
}

// Render cell content with icon tooltips and links
function renderCellWithTooltips(content, onNavigate) {
  if (!content) return content
  
  // Check if content is a single icon
  const trimmed = content.trim()
  if (iconTooltips[trimmed]) {
    return <span title={iconTooltips[trimmed]}>{content}</span>
  }
  
  // First parse links, then handle icons in the remaining text
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  const parts = []
  let lastIndex = 0
  let match
  
  while ((match = linkRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      // Add text before the link (with icon tooltips)
      const textBefore = content.slice(lastIndex, match.index)
      parts.push(...renderIconsWithTooltips(textBefore, lastIndex))
    }
    
    const linkText = match[1]
    const href = match[2]
    
    // Check if it's an internal link
    if (href.startsWith('journal/') || href.endsWith('.md')) {
      parts.push(
        <a
          key={`link-${match.index}`}
          href="#"
          className="internal-link"
          onClick={(e) => {
            e.preventDefault()
            onNavigate(href)
          }}
        >
          {linkText}
        </a>
      )
    } else {
      parts.push(
        <a
          key={`link-${match.index}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="external-link"
        >
          {linkText}
        </a>
      )
    }
    
    lastIndex = match.index + match[0].length
  }
  
  // Add remaining text after last link
  if (lastIndex < content.length) {
    parts.push(...renderIconsWithTooltips(content.slice(lastIndex), lastIndex))
  }
  
  return parts.length > 0 ? parts : content
}

// Helper to wrap icons with tooltips
function renderIconsWithTooltips(text, keyOffset = 0) {
  const iconPattern = /([🔴🟡🔵⚪✅🐸📖])/g
  if (!iconPattern.test(text)) {
    return [text]
  }
  
  iconPattern.lastIndex = 0 // Reset regex
  const parts = text.split(iconPattern)
  return parts.map((part, i) => {
    if (iconTooltips[part]) {
      return <span key={`icon-${keyOffset}-${i}`} title={iconTooltips[part]}>{part}</span>
    }
    return part
  }).filter(p => p !== '')
}

// Task row component with expandable todos
function TaskRow({ row, headers, onNavigate, managerPriorities, onScrollToPriorities, onContextMenu, rawLine, onChangePriority, onPromoteTodo, onRenameTask, onChangeLinkedId, taskLookup, activeTaskIds, linkedIdMap, adoLookup }) {
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [todos, setTodos] = useState(null)
  const [todosLoading, setTodosLoading] = useState(false)
  const [journalPath, setJournalPath] = useState(null)
  const [journalChecked, setJournalChecked] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [isEditingLinkedId, setIsEditingLinkedId] = useState(false)
  const [linkedIdText, setLinkedIdText] = useState('')
  
  const taskId = extractTaskId(row)
  
  // Check if journal exists for this task ID
  useEffect(() => {
    if (taskId && !journalChecked) {
      storage.checkJournal(taskId)
        .then(data => {
          if (data.exists) {
            setJournalPath(data.path)
          }
          setJournalChecked(true)
        })
        .catch(() => setJournalChecked(true))
    }
  }, [taskId])
  
  // Fetch todos when journal path is known
  useEffect(() => {
    if (journalPath && todos === null) {
      setTodosLoading(true)
      storage.getTodos(journalPath)
        .then(todos => {
          setTodos(todos || [])
          setTodosLoading(false)
        })
        .catch(() => {
          setTodos([])
          setTodosLoading(false)
        })
    }
  }, [journalPath])
  
  const getPriorityClass = (priority) => {
    if (priority?.includes('🔴')) return 'priority-urgent'
    if (priority?.includes('🟡')) return 'priority-important'
    if (priority?.includes('🔵')) return 'priority-delegate'
    if (priority?.includes('⚪')) return 'priority-low'
    if (priority?.includes('✅')) return 'priority-done'
    return ''
  }
  
  const priorityCol = headers.find(h => h.includes('🎯')) || '🎯'
  const mngrPriorityCol = headers.find(h => h.includes('Mngr') || h.includes('Work') || h.includes('Priority')) || 'Work Priority'
  
  const handleContextMenu = (e) => {
    e.preventDefault()
    onContextMenu(e, rawLine, row, journalPath, taskId)
  }
  
  // Filter to only uncompleted todos
  const uncompletedTodos = todos ? todos.filter(t => !t.done) : []
  const hasUncompletedTodos = uncompletedTodos.length > 0
  const nextTodo = hasUncompletedTodos ? uncompletedTodos[0] : null
  
  return (
    <>
      <tr 
        className={getPriorityClass(row[priorityCol])}
        onContextMenu={handleContextMenu}
        data-task-id={taskId || undefined}
      >
        {headers.map((h, i) => {
          const cellValue = row[h]
          
          // Special handling for ID column (with linked ID arrow)
          if (h === 'ID' && typeof cellValue === 'object') {
            const { id, linkedId, adoLink } = cellValue
            const taskName = row['Task'] || ''
            const linkedTaskName = linkedId && taskLookup ? taskLookup[linkedId] : null
            const allTaskIds = activeTaskIds || (taskLookup ? Object.keys(taskLookup) : [])

            const startEditingLinkedId = (e) => {
              e.stopPropagation()
              setLinkedIdText(linkedId || '')
              setIsEditingLinkedId(true)
            }

            const saveLinkedId = () => {
              const trimmed = linkedIdText.trim()
              const oldLinkedId = linkedId || ''
              setIsEditingLinkedId(false)
              if (trimmed !== oldLinkedId) {
                onChangeLinkedId(rawLine, trimmed)
              }
            }

            const navigateToLinkedId = (e) => {
              e.stopPropagation()
              if (!linkedId) return
              // Try to scroll to the task on the current page
              let targetRow = document.querySelector(`tr[data-task-id="${linkedId}"]`)
              if (targetRow) {
                targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
                targetRow.classList.add('highlight-flash')
                setTimeout(() => targetRow.classList.remove('highlight-flash'), 1500)
                return
              }
              // Task might be in a collapsed section — expand collapsed ones and retry
              const collapsedHeaders = document.querySelectorAll('.section-header .collapse-icon')
              let expanded = false
              collapsedHeaders.forEach(icon => {
                if (icon.textContent.trim() === '▶') {
                  icon.closest('.section-header').click()
                  expanded = true
                }
              })
              if (expanded) {
                setTimeout(() => {
                  targetRow = document.querySelector(`tr[data-task-id="${linkedId}"]`)
                  if (targetRow) {
                    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    targetRow.classList.add('highlight-flash')
                    setTimeout(() => targetRow.classList.remove('highlight-flash'), 1500)
                  } else {
                    onNavigate('focus-plan-completed.md', linkedId)
                  }
                }, 100)
              } else {
                onNavigate('focus-plan-completed.md', linkedId)
              }
            }

            return (
              <td key={i} title={taskName} className="id-cell">
                {adoLink ? (
                  <a className="external-link ado-id-link" href={adoLink.url} target="_blank" rel="noopener noreferrer" title={`Ticket #${adoLink.id}`} onClick={(e) => e.stopPropagation()}>
                    {adoLink.id}
                  </a>
                ) : (
                  parseLinks(id, onNavigate)
                )}
                {isEditingLinkedId ? (
                  <span className="linked-id-edit-wrapper">
                    <span className="arrow">→</span>
                    <input
                      className="linked-id-input"
                      type="text"
                      list={`linked-ids-${id}`}
                      value={linkedIdText}
                      onChange={e => setLinkedIdText(e.target.value)}
                      onBlur={saveLinkedId}
                      onKeyDown={e => {
                        if (e.key === 'Enter') saveLinkedId()
                        if (e.key === 'Escape') setIsEditingLinkedId(false)
                      }}
                      autoFocus
                      placeholder="ID"
                    />
                    <datalist id={`linked-ids-${id}`}>
                      {allTaskIds.filter(tid => tid !== String(id).replace(/\D/g, '')).map(tid => (
                        <option key={tid} value={tid}>{taskLookup[tid]}</option>
                      ))}
                    </datalist>
                  </span>
                ) : linkedId ? (
                  <span className="linked-id-wrapper">
                    <span className="arrow linked-id-edit-arrow" onClick={startEditingLinkedId} title="Edit link">→</span>
                    {(() => {
                      const linkedNumMatch = linkedId.match(/^(\d+)$/)
                      const linkedAdoLink = linkedNumMatch && adoLookup ? adoLookup[linkedNumMatch[1]] : null
                      if (linkedAdoLink) {
                        return <a className="linked-id-link external-link ado-id-link" href={linkedAdoLink.url} target="_blank" rel="noopener noreferrer" title={linkedTaskName || `Ticket #${linkedAdoLink.id}`} onClick={(e) => e.stopPropagation()}>{linkedAdoLink.id}</a>
                      }
                      return <span className="linked-id-link" onClick={navigateToLinkedId} title={linkedTaskName || `Go to task ${linkedId.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}`}>{parseLinks(linkedId, onNavigate)}</span>
                    })()}
                    {linkedTaskName && (
                      <span className="linked-id-tooltip">{linkedTaskName}</span>
                    )}
                  </span>
                ) : (
                  <span className="linked-id-add-btn" onClick={startEditingLinkedId} title="Link to another task">
                    <span className="arrow">→</span>
                  </span>
                )}
              </td>
            )
          }
          
          // Special handling for Task column - add journal link and todo expander
          if (h === 'Task') {
            const startEditing = () => {
              setEditText(cellValue || '')
              setIsEditing(true)
            }
            
            const saveEdit = () => {
              if (editText.trim() && editText !== cellValue) {
                onRenameTask(rawLine, editText.trim())
              }
              setIsEditing(false)
            }
            
            const cancelEdit = () => {
              setIsEditing(false)
              setEditText('')
            }
            
            return (
              <td key={i}>
                <div className="task-with-todos">
                  {isEditing ? (
                    <input
                      type="text"
                      className="task-edit-input"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onBlur={saveEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit()
                        if (e.key === 'Escape') cancelEdit()
                      }}
                      autoFocus
                    />
                  ) : (
                    <span className="task-text" onDoubleClick={startEditing} title="Double-click to edit">
                      {renderCellWithTooltips(cellValue, onNavigate)}
                      {journalPath && (
                        <a
                          href="#"
                          className="journal-link"
                          title="Open journal"
                          onClick={(e) => {
                            e.preventDefault()
                            onNavigate(journalPath)
                          }}
                        >
                          📓
                        </a>
                      )}
                    </span>
                  )}
                  {hasUncompletedTodos && !isEditing && (
                    <div className="todo-preview" onClick={() => setTodosExpanded(!todosExpanded)}>
                      <span className="todo-expander">{todosExpanded ? '▼' : '▶'}</span>
                      {!todosExpanded && nextTodo && (
                        <span className="todo-first">
                          {nextTodo.text}
                        </span>
                      )}
                    </div>
                  )}
                  {todosLoading && <span className="todo-loading">...</span>}
                </div>
              </td>
            )
          }
          
          // Special handling for Work Priority column — read-only, derived from linked ID chain
          if (h === mngrPriorityCol) {
            const resolved = resolveManagerPriority(taskId, linkedIdMap || {}, managerPriorities)
            const isSelfPriority = taskId && managerPriorities[taskId]
            
            if (isSelfPriority) {
              return (
                <td key={i}>
                  <span 
                    className="mngr-priority-link mngr-priority-self"
                    title={`This task is Work Priority #${managerPriorities[taskId]}`}
                    onClick={(e) => { e.stopPropagation(); onScrollToPriorities() }}
                  >
                    ★ #{managerPriorities[taskId]}
                  </span>
                </td>
              )
            }
            
            if (resolved) {
              const resolvedName = taskLookup ? taskLookup[resolved.id] : resolved.id
              return (
                <td key={i}>
                  <span 
                    className="mngr-priority-link"
                    title={`Linked to Work Priority #${resolved.order}: ${resolvedName || resolved.id}`}
                    onClick={(e) => { e.stopPropagation(); onScrollToPriorities() }}
                  >
                    {resolvedName || `Task ${resolved.id}`}
                    <span className="priority-badge">#{resolved.order}</span>
                  </span>
                </td>
              )
            }
            
            return <td key={i}>-</td>
          }
          
          // Special handling for Priority column - clickable dropdown
          if (h === priorityCol) {
            return (
              <td key={i}>
                <PriorityDropdown 
                  currentPriority={cellValue || '⚪'} 
                  onChangePriority={(newPriority) => onChangePriority(rawLine, cellValue, newPriority)}
                />
              </td>
            )
          }
          
          // Age column shows Added date on hover
          if (h === 'Age') {
            const addedDate = row['Added'] || ''
            return <td key={i} title={addedDate ? `Added: ${addedDate}` : ''} style={{cursor: addedDate ? 'default' : undefined}}>{cellValue}</td>
          }
          
          return <td key={i}>{renderCellWithTooltips(cellValue, onNavigate)}</td>
        })}
      </tr>
      {todosExpanded && hasUncompletedTodos && (
        <tr className="todo-row">
          <td></td>
          <td></td>
          <td colSpan={headers.length - 2}>
            <div className="todo-list">
              {uncompletedTodos.map((todo, i) => (
                <div key={i} className="todo-item">
                  <span className="todo-text">{todo.text}</span>
                  <button 
                    className="promote-todo-btn"
                    title="Promote to task"
                    onClick={() => onPromoteTodo(todo.text, taskId, row)}
                  >
                    ↗
                  </button>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// Collapsible section component
function TaskSection({ title, tableLines, onNavigate, defaultOpen = true, managerPriorities, onScrollToPriorities, onTaskAction, onMoveToCompleted, onAddTask, onCreateJournal, onChangePriority, onDeleteTask, onPromoteTodo, onRenameTask, onChangeLinkedId, onLinkToAdoBugDb, taskLookup, activeTaskIds, linkedIdMap, adoLookup, onPromoteToManagerPriority, onRemoveFromManagerPriority }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const { headers, rows, rawLines } = parseMarkdownTable(tableLines)
  const [contextMenu, setContextMenu] = useState(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [adoLinkDialog, setAdoLinkDialog] = useState(null)
  
  // Sort rows: urgent first, then manager priority, then dependency depth, then eisenhower icon
  const { sortedRows, sortedRawLines } = sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities)
  
  const isTaskSection = title === 'Today' || title === 'Deferred'
  if (sortedRows.length === 0 && !showAddDialog && !isTaskSection) return null
  
  const openTaskPiP = async (taskId, taskName, priority, journalPath) => {
    const pipWindow = await documentPictureInPicture.requestWindow({
      width: 420,
      height: 320,
    })
    
    const style = pipWindow.document.createElement('style')
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #1a1a2e; color: #e2e8f0; padding: 16px; overflow-y: auto; cursor: default; }
      body::after { content: "Double-click to open journal"; position: fixed; bottom: 6px; left: 0; right: 0;
        text-align: center; font-size: 0.65rem; color: #475569; pointer-events: none; }
      .pip-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
        border-bottom: 1px solid #334155; padding-bottom: 10px; }
      .pip-priority { font-size: 1.4rem; }
      .pip-title { font-size: 1rem; font-weight: 600; color: #fff; flex: 1; }
      .pip-id { font-size: 0.75rem; color: #64748b; }
      .pip-section-label { font-size: 0.75rem; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
      .pip-todo { padding: 4px 0; font-size: 0.9rem; color: #cbd5e1; display: flex; align-items: flex-start; gap: 6px; }
      .pip-todo::before { content: "○"; color: #60a5fa; flex-shrink: 0; margin-top: 1px; }
      .pip-todo.done { text-decoration: line-through; opacity: 0.4; }
      .pip-todo.done::before { content: "●"; color: #22c55e; }
      .pip-empty { color: #64748b; font-style: italic; font-size: 0.85rem; margin-top: 8px; }
    `
    pipWindow.document.head.appendChild(style)
    
    const container = pipWindow.document.createElement('div')
    container.innerHTML = `
      <div class="pip-header">
        <span class="pip-priority">${priority}</span>
        <span class="pip-title">${taskName}</span>
        ${taskId ? `<span class="pip-id">#${taskId}</span>` : ''}
      </div>
    `
    pipWindow.document.body.appendChild(container)
    
    // Double-click anywhere to jump to journal in main window
    pipWindow.document.body.addEventListener('dblclick', () => {
      if (journalPath) {
        onNavigate(journalPath)
      }
      window.focus()
    })
    
    // Fetch and show todos if journal exists
    if (journalPath) {
      try {
        const todos = await storage.getTodos(journalPath)
        if (todos.length > 0) {
          const label = pipWindow.document.createElement('div')
          label.className = 'pip-section-label'
          label.textContent = 'To Do'
          container.appendChild(label)
          for (const todo of todos) {
            const item = pipWindow.document.createElement('div')
            item.className = `pip-todo${todo.done ? ' done' : ''}`
            item.textContent = todo.text
            container.appendChild(item)
          }
        } else {
          const empty = pipWindow.document.createElement('div')
          empty.className = 'pip-empty'
          empty.textContent = 'No todos in journal'
          container.appendChild(empty)
        }
      } catch {
        const err = pipWindow.document.createElement('div')
        err.className = 'pip-empty'
        err.textContent = 'Could not load journal'
        container.appendChild(err)
      }
    } else {
      const empty = pipWindow.document.createElement('div')
      empty.className = 'pip-empty'
      empty.textContent = 'No journal for this task'
      container.appendChild(empty)
    }
  }

  const handleContextMenu = (e, rawLine, row, journalPath, taskId) => {
    const options = []
    
    if (title === 'Today') {
      options.push({
        label: 'Defer',
        icon: '📅',
        action: () => onTaskAction('defer', rawLine, 'Today', 'Deferred')
      })
    } else if (title === 'Deferred') {
      options.push({
        label: 'Move to Today',
        icon: '⬆️',
        action: () => onTaskAction('move', rawLine, 'Deferred', 'Today')
      })
    }
    
    // Add "Move to Completed" option for both Today and Deferred
    options.push({
      label: 'Move to Completed',
      icon: '✅',
      action: () => onMoveToCompleted(rawLine, row, title)
    })
    
    // Add "Create Journal" option if no journal exists and we have a task ID
    if (!journalPath && taskId) {
      const taskName = row['Task'] || ''
      options.push({
        label: 'Create Journal',
        icon: '📓',
        action: () => onCreateJournal(taskId, taskName)
      })
    }
    
    // Add "Focus Sticky Note" option
    if ('documentPictureInPicture' in window) {
      const taskName = row['Task'] || ''
      const priority = row[headers.find(h => h.includes('🎯')) || '🎯'] || ''
      options.push({
        label: 'Focus Sticky Note',
        icon: '📌',
        action: () => openTaskPiP(taskId, taskName, priority, journalPath)
      })
    }
    
    // Add "Promote/Remove Priority" option (unified — was Work + Personal)
    if (taskId) {
      if (managerPriorities[taskId]) {
        options.push({
          label: 'Remove from Priorities',
          icon: '⭐',
          action: () => onRemoveFromManagerPriority(taskId)
        })
      } else {
        options.push({
          label: 'Promote to Priority',
          icon: '⭐',
          action: () => onPromoteToManagerPriority(taskId)
        })
      }
    }
    
    // Add "Link to Bug DB" option
    const idObj = row['ID']
    const currentAdoLink = typeof idObj === 'object' ? idObj.adoLink : null
    options.push({
      label: currentAdoLink ? 'Edit external link' : 'External link',
      icon: '🔗',
      action: () => setAdoLinkDialog({ rawLine, currentUrl: currentAdoLink ? currentAdoLink.url : '' })
    })
    
    // Add "Delete Task" option (also deletes journal if exists)
    options.push({
      label: 'Delete Task',
      icon: '🗑️',
      action: () => onDeleteTask(rawLine, title, journalPath)
    })
    
    if (options.length > 0) {
      setContextMenu({ x: e.clientX, y: e.clientY, options })
    }
  }
  
  return (
    <div className="task-section">
      <h2 
        className="section-header"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="collapse-icon">{isOpen ? '▼' : '▶'}</span>
        {title}
        <span className="task-count">({sortedRows.length})</span>
        <span className="sort-info-wrapper" onClick={(e) => e.stopPropagation()}>
          <span className="sort-info-icon" title="Sort order">ⓘ</span>
          <span className="sort-info-tooltip">
            <strong>Sort Order</strong><br/>
            1. 🔴 Urgent — always on top<br/>
            2. Work Priority (🐸 first within each)<br/>
            3. Priority icon: 🐸 → 🟡 → 🔵 → 📖 → ⚪ → ✅
          </span>
        </span>
        <button 
          className="add-task-btn"
          onClick={(e) => {
            e.stopPropagation()
            setShowAddDialog(true)
          }}
          title={`Add task to ${title}`}
        >
          +
        </button>
      </h2>
      {isOpen && (
        <div className="task-table-container">
          <table className="task-table">
            <thead>
              <tr>
                {headers.map((h, i) => <th key={i}>{displayHeader(h)}</th>)}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, i) => (
                <TaskRow 
                  key={extractTaskId(row) || `row-${i}`} 
                  row={row} 
                  headers={headers} 
                  onNavigate={onNavigate}
                  managerPriorities={managerPriorities}
                  onScrollToPriorities={onScrollToPriorities}
                  onContextMenu={handleContextMenu}
                  rawLine={sortedRawLines[i]}
                  onChangePriority={onChangePriority}
                  onPromoteTodo={onPromoteTodo}
                  onRenameTask={onRenameTask}
                  onChangeLinkedId={onChangeLinkedId}
                  taskLookup={taskLookup}
                  activeTaskIds={activeTaskIds}
                  linkedIdMap={linkedIdMap}
                  adoLookup={adoLookup}/>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          options={contextMenu.options}
          onClose={() => setContextMenu(null)}
        />
      )}
      {showAddDialog && (
        <AddTaskDialog
          section={title}
          onClose={() => setShowAddDialog(false)}
          onAdd={onAddTask}
          taskLookup={taskLookup}
          activeTaskIds={activeTaskIds}
        />
      )}
      {adoLinkDialog && (
        <AdoLinkDialog
          currentUrl={adoLinkDialog.currentUrl}
          onClose={() => setAdoLinkDialog(null)}
          onSave={(adoLink) => onLinkToAdoBugDb(adoLinkDialog.rawLine, adoLink)}
        />
      )}
    </div>
  )
}

// Manager Priorities Section
function ManagerPrioritiesSection({ lines, defaultOpen = false, onUpdate, onAddAndPrioritize, tasksByPriority = {}, taskLookup = {}, title = 'Work Priorities', sectionId = 'work-priorities' }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [isAdding, setIsAdding] = useState(false)
  const [newPriority, setNewPriority] = useState('')
  const [expandedPriorities, setExpandedPriorities] = useState({})
  const priorities = parseManagerPriorities(lines)
  const priorityList = Object.entries(priorities).sort((a, b) => a[1] - b[1])
  
  const toggleExpanded = (id) => {
    setExpandedPriorities(prev => ({ ...prev, [id]: !prev[id] }))
  }
  
  const scrollToTask = (taskId) => {
    if (!taskId) return
    let targetRow = document.querySelector(`tr[data-task-id="${taskId}"]`)
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
      targetRow.classList.add('highlight-flash')
      setTimeout(() => targetRow.classList.remove('highlight-flash'), 1500)
      return
    }
    // Expand collapsed sections and retry
    const collapsedHeaders = document.querySelectorAll('.task-section:not(.manager-priorities-section) .section-header .collapse-icon, .task-section:not(.personal-priorities-section) .section-header .collapse-icon')
    let expanded = false
    collapsedHeaders.forEach(icon => {
      if (icon.textContent.trim() === '▶') {
        icon.closest('.section-header').click()
        expanded = true
      }
    })
    if (expanded) {
      setTimeout(() => {
        targetRow = document.querySelector(`tr[data-task-id="${taskId}"]`)
        if (targetRow) {
          targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
          targetRow.classList.add('highlight-flash')
          setTimeout(() => targetRow.classList.remove('highlight-flash'), 1500)
        }
      }, 150)
    }
  }
  
  const handleAdd = () => {
    const text = newPriority.trim()
    if (!text) return
    if (onAddAndPrioritize) {
      onAddAndPrioritize(text)
    } else {
      const newLines = [...lines]
      let lastNumIndex = -1
      for (let i = 0; i < newLines.length; i++) {
        if (/^\d+\.\s+/.test(newLines[i].trim())) lastNumIndex = i
      }
      const newNum = priorityList.length + 1
      const newLine = `${newNum}. ${text}`
      if (lastNumIndex >= 0) newLines.splice(lastNumIndex + 1, 0, newLine)
      else newLines.push(newLine)
      onUpdate(newLines)
    }
    setNewPriority('')
    setIsAdding(false)
  }
  
  const handleDelete = (id) => {
    const newLines = lines.filter(line => {
      const match = line.trim().match(/^\d+\.\s+(.+)$/)
      return !(match && match[1].trim() === id)
    })
    let num = 1
    const renumbered = newLines.map(line => {
      const match = line.trim().match(/^\d+\.\s+(.+)$/)
      if (match) {
        return `${num++}. ${match[1]}`
      }
      return line
    })
    onUpdate(renumbered)
  }
  
  const handleMove = (id, direction) => {
    const idx = priorityList.findIndex(([n]) => n === id)
    if (direction === 'up' && idx <= 0) return
    if (direction === 'down' && idx >= priorityList.length - 1) return
    
    const newList = [...priorityList]
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    ;[newList[idx], newList[swapIdx]] = [newList[swapIdx], newList[idx]]
    
    const newLines = lines.filter(line => !/^\d+\.\s+/.test(line.trim()))
    newList.forEach(([n], i) => {
      newLines.push(`${i + 1}. ${n}`)
    })
    onUpdate(newLines)
  }
  
  const allTaskIds = taskLookup ? Object.keys(taskLookup) : []
  
  return (
    <div className="task-section manager-priorities-section" id={sectionId}>
      <h2
        className="section-header"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="collapse-icon">{isOpen ? '▼' : '▶'}</span>
        {title}
        <span className="task-count">({priorityList.length})</span>
        <button 
          className="add-task-btn"
          onClick={(e) => { e.stopPropagation(); setIsOpen(true); setIsAdding(true); }}
          title="Add priority"
        >+</button>
      </h2>
      {isOpen && (
        <div className="priorities-content">
          <ol className="priorities-list">
            {priorityList.map(([id, num], idx) => {
              const rawTasks = tasksByPriority[id] || []
              const priorityOrder = { '🐸': 0, '🔴': 1, '🟡': 2, '🔵': 3, '⚪': 4, '📖': 5, '✅': 6 }
              const sectionOrder = { 'Today': 0, 'Deferred': 1 }
              const tasks = [...rawTasks].sort((a, b) => {
                const sa = sectionOrder[a.section] ?? 2
                const sb = sectionOrder[b.section] ?? 2
                if (sa !== sb) return sa - sb
                const pa = Object.keys(priorityOrder).find(icon => (a.priority || '').includes(icon)) || '⚪'
                const pb = Object.keys(priorityOrder).find(icon => (b.priority || '').includes(icon)) || '⚪'
                return (priorityOrder[pa] ?? 4) - (priorityOrder[pb] ?? 4)
              })
              const isExpanded = expandedPriorities[id] || false
              const firstTask = tasks[0]
              const taskName = taskLookup[id] || `Task ${id}`
              
              return (
                <li key={id} className="priority-item">
                  <div className="priority-item-header">
                    <span className="priority-number">#{num}</span>
                    <span className="priority-name priority-name-clickable" onClick={() => scrollToTask(id)} title={taskName}>
                      {taskName}
                    </span>
                    {tasks.length > 0 && (
                      <span className="priority-task-count">({tasks.length})</span>
                    )}
                    <span className="priority-actions">
                      <button 
                        className="priority-move-btn" 
                        onClick={() => handleMove(id, 'up')}
                        disabled={idx === 0}
                        title="Move up"
                      >↑</button>
                      <button 
                        className="priority-move-btn" 
                        onClick={() => handleMove(id, 'down')}
                        disabled={idx === priorityList.length - 1}
                        title="Move down"
                      >↓</button>
                      <button 
                        className="priority-delete-btn" 
                        onClick={() => handleDelete(id)}
                        title="Remove"
                      >×</button>
                    </span>
                  </div>
                  {tasks.length > 0 && (
                    <div className="priority-tasks-preview" onClick={() => toggleExpanded(id)}>
                      <span className="todo-expander">{isExpanded ? '▼' : '▶'}</span>
                      {!isExpanded && firstTask && (
                        <span className="todo-first" onClick={(e) => { e.stopPropagation(); scrollToTask(firstTask.id); }}>
                          {firstTask.priority} {firstTask.task}
                          <span className="priority-task-section">({firstTask.section})</span>
                        </span>
                      )}
                    </div>
                  )}
                  {isExpanded && tasks.length > 0 && (
                    <div className="priority-tasks-list">
                      {tasks.map((t, idx) => (
                        <div key={`${t.id}-${t.section}-${idx}`} className="priority-task-item" onClick={() => scrollToTask(t.id)} title={t.task}>
                          <span className="priority-task-icon">{t.priority}</span>
                          <span className="priority-task-name">{t.task}</span>
                          <span className="priority-task-section">({t.section})</span>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
          {isAdding && (
            <div className="add-priority-form">
              <input
                type="text"
                list="add-priority-task-ids"
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value)}
                placeholder="Task name..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd()
                  if (e.key === 'Escape') { setIsAdding(false); setNewPriority('') }
                }}
              />
              <datalist id="add-priority-task-ids">
                {allTaskIds.filter(tid => !priorities[tid]).map(tid => (
                  <option key={tid} value={tid}>{taskLookup[tid]}</option>
                ))}
              </datalist>
              <button onClick={handleAdd}>Add</button>
              <button onClick={() => { setIsAdding(false); setNewPriority('') }}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Parse focus-plan.md into sections
function parseFocusPlan(content) {
  const lines = content.split('\n')
  const sections = []
  let currentSection = null
  let currentLines = []
  
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection) {
        sections.push({ title: currentSection, lines: currentLines })
      }
      currentSection = line.replace('## ', '').trim()
      currentLines = []
    } else if (currentSection) {
      currentLines.push(line)
    }
  }
  
  if (currentSection) {
    sections.push({ title: currentSection, lines: currentLines })
  }
  
  return sections
}

// Section-name predicates. The unified "Priorities" section absorbs the
// legacy split between "Work Priorities" and "Manager Priorities".
function isPrioritiesSection(title) {
  return title === 'Priorities' || title === 'Work Priorities' || title === 'Manager Priorities'
}
function isPersonalPrioritiesSection(title) {
  return title === 'Personal Priorities'
}

/**
 * One-shot migration: collapse legacy `Work Priorities` + `Personal Priorities`
 * (or just the legacy heading) into a single `## Priorities` section.
 *
 * Returns the migrated content, or `null` if no migration was needed (so callers
 * can avoid pointless writes).
 */
function migratePrioritiesSections(content) {
  const lines = content.split('\n')
  const sections = []
  let current = null
  let buffer = []
  let headerLineIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      if (current) sections.push({ ...current, lines: buffer, end: i })
      current = { title: line.replace('## ', '').trim(), start: i, headerLine: line }
      buffer = []
      if (headerLineIdx === -1) headerLineIdx = i
    } else if (current) {
      buffer.push(line)
    }
  }
  if (current) sections.push({ ...current, lines: buffer, end: lines.length })

  const work = sections.find(s => isPrioritiesSection(s.title))
  const personal = sections.find(s => isPersonalPrioritiesSection(s.title))
  if (!work && !personal) return null
  // Already canonical and no Personal section → no-op.
  if (work && work.title === 'Priorities' && !personal) return null

  const collectEntries = (lines) => lines
    .map(l => l.trim().match(/^\d+\.\s+(.+)$/))
    .filter(Boolean)
    .map(m => m[1].trim())

  const workEntries = work ? collectEntries(work.lines) : []
  const personalEntries = personal ? collectEntries(personal.lines) : []
  const seen = new Set()
  const merged = []
  for (const e of [...workEntries, ...personalEntries]) {
    if (seen.has(e)) continue
    seen.add(e)
    merged.push(e)
  }

  // Rebuild the file: drop the old sections, insert a single Priorities section
  // wherever the first of them used to live (preserving ordering relative to Today/Deferred).
  const toRemove = new Set()
  for (const s of [work, personal]) {
    if (!s) continue
    for (let i = s.start; i < s.end; i++) toRemove.add(i)
  }
  const insertAt = work ? work.start : personal.start
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (i === insertAt) {
      out.push('## Priorities')
      out.push('')
      merged.forEach((e, idx) => out.push(`${idx + 1}. ${e}`))
      out.push('')
    }
    if (toRemove.has(i)) continue
    out.push(lines[i])
  }
  // Trim trailing blank lines accumulated by repeated migrations
  while (out.length > 1 && out[out.length - 1] === '' && out[out.length - 2] === '') {
    out.pop()
  }
  return out.join('\n')
}

// Build task ID to name lookup from table lines
function buildTaskIdLookup(tableLines) {
  const lookup = {}
  const { headers, rows } = parseMarkdownTable(tableLines)
  const idHeader = headers.find(h => h === 'ID' || h === '#') || 'ID'
  for (const row of rows) {
    const idValue = row[idHeader]
    let id = null
    if (typeof idValue === 'object') {
      const match = idValue.id.match(/\[?(\d+)\]?/)
      if (match) id = match[1]
    } else if (idValue) {
      const match = String(idValue).match(/(\d+)/)
      if (match) id = match[1]
    }
    if (id) {
      lookup[id] = row['Task'] || ''
    }
  }
  return lookup
}

// Build ADO lookup: localTaskId -> { id, url } for tasks that have ADO links
function buildAdoLookup(tableLines) {
  const lookup = {}
  const { headers, rows } = parseMarkdownTable(tableLines)
  const idHeader = headers.find(h => h === 'ID' || h === '#') || 'ID'
  for (const row of rows) {
    const idValue = row[idHeader]
    if (typeof idValue === 'object' && idValue.adoLink) {
      const match = idValue.id.match(/\[?(\d+)\]?/)
      if (match) {
        lookup[match[1]] = idValue.adoLink
      }
    }
  }
  return lookup
}

// Build linked ID map: taskId -> linkedId (for chain walking)
function buildLinkedIdMap(tableLines) {
  const map = {}
  const { headers, rows } = parseMarkdownTable(tableLines)
  const idHeader = headers.find(h => h === 'ID' || h === '#') || 'ID'
  for (const row of rows) {
    const idValue = row[idHeader]
    if (typeof idValue === 'object' && idValue.linkedId) {
      const idMatch = idValue.id.match(/\[?(\d+)\]?/)
      const linkedMatch = idValue.linkedId.match(/\[?(\d+)\]?/)
      if (idMatch && linkedMatch) {
        map[idMatch[1]] = linkedMatch[1]
      }
    }
  }
  return map
}

// Focus Plan View component
function FocusPlanView({ content, onNavigate, onContentUpdate }) {
  const [completedTaskLookup, setCompletedTaskLookup] = useState({})
  const sections = parseFocusPlan(content)
  
  // Find sections
  const taskSections = sections.filter(s => 
    s.title === 'Today' || s.title === 'Deferred'
  )
  const managerPrioritiesSection = sections.find(s => isPrioritiesSection(s.title))

  // Parse the unified Priorities section. We keep the variable name
  // `managerPriorities` for compatibility with downstream sort/lookup helpers.
  const managerPriorities = managerPrioritiesSection
    ? parseManagerPriorities(managerPrioritiesSection.lines)
    : {}

  // Build lookup from current focus plan tasks + linked ID map + ADO lookup for chain walking
  const currentTaskLookup = {}
  const linkedIdMap = {}
  const adoLookup = {}
  for (const section of taskSections) {
    Object.assign(currentTaskLookup, buildTaskIdLookup(section.lines))
    Object.assign(linkedIdMap, buildLinkedIdMap(section.lines))
    Object.assign(adoLookup, buildAdoLookup(section.lines))
  }
  // Also include manager priorities section in ADO lookup
  if (managerPrioritiesSection) {
    Object.assign(adoLookup, buildAdoLookup(managerPrioritiesSection.lines))
  }

  // Build tasksByPriority: group tasks by which manager priority they resolve to via chain walking
  const tasksByPriority = {}
  for (const section of taskSections) {
    const { headers, rows } = parseMarkdownTable(section.lines)
    const priorityCol = headers.find(h => h.includes('🎯')) || '🎯'
    for (const row of rows) {
      const id = extractTaskId(row)
      if (!id) continue
      // Skip tasks that ARE manager priorities themselves
      if (managerPriorities[id]) continue
      const resolved = resolveManagerPriority(id, linkedIdMap, managerPriorities)
      if (resolved) {
        if (!tasksByPriority[resolved.id]) tasksByPriority[resolved.id] = []
        tasksByPriority[resolved.id].push({
          id,
          task: row['Task'] || '',
          priority: row[priorityCol] || '',
          section: section.title
        })
      }
    }
  }
  
  // Fetch completed tasks for linked ID lookup
  useEffect(() => {
    storage.read('focus-plan-completed.md')
      .then(content => {
        if (content) {
          const completedSections = parseFocusPlan(content)
          const lookup = {}
          for (const section of completedSections) {
            Object.assign(lookup, buildTaskIdLookup(section.lines))
          }
          setCompletedTaskLookup(lookup)
        }
      })
      .catch(() => {})
  }, [])
  
  // Merge lookups: current tasks take priority (full lookup for display, active-only for dropdowns)
  const taskLookup = { ...completedTaskLookup, ...currentTaskLookup }
  const activeTaskIds = Object.keys(currentTaskLookup)
  
  const scrollToPriorities = () => {
    const el = document.getElementById('priorities')
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
      const header = el.querySelector('.section-header')
      if (header && el.querySelector('.priorities-content') === null) {
        header.click()
      }
    }
  }

  const handleTaskAction = async (action, rawLine, fromSection, toSection) => {
    // Move task from one section to another
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
      
      // Find where to insert in target section (after header row and separator)
      if (inToSection && line.trim().startsWith('|') && line.includes('---')) {
        toSectionInsertIndex = i + 1
      }
      
      // Find the line to remove
      if (inFromSection && line.trim() === rawLine) {
        lineToRemoveIndex = i
      }
    }
    
    if (lineToRemoveIndex !== -1 && toSectionInsertIndex !== -1) {
      // Remove from source
      const removedLine = lines.splice(lineToRemoveIndex, 1)[0]
      
      // Adjust insert index if removal was before it
      if (lineToRemoveIndex < toSectionInsertIndex) {
        toSectionInsertIndex--
      }
      
      // Insert into target
      lines.splice(toSectionInsertIndex, 0, removedLine)
      
      const newContent = lines.join('\n')
      await onContentUpdate(newContent)
    }
  }
  
  const handleChangePriority = async (rawLine, oldPriority, newPriority) => {
    // Replace the priority in the raw line
    const newLine = rawLine.replace(oldPriority, newPriority)
    const lines = content.split('\n')
    const lineIndex = lines.findIndex(line => line.trim() === rawLine)
    if (lineIndex !== -1) {
      lines[lineIndex] = newLine
      const newContent = lines.join('\n')
      await onContentUpdate(newContent)
    }
  }
  
  const handleDeleteTask = async (rawLine, fromSection, journalPath) => {
    // Delete the task from focus plan
    const lines = content.split('\n')
    const lineIndex = lines.findIndex(line => line.trim() === rawLine)
    if (lineIndex !== -1) {
      lines.splice(lineIndex, 1)
      const newContent = lines.join('\n')
      await onContentUpdate(newContent)
    }
    
    // Also delete journal if it exists
    if (journalPath) {
      try {
        await storage.remove(journalPath)
      } catch (e) {
        console.error('Failed to delete journal:', e)
      }
    }
  }
  
  const handleMoveToCompleted = async (rawLine, row, fromSection) => {
    // Extract task info from row
    const taskId = extractTaskId(row)
    const taskName = row['Task'] || ''
    const mngrPriority = row['Work Priority'] || row['Mngr Priority'] || '-'
    
    // Get today's date
    const today = new Date().toISOString().split('T')[0]
    
    // Fetch journal todos if journal exists
    let todoItems = []
    if (taskId) {
      try {
        const journalData = await storage.checkJournal(taskId)
        if (journalData.exists) {
          const todos = await storage.getTodos(journalData.path)
          todoItems = todos.map(t => t.text)
        }
      } catch (e) {
        console.error('Failed to fetch journal todos:', e)
      }
    }
    
    // Build the completed task description: Task name - item1 - item2 ...
    let completedTaskName = taskName.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove markdown links
    if (todoItems.length > 0) {
      completedTaskName += ' - ' + todoItems.join(' - ')
    }
    
    // Extract ID for display (simple number or keep as-is)
    const displayId = taskId || '-'
    
    // Build the completed row
    const completedRow = `| ${displayId} | ✅ | ${completedTaskName} | ${mngrPriority} | ${today} |`
    
    // Remove from focus-plan.md
    const focusLines = content.split('\n')
    let inFromSection = false
    let lineToRemoveIndex = -1
    
    for (let i = 0; i < focusLines.length; i++) {
      const line = focusLines[i]
      if (line.startsWith('## ')) {
        inFromSection = line.replace('## ', '').trim() === fromSection
      }
      if (inFromSection && line.trim() === rawLine) {
        lineToRemoveIndex = i
        break
      }
    }
    
    if (lineToRemoveIndex !== -1) {
      focusLines.splice(lineToRemoveIndex, 1)
      await onContentUpdate(focusLines.join('\n'))
    }
    
    // Add to focus-plan-completed.md under the current week
    try {
      const completedContent = await storage.read('focus-plan-completed.md').catch(() => '# Completed Tasks\n')
      const completedLines = completedContent.split('\n')
      
      // Compute Monday of the current week (M/D/YYYY format)
      const now = new Date()
      const dayOfWeek = now.getDay()
      const monday = new Date(now)
      monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7))
      const weekLabel = `${monday.getMonth() + 1}/${monday.getDate()}/${monday.getFullYear()}`
      const weekHeader = `## Week of ${weekLabel}`
      
      // Find if this week's section already exists
      let insertIndex = -1
      for (let i = 0; i < completedLines.length; i++) {
        const line = completedLines[i]
        if (line.trim() === weekHeader) {
          // Found matching week — find its table separator and insert after it
          for (let j = i + 1; j < completedLines.length; j++) {
            if (completedLines[j].trim().startsWith('|') && completedLines[j].includes('---')) {
              insertIndex = j + 1
              break
            }
          }
          break
        }
      }
      
      // If week section doesn't exist, create it after the "# Completed Tasks" heading
      if (insertIndex === -1) {
        let headerIndex = completedLines.findIndex(l => l.startsWith('# Completed Tasks'))
        if (headerIndex === -1) headerIndex = 0
        const newSection = [
          '',
          weekHeader,
          '',
          '| # | 🎯 | Task | Work Priority | Completed Date |',
          '|---|---|------|---------------|----------------|',
          completedRow
        ]
        completedLines.splice(headerIndex + 1, 0, ...newSection)
      } else {
        completedLines.splice(insertIndex, 0, completedRow)
      }
      
      await storage.write('focus-plan-completed.md', completedLines.join('\n'))
    } catch (e) {
      console.error('Failed to update completed file:', e)
    }
  }
  
  const handleAddTask = async ({ task, priority, linkedTask, section }) => {
    const lines = content.split('\n')
    let inTargetSection = false
    let insertIndex = -1
    let maxId = 0
    
    // Get max ID from journal files
    const maxJournalId = await getMaxJournalId()
    maxId = Math.max(maxId, maxJournalId)
    
    // Check if linkedTask is a URL with an extractable ticket/incident ID
    const extractTicketId = (url) => {
      const endMatch = url.match(/\/(\d+)\/?(?:[?#].*)?$/)
      if (endMatch) return endMatch[1]
      const midMatch = url.match(/\/(\d{5,})\//)
      if (midMatch) return midMatch[1]
      return null
    }
    const trimmedLinked = linkedTask ? linkedTask.trim() : ''
    const isUrl = /^https?:\/\//.test(trimmedLinked)
    const adoUrlMatch = isUrl ? { id: extractTicketId(trimmedLinked), url: trimmedLinked } : null
    
    // Find the target section, locate insert point, and track max ID
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      
      if (line.startsWith('## ')) {
        inTargetSection = line.replace('## ', '').trim() === section
      }
      
      // Find the separator row (|---|---|...) in target section
      if (inTargetSection && insertIndex === -1 && line.trim().startsWith('|') && line.includes('---')) {
        insertIndex = i + 1
      }
      
      // Track max ID from all table rows
      if (line.trim().startsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim())
        if (cells.length >= 1 && cells[0] !== 'ID' && !/^[-:]+$/.test(cells[0])) {
          const numMatch = cells[0].match(/^(\d+)/)
          if (numMatch) {
            maxId = Math.max(maxId, parseInt(numMatch[1], 10))
          }
        }
      }
    }
    
    if (insertIndex !== -1) {
      const newId = maxId + 1
      const today = new Date().toISOString().split('T')[0]
      if (adoUrlMatch && adoUrlMatch.id) {
        const adoId = adoUrlMatch.id
        const adoUrl = adoUrlMatch.url.replace(/\/$/, '')
        const newRow = `| ${newId},[${adoId}](${adoUrl}) | ${priority} | ${task} | - | ${today} | |`
        lines.splice(insertIndex, 0, newRow)
      } else {
        const newRow = `| ${newId} | ${priority} | ${task} | - | ${today} | ${linkedTask || ''} |`
        lines.splice(insertIndex, 0, newRow)
      }
      await onContentUpdate(lines.join('\n'))
    }
  }
  
  const handleAddAndPrioritize = async (taskName, prioritySectionTitle) => {
    const lines = content.split('\n')
    let maxId = await getMaxJournalId()
    let todayInsertIndex = -1
    let inToday = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('## ')) inToday = line.replace('## ', '').trim() === 'Today'
      if (inToday && line.trim().startsWith('|') && line.includes('---')) todayInsertIndex = i + 1
      if (line.trim().startsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim())
        if (cells.length >= 1 && cells[0] !== 'ID' && !/^[-:]+$/.test(cells[0])) {
          const numMatch = cells[0].match(/^(\d+)/)
          if (numMatch) maxId = Math.max(maxId, parseInt(numMatch[1], 10))
        }
      }
    }

    if (todayInsertIndex === -1) return
    const newId = maxId + 1
    const today = new Date().toISOString().split('T')[0]
    const newRow = `| ${newId} | 🟡 | ${taskName} | - | ${today} | |`
    lines.splice(todayInsertIndex, 0, newRow)

    // Add the new task ID to the priority section
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

    await onContentUpdate(lines.join('\n'))
  }

  const handlePromoteTodo = async (todoText, parentTaskId, parentRow) => {
    const lines = content.split('\n')
    let inTodaySection = false
    let insertIndex = -1
    let maxId = 0
    
    // Get max ID from journal files first
    const maxJournalId = await getMaxJournalId()
    maxId = Math.max(maxId, maxJournalId)
    
    // Find max ID and the Today section to insert the new task
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      
      if (line.startsWith('## ')) {
        inTodaySection = line.replace('## ', '').trim() === 'Today'
      }
      
      // Find the separator row in Today section
      if (inTodaySection && insertIndex === -1 && line.trim().startsWith('|') && line.includes('---')) {
        insertIndex = i + 1
      }
      
      // Track max ID from all table rows
      if (line.trim().startsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim())
        if (cells.length >= 1 && cells[0] !== 'ID' && !/^[-:]+$/.test(cells[0])) {
          const numMatch = cells[0].match(/^(\d+)/)
          if (numMatch) {
            const id = parseInt(numMatch[1], 10)
            maxId = Math.max(maxId, id)
          }
        }
      }
    }
    
    if (insertIndex !== -1) {
      const newId = maxId + 1
      const today = new Date().toISOString().split('T')[0]
      // Clean the todo text (remove TODO: prefix if present)
      const cleanTodoText = todoText.replace(/^TODO:\s*/i, '').trim()
      // Create new task with auto-generated ID and link to parent
      const newRow = `| ${newId} | 🟡 | ${cleanTodoText} | - | ${today} | ${parentTaskId} |`
      lines.splice(insertIndex, 0, newRow)
      await onContentUpdate(lines.join('\n'))
    }
  }
  
  const handleCreateJournal = async (taskId, taskName) => {
    // Clean task name for title (remove markdown links and special chars)
    const cleanTaskName = taskName.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
    const journalContent = `# Task ${taskId}: ${cleanTaskName}\n\n- TODO: \n`
    const journalPath = `journal/task-${taskId}.md`
    
    try {
      await storage.write(journalPath, journalContent)
      // Navigate to the new journal
      onNavigate(journalPath)
    } catch (e) {
      console.error('Failed to create journal:', e)
    }
  }
  
  const handleRenameTask = async (rawLine, newTaskName) => {
    const lines = content.split('\n')
    const lineIndex = lines.findIndex(line => line === rawLine)
    
    if (lineIndex !== -1) {
      // Parse the line and replace the Task column (3rd column, index 2)
      const parts = rawLine.split('|')
      if (parts.length >= 4) {
        parts[3] = ` ${newTaskName} `  // Task is the 3rd column (index 3 after split)
        lines[lineIndex] = parts.join('|')
        await onContentUpdate(lines.join('\n'))
      }
    }
  }
  
  const handleChangeLinkedId = async (rawLine, newLinkedId) => {
    const lines = content.split('\n')
    const lineIndex = lines.findIndex(line => line === rawLine)
    
    if (lineIndex !== -1) {
      const parts = rawLine.split('|')
      if (parts.length >= 7) {
        parts[6] = ` ${newLinkedId || ''} `
        lines[lineIndex] = parts.join('|')
        await onContentUpdate(lines.join('\n'))
      }
    }
  }
  
  const handleLinkToAdoBugDb = async (rawLine, adoLink) => {
    const lines = content.split('\n')
    const lineIndex = lines.findIndex(line => line === rawLine)
    
    if (lineIndex !== -1) {
      const parts = rawLine.split('|')
      if (parts.length >= 3) {
        const currentId = parts[1].trim()
        // Extract local ID (before comma if present)
        const commaIdx = currentId.indexOf(',[')
        const localId = commaIdx !== -1 ? currentId.substring(0, commaIdx) : currentId
        
        if (adoLink) {
          parts[1] = ` ${localId},[${adoLink.id}](${adoLink.url}) `
        } else {
          // Remove ADO link, keep just local ID
          parts[1] = ` ${localId} `
        }
        lines[lineIndex] = parts.join('|')
        await onContentUpdate(lines.join('\n'))
      }
    }
  }
  
  const updateNamedSection = async (sectionName, newLines) => {
    const lines = content.split('\n')
    let inSection = false
    let startIndex = -1
    let endIndex = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith(`## ${sectionName}`)) {
        inSection = true
        startIndex = i
      } else if (inSection && line.startsWith('## ')) {
        endIndex = i
        break
      }
    }
    if (startIndex === -1) return
    if (endIndex === -1) endIndex = lines.length
    const before = lines.slice(0, startIndex + 1)
    const after = lines.slice(endIndex)
    await onContentUpdate([...before, '', ...newLines, '', ...after].join('\n'))
  }

  const handleUpdateManagerPriorities = async (newLines) => {
    // Always normalize the section heading to "Priorities" while writing.
    const sectionName = managerPrioritiesSection?.title || 'Priorities'
    if (sectionName !== 'Priorities') {
      // Migration on first write: rename heading to canonical form too.
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === `## ${sectionName}`) { lines[i] = '## Priorities'; break }
      }
      // Persist the rename, then update body.
      const renamed = lines.join('\n')
      // Replace section body inline so we don't write twice.
      const beforeLines = renamed.split('\n')
      let inSection = false, startIndex = -1, endIndex = -1
      for (let i = 0; i < beforeLines.length; i++) {
        if (beforeLines[i].startsWith('## Priorities')) { inSection = true; startIndex = i }
        else if (inSection && beforeLines[i].startsWith('## ')) { endIndex = i; break }
      }
      if (endIndex === -1) endIndex = beforeLines.length
      const out = [...beforeLines.slice(0, startIndex + 1), '', ...newLines, '', ...beforeLines.slice(endIndex)]
      await onContentUpdate(out.join('\n'))
      return
    }
    await updateNamedSection('Priorities', newLines)
  }

  const handlePromoteToManagerPriority = async (taskId) => {
    if (!managerPrioritiesSection) {
      const newContent = content.trimEnd() + '\n\n## Priorities\n\n1. ' + taskId + '\n'
      await onContentUpdate(newContent)
      return
    }
    const mpLines = [...managerPrioritiesSection.lines]
    let lastNumIndex = -1
    let maxNum = 0
    for (let i = 0; i < mpLines.length; i++) {
      const match = mpLines[i].trim().match(/^(\d+)\.\s+/)
      if (match) {
        lastNumIndex = i
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
    const newLine = `${maxNum + 1}. ${taskId}`
    if (lastNumIndex >= 0) {
      mpLines.splice(lastNumIndex + 1, 0, newLine)
    } else {
      mpLines.push(newLine)
    }
    await handleUpdateManagerPriorities(mpLines)
  }
  
  const handleRemoveFromManagerPriority = async (taskId) => {
    if (!managerPrioritiesSection) return
    const mpLines = managerPrioritiesSection.lines.filter(line => {
      const match = line.trim().match(/^\d+\.\s+(.+)$/)
      return !(match && match[1].trim() === taskId)
    })
    let num = 1
    const renumbered = mpLines.map(line => {
      const match = line.trim().match(/^\d+\.\s+(.+)$/)
      if (match) return `${num++}. ${match[1]}`
      return line
    })
    await handleUpdateManagerPriorities(renumbered)
  }

  return (
    <div className="focus-plan-view">
      <h1>📋 Focus Plan</h1>
      
      {taskSections.map((section, i) => (
        <TaskSection
          key={i}
          title={section.title}
          tableLines={section.lines}
          onNavigate={onNavigate}
          defaultOpen={section.title === 'Today'}
          managerPriorities={managerPriorities}
          onScrollToPriorities={scrollToPriorities}
          onTaskAction={handleTaskAction}
          onMoveToCompleted={handleMoveToCompleted}
          onAddTask={handleAddTask}
          onCreateJournal={handleCreateJournal}
          onChangePriority={handleChangePriority}
          onDeleteTask={handleDeleteTask}
          onPromoteTodo={handlePromoteTodo}
          onRenameTask={handleRenameTask}
          onChangeLinkedId={handleChangeLinkedId}
          onLinkToAdoBugDb={handleLinkToAdoBugDb}
          taskLookup={taskLookup}
          activeTaskIds={activeTaskIds}
          linkedIdMap={linkedIdMap}
          adoLookup={adoLookup}
          onPromoteToManagerPriority={handlePromoteToManagerPriority}
          onRemoveFromManagerPriority={handleRemoveFromManagerPriority}
        />
      ))}

      {managerPrioritiesSection && (
        <ManagerPrioritiesSection
          lines={managerPrioritiesSection.lines}
          defaultOpen={false}
          onUpdate={handleUpdateManagerPriorities}
          onAddAndPrioritize={(name) => handleAddAndPrioritize(name, managerPrioritiesSection.title)}
          tasksByPriority={tasksByPriority}
          taskLookup={taskLookup}
          title="Priorities"
          sectionId="priorities"
        />
      )}
      

    </div>
  )
}

// Generic markdown view for other files - now editable
// Completed Plan View - rich rendering for focus-plan-completed.md
function CompletedPlanView({ content, onNavigate }) {
  const sections = parseFocusPlan(content)

  const getPriorityClass = (priority) => {
    if (priority?.includes('🔴')) return 'priority-urgent'
    if (priority?.includes('🟡')) return 'priority-important'
    if (priority?.includes('🔵')) return 'priority-delegate'
    if (priority?.includes('⚪')) return 'priority-low'
    if (priority?.includes('✅')) return 'priority-done'
    return ''
  }

  return (
    <div className="focus-plan-view completed-plan-view">
      <div className="editor-header">
        <button
          className="back-to-focus-btn"
          onClick={() => onNavigate('focus-plan.md')}
          title="Back to Focus Plan"
        >
          ← Focus Plan
        </button>
        <h1>✅ Completed Tasks</h1>
      </div>

      {sections.map((section, si) => {
        if (section.title === 'Completed Tasks') return null
        const { headers, rows, rawLines } = parseMarkdownTable(section.lines)
        if (rows.length === 0) return null

        return (
          <CompletedWeekSection
            key={si}
            title={section.title}
            headers={headers}
            rows={rows}
            getPriorityClass={getPriorityClass}
            onNavigate={onNavigate}
            defaultOpen={si === 0}
          />
        )
      })}
    </div>
  )
}

function CompletedWeekSection({ title, headers, rows, getPriorityClass, onNavigate, defaultOpen }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const priorityCol = headers.find(h => h.includes('🎯')) || '🎯'

  return (
    <div className="task-section">
      <h2 className="section-header" onClick={() => setIsOpen(!isOpen)}>
        <span className="collapse-icon">{isOpen ? '▼' : '▶'}</span>
        {title}
        <span className="task-count">({rows.length})</span>
      </h2>
      {isOpen && (
        <div className="task-table-container">
          <table className="task-table completed-table">
            <thead>
              <tr>
                {headers.map((h, i) => {
                  let label = h
                  if (h === '#') label = 'ID'
                  else if (h === 'Completed Date') label = 'Completed'
                  else label = displayHeader(h)
                  return <th key={i}>{label}</th>
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                const idValue = row['#'] || row['ID']
                const taskId = typeof idValue === 'object' ? idValue.id?.match(/\d+/)?.[0] : String(idValue).match(/\d+/)?.[0]
                return (
                  <tr key={ri} className={getPriorityClass(row[priorityCol])} data-task-id={taskId || undefined}>
                    {headers.map((h, ci) => {
                      const val = row[h]
                      if ((h === '#' || h === 'ID') && typeof val === 'object') {
                        return <td key={ci}>{parseLinks(val.id, onNavigate)}</td>
                      }
                      if (h === 'Task') {
                        return <td key={ci}>{renderCellWithTooltips(val, onNavigate)}</td>
                      }
                      return <td key={ci}>{renderCellWithTooltips(val, onNavigate)}</td>
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Markdown Editor View component
function MarkdownView({ content, filePath, onContentUpdate, onNavigate }) {
  const [editedContent, setEditedContent] = useState(content)
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef(null)
  
  // Update local state when content prop changes
  useEffect(() => {
    setEditedContent(content)
    setIsDirty(false)
  }, [content])
  
  const handleChange = (e) => {
    setEditedContent(e.target.value)
    setIsDirty(true)
  }
  
  const handleSave = async () => {
    if (!isDirty) return
    setSaving(true)
    await onContentUpdate(editedContent)
    setIsDirty(false)
    setSaving(false)
  }
  
  // Auto-save on blur
  const handleBlur = () => {
    if (isDirty) {
      handleSave()
    }
  }
  
  // Ctrl+S to save
  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      handleSave()
    }
  }
  
  return (
    <div className="markdown-view editable">
      <div className="editor-header">
        <button 
          className="back-to-focus-btn"
          onClick={() => onNavigate('focus-plan.md')}
          title="Back to Focus Plan"
        >
          ← Focus Plan
        </button>
        <h1>{filePath.split(/[/\\]/).pop()}</h1>
        <div className="editor-status">
          {saving && <span className="saving">Saving...</span>}
          {isDirty && !saving && <span className="unsaved">Unsaved changes</span>}
          {!isDirty && !saving && <span className="saved">✓ Saved</span>}
        </div>
      </div>
      <textarea
        ref={textareaRef}
        className="markdown-editor"
        value={editedContent}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        spellCheck={false}
      />
    </div>
  )
}

// Auto-assign unique IDs to tasks without IDs
// Get max task ID from journal filenames
async function getMaxJournalId() {
  try {
    return await storage.maxJournalId()
  } catch {
    return 0
  }
}

async function ensureUniqueIds(content, updateFile) {
  const lines = content.split(/\r?\n/)  // Handle both Unix and Windows line endings
  let maxId = 0
  const linesToUpdate = []
  
  // Get max ID from existing journal files
  const maxJournalId = await getMaxJournalId()
  maxId = Math.max(maxId, maxJournalId)
  
  // First pass: find max ID in content and lines needing IDs
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim().startsWith('|')) continue
    
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 2) continue
    
    // Skip header row
    if (cells[0] === 'ID') continue
    
    // Skip separator rows (must have multiple dashes/colons, not just one dash)
    if (cells[0].length > 1 && /^[-:]+$/.test(cells[0])) continue
    
    const idCell = cells[0]
    
    // Check if it has a numeric ID (plain number or number before comma-separated ADO link)
    const numMatch = idCell.match(/^(\d+)/)
    if (numMatch) {
      const id = parseInt(numMatch[1], 10)
      maxId = Math.max(maxId, id)
    } else if (idCell === '-' || idCell.startsWith('-,')) {
      linesToUpdate.push(i)
    }
  }
  
  // Second pass: assign new IDs
  if (linesToUpdate.length > 0) {
    for (const lineIndex of linesToUpdate) {
      maxId++
      const line = lines[lineIndex]
      // Replace the ID cell (first cell after initial |)
      const parts = line.split('|')
      const currentId = parts[1].trim()
      if (currentId.startsWith('-,')) {
        // Preserve ADO link: replace "-" prefix with new ID
        parts[1] = ` ${maxId}${currentId.substring(1)} `
      } else {
        parts[1] = ` ${maxId} `
      }
      lines[lineIndex] = parts.join('|')
    }
    
    const newContent = lines.join('\n')
    await updateFile(newContent)
    return newContent
  }
  
  return content
}

const PROVIDER_ICONS = {
  [PROVIDERS.LOCAL_STORAGE]: '🗂️',
  [PROVIDERS.FSA]: '💾',
  [PROVIDERS.ONEDRIVE]: '☁️',
  [PROVIDERS.GOOGLE_DRIVE]: '🌐',
}

const STORAGE_META = {
  [PROVIDERS.LOCAL_STORAGE]: { tagline: 'No setup · this browser only' },
  [PROVIDERS.FSA]: { tagline: 'Plain text files on your computer' },
  [PROVIDERS.ONEDRIVE]: { tagline: 'Sign in to sync across devices' },
  [PROVIDERS.GOOGLE_DRIVE]: { tagline: 'Sign in to sync across devices' },
}

function TourModal({ onClose }) {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={e => e.stopPropagation()}>
        <div className="settings-dialog-header">
          <h3>Welcome to Focus Planner 👋</h3>
          <button className="settings-dialog-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-dialog-section">
          <ul className="tour-list">
            <li><strong>Today &amp; Deferred</strong> — your top focus plan lives in <code>focus-plan.md</code>. Add tasks with the <strong>+</strong> button; right-click to defer or complete.</li>
            <li><strong>Priorities</strong> — pin top-of-mind themes in the <em>Priorities</em> section so tasks can be tagged against them.</li>
            <li><strong>Journals</strong> — every task with a journal entry expands to show its TODO / DONE bullets inline.</li>
            <li><strong>Sources</strong> — open <em>Settings</em> to add more storage sources (e.g. a Work folder + a Personal folder). With multiple sources, a ✨ <strong>Combined</strong> view appears at the top.</li>
            <li><strong>Sync</strong> — start with browser storage, then upgrade to a local folder, OneDrive, or Google Drive whenever you're ready. Your tasks come with you.</li>
          </ul>
        </div>
        <div className="settings-dialog-section">
          <button className="storage-footer-btn" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  )
}

function StorageFooter({ storageProvider, folderName, onPick, onSourcesChanged }) {
  const [open, setOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [view, setView] = useState('menu') // 'menu' | 'migrate' | 'add-source' | 'rename'
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [keepSource, setKeepSource] = useState(true)
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')

  const sources = getSources()
  const activeId = getActiveSourceId()
  const isMulti = sources.length > 1

  const providerIcon = PROVIDER_ICONS[storageProvider] || '📁'
  const others = getAvailableProviders().filter(id => id !== storageProvider)
  const isCloud = (id) => id === PROVIDERS.ONEDRIVE || id === PROVIDERS.GOOGLE_DRIVE
  // Show "Sync to the cloud" CTA in place of Settings when the user is still
  // on default browser storage with a single source — i.e. they haven't set up
  // any local-folder or cloud sync yet. Once they upgrade (or add a 2nd
  // source), revert to the standard ⚙ Settings affordance.
  const isBrowserOnly = !isMulti && storageProvider === PROVIDERS.LOCAL_STORAGE

  const reset = () => { setView('menu'); setConfirmTarget(null); setError(''); setRenamingId(null) }
  const close = () => { setOpen(false); reset() }

  const startMigrate = async (toId) => {
    setError('')
    setBusy(true)
    try {
      const result = await migrate(getActiveProvider(), toId, {
        deleteSource: !keepSource,
        fromId: storageProvider,
      })
      if (result.ok) { window.location.reload(); return }
      if (result.redirected) return
      setError(result.error || 'Migration failed')
    } catch (e) {
      setError(e.message || 'Migration failed')
    } finally {
      setBusy(false)
    }
  }

  // Add a brand-new source. Only LocalStorage and FSA are supported here —
  // cloud sources need an OAuth redirect dance that the existing migrate flow
  // owns and is not worth duplicating until there's clear demand.
  const addLocalStorageSource = async () => {
    setBusy(true); setError('')
    try {
      if (sources.some(s => s.providerType === PROVIDERS.LOCAL_STORAGE)) {
        setError('Browser Storage is already a source.')
        return
      }
      const src = addSource({ providerType: PROVIDERS.LOCAL_STORAGE, name: 'Browser Storage' })
      const p = getProvider(src.id)
      await p.restore()
      await p.scaffold()
      await setActiveSource(src.id)
      onSourcesChanged?.()
      close()
    } catch (e) {
      setError(e.message || 'Failed to add source')
    } finally { setBusy(false) }
  }

  const addFsaSource = async () => {
    setBusy(true); setError('')
    try {
      const src = addSource({ providerType: PROVIDERS.FSA, name: 'Local Folder' })
      const p = getProvider(src.id)
      try {
        const handle = await p.pick()
        if (!handle) {
          await removeSource(src.id)
          setError('Folder selection cancelled.')
          return
        }
        renameSource(src.id, handle.name || 'Local Folder')
        await p.scaffold()
        await setActiveSource(src.id)
        onSourcesChanged?.()
        close()
      } catch (e) {
        await removeSource(src.id)
        throw e
      }
    } catch (e) {
      setError(e.message || 'Failed to add source')
    } finally { setBusy(false) }
  }

  const addCloudSource = async (providerType) => {
    setBusy(true); setError('')
    try {
      // Persists registry entry, sets pending flag, and triggers OAuth redirect.
      // The page reloads on success — init handles the rest.
      await beginAddCloudSource(providerType)
    } catch (e) {
      // Roll back the half-created entry if pick threw before redirecting.
      try { await abortPendingAdd() } catch { /* noop */ }
      setError(e.message || 'Failed to start sign-in')
      setBusy(false)
    }
  }

  const switchToSource = async (id) => {
    if (id === activeId) return
    await setActiveSource(id)
    onSourcesChanged?.()
    close()
  }

  const removeSourceById = async (id) => {
    if (sources.length <= 1) {
      setError('Cannot remove the last source.')
      return
    }
    if (!confirm('Remove this source? Files in the source are not deleted.')) return
    await removeSource(id)
    onSourcesChanged?.()
  }

  const startRename = (id, currentName) => {
    setRenamingId(id)
    setRenameValue(currentName)
  }
  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      renameSource(renamingId, renameValue.trim())
      onSourcesChanged?.()
    }
    setRenamingId(null)
  }

  return (
    <>
      <div className="sidebar-storage-footer">
        <button
          className="storage-footer-toggle"
          onClick={() => setTourOpen(true)}
          title="Take a quick tour of Focus Planner"
        >
          <span className="storage-footer-icon">📚</span>
          <span className="storage-footer-label">Take a tour</span>
        </button>
        {isBrowserOnly ? (
          <button
            className="storage-footer-toggle storage-footer-cta"
            onClick={() => { setView('migrate'); setOpen(true) }}
            title="Move your tasks to a local folder or the cloud"
          >
            <span className="storage-footer-icon">☁️</span>
            <span className="storage-footer-label">Sync to the cloud</span>
          </button>
        ) : (
          <button
            className="storage-footer-toggle"
            onClick={() => setOpen(true)}
            title="Settings"
          >
            <span className="storage-footer-icon">⚙</span>
            <span className="storage-footer-label">Settings</span>
          </button>
        )}
      </div>

      {tourOpen && <TourModal onClose={() => setTourOpen(false)} />}

      {open && (
        <div className="dialog-overlay" onClick={close}>
          <div className="settings-dialog" onClick={e => e.stopPropagation()}>
            <div className="settings-dialog-header">
              <h3>Settings</h3>
              <button className="settings-dialog-close" onClick={close}>✕</button>
            </div>

            <div className="settings-dialog-section">
              <div className="settings-dialog-section-title">Sources</div>
              {sources.map(s => {
                const icon = PROVIDER_ICONS[s.providerType] || '📁'
                const isActive = s.id === activeId
                if (renamingId === s.id) {
                  return (
                    <div key={s.id} className="storage-footer-source-row">
                      <span className="storage-footer-source-icon">{icon}</span>
                      <input
                        className="storage-footer-source-rename"
                        value={renameValue}
                        autoFocus
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitRename()
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                      />
                    </div>
                  )
                }
                return (
                  <div key={s.id} className={`storage-footer-source-row${isActive ? ' active' : ''}`}>
                    <button
                      className="storage-footer-source-main"
                      onClick={() => switchToSource(s.id)}
                      title={isActive ? 'Active source' : 'Click to switch to this source'}
                    >
                      <span className="storage-footer-source-icon">{icon}</span>
                      <span className="storage-footer-source-name">{s.name}</span>
                      {isActive && <span className="storage-footer-source-active">●</span>}
                    </button>
                    <button
                      className="storage-footer-source-action"
                      title="Rename"
                      onClick={() => startRename(s.id, s.name)}
                    >✎</button>
                    {sources.length > 1 && (
                      <button
                        className="storage-footer-source-action"
                        title="Remove source"
                        onClick={() => removeSourceById(s.id)}
                      >🗑</button>
                    )}
                  </div>
                )
              })}
              {view !== 'add-source' ? (
                <button className="storage-footer-btn" onClick={() => { setView('add-source'); setError('') }}>
                  + Add source
                </button>
              ) : (
                <div className="storage-footer-add-source">
                  {availableProviderTypesForAdd().map(t => {
                    const onClick = t === PROVIDERS.LOCAL_STORAGE ? addLocalStorageSource
                      : t === PROVIDERS.FSA ? addFsaSource
                      : () => addCloudSource(t)
                    return (
                      <button key={t} className="storage-footer-btn storage-footer-option-btn" onClick={onClick} disabled={busy}>
                        <span className="storage-footer-option-name">{PROVIDER_ICONS[t] || '📁'} {getProviderName(t)}</span>
                        <span className="storage-footer-option-tagline">{STORAGE_META[t]?.tagline || ''}</span>
                      </button>
                    )
                  })}
                  {availableProviderTypesForAdd().length === 0 && (
                    <div className="storage-footer-note">All available source types are already in use.</div>
                  )}
                  {(availableProviderTypesForAdd().includes(PROVIDERS.ONEDRIVE) ||
                    availableProviderTypesForAdd().includes(PROVIDERS.GOOGLE_DRIVE)) && (
                    <div className="storage-footer-note">Cloud sources will redirect you to sign in. The page will reload after.</div>
                  )}
                  {error && <div className="storage-footer-error">⚠️ {error}</div>}
                  <button className="storage-footer-btn secondary" onClick={() => setView('menu')} disabled={busy}>↩ Back</button>
                </div>
              )}
            </div>

            {!isMulti && view === 'menu' && (
              <div className="settings-dialog-section">
                <div className="settings-dialog-section-title">Storage actions</div>
                <div className="settings-dialog-info">
                  Active: {providerIcon} {folderName || getProviderName(storageProvider)}
                </div>
                {storageProvider === PROVIDERS.FSA && (
                  <button className="storage-footer-btn" onClick={() => { close(); onPick() }}>
                    📂 Change folder
                  </button>
                )}
                {others.length > 0 && (
                  <button className="storage-footer-btn" onClick={() => setView('migrate')}>
                    ⇄ Switch storage
                  </button>
                )}
              </div>
            )}

            {view === 'migrate' && !confirmTarget && (
              <div className="settings-dialog-section">
                <div className="storage-footer-section">Switch to:</div>
                {others.map(id => (
                    <button key={id} className="storage-footer-btn storage-footer-option-btn" onClick={() => setConfirmTarget(id)}>
                      <span className="storage-footer-option-name">{PROVIDER_ICONS[id] || "📁"} {getProviderName(id)}</span>
                      <span className="storage-footer-option-tagline">{STORAGE_META[id]?.tagline || ""}</span>
                  </button>
                ))}
                <button className="storage-footer-btn secondary" onClick={reset}>↩ Back</button>
              </div>
            )}

            {view === 'migrate' && confirmTarget && (
              <div className="settings-dialog-section">
                <div className="storage-footer-section">
                  Switch to <strong>{getProviderName(confirmTarget)}</strong>?
                </div>
                {storageProvider === PROVIDERS.LOCAL_STORAGE && (
                  <label className="storage-footer-checkbox">
                    <input
                      type="checkbox"
                      checked={!keepSource}
                      onChange={e => setKeepSource(!e.target.checked)}
                    />
                    Delete browser copy after
                  </label>
                )}
                {isCloud(confirmTarget) && (
                  <div className="storage-footer-note">
                    You'll be redirected to sign in. Your data will be copied over automatically.
                  </div>
                )}
                {error && <div className="storage-footer-error">⚠️ {error}</div>}
                <div className="storage-footer-actions">
                  <button className="storage-footer-btn" onClick={() => startMigrate(confirmTarget)} disabled={busy}>
                    {busy ? 'Switching…' : 'Switch'}
                  </button>
                  <button className="storage-footer-btn secondary" onClick={() => setConfirmTarget(null)} disabled={busy}>
                    Back
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
// Combined Focus Plan view — read-only synthesis across all sources.
// The merged Today/Deferred tables get a "Source" column; each source's
// Priorities section is rendered separately so they don't collide.
function CombinedFocusPlanView({ sources, onNavigate }) {
  const [perSource, setPerSource] = useState(null) // [{source, sections}]
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [addDialog, setAddDialog] = useState(null) // { section }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const results = await Promise.all(sources.map(async (s) => {
          try {
            const text = await storage.readFromSource(s.id, 'focus-plan.md')
            const migrated = migratePrioritiesSections(text) ?? text
            return { source: s, sections: parseFocusPlan(migrated) }
          } catch {
            return { source: s, sections: [] }
          }
        }))
        if (!cancelled) setPerSource(results)
      } catch (e) {
        if (!cancelled) setError(e.message || String(e))
      }
    })()
    return () => { cancelled = true }
  }, [sources, reloadKey])

  const handleAdd = async ({ task, priority, linkedTask, section, sourceId }) => {
    if (!sourceId) return
    const text = await storage.readFromSource(sourceId, 'focus-plan.md')
    const lines = text.split('\n')
    let inTargetSection = false
    let insertIndex = -1
    let maxId = await storage.maxJournalIdFromSource(sourceId)
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
    if (insertIndex === -1) return
    const newId = maxId + 1
    const today = new Date().toISOString().split('T')[0]
    const trimmedLinked = linkedTask ? linkedTask.trim() : ''
    const isUrl = /^https?:\/\//.test(trimmedLinked)
    const extractTicketId = (url) => {
      const endMatch = url.match(/\/(\d+)\/?(?:[?#].*)?$/)
      if (endMatch) return endMatch[1]
      const midMatch = url.match(/\/(\d{5,})\//)
      if (midMatch) return midMatch[1]
      return null
    }
    if (isUrl) {
      const adoId = extractTicketId(trimmedLinked)
      if (adoId) {
        const adoUrl = trimmedLinked.replace(/\/$/, '')
        lines.splice(insertIndex, 0, `| ${newId},[${adoId}](${adoUrl}) | ${priority} | ${task} | - | ${today} | |`)
      } else {
        lines.splice(insertIndex, 0, `| ${newId} | ${priority} | ${task} | - | ${today} | ${trimmedLinked} |`)
      }
    } else {
      lines.splice(insertIndex, 0, `| ${newId} | ${priority} | ${task} | - | ${today} | ${trimmedLinked} |`)
    }
    await storage.writeToSource(sourceId, 'focus-plan.md', lines.join('\n'))
    setReloadKey(k => k + 1)
  }

  if (error) return <div className="placeholder"><h1>✨ Combined</h1><p>Failed to load: {error}</p></div>
  if (!perSource) return <div className="placeholder"><h1>✨ Combined</h1><p>Loading…</p></div>

  // Merge tables across sources. Each row is augmented with a Source label.
  const mergeSection = (title) => {
    const merged = []
    for (const { source, sections } of perSource) {
      const sec = sections.find(s => s.title === title)
      if (!sec) continue
      const { headers, rows } = parseMarkdownTable(sec.lines)
      for (const row of rows) {
        merged.push({ row, headers, source })
      }
    }
    return merged
  }
  const today = mergeSection('Today')
  const deferred = mergeSection('Deferred')

  const renderTable = (title, items, defaultOpen = true) => {
    const headerSet = items[0]?.headers || ['ID', '🎯', 'Task', 'Mngr Priority', 'Added', 'Linked ID']
    return (
      <CombinedSection
        key={title}
        title={title}
        items={items}
        baseHeaders={headerSet}
        defaultOpen={defaultOpen}
        onNavigate={onNavigate}
        onAddClick={() => setAddDialog({ section: title })}
      />
    )
  }

  return (
    <div className="focus-plan-view combined-view">
      <h1>✨ Combined Focus Plan</h1>
      {renderTable('Today', today, true)}
      {renderTable('Deferred', deferred, false)}
      {perSource.map(({ source, sections }) => {
        const pri = sections.find(s => isPrioritiesSection(s.title))
        if (!pri) return null
        const taskSections = sections.filter(s => s.title === 'Today' || s.title === 'Deferred')
        const taskLookup = {}
        const linkedIdMap = {}
        for (const section of taskSections) {
          Object.assign(taskLookup, buildTaskIdLookup(section.lines))
          Object.assign(linkedIdMap, buildLinkedIdMap(section.lines))
        }
        const managerPriorities = parseManagerPriorities(pri.lines)
        const tasksByPriority = {}
        for (const section of taskSections) {
          const { headers, rows } = parseMarkdownTable(section.lines)
          const priorityCol = headers.find(h => h.includes('🎯')) || '🎯'
          for (const row of rows) {
            const id = extractTaskId(row)
            if (!id) continue
            if (managerPriorities[id]) continue
            const resolved = resolveManagerPriority(id, linkedIdMap, managerPriorities)
            if (resolved) {
              if (!tasksByPriority[resolved.id]) tasksByPriority[resolved.id] = []
              tasksByPriority[resolved.id].push({
                id,
                task: row['Task'] || '',
                priority: row[priorityCol] || '',
                section: section.title,
              })
            }
          }
        }
        return (
          <ManagerPrioritiesSection
            key={source.id}
            lines={pri.lines}
            defaultOpen={false}
            onUpdate={() => {}}
            onAddAndPrioritize={() => {}}
            tasksByPriority={tasksByPriority}
            taskLookup={taskLookup}
            title={`${source.name} — Priorities`}
            sectionId={`combined-priorities-${source.id}`}
          />
        )
      })}
      {addDialog && (
        <AddTaskDialog
          section={addDialog.section}
          sources={sources}
          defaultSourceId={sources[0]?.id}
          onClose={() => setAddDialog(null)}
          onAdd={handleAdd}
        />
      )}
    </div>
  )
}

function CombinedSection({ title, items, baseHeaders, defaultOpen, onNavigate, onAddClick }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const headers = baseHeaders
  return (
    <div className="task-section">
      <h2 className="section-header" onClick={() => setIsOpen(!isOpen)}>
        <span className="collapse-icon">{isOpen ? '▼' : '▶'}</span>
        {title}
        <span className="task-count">({items.length})</span>
        {onAddClick && (
          <button
            className="add-task-btn"
            onClick={(e) => { e.stopPropagation(); onAddClick() }}
            title={`Add task to ${title}`}
          >+</button>
        )}
      </h2>
      {isOpen && (
        <div className="task-table-container">
          <table className="task-table">
            <thead>
              <tr>{headers.map((h, i) => <th key={i}>{displayHeader(h)}</th>)}</tr>
            </thead>
            <tbody>
              {items.map(({ row, source }, i) => (
                <tr key={`${source.id}-${i}`}>
                  {baseHeaders.map((h, ci) => {
                    const val = row[h]
                    if ((h === 'ID' || h === '#') && typeof val === 'object') {
                      return <td key={ci}>{parseLinks(val.id, onNavigate)}</td>
                    }
                    return <td key={ci}>{renderCellWithTooltips(typeof val === 'object' ? (val.id ?? '') : val, onNavigate)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function App() {
  // 'loading' | 'pick-storage' | 'ready'
  const [appState, setAppState] = useState('loading')
  const [files, setFiles] = useState([])
  const [folderName, setFolderName] = useState('')
  const [storageProvider, setStorageProvider] = useState('')
  // selectedFile uses qualified paths in multi-source mode (`${sourceId}::${path}`),
  // plain paths in single-source mode. The dispatcher in handleSelectFile/etc.
  // copes with both shapes.
  const [selectedFile, setSelectedFile] = useState('focus-plan.md')
  const [content, setContent] = useState('')
  const [pendingScrollToTaskId, setPendingScrollToTaskId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Re-render trigger for the source list when Settings mutates it.
  const [sourcesVersion, setSourcesVersion] = useState(0)
  // Re-read every render so post-init/post-mutation state is always fresh.
  // sourcesVersion is the explicit reactivity trigger.
  void sourcesVersion
  const sources = getSources()
  const isMulti = sources.length > 1

  /**
   * Build the sidebar tree.
   *  - 0/1 source → return that source's tree directly (no wrapper folders,
   *    no Combined entry — the UI looks identical to before).
   *  - 2+ sources → wrap each source's tree in a top-level folder, with
   *    "✨ Combined" prepended.
   */
  const loadFiles = async () => {
    try {
      // Read fresh registry — the closure-captured `sources` may be stale during init.
      const liveSources = getSources()
      if (liveSources.length <= 1) {
        const data = await storage.getFiles()
        setFiles(data)
        return
      }
      const perSource = await Promise.all(
        liveSources.map(async (s) => {
          try {
            const tree = await storage.getFilesFromSource(s.id)
            return { source: s, tree }
          } catch {
            return { source: s, tree: [] }
          }
        })
      )
      const combinedFolder = {
        name: '✨ Combined',
        type: 'directory',
        path: `${COMBINED_ID}::`,
        children: [
          { name: 'focus-plan.md', type: 'file', path: `${COMBINED_ID}::focus-plan.md` },
        ],
      }
      const sourceFolders = perSource.map(({ source, tree }) => ({
        name: source.name,
        type: 'directory',
        path: `${source.id}::`,
        children: prefixTreePaths(tree, source.id),
      }))
      setFiles([combinedFolder, ...sourceFolders])
    } catch (err) {
      console.error('Failed to load files:', err)
    }
  }

  const handleSelectFile = async (qualifiedPath) => {
    const { sourceId, path } = splitSourcePath(qualifiedPath)
    setSelectedFile(qualifiedPath)
    setSidebarOpen(false)

    // Combined virtual file → CombinedFocusPlanView reads its own data, just clear content.
    if (sourceId === COMBINED_ID) {
      setContent('')
      return
    }

    // Switch active source if the file lives in a non-active source.
    if (sourceId && sourceId !== getActiveSourceId()) {
      try {
        await setActiveSource(sourceId)
        setStorageProvider(sources.find(s => s.id === sourceId)?.providerType || '')
        setFolderName(storage.folderName())
      } catch (e) {
        console.error('Failed to switch source:', e)
      }
    }

    try {
      const text = await storage.read(path || qualifiedPath)
      const target = path || qualifiedPath
      if (target === 'focus-plan.md') {
        // Run the legacy Work/Personal Priorities → unified Priorities migration once.
        const migrated = migratePrioritiesSections(text)
        const startContent = migrated ?? text
        if (migrated && migrated !== text) {
          await storage.write(target, migrated)
        }
        const updatedContent = await ensureUniqueIds(startContent, async (newContent) => {
          await storage.write(target, newContent)
        })
        setContent(updatedContent)
      } else {
        setContent(text)
      }
    } catch {
      setContent('')
    }
  }

  const refreshAfterSourcesChange = async () => {
    setSourcesVersion(v => v + 1)
    await loadFiles()
    const liveSources = getSources()
    const active = liveSources.find(s => s.id === getActiveSourceId())
    if (active) {
      setStorageProvider(active.providerType)
      setFolderName(storage.folderName())
    }
    // If selection no longer points to a valid place (e.g. Combined after
    // collapsing back to a single source, or a deleted source), reset to the
    // canonical focus plan view.
    const { sourceId } = splitSourcePath(selectedFile)
    const isCombined = sourceId === COMBINED_ID
    const sourceMissing = sourceId && sourceId !== COMBINED_ID && !liveSources.some(s => s.id === sourceId)
    if ((isCombined && liveSources.length <= 1) || sourceMissing) {
      const target = liveSources.length > 1 ? `${COMBINED_ID}::focus-plan.md` : 'focus-plan.md'
      await handleSelectFile(target)
    }
  }

  const initWithProvider = async (providerId) => {
    await storage.scaffold()
    // Ensure we have a sources registry. If first run on legacy install,
    // the legacy → registry migration was already attempted; otherwise
    // create the canonical single-source entry now.
    if (getSources().length === 0) {
      const src = addSource({ providerType: providerId, name: storage.folderName() || getProviderName(providerId) })
      await setActiveSource(src.id)
    }
    await loadFiles()
    setFolderName(storage.folderName())
    setStorageProvider(providerId)
    setSourcesVersion(v => v + 1)
    setAppState('ready')
    handleSelectFile('focus-plan.md')
  }

  useEffect(() => {
    (async () => {
      try {
        // 1. If returning from OAuth redirect with a pending migration, finish it
        if (hasPendingMigration()) {
          const migratedTo = await resumePendingMigration()
          if (migratedTo) {
            window.location.reload()
            return
          }
        }

        // 2. Load (and one-shot migrate) the multi-source registry.
        loadSources()
        migrateLegacy()
        const registry = getSources()

        if (registry.length > 0) {
          // If we're returning from an "add cloud source" OAuth redirect,
          // restore that source FIRST so it consumes the ?code= param —
          // otherwise other cloud providers' restore() would try (and fail)
          // to exchange the code as their own.
          const pendingAddId = consumePendingAdd()
          let scaffoldedAddId = null
          if (pendingAddId) {
            try {
              const p = await restoreSource(pendingAddId)
              if (p) {
                await p.scaffold()
                scaffoldedAddId = pendingAddId
              } else {
                // User cancelled / token exchange failed — roll back the entry.
                await removeSource(pendingAddId)
              }
            } catch (e) {
              console.error('Cloud source add failed, rolling back:', e)
              await removeSource(pendingAddId)
            }
          }
          // Restore each source's provider eagerly so cross-source reads work.
          const restoredIds = new Set()
          if (scaffoldedAddId) restoredIds.add(scaffoldedAddId)
          let firstHealthyId = scaffoldedAddId || null
          for (const s of getSources()) {
            if (restoredIds.has(s.id)) continue
            try {
              const p = await restoreSource(s.id)
              if (p) {
                restoredIds.add(s.id)
                if (!firstHealthyId) firstHealthyId = s.id
              }
            } catch {
              /* ignore — surfaces in Settings if the user picks it */
            }
          }
          // Pick the saved active source if it restored, otherwise the first that did.
          const savedActive = getActiveSourceId()
          const targetId = restoredIds.has(savedActive) ? savedActive : firstHealthyId
          if (targetId) {
            await setActiveSource(targetId)
            const active = getSources().find(s => s.id === targetId)
            await initWithProvider(active.providerType)
            return
          }
          // No source restored cleanly — fall back to LocalStorage.
        }

        // 3. Legacy single-provider path (no registry yet — migrateLegacy() didn't run because
        // there was no fp-storage-provider key either). Fresh install → pick storage.
        const savedId = localStorage.getItem('fp-storage-provider')
        if (!savedId) {
          // Auto-bootstrap LocalStorage as the default first source.
          const fallback = new LocalStorageProvider()
          await fallback.restore()
          setActiveProvider(fallback)
          localStorage.setItem('fp-storage-provider', PROVIDERS.LOCAL_STORAGE)
          await initWithProvider(PROVIDERS.LOCAL_STORAGE)
          return
        }
        const provider = makeProvider(savedId)
        const ok = await provider.restore()
        if (ok) {
          setActiveProvider(provider)
          await initWithProvider(savedId)
        } else {
          const fallback = new LocalStorageProvider()
          await fallback.restore()
          setActiveProvider(fallback)
          localStorage.setItem('fp-storage-provider', PROVIDERS.LOCAL_STORAGE)
          await initWithProvider(PROVIDERS.LOCAL_STORAGE)
        }
      } catch (e) {
        console.error('Storage init failed:', e)
        setAppState('pick-storage')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePick = async () => {
    setAppState('pick-storage')
  }

  const handleStorageReady = async (providerId) => {
    await initWithProvider(providerId)
  }

  const handleNavigate = (path, scrollToTaskId) => {
    if (scrollToTaskId) setPendingScrollToTaskId(scrollToTaskId)
    handleSelectFile(path)
  }

  useEffect(() => {
    if (!pendingScrollToTaskId || !content) return
    const taskId = pendingScrollToTaskId
    setPendingScrollToTaskId(null)
    setTimeout(() => {
      const targetRow = document.querySelector(`tr[data-task-id="${taskId}"]`)
      if (targetRow) {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
        targetRow.classList.add('highlight-flash')
        setTimeout(() => targetRow.classList.remove('highlight-flash'), 1500)
        return
      }
      const textarea = document.querySelector('.markdown-editor')
      if (textarea) {
        const lines = textarea.value.split('\n')
        let charPos = 0
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(`| ${taskId} |`) || lines[i].includes(`| ${taskId} `)) {
            textarea.focus()
            textarea.setSelectionRange(charPos, charPos + lines[i].length)
            const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20
            textarea.scrollTop = Math.max(0, i * lineHeight - textarea.clientHeight / 2)
            break
          }
          charPos += lines[i].length + 1
        }
      }
    }, 200)
  }, [content, pendingScrollToTaskId])

  const handleContentUpdate = async (newContent) => {
    const { path, sourceId } = splitSourcePath(selectedFile)
    if (sourceId === COMBINED_ID) return // Combined view is read-only
    try {
      await storage.write(path || selectedFile, newContent)
      setContent(newContent)
    } catch (err) {
      console.error('Failed to update file:', err)
    }
  }

  if (appState === 'loading') {
    return <div className="loading">Loading planner...</div>
  }

  if (appState === 'pick-storage') {
    return <StoragePicker onReady={handleStorageReady} />
  }

  const { sourceId: selSourceId, path: selPath } = splitSourcePath(selectedFile)
  const isCombinedFocusPlan = selSourceId === COMBINED_ID && (selPath === 'focus-plan.md' || selPath === '')
  const localPath = selPath || selectedFile
  const isFocusPlan = !isCombinedFocusPlan && localPath === 'focus-plan.md'
  const isCompletedPlan = !isCombinedFocusPlan && localPath === 'focus-plan-completed.md'

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ''}`}>
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>📋 Planner</h2>
          <button
            className="sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >✕</button>
        </div>
        <div className="sidebar-file-tree">
          <FileTree
            items={files}
            onSelect={handleSelectFile}
            selectedPath={selectedFile}
            defaultOpen={isMulti}
          />
        </div>
        <StorageFooter
          storageProvider={storageProvider}
          folderName={folderName}
          onPick={handlePick}
          onSourcesChanged={refreshAfterSourcesChange}
          sourcesVersion={sourcesVersion}
        />
      </aside>
      <main className="content">
        <div className="mobile-nav-bar">
          <button
            className="mobile-menu-btn"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open file menu"
          >☰ Files</button>
          {selectedFile && <span className="mobile-file-name">{(selPath || selectedFile).replace(/.*\//, '')}</span>}
        </div>
        {isCombinedFocusPlan ? (
          <CombinedFocusPlanView sources={sources} onNavigate={handleNavigate} />
        ) : content ? (
          isFocusPlan ? (
            <FocusPlanView
              content={content}
              onNavigate={handleNavigate}
              onContentUpdate={handleContentUpdate}
            />
          ) : isCompletedPlan ? (
            <CompletedPlanView
              content={content}
              onNavigate={handleNavigate}
            />
          ) : (
            <MarkdownView
              content={content}
              filePath={localPath}
              onContentUpdate={handleContentUpdate}
              onNavigate={handleNavigate}
            />
          )
        ) : (
          <div className="placeholder">
            <h1>Welcome to Planner</h1>
            <p>Select a markdown file from the sidebar to view its content.</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
