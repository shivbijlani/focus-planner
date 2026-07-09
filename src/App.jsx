import { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import './mobile-board.css'
import * as storage from './storage/storage.js'
import { setActiveProvider, getActiveProvider, PROVIDERS, TARGET_STATUS, getProviderName } from './storage/storage.js'
import { LocalStorageProvider } from './storage/localstorage-provider.js'
import { resumePendingMigration, hasPendingMigration, makeProvider } from './storage/migrate.js'
import {
  loadSources, migrateLegacy, getSources, getActiveSourceId, getActiveSource, setActiveSource,
  addSource, removeSource, renameSource, getProvider, restoreSource,
  consumePendingAdd, consumePendingReauth,
} from './storage/sources.js'
import { extractTaskId, parseManagerPriorities, resolveManagerPriority, sortTasksByPriority, isNeededForUrgentTask } from './taskSort.js'
import { computeMoveSet, computeBrokenLinks, renumberMovedRows, maxTaskIdInRows, retitleJournal } from './moveTask.js'
import { tagMergedRows, resolveRowSourceId } from './combinedRouting.js'
// SELF_HEAL_IDS (temporary): renumber runaway/foreign task IDs on load. Safe to
// delete this import + selfHealIds.js + its call site once all devices healed.
import { selfHealOutlierIds } from './selfHealIds.js'
import { recordDeletedId, getActiveTombstoneIds } from './idTombstones.js'
import { scrollToAndFlashTask } from './scrollToTask.js'
import { filterRowsAndRawLines, taskRowMatchesSearch, normalizeQuery, boardSearchPlaceholder } from './boardSearch.js'
import {
  addDaysToDateString,
  formatSnoozeDate,
  getNextSaturdayDateString,
  getTodayDateString,
  isSnoozeActive,
  normalizeDateOnly,
  parseSnoozeUntil,
} from './snooze.js'
import { StoragePicker } from './StoragePicker.jsx'
import { isPrioritiesSection } from './focusPlanShared.js'
import * as ops from './focusPlanOps.js'
import { parseTgLink } from '../packages/telegram-bridge/src/deepLink.js'
import { APP_NAME, PLAN_FILE, COMPLETED_FILE } from './config/branding.js'
import { parseJournalChat, formatChatDay, appendJournalMessage } from './journalChat.js'
import * as readStateService from './readState/readStateService.js'
import { getMissionStatement, loadMissionStatement, setMissionStatement, subscribeMissionStatement } from './missionStatement.js'
import { SETTINGS_FILE } from './storage/settings.js'
import { AI_SETTINGS_FILE, AI_SETTINGS_TEMPLATE } from './config/aiSettings.js'
import {
  attachmentFolderPath,
  formatAttachmentFolderMarkdown,
  formatAttachmentMarkdown,
  taskIdFromJournalPath,
} from './journalAttachments.js'
import {
  InstallButton, InstallModal, InstallNudge,
  InstallSettingsSection, InstallSuccessToast,
} from '../packages/install-prompt/src/index.js'
import '../packages/install-prompt/src/styles/install-prompt.css'

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
function LinkPickerModal({ currentLinkedId, taskLookup, allTaskIds, onSelect, onCancel }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const q = query.trim().toLowerCase()
  const matches = allTaskIds
    .map(tid => ({ tid, name: (taskLookup && taskLookup[tid]) || '' }))
    .filter(({ tid, name }) => !q || tid.toLowerCase().includes(q) || name.toLowerCase().includes(q))
    .slice(0, 50)

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onCancel()
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (/^\d+$/.test(q)) { onSelect(q); return }
    if (matches.length > 0) onSelect(matches[0].tid)
  }

  return (
    <div className="link-picker-overlay" onMouseDown={handleBackdrop}>
      <div className="link-picker" onMouseDown={e => e.stopPropagation()}>
        <div className="link-picker-header">
          <h3>{currentLinkedId ? 'Edit linked task' : 'Link to task'}</h3>
          <button type="button" className="link-picker-close" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className="link-picker-input"
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by ID or task name…"
            autoComplete="off"
            inputMode="search"
          />
        </form>
        <div className="link-picker-list">
          {matches.length === 0 ? (
            <div className="link-picker-empty">
              {q ? `No tasks match "${query}"` : 'No tasks available'}
            </div>
          ) : (
            matches.map(({ tid, name }) => (
              <button
                key={tid}
                type="button"
                className={`link-picker-item${tid === currentLinkedId ? ' is-current' : ''}`}
                onClick={() => onSelect(tid)}
              >
                <span className="link-picker-item-id">{tid}</span>
                <span className="link-picker-item-name">{name || '(no name)'}</span>
              </button>
            ))
          )}
        </div>
        <div className="link-picker-actions">
          {currentLinkedId && (
            <button type="button" className="link-picker-remove" onClick={() => onSelect('')}>
              Remove link
            </button>
          )}
          <button type="button" className="link-picker-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Mobile bottom-sheet primitives (#335) ---------------------------------
// The legacy row context-menu and the priority-orb menu were positioned boxes
// rendered *inside* the table's scroll container. After filtering to one row
// that container is short, so the menu landed outside it and got clipped /
// lost the stacking fight with the sticky header. A bottom sheet portaled to
// <body> removes the positioning math entirely — it can't be clipped.

// True on phone-width viewports / coarse-pointer (touch) devices.
function useIsMobile() {
  const query = '(max-width: 768px), (pointer: coarse)'
  const get = () => typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia(query).matches
  const [isMobile, setIsMobile] = useState(get)
  useEffect(() => {
    if (!window.matchMedia) return
    const mqls = ['(max-width: 768px)', '(pointer: coarse)'].map(q => window.matchMedia(q))
    const update = () => setIsMobile(mqls.some(m => m.matches))
    mqls.forEach(m => m.addEventListener('change', update))
    update()
    return () => mqls.forEach(m => m.removeEventListener('change', update))
  }, [])
  return isMobile
}

// A full-width sheet that slides up from the bottom, drawn on document.body so
// nothing can clip it. Tap the backdrop or Esc to dismiss.
function BottomSheet({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="bottom-sheet-backdrop" onMouseDown={onClose}>
      <div
        className="bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Actions'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="bottom-sheet-handle" aria-hidden="true" />
        {title && <div className="bottom-sheet-title">{title}</div>}
        <div className="bottom-sheet-body">{children}</div>
      </div>
    </div>,
    document.body
  )
}

function ContextMenu({ x, y, options, onClose, title = 'Actions', sheet = false }) {
  const menuRef = useRef(null)

  useEffect(() => {
    if (sheet) return
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose, sheet])

  // Mobile: render the options inside a bottom sheet (portaled, unclippable).
  if (sheet) {
    return (
      <BottomSheet title={title} onClose={onClose}>
        <div className="action-sheet-list">
          {options.map((option, i) => (
            <button
              key={i}
              className="action-sheet-item"
              onClick={() => { option.action(); onClose() }}
            >
              {option.icon && <span className="action-sheet-icon">{option.icon}</span>}
              <span className="action-sheet-label">{option.label}</span>
            </button>
          ))}
        </div>
      </BottomSheet>
    )
  }

  // Desktop: the existing positioned menu.
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

function AttachmentDialog({ taskId, onInsert, onClose }) {
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('auto')
  const fileInputRef = useRef(null)
  const folderPath = attachmentFolderPath(taskId)

  const insertMarkdown = (markdown) => {
    if (!markdown) return
    onInsert(markdown)
    onClose()
  }

  const handleInsertLink = () => {
    const markdown = kind === 'folder'
      ? formatAttachmentFolderMarkdown({ taskId, url, label })
      : formatAttachmentMarkdown({ url, name: label, kind })
    insertMarkdown(markdown)
  }

  const handleFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => insertMarkdown(formatAttachmentMarkdown({
      url: reader.result,
      name: file.name,
      mimeType: file.type,
      kind: 'auto',
    }))
    reader.readAsDataURL(file)
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog attachment-dialog" onClick={e => e.stopPropagation()}>
        <h3>📎 Attach file or link</h3>
        <p className="dialog-hint">
          Paste a Google Drive, OneDrive, or web share link. Images are inserted inline; documents become clickable links.
        </p>
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://drive.google.com/... or https://1drv.ms/..."
          autoFocus
          onKeyDown={e => {
            if (e.key === 'Enter') handleInsertLink()
            if (e.key === 'Escape') onClose()
          }}
        />
        <input
          type="text"
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder={kind === 'folder' ? `Task ${taskId || ''} attachments folder` : 'Optional label / file name'}
        />
        <select className="attachment-kind" value={kind} onChange={e => setKind(e.target.value)}>
          <option value="auto">Auto-detect image vs document</option>
          <option value="image">Image (inline)</option>
          <option value="file">Document/link</option>
          <option value="folder">Folder link</option>
        </select>
        {folderPath && (
          <p className="attachment-folder-hint">
            Suggested per-task folder name: <code>{folderPath}</code>
          </p>
        )}
        <input ref={fileInputRef} type="file" className="attachment-file-input" onChange={handleFile} />
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => fileInputRef.current?.click()}>Choose local file…</button>
          <button className="dialog-save-btn" onClick={handleInsertLink} disabled={!url.trim()}>Insert link</button>
        </div>
      </div>
    </div>
  )
}

// Confirmation dialog shown before deleting/completing a task that has incoming links.
// Offers to bridge those links to the next task in the chain.
function LinkBridgeDialog({ incomingLinks, removedTaskName, nextTaskId, nextTaskName, onClose, onConfirm }) {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>🔗 Bridge Task Links?</h3>
        <p className="dialog-hint">
          The following {incomingLinks.length === 1 ? 'task links' : 'tasks link'} to <strong>{removedTaskName}</strong> which you are removing.
        </p>
        <ul className="move-task-list">
          {incomingLinks.map(link => (
            <li key={link.fromId}>
              <strong>#{link.fromId}</strong> {link.fromName}
            </li>
          ))}
        </ul>
        <p className="dialog-hint">
          {nextTaskId ? (
            <>Should these tasks now link to <strong>#{nextTaskId}</strong> ({nextTaskName}) instead?</>
          ) : (
            <>Since <strong>{removedTaskName}</strong> wasn't linked to anything else, these links will be removed.</>
          )}
        </p>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="dialog-save-btn" onClick={onConfirm}>
            {nextTaskId ? 'Bridge Links' : 'Remove Links & Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Confirmation dialog shown before moving a task (and possibly its
// dependency subtree) from the active source to another source.
function MoveToSourceDialog({ targetName, movingTasks, brokenLinks, onClose, onConfirm }) {
  const [moving, setMoving] = useState(false)

  const handleMove = async () => {
    setMoving(true)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setMoving(false)
      alert(`Failed to move tasks to ${targetName}: ${err.message || err}`)
    }
  }

  return (
    <div className="dialog-overlay" onClick={moving ? undefined : onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>📦 Move to {targetName}</h3>
        {moving ? (
          <div className="move-in-progress">
            <span className="spinner" />
            Moving tasks to {targetName}…
          </div>
        ) : (
          <>
            <p className="dialog-hint">
              {movingTasks.length === 1
                ? 'The following task will be moved:'
                : `The following ${movingTasks.length} tasks will be moved together:`}
            </p>
            <ul className="move-task-list">
              {movingTasks.map(t => (
                <li key={t.id}>
                  <strong>#{t.id}</strong> {t.name || '(no name)'}
                  {t.isPriority && <span className="move-task-tag"> ⭐ priority</span>}
                </li>
              ))}
            </ul>
            {brokenLinks.length > 0 && (
              <>
                <p className="dialog-hint dialog-warning">
                  ⚠️ {brokenLinks.length === 1 ? 'This link will break' : `${brokenLinks.length} links will break`} because the linked task is moving to another source:
                </p>
                <ul className="move-task-list move-broken-list">
                  {brokenLinks.map(b => (
                    <li key={`${b.fromId}->${b.toId}`}>
                      <strong>#{b.fromId}</strong> {b.fromName || ''} → <strong>#{b.toId}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button onClick={onClose} disabled={moving}>Cancel</button>
          <button className="dialog-save-btn" onClick={handleMove} disabled={moving}>
            {moving ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </div>
  )
}

// The set of priority choices, shared by the inline priority dropdown and the
// kebab "Change priority" submenu (#346).
const PRIORITY_CHOICES = [
  { icon: '🔴', label: 'Urgent & Important' },
  { icon: '🟡', label: 'Important' },
  { icon: '🔵', label: 'Urgent, Not Important' },
  { icon: '⚪', label: 'Low Priority' },
  { icon: '🐸', label: 'Frog (eat first)' },
  { icon: '📖', label: 'Learning' },
]

// Priority Dropdown component
function PriorityDropdown({ currentPriority, isNeededForUrgent, onChangePriority }) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef(null)
  const isMobile = useIsMobile()
  
  const priorities = PRIORITY_CHOICES
  
  useEffect(() => {
    // On mobile the menu is a portaled bottom sheet with its own backdrop,
    // so the click-outside-to-close handler only applies to the desktop popover.
    if (isMobile) return
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, isMobile])
  
  const handleSelect = (icon) => {
    onChangePriority(icon)
    setIsOpen(false)
  }
  
  return (
    <div className="priority-dropdown" ref={dropdownRef}>
      <span 
        className="priority-icon-btn"
        onClick={() => setIsOpen(!isOpen)}
        title={isNeededForUrgent ? "Needed for an urgent task — consider changing to urgent" : "Click to change priority"}
      >
        {currentPriority}
        {isNeededForUrgent && <span className="urgent-needed-marker" aria-hidden="true">!</span>}
      </span>
      {/* Mobile (#335): priority picker as an unclippable bottom sheet of big swatches. */}
      {isOpen && isMobile && (
        <BottomSheet title="Set priority" onClose={() => setIsOpen(false)}>
          <div className="priority-sheet-grid">
            {priorities.map(({ icon, label }) => (
              <button
                key={icon}
                className={`priority-sheet-option ${icon === currentPriority ? 'selected' : ''}`}
                onClick={() => handleSelect(icon)}
              >
                <span className="priority-sheet-icon">{icon}</span>
                <span className="priority-sheet-label">{label}</span>
              </button>
            ))}
          </div>
        </BottomSheet>
      )}
      {isOpen && !isMobile && (
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
function AddTaskDialog({ section, onClose, onAdd, taskLookup, activeTaskIds, sources, defaultSourceId, perSourceTaskLookup }) {
  const [task, setTask] = useState('')
  const [priority, setPriority] = useState('🟡')
  const [linkedTask, setLinkedTask] = useState('')
  const [sourceId, setSourceId] = useState(defaultSourceId || (sources && sources[0]?.id) || '')
  const [showLinkPicker, setShowLinkPicker] = useState(false)
  const dialogRef = useRef(null)
  const inputRef = useRef(null)

  // Resolve the task lookup for the currently-selected source.
  // In multi-source (Combined) view: use perSourceTaskLookup[sourceId].
  // In single-source view: fall back to the taskLookup / activeTaskIds props.
  const effectiveTaskLookup = (perSourceTaskLookup && sourceId && perSourceTaskLookup[sourceId])
    ? perSourceTaskLookup[sourceId]
    : (taskLookup || {})
  // Use activeTaskIds when available (single source view), otherwise fall back to keys of current lookup
  const effectiveTaskIds = activeTaskIds || Object.keys(effectiveTaskLookup)
  
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
              name="task-description"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="sentences"
              spellCheck={false}
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
              <div className="linked-task-input-wrapper">
                <input
                  type="text"
                  name="linked-task"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  inputMode="search"
                  value={linkedTask}
                  onChange={(e) => setLinkedTask(e.target.value)}
                  placeholder="Paste URL or task ID…"
                />
                {effectiveTaskIds.length > 0 && (
                  <button
                    type="button"
                    className="linked-task-pick-btn"
                    onClick={() => setShowLinkPicker(true)}
                    title="Pick from existing tasks"
                    aria-label="Pick from existing tasks"
                  >
                    🔗
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn-cancel">Cancel</button>
            <button type="submit" className="btn-add">Add Task</button>
          </div>
        </form>
        {showLinkPicker && (
          <LinkPickerModal
            currentLinkedId={linkedTask}
            taskLookup={effectiveTaskLookup}
            allTaskIds={effectiveTaskIds}
            onSelect={(tid) => { setLinkedTask(tid); setShowLinkPicker(false) }}
            onCancel={() => setShowLinkPicker(false)}
          />
        )}
      </div>
    </div>
  )
}

function FileTree({ items, onSelect, selectedPath }) {
  // Track which folders are open. All folders start collapsed; clicking a
  // folder both expands it and (if it contains planner.md as a direct child)
  // jumps straight to that file so the user doesn't have to drill in.
  const [openPaths, setOpenPaths] = useState(() => new Set())

  const toggle = (path) => {
    setOpenPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleFolderClick = (item) => {
    toggle(item.path)
    const planner = (item.children || []).find(
      c => c.type === 'file' && c.name === PLAN_FILE
    )
    if (planner) onSelect(planner.path)
  }

  return (
    <ul className="file-tree">
      {items.map((item) => (
        <li key={item.path}>
          {item.type === 'directory' ? (
            <>
              <button
                type="button"
                className={`folder${openPaths.has(item.path) ? ' open' : ''}`}
                onClick={() => handleFolderClick(item)}
                aria-expanded={openPaths.has(item.path)}
              >
                <span className="folder-caret">{openPaths.has(item.path) ? '▾' : '▸'}</span>
                <span className="folder-icon">📁</span>
                <span className="folder-name">{item.name}</span>
              </button>
              {openPaths.has(item.path) && item.children && (
                <FileTree items={item.children} onSelect={onSelect} selectedPath={selectedPath} />
              )}
            </>
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
    const snoozeUntil = parseSnoozeUntil(trimmed)
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
    row.snoozeUntil = snoozeUntil
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
  const iconPattern = /([🔴🟡🔵⚪✅🐸📖])/gu
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
function TaskRow({ row, headers, onNavigate, managerPriorities, onScrollToPriorities, onContextMenu, rawLine, onChangePriority, onPromoteTodo, onRenameTask, onChangeLinkedId, taskLookup, taskPriorityLookup, activeTaskIds, linkedIdMap, adoLookup }) {
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [todos, setTodos] = useState(null)
  const [todosLoading, setTodosLoading] = useState(false)
  const [journalPath, setJournalPath] = useState(null)
  const [journalChecked, setJournalChecked] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [isEditingLinkedId, setIsEditingLinkedId] = useState(false)
  const [telegram, setTelegram] = useState(null)
  const isMobile = useIsMobile()
  
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
  }, [taskId, journalChecked])
  
  // Fetch todos when journal path is known. We read the journal once and derive
  // BOTH the todo list and the Telegram deep link (if the journal carries a
  // tg-meta marker) from the same content — no extra round-trips.
  useEffect(() => {
    if (journalPath && todos === null) {
      setTodosLoading(true)
      storage.read(journalPath)
        .then(content => {
          setTodos(storage.parseTodos(content) || [])
          setTelegram(parseTgLink(content))
          setTodosLoading(false)
        })
        .catch(() => {
          setTodos([])
          setTodosLoading(false)
        })
    }
  }, [journalPath])

  // Journal read/unread indicator (task #311). The row holds NO business logic:
  // it hands the raw journal content to the read-state service (which computes
  // the signature + decides unread), renders the boolean, and fires an "opened"
  // event when the user opens the journal. localStorage is one provider behind
  // the service; the UI never touches it directly.
  const [isJournalUnread, setIsJournalUnread] = useState(false)
  useEffect(() => {
    if (!journalPath || !taskId) return
    let cancelled = false
    storage.read(journalPath)
      .then(content => { if (!cancelled) readStateService.track(taskId, content) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [journalPath, taskId])
  useEffect(() => {
    if (!taskId) return
    const update = () => setIsJournalUnread(readStateService.isUnread(taskId))
    update()
    return readStateService.subscribe(update)
  }, [taskId])
  
  const getPriorityClass = (priority) => {
    if (priority?.includes('🔴')) return 'priority-urgent'
    if (priority?.includes('🟡')) return 'priority-important'
    if (priority?.includes('🔵')) return 'priority-delegate'
    if (priority?.includes('⚪')) return 'priority-low'
    if (priority?.includes('✅')) return 'priority-done'
    return ''
  }
  
  const priorityCol = headers.find(h => h.includes('🎯')) || '🎯'
  const currentPriority = row[priorityCol] || '⚪'
  const mngrPriorityCol = headers.find(h => h.includes('Mngr') || h.includes('Work') || h.includes('Priority')) || 'Work Priority'
  const activeSnoozeUntil = isSnoozeActive(row.snoozeUntil) ? row.snoozeUntil : null
  
  const handleContextMenu = (e) => {
    e.preventDefault()
    onContextMenu(e, rawLine, row, journalPath, taskId)
  }

  // Mobile (#335): visible kebab opens the same row-action sheet — no hidden
  // right-click / press-and-hold gesture required.
  const handleKebab = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e, rawLine, row, journalPath, taskId)
  }
  
  // Filter to only uncompleted todos
  const uncompletedTodos = todos ? todos.filter(t => !t.done) : []
  const hasUncompletedTodos = uncompletedTodos.length > 0
  const nextTodo = hasUncompletedTodos ? uncompletedTodos[0] : null

  // "Lead-up" list: the child tasks that point at THIS task via their Linked ID
  // (i.e. the work that leads up to it), merged with this task's own journal
  // todos. Rendered together in the row's collapsible, mirroring the Priorities
  // section's expandable list.
  //
  // Ordering rule (documented): child tasks come first, sorted by priority/
  // urgency (🐸 → 🔴 → 🟡 → 🔵 → ⚪ → 📖 → ✅) and then by ascending numeric ID;
  // the task's own journal todos follow, in journal/file order.
  const LEAD_UP_PRIORITY_ORDER = { '🐸': 0, '🔴': 1, '🟡': 2, '🔵': 3, '⚪': 4, '📖': 5, '✅': 6 }
  const childTasks = (taskId && linkedIdMap)
    ? Object.entries(linkedIdMap)
        .filter(([fromId, toId]) => toId === taskId && fromId !== taskId)
        .map(([fromId]) => ({
          id: fromId,
          name: (taskLookup && taskLookup[fromId]) || `Task ${fromId}`,
          priority: (taskPriorityLookup && taskPriorityLookup[fromId]) || '⚪',
        }))
        .sort((a, b) => {
          const pa = Object.keys(LEAD_UP_PRIORITY_ORDER).find(ic => (a.priority || '').includes(ic)) || '⚪'
          const pb = Object.keys(LEAD_UP_PRIORITY_ORDER).find(ic => (b.priority || '').includes(ic)) || '⚪'
          const d = (LEAD_UP_PRIORITY_ORDER[pa] ?? 4) - (LEAD_UP_PRIORITY_ORDER[pb] ?? 4)
          if (d !== 0) return d
          return (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0)
        })
    : []
  const hasChildTasks = childTasks.length > 0
  const hasLeadUp = hasChildTasks || hasUncompletedTodos
  const firstChild = hasChildTasks ? childTasks[0] : null

  // Collapsible "lead-up" preview (▶ chevron + first item). Rendered inside the
  // Task cell on desktop; on mobile (#346) it moves to its own full-width cell
  // below the linkage pills so the trigger + expanded list read *below* the
  // links instead of jumping over them.
  const leadUpPreview = hasLeadUp ? (
    <div className="todo-preview" onClick={() => setTodosExpanded(!todosExpanded)}>
      <span className="todo-expander">{todosExpanded ? '▼' : '▶'}</span>
      {!todosExpanded && firstChild && (
        <span className="todo-first">{firstChild.priority} {firstChild.name}</span>
      )}
      {!todosExpanded && !firstChild && nextTodo && (
        <span className="todo-first">{nextTodo.text}</span>
      )}
    </div>
  ) : null

  return (
    <>
      <tr 
        className={[getPriorityClass(row[priorityCol]), activeSnoozeUntil ? 'task-row-snoozed' : ''].filter(Boolean).join(' ')}
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
            const allTaskIds = activeTaskIds || []
            const linkedNum = linkedId && String(linkedId).match(/(\d+)/)?.[1];
            const isLinkedTaskMissing = linkedNum && activeTaskIds && !activeTaskIds.includes(linkedNum);

            const startEditingLinkedId = (e) => {
              e.stopPropagation()
              setIsEditingLinkedId(true)
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
                    onNavigate(COMPLETED_FILE, linkedId)
                  }
                }, 100)
              } else {
                onNavigate(COMPLETED_FILE, linkedId)
              }
            }

            return (
              <td key={i} title={taskName} className="id-cell">
                {parseLinks(id, onNavigate)}
                {adoLink && (
                  <a className="external-link ado-id-link ado-id-badge" href={adoLink.url} target="_blank" rel="noopener noreferrer" title={`Ticket #${adoLink.id}`} onClick={(e) => e.stopPropagation()}>
                    {adoLink.id}
                  </a>
                )}
                {isEditingLinkedId && (
                  <LinkPickerModal
                    currentLinkedId={linkedId || ''}
                    taskLookup={taskLookup}
                    allTaskIds={allTaskIds.filter(tid => tid !== String(id).replace(/\D/g, ''))}
                    onSelect={(tid) => {
                      const oldLinkedId = linkedId || ''
                      setIsEditingLinkedId(false)
                      if (tid !== oldLinkedId) onChangeLinkedId(rawLine, tid, row.__sourceId)
                    }}
                    onCancel={() => setIsEditingLinkedId(false)}
                  />
                )}
                {linkedId ? (
                  <span className="linked-id-wrapper">
                    <span className="arrow linked-id-edit-arrow" onClick={startEditingLinkedId} title="Edit link">→</span>
                    {(() => {
                      const linkedNumMatch = linkedId.match(/^(\d+)$/)
                      const linkedAdoLink = linkedNumMatch && adoLookup ? adoLookup[linkedNumMatch[1]] : null
                      if (linkedAdoLink) {
                        return (
                          <span className="linked-id-link" onClick={navigateToLinkedId} title={linkedTaskName ? `${linkedTaskName} — go to task ${linkedId}` : `Go to task ${linkedId} (Ticket #${linkedAdoLink.id})`}>
                            <span className="linked-id-local">{linkedId}</span>
                            <a className="external-link ado-id-link ado-id-badge" href={linkedAdoLink.url} target="_blank" rel="noopener noreferrer" title={`Open ticket #${linkedAdoLink.id}`} onClick={(e) => e.stopPropagation()}>{linkedAdoLink.id}</a>
                          </span>
                        )
                      }
                      return <span className="linked-id-link" onClick={navigateToLinkedId} title={linkedTaskName || `Go to task ${linkedId.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}`}>{parseLinks(linkedId, onNavigate)}</span>
                    })()}
                    {isLinkedTaskMissing && <span className="missing-link-badge" title="Linked task is missing (deleted or completed)">!</span>}
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
                onRenameTask(rawLine, editText.trim(), row.__sourceId)
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
                  <div className="task-main-row">
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
                        {activeSnoozeUntil && (
                          <span className="snooze-badge" title={`Snoozed until ${activeSnoozeUntil}`}>
                            💤 Snoozed until {formatSnoozeDate(activeSnoozeUntil)}
                          </span>
                        )}
                        {journalPath && !isMobile && (
                          <a
                            href="#"
                            className="journal-link"
                            title="Open journal"
                            onClick={(e) => {
                              e.preventDefault()
                              readStateService.emitJournalOpened(taskId)
                              onNavigate(journalPath)
                            }}
                          >
                            📓
                            {isJournalUnread && (
                              <span
                                className="journal-unread-dot"
                                aria-label="New journal entries since you last opened this"
                                title="New entries since you last opened this"
                              >★</span>
                            )}
                          </a>
                        )}
                        {telegram?.url && !isMobile && (
                          <a
                            href={telegram.url}
                            className="telegram-link"
                            title="Open Telegram thread"
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            ✈️
                          </a>
                        )}
                      </span>
                    )}
                  </div>
                  {!isMobile && !isEditing && leadUpPreview}
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
            const isNeededForUrgent = !currentPriority.includes('🔴') && taskId && isNeededForUrgentTask(taskId, linkedIdMap || {}, taskPriorityLookup || {})
            return (
              <td key={i}>
                <PriorityDropdown 
                  currentPriority={cellValue || '⚪'} 
                  isNeededForUrgent={isNeededForUrgent}
                  onChangePriority={(newPriority) => onChangePriority(rawLine, cellValue, newPriority, row.__sourceId)}
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
        {/* Mobile (#335): journal + kebab get their own trailing column at the
            row's right edge — kebab all the way right, journal just before it —
            with real 40px tap targets that never overlap the task text. */}
        {isMobile && (
          <td className="row-actions-cell">
            {!isEditing && (
              <>
                <div className="row-actions">
                  {journalPath && (
                    <a
                      href="#"
                      className="row-action-btn journal-action"
                      aria-label="Open journal"
                      title="Open journal"
                      onClick={(e) => {
                        e.preventDefault()
                        readStateService.emitJournalOpened(taskId)
                        onNavigate(journalPath)
                      }}
                    >
                      📓
                      {isJournalUnread && (
                        <span
                          className="journal-unread-dot"
                          aria-label="New journal entries since you last opened this"
                          title="New entries since you last opened this"
                        >★</span>
                      )}
                    </a>
                  )}
                  {telegram?.url && (
                    <a
                      href={telegram.url}
                      className="row-action-btn telegram-action"
                      aria-label="Open Telegram thread"
                      title="Open Telegram thread"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      ✈️
                    </a>
                  )}
                  <button
                    type="button"
                    className="row-action-btn row-kebab-btn"
                    aria-label="Task actions"
                    title="Task actions"
                    onClick={handleKebab}
                  >
                    ⋯
                  </button>
                </div>
                {/* #346: the day-count ("Age") moves under the journal/kebab as a
                    small label instead of floating right and overlapping the rail. */}
                {row['Age'] && (
                  <span className="row-age-label" title={row['Added'] ? `Added: ${row['Added']}` : ''}>{row['Age']}</span>
                )}
              </>
            )}
          </td>
        )}
        {/* #346: on mobile the lead-up preview gets its own full-width cell below
            the linkage pills so it no longer jumps over the links. */}
        {isMobile && hasLeadUp && !isEditing && (
          <td className="todo-preview-cell">{leadUpPreview}</td>
        )}
      </tr>
      {todosExpanded && hasLeadUp && (
        <tr className="todo-row">
          <td></td>
          <td></td>
          <td colSpan={headers.length - 2}>
            <div className="todo-list lead-up-list">
              {hasChildTasks && (
                <>
                  {hasUncompletedTodos && <div className="lead-up-group-label">Lead-up tasks</div>}
                  {childTasks.map((c) => (
                    <div
                      key={`child-${c.id}`}
                      className="priority-task-item lead-up-task-item"
                      onClick={() => scrollToAndFlashTask(c.id)}
                      title={`Go to task ${c.id}: ${c.name}`}
                    >
                      <span className="priority-task-icon">{c.priority}</span>
                      <span className="priority-task-name">{c.name}</span>
                      <span className="priority-task-section">#{c.id}</span>
                    </div>
                  ))}
                </>
              )}
              {hasUncompletedTodos && (
                <>
                  {hasChildTasks && <div className="lead-up-group-label">To-dos</div>}
                  {uncompletedTodos.map((todo, i) => (
                    <div key={`todo-${i}`} className="todo-item">
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
                </>
              )}
            </div>
          </td>
          {isMobile && <td className="row-actions-cell"></td>}
        </tr>
      )}
    </>
  )
}

// Collapsible section component
// Collapsible section component
function TaskSection({ title, tableLines, lineSourceIds, onNavigate, defaultOpen = true, managerPriorities, onScrollToPriorities, onTaskAction, onMoveToCompleted, onAddTask, onAddClick, onCreateJournal, onChangePriority, onSnoozeTask, onDeleteTask, onPromoteTodo, onRenameTask, onChangeLinkedId, onLinkToAdoBugDb, taskLookup, taskPriorityLookup, activeTaskIds, linkedIdMap, adoLookup, onPromoteToManagerPriority, onRemoveFromManagerPriority, otherSources, onMoveToSource, onDeferBelow, searchQuery = '' }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const { headers, rows, rawLines } = parseMarkdownTable(tableLines)
  // Combined view (#39): tag each row with its owning source so destructive
  // ops route back to the correct source even when two sources share an
  // identical row text / id. `lineSourceIds` is parallel to the data rows.
  if (lineSourceIds) tagMergedRows(rows, lineSourceIds)
  const [contextMenu, setContextMenu] = useState(null)
  // #346: separate state for the kebab's "Change priority" submenu.
  const [priorityMenu, setPriorityMenu] = useState(null)
  const isMobile = useIsMobile()
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [adoLinkDialog, setAdoLinkDialog] = useState(null)
  
  // Sort rows: urgent first, then manager priority, then dependency depth, then eisenhower icon
  const { sortedRows, sortedRawLines } = sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities)

  // Board search (#271): filter to matching rows. An empty query is a no-op.
  const isSearching = normalizeQuery(searchQuery).length > 0
  const { rows: visibleRows, rawLines: visibleRawLines, matchCount } =
    filterRowsAndRawLines(sortedRows, sortedRawLines, searchQuery)
  // While searching, force the section open so matches are visible.
  const effectiveOpen = isSearching ? true : isOpen
  
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
    const today = getTodayDateString()
    const tomorrow = addDaysToDateString(today, 1)
    const weekend = getNextSaturdayDateString(today)
    const nextWeek = addDaysToDateString(today, 7)
    const currentSnoozeUntil = row.snoozeUntil || parseSnoozeUntil(rawLine)
    
    if (title === 'Today') {
      options.push({
        label: 'Defer',
        icon: '📅',
        action: () => onTaskAction('defer', rawLine, 'Today', 'Deferred', row.__sourceId)
      })
      // "Defer all below" cut-line action — only when a handler is provided
      // (single-source view) and there are tasks below the clicked row.
      if (onDeferBelow) {
        const idx = sortedRawLines.indexOf(rawLine)
        if (idx >= 0 && idx < sortedRawLines.length - 1) {
          const below = sortedRawLines.slice(idx + 1)
          options.push({
            label: `Defer ${below.length} below`,
            icon: '✂️',
            action: () => onDeferBelow(below)
          })
        }
      }
    } else if (title === 'Deferred') {
      options.push({
        label: 'Move to Today',
        icon: '⬆️',
        action: () => onTaskAction('move', rawLine, 'Deferred', 'Today', row.__sourceId)
      })
    }

    if (onSnoozeTask) {
      options.push(
        {
          label: `Snooze until tomorrow (${formatSnoozeDate(tomorrow)})`,
          icon: '💤',
          action: () => onSnoozeTask(rawLine, tomorrow, row.__sourceId),
        },
        {
          label: `Snooze until this weekend (${formatSnoozeDate(weekend)})`,
          icon: '💤',
          action: () => onSnoozeTask(rawLine, weekend, row.__sourceId),
        },
        {
          label: `Snooze for next week (${formatSnoozeDate(nextWeek)})`,
          icon: '💤',
          action: () => onSnoozeTask(rawLine, nextWeek, row.__sourceId),
        },
        {
          label: 'Snooze until custom date…',
          icon: '📆',
          action: () => {
            const value = window.prompt('Snooze until date (YYYY-MM-DD)', currentSnoozeUntil || tomorrow)
            if (value === null) return
            const date = normalizeDateOnly(value)
            if (!date || date <= today) {
              window.alert('Enter a future date as YYYY-MM-DD.')
              return
            }
            onSnoozeTask(rawLine, date, row.__sourceId)
          },
        },
      )
      if (currentSnoozeUntil) {
        options.push({
          label: 'Un-snooze',
          icon: '☀️',
          action: () => onSnoozeTask(rawLine, null, row.__sourceId),
        })
      }
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
      action: () => setAdoLinkDialog({ rawLine, currentUrl: currentAdoLink ? currentAdoLink.url : '', sourceId: row.__sourceId })
    })
    
    // Add "Move to {source}" options when there are multiple sources.
    if (otherSources && otherSources.length > 0 && taskId) {
      for (const src of otherSources) {
        options.push({
          label: `Move to ${src.name}`,
          icon: '📦',
          action: () => onMoveToSource(rawLine, row, taskId, src.id),
        })
      }
    }

    // #346: change priority straight from the kebab (mobile users complained the
    // slim left tap-bar wasn't discoverable). Opens a second menu/sheet of the
    // same priority choices; picking one applies it to this row.
    if (taskId || row['ID']) {
      options.push({
        label: 'Change priority',
        icon: '🎯',
        action: () => setPriorityMenu({
          x: e.clientX,
          y: e.clientY,
          rawLine,
          idCell: row['ID'],
          sourceId: row.__sourceId,
        }),
      })
    }

    // Add "Delete Task" option (also deletes journal if exists)
    options.push({
      label: 'Delete Task',
      icon: '🗑️',
      action: () => onDeleteTask(rawLine, title, journalPath, taskId, row)
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
        <span className="collapse-icon">{effectiveOpen ? '▼' : '▶'}</span>
        {title}
        <span className="sort-info-wrapper" onClick={(e) => e.stopPropagation()}>
          <span className="sort-info-icon" title="Sort order">ⓘ</span>
          <span className="sort-info-tooltip">
            <strong>Sort Order</strong><br/>
            1. Active snoozes stay at the bottom until their date<br/>
            2. 🔴 Urgent — always on top<br/>
            3. Work Priority (🐸 first within each)<br/>
            4. Priority icon: 🐸 → 🟡 → 🔵 → 📖 → ⚪ → ✅
          </span>
        </span>
        <button 
          className="add-task-btn"
          onClick={(e) => {
            e.stopPropagation()
            if (onAddClick) { onAddClick(); return }
            setShowAddDialog(true)
          }}
          title={`Add task to ${title}`}
        >
          +
        </button>
      </h2>
      {effectiveOpen && (
        <div className="task-table-container">
          <table className="task-table">
            <thead>
              <tr>
                {headers.map((h, i) => <th key={i}>{displayHeader(h)}</th>)}
                {isMobile && <th key="__actions" className="row-actions-header" aria-label="Actions"></th>}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, i) => (
                <TaskRow 
                  key={`${extractTaskId(row) || 'row'}-${i}`} 
                  row={row} 
                  headers={headers} 
                  onNavigate={onNavigate}
                  managerPriorities={managerPriorities}
                  onScrollToPriorities={onScrollToPriorities}
                  onContextMenu={handleContextMenu}
                  rawLine={visibleRawLines[i]}
                  onChangePriority={onChangePriority}
                  onPromoteTodo={onPromoteTodo}
                  onRenameTask={onRenameTask}
                  onChangeLinkedId={onChangeLinkedId}
                  taskLookup={taskLookup}
                  taskPriorityLookup={taskPriorityLookup}
                  activeTaskIds={activeTaskIds}
                  linkedIdMap={linkedIdMap}
                  adoLookup={adoLookup}/>
              ))}
              {isSearching && matchCount === 0 && (
                <tr className="search-no-match-row">
                  <td colSpan={headers.length + (isMobile ? 1 : 0)}>No matches in {title}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          options={contextMenu.options}
          title="Task actions"
          sheet={isMobile}
          onClose={() => setContextMenu(null)}
        />
      )}
      {/* #346: the "Change priority" submenu opened from the kebab. */}
      {priorityMenu && (
        <ContextMenu
          x={priorityMenu.x}
          y={priorityMenu.y}
          title="Change priority"
          sheet={isMobile}
          options={PRIORITY_CHOICES.map(({ icon, label }) => ({
            icon,
            label,
            action: () => onChangePriority(priorityMenu.rawLine, priorityMenu.idCell, icon, priorityMenu.sourceId),
          }))}
          onClose={() => setPriorityMenu(null)}
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
          onSave={(adoLink) => onLinkToAdoBugDb(adoLinkDialog.rawLine, adoLink, adoLinkDialog.sourceId)}
        />
      )}
    </div>
  )
}

// Manager Priorities Section
function ManagerPrioritiesSection({ lines, defaultOpen = false, onUpdate, onAddAndPrioritize, tasksByPriority = {}, taskLookup = {}, title = 'Work Priorities', sectionId = 'work-priorities', otherSources, onMoveToSource, sourceId }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [isAdding, setIsAdding] = useState(false)
  const [newPriority, setNewPriority] = useState('')
  const [expandedPriorities, setExpandedPriorities] = useState({})
  const [contextMenu, setContextMenu] = useState(null)
  const isMobile = useIsMobile()

  const handlePriorityContextMenu = (e, id, taskName) => {
    e.preventDefault()
    const options = []
    if (otherSources && otherSources.length > 0 && onMoveToSource) {
      for (const src of otherSources) {
        options.push({
          label: `Move to ${src.name}`,
          icon: '📦',
          action: () => onMoveToSource(null, { Task: taskName }, id, src.id, sourceId),
        })
      }
    }
    if (options.length > 0) setContextMenu({ x: e.clientX, y: e.clientY, options })
  }
  const priorities = parseManagerPriorities(lines)
  const priorityList = Object.entries(priorities).sort((a, b) => a[1] - b[1])
  
  const toggleExpanded = (id) => {
    setExpandedPriorities(prev => ({ ...prev, [id]: !prev[id] }))
  }
  
  const scrollToTask = (taskId) => {
    scrollToAndFlashTask(taskId)
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
                <li key={id} className="priority-item" onContextMenu={(e) => handlePriorityContextMenu(e, id, taskName)}>
                  <div className="priority-item-header">
                    <span className="priority-number">#{num}</span>
                    <span className="priority-name priority-name-clickable" onClick={() => scrollToTask(id)} title={taskName}>
                      {taskName}
                    </span>
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
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          options={contextMenu.options}
          title="Priority actions"
          sheet={isMobile}
          onClose={() => setContextMenu(null)}
        />
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

// Section-name predicates moved to focusPlanShared.js so they can be reused
// from focusPlanOps.js without an import cycle.
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

function buildTaskPriorityLookup(tableLines) {
  const lookup = {}
  const { headers, rows } = parseMarkdownTable(tableLines)
  const priorityCol = headers.find(h => h.includes('🎯')) || '🎯'
  for (const row of rows) {
    const id = extractTaskId(row)
    if (id) {
      lookup[id] = row[priorityCol] || ''
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
// After adding a task we wait a tick for React to commit the new row to the DOM,
// then scroll to it and flash it so the user can see where it landed (#268).
const SCROLL_AFTER_ADD_MS = 120
function scrollToNewTaskAfterRender(taskId) {
  setTimeout(() => scrollToAndFlashTask(taskId), SCROLL_AFTER_ADD_MS)
}

/**
 * Decides whether the board search box is worth showing. It is only useful when
 * the task list is long enough to scroll/filter, so we hide it when everything
 * already fits the viewport and reclaim that vertical space (#auto-hide-search).
 *
 * The decision is measured against the scrollable container's content height
 * *excluding* the search bar itself — so toggling the bar can't change the
 * outcome and cause a show/hide flicker loop. A small dead-band adds hysteresis
 * against sub-pixel / scrollbar jitter.
 *
 * @param rootRef    ref to the view root (its parent is the scroll container)
 * @param searchRef  ref to the search bar element (null when not rendered)
 * @param forceShow  keep visible regardless (active query, or `/` summon)
 * @returns boolean — whether the search box is needed
 */
const SEARCH_BAR_MARGIN_PX = 16 // .board-search margin-bottom (1rem)
const OVERFLOW_DEADBAND_PX = 6
function useSearchNeeded(rootRef, searchRef, forceShow) {
  // Default to visible so a long list (the common case) never flashes hidden.
  const [needed, setNeeded] = useState(true)

  useLayoutEffect(() => {
    const root = rootRef.current
    const scrollEl = root?.parentElement
    if (!scrollEl) return

    let raf = 0
    const measure = () => {
      raf = 0
      const searchEl = searchRef.current
      const searchSpace = searchEl ? searchEl.offsetHeight + SEARCH_BAR_MARGIN_PX : 0
      // Height of the content if the search bar were not present.
      const contentAlone = scrollEl.scrollHeight - (searchEl ? searchSpace : 0)
      const overflow = contentAlone - scrollEl.clientHeight

      setNeeded((prev) => {
        if (forceShow) return true
        if (prev && overflow < -OVERFLOW_DEADBAND_PX) return false // clearly fits → hide
        if (!prev && overflow > OVERFLOW_DEADBAND_PX) return true  // clearly overflows → show
        return prev
      })
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure) }

    const ro = new ResizeObserver(schedule)
    ro.observe(scrollEl)
    ro.observe(root) // catches task add/remove, section/journal expand-collapse
    window.addEventListener('resize', schedule)
    schedule()

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [rootRef, searchRef, forceShow])

  return forceShow ? true : needed
}

/**
 * Tracks whether the primary pointer is "coarse" (touch). Used to drop the
 * keyboard-only "/ to focus" affordance on phones/tablets where there is no
 * physical keyboard (#284). Re-evaluates if the pointer capability changes
 * (e.g. a tablet docked with a keyboard).
 */
function useCoarsePointer() {
  const query = '(pointer: coarse)'
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  const [coarse, setCoarse] = useState(get)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setCoarse(mql.matches)
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [])
  return coarse
}

function FocusPlanView({ content, onNavigate, onContentUpdate, otherSources, search: searchProp, onSearchChange, mission, syncStatus }) {
  const [completedTaskLookup, setCompletedTaskLookup] = useState({})
  const [bridgeDialog, setBridgeDialog] = useState(null)
  const [searchLocal, setSearchLocal] = useState('')
  // Search can be driven by a parent (e.g. the mobile header input) via props,
  // or owned locally (desktop). Props win when supplied.
  const search = searchProp !== undefined ? searchProp : searchLocal
  const setSearch = onSearchChange || setSearchLocal
  const [searchForced, setSearchForced] = useState(false)
  const coarsePointer = useCoarsePointer()
  const searchInputRef = useRef(null)
  const viewRootRef = useRef(null)
  const searchBarRef = useRef(null)
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
  const taskPriorityLookup = {}
  const linkedIdMap = {}
  const adoLookup = {}
  for (const section of taskSections) {
    Object.assign(currentTaskLookup, buildTaskIdLookup(section.lines))
    Object.assign(taskPriorityLookup, buildTaskPriorityLookup(section.lines))
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
    storage.read(COMPLETED_FILE)
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

  // The board search is always shown now: it carries the mission statement as
  // its quote-styled zero-state placeholder (#322), so there's no separate
  // mission band to hide/show. `forceShow` keeps the bar pinned regardless of
  // list height; `searchForced` is still honored for the `/`-summon focus.
  const showSearch = useSearchNeeded(viewRootRef, searchBarRef, true)

  // When the box is summoned via `/`, focus it once it actually renders.
  useEffect(() => {
    if (searchForced && showSearch) searchInputRef.current?.focus()
  }, [searchForced, showSearch])

  // Board search (#271): `/` focuses the search box (revealing it if hidden),
  // `Esc` clears it and lets it auto-hide again. Skipped on touch/coarse-pointer
  // devices where there is no physical keyboard (#284).
  useEffect(() => {
    if (coarsePointer) return
    const onKeyDown = (e) => {
      const el = e.target
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        setSearchForced(true)
        searchInputRef.current?.focus()
      } else if (e.key === 'Escape' && el === searchInputRef.current) {
        setSearch('')
        setSearchForced(false)
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [coarsePointer])

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

  // Cut-line "Defer all below" — batch move multiple rows from Today to
  // Deferred in a single content update.
  const handleDeferBelow = async (rawLines) => {
    if (!Array.isArray(rawLines) || rawLines.length === 0) return
    const newContent = ops.opMoveLinesBetweenSections(content, rawLines, 'Today', 'Deferred')
    if (newContent !== content) await onContentUpdate(newContent)
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

  const handleSnoozeTask = async (rawLine, snoozeUntil) => {
    const newContent = ops.opSetTaskSnooze(content, rawLine, snoozeUntil)
    if (newContent !== content) await onContentUpdate(newContent)
  }
   
  const handleDeleteTask = async (rawLine, fromSection, journalPath, taskId, row) => {
    // Check for incoming links to bridge
    if (taskId && linkedIdMap) {
      const incoming = []
      for (const [fId, tId] of Object.entries(linkedIdMap)) {
        if (tId === String(taskId)) {
          incoming.push({ fromId: fId, fromName: taskLookup[fId] || '' })
        }
      }
      if (incoming.length > 0) {
        const idCol = row['ID']
        const nextIdRawValue = (typeof idCol === 'object' && idCol.linkedId) ? idCol.linkedId : ''
        const nextIdNum = nextIdRawValue.match(/(\d+)/)?.[1]
        setBridgeDialog({
          incomingLinks: incoming,
          removedTaskName: row['Task'] || `Task ${taskId}`,
          nextTaskId: nextIdNum,
          nextTaskName: nextIdNum ? taskLookup[nextIdNum] : '',
          onConfirm: async () => {
            const bridged = ops.opBridgeLinks(content, taskId, nextIdRawValue)
            const final = ops.opDeleteTask(bridged, rawLine)
            await onContentUpdate(final)
            if (taskId) recordDeletedId(taskId)
            if (journalPath) await storage.remove(journalPath).catch(() => {})
            setBridgeDialog(null)
          }
        })
        return
      }
    }

    // Delete the task from focus plan
    const newContent = ops.opDeleteTask(content, rawLine)
    await onContentUpdate(newContent)
    // Tombstone the freed ID so it isn't reused while a synced replica could
    // still resurrect this task's journal (#314).
    if (taskId) recordDeletedId(taskId)
    
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

    // Check for incoming links to bridge
    if (taskId && linkedIdMap) {
      const incoming = []
      for (const [fId, tId] of Object.entries(linkedIdMap)) {
        if (tId === String(taskId)) {
          incoming.push({ fromId: fId, fromName: taskLookup[fId] || '' })
        }
      }
      if (incoming.length > 0) {
        const idCol = row['ID']
        const nextIdRawValue = (typeof idCol === 'object' && idCol.linkedId) ? idCol.linkedId : ''
        const nextIdNum = nextIdRawValue.match(/(\d+)/)?.[1]
        setBridgeDialog({
          incomingLinks: incoming,
          removedTaskName: row['Task'] || `Task ${taskId}`,
          nextTaskId: nextIdNum,
          nextTaskName: nextIdNum ? taskLookup[nextIdNum] : '',
          onConfirm: async () => {
            const bridged = ops.opBridgeLinks(content, taskId, nextIdRawValue)
            setBridgeDialog(null)
            await performMoveToCompleted(rawLine, row, fromSection, bridged)
          }
        })
        return
      }
    }
    await performMoveToCompleted(rawLine, row, fromSection, content)
  }

  const performMoveToCompleted = async (rawLine, row, fromSection, currentContent) => {
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
      // Use the potentially bridged content as the base
      const finalFocusLines = currentContent.split('\n')
      const finalLineToRemoveIndex = finalFocusLines.findIndex(l => l.trim() === rawLine)
      if (finalLineToRemoveIndex !== -1) {
        finalFocusLines.splice(finalLineToRemoveIndex, 1)
      }
      await onContentUpdate(finalFocusLines.join('\n'))
    }
    
    // Add to focus-plan-completed.md under the current week
    try {
      const completedContent = await storage.read(COMPLETED_FILE).catch(() => '# Completed Tasks\n')
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
      
      await storage.write(COMPLETED_FILE, completedLines.join('\n'))
    } catch (e) {
      console.error('Failed to update completed file:', e)
    }
  }
  
  const handleAddTask = async ({ task, priority, linkedTask, section }) => {
    const lines = content.split('\n')
    let inTargetSection = false
    let insertIndex = -1
    let maxId = 0

    // Existing journal IDs are only a collision-skip set — numbering is driven
    // by the planner's own rows so a stray/foreign high journal ID can't inflate it.
    const journalIds = await getJournalIds()
    
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
      let newId = maxId + 1
      while (journalIds.has(newId)) newId++
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
      scrollToNewTaskAfterRender(newId)
    }
  }
  
  const handleAddAndPrioritize = async (taskName, prioritySectionTitle) => {
    const lines = content.split('\n')
    const journalIds = await getJournalIds()
    let maxId = 0
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
    let newId = maxId + 1
    while (journalIds.has(newId)) newId++
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
    scrollToNewTaskAfterRender(newId)
  }

  const handlePromoteTodo = async (todoText, parentTaskId) => {
    const lines = content.split('\n')
    let inTodaySection = false
    let insertIndex = -1
    let maxId = 0
    
    const journalIds = await getJournalIds()
    
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
      let newId = maxId + 1
      while (journalIds.has(newId)) newId++
      const today = new Date().toISOString().split('T')[0]
      // Clean the todo text (remove TODO: prefix if present)
      const cleanTodoText = todoText.replace(/^TODO:\s*/i, '').trim()
      // Create new task with auto-generated ID and link to parent
      const newRow = `| ${newId} | 🟡 | ${cleanTodoText} | - | ${today} | ${parentTaskId} |`
      lines.splice(insertIndex, 0, newRow)
      await onContentUpdate(lines.join('\n'))
      scrollToNewTaskAfterRender(newId)
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

  // ── Move-to-source ────────────────────────────────────────────────
  // Right-click → "Move to {source}" hands the task (and, for a manager
  // priority, its full dependency subtree) over to another source's
  // focus-plan.md. The dialog summarises which tasks are travelling and
  // which incoming links will break before the move is committed.
  const [moveDialog, setMoveDialog] = useState(null)

  const findRawLineForTaskId = (id) => {
    for (const section of taskSections) {
      for (const line of section.lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('|')) continue
        const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
        if (cells.length === 0) continue
        const idCell = cells[0]
        const localId = idCell.indexOf(',[') !== -1
          ? idCell.substring(0, idCell.indexOf(',['))
          : idCell
        if (localId === String(id)) return { rawLine: trimmed, sectionTitle: section.title }
      }
    }
    return null
  }

  const handleMoveToSource = (rawLine, row, taskId, targetSourceId) => {
    if (!targetSourceId || !taskId) return
    const target = (otherSources || []).find(s => s.id === targetSourceId)
    if (!target) return

    const moveSet = computeMoveSet(taskId, managerPriorities, linkedIdMap, activeTaskIds)
    const movingTasks = [...moveSet].map(id => ({
      id,
      name: taskLookup[id] || (id === taskId ? (row['Task'] || '') : ''),
      isPriority: !!managerPriorities[id],
    }))
    const brokenLinks = computeBrokenLinks(moveSet, linkedIdMap, taskLookup)

    setMoveDialog({
      target,
      taskId,
      rawLine,
      movingTasks,
      brokenLinks,
    })
  }

  const performMoveToSource = async ({ target, movingTasks }) => {
    const movingIds = new Set(movingTasks.map(t => t.id))
    // Collect raw lines + journal task IDs in deterministic order.
    const movingRows = []
    for (const t of movingTasks) {
      const found = findRawLineForTaskId(t.id)
      if (found) movingRows.push({ ...found, taskId: t.id })
    }
    if (movingRows.length === 0) return

    // 1. Build the new content for the current source: drop matching rows
    //    from Today/Deferred and remove any matching Priorities entries.
    const removalSet = new Set(movingRows.map(r => r.rawLine))
    const lines = content.split('\n')
    let inPriorities = false
    const newLines = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('## ')) {
        inPriorities = isPrioritiesSection(trimmed.replace(/^##\s+/, ''))
        newLines.push(line)
        continue
      }
      if (removalSet.has(trimmed)) continue
      if (inPriorities) {
        const m = trimmed.match(/^\d+\.\s+(.+)$/)
        if (m && movingIds.has(m[1].trim())) continue
      }
      newLines.push(line)
    }
    // Renumber the remaining Priorities entries.
    const renumbered = []
    let pInside = false
    let pIdx = 1
    for (const line of newLines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('## ')) {
        pInside = isPrioritiesSection(trimmed.replace(/^##\s+/, ''))
        if (pInside) pIdx = 1
        renumbered.push(line)
        continue
      }
      if (pInside) {
        const m = line.match(/^(\s*)\d+\.\s+(.+)$/)
        if (m) {
          renumbered.push(`${m[1]}${pIdx++}. ${m[2]}`)
          continue
        }
      }
      renumbered.push(line)
    }

    // 2. Build the new content for the target source. We need to read its
    //    current focus-plan.md, then append moving rows under Today and
    //    moving manager-priority entries under Priorities.
    const targetProvider = getProvider(target.id)
    if (!targetProvider) {
      alert(`Cannot reach source "${target.name}". Please check that the source is connected.`)
      return
    }
    let targetContent = ''
    try {
      targetContent = await targetProvider.read(PLAN_FILE)
    } catch {
      // Target may not have a focus-plan yet — start with a minimal one.
      targetContent =
        '# Focus Plan\n\n## Today\n\n| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |\n|---|---|------|---------------|-------|-----------|\n\n## Deferred\n\n| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |\n|---|---|------|---------------|-------|-----------|\n'
    }

    const tLines = targetContent.split('\n')
    // Renumber moving tasks into the target's own sequence so a foreign ID
    // never crosses folders (which would inflate the target's numbering).
    const targetBase = maxTaskIdInRows(targetContent)
    const targetJournalIds = withDeletedIdTombstones(await storage.journalIdsFromSource(target.id))
    const { idMap, rows: renumberedRows } = renumberMovedRows(movingRows, targetBase, targetJournalIds)
    // Find Today section's insertion point (right after the separator row).
    let inToday = false
    let todayInsertIdx = -1
    for (let i = 0; i < tLines.length; i++) {
      const trimmed = tLines[i].trim()
      if (trimmed.startsWith('## ')) {
        inToday = trimmed.replace(/^##\s+/, '') === 'Today'
        continue
      }
      if (inToday && trimmed.startsWith('|') && trimmed.includes('---')) {
        todayInsertIdx = i + 1
        break
      }
    }
    if (todayInsertIdx === -1) {
      // No Today section in target — append one.
      tLines.push(
        '',
        '## Today',
        '',
        '| ID | 🎯 | Task | Mngr Priority | Added | Linked ID |',
        '|---|---|------|---------------|-------|-----------|',
      )
      todayInsertIdx = tLines.length
    }
    const rowsToInsert = renumberedRows.map(r => r.newRawLine)
    tLines.splice(todayInsertIdx, 0, ...rowsToInsert)

    // Append any moving Priorities entries to the target's Priorities section.
    const priorityIdsMoving = movingTasks.filter(t => t.isPriority).map(t => idMap.get(String(t.id)) || String(t.id))
    if (priorityIdsMoving.length > 0) {
      let pStart = -1
      let pEnd = tLines.length
      for (let i = 0; i < tLines.length; i++) {
        const trimmed = tLines[i].trim()
        if (trimmed.startsWith('## ') && isPrioritiesSection(trimmed.replace(/^##\s+/, ''))) {
          pStart = i
        } else if (pStart !== -1 && trimmed.startsWith('## ')) {
          pEnd = i
          break
        }
      }
      if (pStart === -1) {
        tLines.push('', '## Priorities', '')
        pStart = tLines.length - 2
        pEnd = tLines.length
      }
      let maxNum = 0
      for (let i = pStart + 1; i < pEnd; i++) {
        const m = tLines[i].trim().match(/^(\d+)\.\s+/)
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10))
      }
      const newEntries = priorityIdsMoving.map((id, i) => `${maxNum + i + 1}. ${id}`)
      // Insert before pEnd (end of section), trimming trailing blanks.
      let insertAt = pEnd
      while (insertAt > pStart + 1 && tLines[insertAt - 1].trim() === '') insertAt--
      tLines.splice(insertAt, 0, ...newEntries)
    }

    // 3. Move journals (best effort — silently skip those that don't exist).
    //    Renumber the journal filename + title to the task's new target ID.
    const activeProvider = getActiveProvider()
    for (const r of renumberedRows) {
      const fromPath = `journal/task-${r.oldId}.md`
      const toPath = `journal/task-${r.newId}.md`
      try {
        const journalContent = await activeProvider.read(fromPath)
        if (typeof journalContent === 'string') {
          await targetProvider.write(toPath, retitleJournal(journalContent, r.newId))
          await activeProvider.remove(fromPath)
        }
      } catch {
        // No journal for this task — fine.
      }
    }

    // 4. Persist both sides. Write the target first so a failure there
    //    doesn't leave us with deleted-but-not-moved tasks.
    await targetProvider.write(PLAN_FILE, tLines.join('\n'))
    await onContentUpdate(renumbered.join('\n'))
  }

  return (
    <div className="focus-plan-view" ref={viewRootRef}>
      {(showSearch || mission || syncStatus) && (
        <div className="board-search" ref={searchBarRef}>
          {showSearch && (
            <>
              <span className="board-search-icon" aria-hidden="true">🔍</span>
              <input
                ref={searchInputRef}
                type="text"
                className={`board-search-input${mission ? ' has-mission' : ''}`}
                placeholder={boardSearchPlaceholder(coarsePointer, mission)}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); setSearchForced(false); e.currentTarget.blur() } }}
                aria-label="Search tasks"
              />
              {search && (
                <button
                  type="button"
                  className="board-search-clear"
                  onClick={() => { setSearch(''); searchInputRef.current?.focus() }}
                  title="Clear search (Esc)"
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </>
          )}
          <SyncIndicator syncStatus={syncStatus} />
        </div>
      )}

      {taskSections.map((section, i) => (
        <TaskSection
          key={i}
          title={section.title}
          tableLines={section.lines}
          searchQuery={search}
          onNavigate={onNavigate}
          defaultOpen={section.title === 'Today'}
          managerPriorities={managerPriorities}
          onScrollToPriorities={scrollToPriorities}
          onTaskAction={handleTaskAction}
          onDeferBelow={handleDeferBelow}
          onMoveToCompleted={handleMoveToCompleted}
          onAddTask={handleAddTask}
          onCreateJournal={handleCreateJournal}
          onChangePriority={handleChangePriority}
          onSnoozeTask={handleSnoozeTask}
          onDeleteTask={handleDeleteTask}
          onPromoteTodo={handlePromoteTodo}
          onRenameTask={handleRenameTask}
          onChangeLinkedId={handleChangeLinkedId}
          onLinkToAdoBugDb={handleLinkToAdoBugDb}
          taskLookup={taskLookup}
          taskPriorityLookup={taskPriorityLookup}
          activeTaskIds={activeTaskIds}
          linkedIdMap={linkedIdMap}
          adoLookup={adoLookup}
          onPromoteToManagerPriority={handlePromoteToManagerPriority}
          onRemoveFromManagerPriority={handleRemoveFromManagerPriority}
          otherSources={otherSources}
          onMoveToSource={handleMoveToSource}
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
          otherSources={otherSources}
          onMoveToSource={handleMoveToSource}
        />
      )}

      {bridgeDialog && (
        <LinkBridgeDialog
          incomingLinks={bridgeDialog.incomingLinks}
          removedTaskName={bridgeDialog.removedTaskName}
          nextTaskId={bridgeDialog.nextTaskId}
          nextTaskName={bridgeDialog.nextTaskName}
          onClose={() => setBridgeDialog(null)}
          onConfirm={bridgeDialog.onConfirm}
        />
      )}

      {moveDialog && (
        <MoveToSourceDialog
          targetName={moveDialog.target.name}
          movingTasks={moveDialog.movingTasks}
          brokenLinks={moveDialog.brokenLinks}
          onClose={() => setMoveDialog(null)}
          onConfirm={async () => {
            const dlg = moveDialog
            await performMoveToSource(dlg)
          }}
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
          onClick={() => onNavigate(PLAN_FILE)}
          title="Back to Focus Plan"
        >
          ← Focus Plan
        </button>
        <h1>✅ Completed Tasks</h1>
      </div>

      {sections.map((section, si) => {
        if (section.title === 'Completed Tasks') return null
        const { headers, rows } = parseMarkdownTable(section.lines)
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

// ---- Journal chat rendering ----------------------------------------------

// Render inline markdown (bold, italic, code) plus links to React nodes.
function renderInlineFormatting(text, keyBase) {
  const nodes = []
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*|(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9]))/g
  let last = 0
  let m
  let idx = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[2] != null) nodes.push(<strong key={`${keyBase}-b${idx}`}>{m[2]}</strong>)
    else if (m[3] != null) nodes.push(<strong key={`${keyBase}-b${idx}`}>{m[3]}</strong>)
    else if (m[4] != null) nodes.push(<code className="jc-code" key={`${keyBase}-c${idx}`}>{m[4]}</code>)
    else if (m[5] != null) nodes.push(<em key={`${keyBase}-i${idx}`}>{m[5]}</em>)
    else if (m[6] != null) nodes.push(<em key={`${keyBase}-i${idx}`}>{m[6]}</em>)
    last = m.index + m[0].length
    idx++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// Render text with links first, then inline formatting on the plain segments.
function renderInline(text, onNavigate, keyBase = 'k') {
  const linkRe = /(!?)\[([^\]]+)\]\(([^)]+)\)/g
  const out = []
  let last = 0
  let m
  let idx = 0
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) out.push(...renderInlineFormatting(text.slice(last, m.index), `${keyBase}-t${idx}`))
    const isImage = m[1] === '!'
    const label = m[2]
    const href = m[3]
    if (isImage) {
      out.push(
        <a key={`${keyBase}-imgl${idx}`} href={href} target="_blank" rel="noopener noreferrer" className="jc-image-link">
          <img src={href} alt={label} className="jc-image" loading="lazy" />
        </a>
      )
    } else if (href.startsWith('journal/') || href.endsWith('.md')) {
      out.push(
        <a key={`${keyBase}-l${idx}`} href="#" className="internal-link" onClick={(e) => { e.preventDefault(); onNavigate(href) }}>{label}</a>
      )
    } else {
      out.push(
        <a key={`${keyBase}-l${idx}`} href={href} target="_blank" rel="noopener noreferrer" className="external-link">{label}</a>
      )
    }
    last = m.index + m[0].length
    idx++
  }
  if (last < text.length) out.push(...renderInlineFormatting(text.slice(last), `${keyBase}-t${idx}`))
  return out
}

// Render a block of journal lines into chat content (lists, todos, headings,
// tables, blockquotes, text). Uses an index loop so block elements (tables,
// blockquotes) can consume multiple consecutive lines.
function renderJournalLines(lines, onNavigate, onToggle, ctx) {
  const out = []
  let list = null
  const toggleProps = (idx) => (onToggle && ctx ? {
    className: 'jc-todo-toggle',
    role: 'button',
    tabIndex: 0,
    title: 'Click to toggle',
    onClick: () => onToggle(idx),
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(idx) } },
  } : {})
  const flush = () => {
    if (list) { out.push(<ul className="jc-list" key={`ul-${out.length}`}>{list}</ul>); list = null }
  }

  const isTableRow = (s) => /^\|.*\|\s*$/.test(s.trim())
  const isTableSep = (s) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s.trim())
  const splitCells = (s) => s.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) { flush(); continue }
    let m

    // Markdown table: header row, separator row, then body rows.
    if (isTableRow(t) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush()
      const header = splitCells(t)
      const rows = []
      let j = i + 2
      while (j < lines.length && isTableRow(lines[j])) { rows.push(splitCells(lines[j])); j++ }
      out.push(
        <table className="jc-table" key={`tbl-${i}`}>
          <thead><tr>{header.map((h, hi) => <th key={hi}>{renderInline(h, onNavigate, `th${i}-${hi}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => (
            <tr key={ri}>{header.map((_, ci) => <td key={ci}>{renderInline(r[ci] || '', onNavigate, `td${i}-${ri}-${ci}`)}</td>)}</tr>
          ))}</tbody>
        </table>
      )
      i = j - 1
      continue
    }

    // Blockquote: one or more consecutive `>` lines.
    if (/^>\s?/.test(t)) {
      flush()
      const quote = [t.replace(/^>\s?/, '')]
      let j = i + 1
      while (j < lines.length && /^>\s?/.test(lines[j].trim())) { quote.push(lines[j].trim().replace(/^>\s?/, '')); j++ }
      out.push(<blockquote className="jc-quote" key={`q-${i}`}>{renderJournalLines(quote, onNavigate)}</blockquote>)
      i = j - 1
      continue
    }

    // Checkbox items (bulleted or numbered): - [ ] / 1. [ ] / 1) [x]
    if ((m = t.match(/^(?:[-*+]|\d+[.)])\s*\[([ xX])\]\s*(.+)/))) {
      const done = m[1].toLowerCase() === 'x'
      const idx = ctx ? ctx.n++ : null
      list = list || []
      list.push(<li key={i} {...toggleProps(idx)}><span className={`jc-chip ${done ? 'done' : 'open'}`}>{done ? 'DONE' : 'TODO'}</span>{renderInline(m[2], onNavigate, `c${i}`)}</li>)
      continue
    }
    if ((m = t.match(/^-\s*TODO:\s*(.+)/i))) {
      const idx = ctx ? ctx.n++ : null
      list = list || []
      list.push(<li key={i} {...toggleProps(idx)}><span className="jc-chip open">TODO</span>{renderInline(m[1], onNavigate, `c${i}`)}</li>)
      continue
    }
    if ((m = t.match(/^-\s*DONE:\s*(.+)/i))) {
      const idx = ctx ? ctx.n++ : null
      list = list || []
      list.push(<li key={i} {...toggleProps(idx)}><span className="jc-chip done">DONE</span>{renderInline(m[1], onNavigate, `c${i}`)}</li>)
      continue
    }
    if ((m = t.match(/^[-*+]\s+(.+)/)) || (m = t.match(/^(\d+[.)])\s+(.+)/))) {
      const itemText = m[2] != null ? `${m[1]} ${m[2]}` : m[1]
      list = list || []
      list.push(<li key={i}>{renderInline(itemText, onNavigate, `c${i}`)}</li>)
      continue
    }

    flush()
    if (/^([-*_])\1{2,}$/.test(t)) {
      out.push(<hr className="jc-hr" key={i} />)
      continue
    }
    if ((m = t.match(/^#{2,6}\s+(.+)/))) {
      out.push(<div className="jc-subhead" key={i}>{renderInline(m[1], onNavigate, `h${i}`)}</div>)
      continue
    }
    out.push(<p className="jc-p" key={i}>{renderInline(t, onNavigate, `p${i}`)}</p>)
  }
  flush()
  return out
}

// Append a new "me" message to journal markdown, merging into today's bubble.
function JournalChatView({ content, filePath, onContentUpdate, onNavigate, onOpenSidebar }) {
  const [showRaw, setShowRaw] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [showAttachmentDialog, setShowAttachmentDialog] = useState(false)
  const threadRef = useRef(null)
  const inputRef = useRef(null)
  const parsed = useMemo(() => parseJournalChat(content), [content])
  const taskId = taskIdFromJournalPath(filePath)

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [parsed, showRaw])

  // On mobile, the soft keyboard shrinks the visual viewport. Once it has
  // settled, pull the latest messages and the composer back into view so the
  // user never types behind the keyboard.
  const handleComposerFocus = () => {
    setTimeout(() => {
      if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
      inputRef.current?.scrollIntoView({ block: 'nearest' })
    }, 300)
  }

  const handleSend = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onContentUpdate(appendJournalMessage(content, text))
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const insertIntoDraft = (markdown) => {
    const addition = draft && !/\s$/.test(draft) ? ` ${markdown}` : markdown
    setDraft(draft + addition)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // Toggle the Nth checkbox / TODO / DONE line in the raw markdown. The index
  // matches the order in which toggleable items are rendered (top to bottom),
  // which mirrors the file order since quoted (`>`) items are excluded both
  // here and in the renderer.
  const handleToggleTodo = async (index) => {
    if (index == null || sending) return
    const lines = content.split(/\r?\n/)
    let count = -1
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const t = raw.trim()
      if (/^>/.test(t)) continue
      let next = null
      if (/^(?:[-*+]|\d+[.)])\s*\[([ xX])\]\s*(.+)/.test(t)) {
        next = raw.replace(/\[([ xX])\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'))
      } else if (/^-\s*TODO:\s*(.+)/i.test(t)) {
        next = raw.replace(/(-\s*)TODO(\s*:)/i, '$1DONE$2')
      } else if (/^-\s*DONE:\s*(.+)/i.test(t)) {
        next = raw.replace(/(-\s*)DONE(\s*:)/i, '$1TODO$2')
      } else {
        continue
      }
      count++
      if (count === index) {
        lines[i] = next
        setSending(true)
        try {
          await onContentUpdate(lines.join('\n'))
        } finally {
          setSending(false)
        }
        return
      }
    }
  }

  if (showRaw) {
    return (
      <MarkdownView
        content={content}
        filePath={filePath}
        onContentUpdate={onContentUpdate}
        onNavigate={onNavigate}
        headerExtra={<button className="jc-toggle-btn" onClick={() => setShowRaw(false)}>💬 Chat</button>}
      />
    )
  }

  const fileName = filePath.split(/[/\\]/).pop()
  const title = parsed.title || fileName

  // When a journal has dated/authored chat below, undated leading content is
  // shown as a pinned "Earlier notes" card. But when the whole file is undated
  // (the common legacy case), render that content as a normal "me" bubble so it
  // still reads like a chat instead of a lone grey card.
  const hasChat = parsed.groups.length > 0
  const showPinnedCard = hasChat && parsed.pinned.length > 0
  const undatedAsBubble = !hasChat && parsed.pinned.length > 0

  // Shared counter so each toggleable item gets a file-order index. Pinned
  // content sits before the dated groups in the file, so render it first.
  const toggleCtx = { n: 0 }
  const pinnedRendered = parsed.pinned.length
    ? renderJournalLines(parsed.pinned, onNavigate, handleToggleTodo, toggleCtx)
    : null

  const items = []
  let lastDay = null
  let lastAuthor = null
  parsed.groups.forEach((g, gi) => {
    if (g.day !== lastDay) {
      if (g.day) items.push(<div className="jc-day-divider" key={`d-${gi}`}><span>{formatChatDay(g.day)}</span></div>)
      lastDay = g.day
      lastAuthor = null
    }
    if (g.author === 'agent' && lastAuthor !== 'agent') {
      items.push(
        <div className="jc-agent-banner" key={`ab-${gi}`}><span>🤖 {g.agent || 'agent'}</span></div>
      )
    }
    const side = g.author === 'me' ? 'me' : 'agent'
    items.push(
      <div className={`jc-row ${side}`} key={`b-${gi}`}>
        <div className="jc-bubble">{renderJournalLines(g.lines, onNavigate, handleToggleTodo, toggleCtx)}</div>
      </div>
    )
    lastAuthor = g.author
  })

  return (
    <div className="journal-chat-view">
      <div className="jc-appbar">
        {onOpenSidebar && (
          <button className="jc-appbar-menu" onClick={onOpenSidebar} title="Open file menu" aria-label="Open file menu">☰</button>
        )}
        <button className="jc-appbar-back" onClick={() => onNavigate(PLAN_FILE)} title="Back to Focus Plan" aria-label="Back to Focus Plan">‹</button>
        <div className="jc-avatar" aria-hidden="true">📔</div>
        <div className="jc-appbar-id">
          <div className="jc-appbar-title" title={title}>{title}</div>
          <div className="jc-appbar-sub">Notes to self</div>
        </div>
        <button className="jc-toggle-btn" onClick={() => setShowRaw(true)} title="Edit raw markdown">✎ Raw</button>
      </div>

      <div className="jc-thread" ref={threadRef}>
        {showPinnedCard && (
          <div className="jc-pin">
            <span className="jc-pin-label">📌 Pinned</span>
            <div className="jc-pin-body">{pinnedRendered}</div>
          </div>
        )}

        {undatedAsBubble && (
          <div className="jc-row me">
            <div className="jc-bubble jc-bubble-wide">{pinnedRendered}</div>
          </div>
        )}

        {items.length === 0 && parsed.pinned.length === 0 && (
          <div className="jc-empty">No messages yet. Say something below 👇</div>
        )}

        {items}
      </div>

      <div className="jc-composer">
        <button
          type="button"
          className="jc-attach-btn"
          onClick={() => setShowAttachmentDialog(true)}
          title="Attach file or link"
          aria-label="Attach file or link"
        >
          📎
        </button>
        <textarea
          ref={inputRef}
          className="jc-composer-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleComposerFocus}
          placeholder="Message yourself…  (Enter to send, Shift+Enter for newline)"
          rows={1}
        />
        <button className="jc-send-btn" onClick={handleSend} disabled={!draft.trim() || sending}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
      {showAttachmentDialog && (
        <AttachmentDialog
          taskId={taskId}
          onInsert={insertIntoDraft}
          onClose={() => setShowAttachmentDialog(false)}
        />
      )}
    </div>
  )
}

// Markdown Editor View component
function MarkdownView({ content, filePath, onContentUpdate, onNavigate, headerExtra }) {
  const [editedContent, setEditedContent] = useState(content)
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef(null)
  
  // Update local state when content prop changes
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setEditedContent(content)
      setIsDirty(false)
    })
    return () => { cancelled = true }
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
          onClick={() => onNavigate(PLAN_FILE)}
          title="Back to Focus Plan"
        >
          ← Focus Plan
        </button>
        <h1>{filePath.split(/[/\\]/).pop()}</h1>
        <div className="editor-status">
          {headerExtra}
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
function withDeletedIdTombstones(ids) {
  return new Set([
    ...(ids instanceof Set ? ids : []),
    ...getActiveTombstoneIds(),
  ])
}

// Get max task ID from journal filenames
async function getJournalIds() {
  try {
    return withDeletedIdTombstones(await storage.journalIds())
  } catch {
    return withDeletedIdTombstones(new Set())
  }
}

async function ensureUniqueIds(content, updateFile) {
  const lines = content.split(/\r?\n/)  // Handle both Unix and Windows line endings
  let maxId = 0
  const linesToUpdate = []
  
  // Existing journal IDs are only a collision-skip set (see allocateNextId);
  // numbering is driven by the planner's own rows, so a stray/foreign high
  // journal ID can't inflate it.
  const journalIds = await getJournalIds()
  
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
      while (journalIds.has(maxId)) maxId++
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

/**
 * SELF_HEAL_IDS (temporary defence-in-depth).
 *
 * After load, renumber any "runaway" outlier task IDs (e.g. a stray 426xxx
 * cluster that arrived via sync) back into the planner's own sequence, and
 * rename the matching journal files. Idempotent and a no-op for a healthy
 * planner. Delete this function, its import, selfHealIds.js, and the call site
 * once every device has loaded once.
 */
async function selfHealRunawayIds(content, updateFile) {
  const journalIds = await getJournalIds()
  const { content: healed, idMap, changed } = selfHealOutlierIds(content, { journalIds })
  if (!changed) return content

  await updateFile(healed)

  // Rename + retitle each renamed task's journal (best-effort).
  for (const [oldId, newId] of idMap) {
    const fromPath = `journal/task-${oldId}.md`
    const toPath = `journal/task-${newId}.md`
    try {
      const jc = await storage.read(fromPath)
      if (typeof jc === 'string') {
        await storage.write(toPath, jc.replace(/^# Task \d+:/, `# Task ${newId}:`))
        await storage.remove(fromPath)
      }
    } catch { /* no journal for this task — fine */ }
  }
  return healed
}

const PROVIDER_ICONS = {
  [PROVIDERS.LOCAL_STORAGE]: '🗂️',
  [PROVIDERS.FSA]: '💾',
  [PROVIDERS.ONEDRIVE]: '☁️',
  [PROVIDERS.GOOGLE_DRIVE]: '🌐',
}

const SYNC_LABELS = {
  [TARGET_STATUS.DISCONNECTED]: 'Not backed up',
  [TARGET_STATUS.PENDING]: 'Waiting to back up',
  [TARGET_STATUS.SYNCING]: 'Backing up...',
  [TARGET_STATUS.SYNCED]: 'Backed up just now',
  [TARGET_STATUS.RECONNECT_NEEDED]: 'Sign in again to continue backup',
  [TARGET_STATUS.ERROR]: 'Backup failed - try again',
}

// Compact labels for the always-visible board-header sync pill (#333). The
// mobile ☰ Files button (#274) folds sync state in and hides the synced case
// ("no news is good news"); the board pill instead shows every state — including
// a calm green "Backed up" — so desktop users get an at-a-glance backup status
// without opening Settings.
const SYNC_SHORT = {
  [TARGET_STATUS.DISCONNECTED]: 'Not backed up',
  [TARGET_STATUS.PENDING]: 'Pending',
  [TARGET_STATUS.SYNCING]: 'Backing up…',
  [TARGET_STATUS.SYNCED]: 'Backed up',
  [TARGET_STATUS.RECONNECT_NEEDED]: 'Reconnect',
  [TARGET_STATUS.ERROR]: 'Sync error',
}

function SyncIndicator({ syncStatus }) {
  const aggregate = syncStatus?.aggregate ?? TARGET_STATUS.DISCONNECTED
  // "Not backed up" (disconnected) is not actionable, so we show nothing for it
  // — same "no news is good news" rule as the synced state (task #336).
  if (aggregate === TARGET_STATUS.DISCONNECTED) return null
  const syncClass = aggregate.replace(/[^a-z-]/g, '')
  const fullLabel = SYNC_LABELS[aggregate] || 'Sync status'
  return (
    <div
      className={`board-sync sync-${syncClass}`}
      role="status"
      aria-label={fullLabel}
      title={fullLabel}
    >
      <span className={`sync-dot ${syncClass}`} aria-hidden="true" />
      <span className="board-sync-text">{SYNC_SHORT[aggregate] || 'Sync'}</span>
    </div>
  )
}

function TourModal({ onClose }) {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={e => e.stopPropagation()}>
        <div className="settings-dialog-header">
          <h3>Welcome to {APP_NAME} 👋</h3>
          <button className="settings-dialog-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-dialog-section">
          <ul className="tour-list">
            <li><strong>Today &amp; Deferred</strong> — your top plan lives in <code>{PLAN_FILE}</code>. Add tasks with the <strong>+</strong> button; right-click to defer or complete.</li>
            <li><strong>Priorities</strong> — pin top-of-mind themes in the <em>Priorities</em> section so tasks can be tagged against them.</li>
            <li><strong>Journals</strong> — every task with a journal entry expands to show its TODO / DONE bullets inline.</li>
            <li><strong>Sources</strong> — open <em>Settings</em> to add more storage sources (e.g. a Work folder + a Personal folder). With multiple sources, a ✨ <strong>Combined</strong> view appears at the top.</li>
            <li><strong>Sync</strong> — your data is stored in the browser first, then backed up to OneDrive in the background.</li>
          </ul>
        </div>
        <div className="settings-dialog-section">
          <button className="storage-footer-btn" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  )
}

function targetStatus(syncStatus, targetId) {
  return syncStatus?.folders?.[storage.getLocalFolderId()]?.targets?.[targetId] ?? {
    status: TARGET_STATUS.DISCONNECTED,
    message: '',
  }
}

// A source is "empty" when it has no journal entries and no task rows in
// focus-plan.md / focus-plan-completed.md. Scaffold-only counts as empty so
// users can clean up storage they never actually used. Returns true on any
// read failure so we never block deletion if the source is unreachable.
async function isSourceEmpty(provider) {
  try {
    const plan = (await provider.read(PLAN_FILE).catch(() => '')) || ''
    const completed = (await provider.read(COMPLETED_FILE).catch(() => '')) || ''
    const planRows = countTaskRows(plan)
    const completedRows = countTaskRows(completed)
    if (planRows + completedRows > 0) return false
    // Look for any journal/* entries via the provider's tree.
    const tree = await provider.getFiles?.().catch(() => null)
    if (!tree) return true
    return !treeHasJournals(tree)
  } catch {
    return true
  }
}

// A "task row" is a markdown table data row that starts with a numeric ID
// column — i.e. "| 123 | ..." — which is the shape every focus-plan task and
// completed-task entry uses.
function countTaskRows(md) {
  if (!md) return 0
  let n = 0
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*\|\s*\d/.test(line)) n++
  }
  return n
}

function treeHasJournals(items) {
  for (const item of items || []) {
    if (item.type === 'directory' && item.name === 'journal') {
      // Any file inside the journal directory counts.
      if ((item.children || []).some(c => c.type === 'file')) return true
    } else if (item.type === 'directory' && item.children) {
      if (treeHasJournals(item.children)) return true
    }
  }
  return false
}

// Flatten a provider file tree ({name,type,path,children}) into a sorted list
// of plain file entries ({ path, name }) for the Settings file manager.
function flattenTree(items, acc = []) {
  for (const item of items || []) {
    if (item.type === 'directory') {
      flattenTree(item.children, acc)
    } else if (item.type === 'file') {
      acc.push({ path: item.path, name: item.name })
    }
  }
  return acc
}

function backupActionLabel(providerStatus, disconnectedLabel = 'Sign in') {
  if (providerStatus === TARGET_STATUS.RECONNECT_NEEDED) return 'Sign in again'
  if (providerStatus === TARGET_STATUS.DISCONNECTED) return disconnectedLabel
  return 'Sync now'
}

function StorageFooter({ syncStatus, failedSourceIds = new Set(), onDataChanged }) {
  const [open, setOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [emptySources, setEmptySources] = useState({}) // sourceId -> boolean
  const [removeConfirm, setRemoveConfirm] = useState(null) // { sourceId, name }
  // File manager (Settings → Files): browse + delete files in the active source.
  const [filesOpen, setFilesOpen] = useState(false)
  const [fileList, setFileList] = useState(null) // null = not loaded yet; [] = empty
  const [filesBusy, setFilesBusy] = useState(false)
  const [filesError, setFilesError] = useState('')
  const [deletingPath, setDeletingPath] = useState(null)
  // Mission statement editor (Settings → Mission).
  const [mission, setMissionInput] = useState(getMissionStatement())
  useEffect(() => subscribeMissionStatement(setMissionInput), [])
  // AI agent settings editor (Settings → AI). Reads/writes user-settings.md in
  // the active source — the same file the overnight-agent plugin reads.
  const [aiText, setAiText] = useState(null)      // null = not loaded; string = file content ('' if empty)
  const [aiLoaded, setAiLoaded] = useState(false)
  const [aiExists, setAiExists] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMsg, setAiMsg] = useState('')
  // App update (force latest service worker — fixes "stale build on mobile").
  const [updating, setUpdating] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')
  const oneDrive = targetStatus(syncStatus, PROVIDERS.ONEDRIVE)
  const aggregate = syncStatus?.aggregate ?? TARGET_STATUS.DISCONNECTED
  const syncClass = aggregate.replace(/[^a-z-]/g, '')

  const sources = getSources()
  const activeId = getActiveSourceId()
  const isMulti = sources.length > 1
  const activePrimary = getActiveSource()?.providerType ?? PROVIDERS.LOCAL_STORAGE
  const fsaSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window
  const localStorageSource = sources.find(s => s.providerType === PROVIDERS.LOCAL_STORAGE)
  const fsaSources = sources.filter(s => s.providerType === PROVIDERS.FSA)

  // Probe each non-active source's emptiness when the dialog opens so we can
  // show a Remove button on truly empty sources. "Empty" means no task rows in
  // focus-plan.md and no journal files.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      const next = {}
      for (const s of sources) {
        if (s.id === activeId) continue
        try {
          const p = getProvider(s.id)
          if (!p) continue
          // Cloud sources are backup targets, not removable here
          if (s.providerType !== PROVIDERS.LOCAL_STORAGE && s.providerType !== PROVIDERS.FSA) continue
          next[s.id] = await isSourceEmpty(p)
        } catch {
          next[s.id] = false
        }
      }
      if (!cancelled) setEmptySources(next)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId, sources.length])

  const close = () => { setOpen(false); setError(''); setRemoveConfirm(null) }

  // Load user-settings.md from the active source when the dialog opens or the
  // active source changes. null content -> file doesn't exist yet.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setAiLoaded(false)
    setAiMsg('')
    ;(async () => {
      try {
        const raw = await storage.read(AI_SETTINGS_FILE)
        if (cancelled) return
        setAiExists(raw != null)
        setAiText(raw != null ? raw : '')
      } catch {
        if (cancelled) return
        setAiExists(false)
        setAiText('')
      } finally {
        if (!cancelled) setAiLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [open, activeId])

  const seedAiSettings = async () => {
    setAiBusy(true)
    setAiMsg('')
    try {
      await storage.write(AI_SETTINGS_FILE, AI_SETTINGS_TEMPLATE)
      setAiText(AI_SETTINGS_TEMPLATE)
      setAiExists(true)
      setAiMsg('Created — fill in your values and save.')
    } catch (e) {
      setAiMsg(`Couldn't create the file: ${e?.message || e}`)
    } finally {
      setAiBusy(false)
    }
  }

  const saveAiSettings = async () => {
    setAiBusy(true)
    setAiMsg('')
    try {
      await storage.write(AI_SETTINGS_FILE, aiText ?? '')
      setAiExists(true)
      setAiMsg('Saved.')
    } catch (e) {
      setAiMsg(`Couldn't save: ${e?.message || e}`)
    } finally {
      setAiBusy(false)
    }
  }

  const askRemoveSource = (sourceId, name, isCloud = false, isFolder = false) => {
    setError('')
    setRemoveConfirm({ sourceId, name, isCloud, isFolder })
  }

  const confirmRemoveSource = async () => {
    if (!removeConfirm) return
    setBusy(true)
    try {
      await removeSource(removeConfirm.sourceId)
      setRemoveConfirm(null)
      // Reload so the file tree, active provider, and sources state all settle.
      window.location.reload()
    } catch (e) {
      setError(e.message || 'Could not remove source')
      setBusy(false)
    }
  }

  const addLocalFolder = async () => {
    setBusy(true)
    setError('')
    let createdId = null
    try {
      const src = addSource({ providerType: PROVIDERS.FSA })
      createdId = src.id
      const p = getProvider(src.id)
      const handle = await p.pick()
      if (!handle) {
        // User cancelled the picker — roll back the orphan source entry.
        await removeSource(src.id)
        setBusy(false)
        return
      }
      renameSource(src.id, handle.name)
      await p.scaffold()
      await setActiveSource(src.id)
      window.location.reload()
    } catch (e) {
      if (createdId) {
        try { await removeSource(createdId) } catch { /* ignore */ }
      }
      if (!e.message?.toLowerCase().includes('aborted')) {
        setError(e.message || 'Could not access folder')
      }
      setBusy(false)
    }
  }

  const changeLocalFolder = async (sourceId) => {
    setBusy(true)
    setError('')
    try {
      const p = getProvider(sourceId)
      const handle = await p.pick()
      if (!handle) { setBusy(false); return }
      renameSource(sourceId, handle.name)
      await p.scaffold()
      if (sourceId !== activeId) await setActiveSource(sourceId)
      window.location.reload()
    } catch (e) {
      if (!e.message?.toLowerCase().includes('aborted')) {
        setError(e.message || 'Could not access folder')
      }
      setBusy(false)
    }
  }

  const selectLocalFolder = async (sourceId) => {
    setBusy(true)
    setError('')
    try {
      const p = getProvider(sourceId)
      // Try restoring the saved handle. If it's gone (e.g. permission cleared),
      // fall back to a fresh pick so the user can re-grant access.
      const restored = await p.restore()
      if (!restored) {
        const handle = await p.pick()
        if (!handle) { setBusy(false); return }
        renameSource(sourceId, handle.name)
      }
      await setActiveSource(sourceId)
      window.location.reload()
    } catch (e) {
      if (!e.message?.toLowerCase().includes('aborted')) {
        setError(e.message || 'Could not switch folder')
      }
      setBusy(false)
    }
  }

  const useBrowserStorage = async () => {
    setBusy(true)
    try {
      const existing = getSources().find(s => s.providerType === PROVIDERS.LOCAL_STORAGE)
      if (existing) {
        await setActiveSource(existing.id)
        window.location.reload()
      }
    } catch (e) {
      setError(e.message || 'Switch failed')
      setBusy(false)
    }
  }

  const connectOneDrive = async () => {
    setError('')
    setBusy(true)
    try {
      const result = await storage.connectSyncTarget(PROVIDERS.ONEDRIVE)
      if (result.redirected) return
      await storage.syncNow(PROVIDERS.ONEDRIVE)
    } catch (e) {
      setError(e.message || 'OneDrive connection failed')
    } finally {
      setBusy(false)
    }
  }

  const syncOneDrive = async () => {
    setError('')
    setBusy(true)
    try {
      await storage.syncNow(PROVIDERS.ONEDRIVE)
    } catch (e) {
      setError(e.message || 'Backup failed')
    } finally {
      setBusy(false)
    }
  }

  const connectGoogleDrive = async () => {
    setError('')
    setBusy(true)
    try {
      const result = await storage.connectSyncTarget(PROVIDERS.GOOGLE_DRIVE)
      if (result.redirected) return
      await storage.syncNow(PROVIDERS.GOOGLE_DRIVE)
    } catch (e) {
      setError(e.message || 'Google Drive connection failed')
    } finally {
      setBusy(false)
    }
  }

  const syncGoogleDrive = async () => {
    setError('')
    setBusy(true)
    try {
      await storage.syncNow(PROVIDERS.GOOGLE_DRIVE)
    } catch (e) {
      setError(e.message || 'Backup failed')
    } finally {
      setBusy(false)
    }
  }

  const disconnectTarget = async (targetId, label) => {
    if (!window.confirm(`Disconnect ${label}? Your local files stay intact; cloud backup will stop until you sign in again.`)) return
    setError('')
    setBusy(true)
    try {
      await storage.disconnectSyncTarget(targetId)
    } catch (e) {
      setError(e.message || 'Disconnect failed')
    } finally {
      setBusy(false)
    }
  }

  const googleDrive = targetStatus(syncStatus, PROVIDERS.GOOGLE_DRIVE)

  // ── Settings → Files: list + delete files in the active source ──────────
  const activeSourceName = getActiveSource()?.name
    || getProviderName(activePrimary)
    || 'this source'

  const loadFileList = async () => {
    setFilesBusy(true)
    setFilesError('')
    try {
      // Browse via the active-provider singleton (storage.getFiles), which is
      // the restored instance the rest of the app uses. Going through
      // getFilesFromSource(activeId) could hand back a fresh, unrestored
      // provider whose folder handle is null (crashes on `.entries()`).
      const tree = await storage.getFiles()
      const flat = flattenTree(tree).sort((a, b) => a.path.localeCompare(b.path))
      setFileList(flat)
    } catch (e) {
      setFilesError(e.message || 'Could not list files')
      setFileList([])
    } finally {
      setFilesBusy(false)
    }
  }

  // Load the file list the first time the Files section is expanded.
  useEffect(() => {
    if (open && filesOpen && fileList === null && !filesBusy) {
      loadFileList()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filesOpen])

  const deleteOneFile = async (path) => {
    setDeletingPath(path)
    setFilesError('')
    try {
      // Route through the active provider (storage.remove → engine) so the
      // deletion is mirrored and the service worker syncs it to any connected
      // cloud backup (OneDrive / Google Drive).
      await storage.remove(path)
      setFileList(prev => (prev || []).filter(f => f.path !== path))
      onDataChanged?.()
    } catch (e) {
      setFilesError(e.message || `Could not delete ${path}`)
    } finally {
      setDeletingPath(null)
    }
  }

  const deleteAllFiles = async () => {
    const all = fileList || []
    if (all.length === 0) return
    if (!window.confirm(
      `Delete all ${all.length} file(s) in ${activeSourceName}? This clears your tasks and journals here and syncs the deletions to connected backups. This cannot be undone.`
    )) return
    setFilesBusy(true)
    setFilesError('')
    try {
      for (const f of all) {
        setDeletingPath(f.path)
        try {
          await storage.remove(f.path)
          setFileList(prev => (prev || []).filter(x => x.path !== f.path))
        } catch (e) {
          setFilesError(e.message || `Could not delete ${f.path}`)
        }
      }
      onDataChanged?.()
    } finally {
      setDeletingPath(null)
      setFilesBusy(false)
    }
  }

  // Force the latest service worker (and assets), then reload. This is the
  // reliable cure for an installed PWA stuck on a stale build.
  const handleUpdateApp = async () => {
    setUpdating(true)
    setUpdateMsg('Checking for updates…')
    try {
      const { updated } = await storage.updateApp()
      setUpdateMsg(updated ? 'Update found — reloading…' : 'Reloading with the latest…')
    } catch {
      setUpdateMsg('Reloading…')
    }
    // Reload regardless: network-first assets refresh when online, and any
    // freshly-activated worker takes control on the new page load.
    setTimeout(() => {
      try { window.location.reload() } catch { /* ignore */ }
    }, 800)
  }

  return (
    <>
      <div className="sidebar-storage-footer">
        <InstallButton
          onOpen={() => setInstallOpen(true)}
          appName={APP_NAME}
          label="Install app"
          className="storage-footer-toggle"
          iconClassName="storage-footer-icon"
          labelClassName="storage-footer-label"
        />
        <button
          className="storage-footer-toggle"
          onClick={() => setTourOpen(true)}
          title={`Take a quick tour of ${APP_NAME}`}
        >
          <span className="storage-footer-icon">📚</span>
          <span className="storage-footer-label">Take a tour</span>
        </button>
        <button
          className="storage-footer-toggle"
          onClick={() => setOpen(true)}
          title="Settings"
        >
          <span className="storage-footer-icon">⚙</span>
          <span className="storage-footer-label">Settings</span>
          {aggregate !== TARGET_STATUS.DISCONNECTED && (
            <span className={`sync-dot ${syncClass}`} title={SYNC_LABELS[aggregate] || 'Sync status'} />
          )}
        </button>
      </div>

      <InstallNudge onOpen={() => setInstallOpen(true)} appName={APP_NAME} />
      <InstallSuccessToast appName={APP_NAME} />
      {installOpen && <InstallModal onClose={() => setInstallOpen(false)} appName={APP_NAME} />}
      {tourOpen && <TourModal onClose={() => setTourOpen(false)} />}

      {open && (
        <div className="dialog-overlay" onClick={close}>
          <div className="settings-dialog" onClick={e => e.stopPropagation()}>
            <div className="settings-dialog-header">
              <h3>Settings</h3>
              <button className="settings-dialog-close" onClick={close}>✕</button>
            </div>

            <div className="settings-dialog-section">
              <div className="settings-dialog-section-title">App version</div>
              <div className="settings-update-row">
                <div className="settings-update-info">
                  <span className="settings-update-build">Build {storage.getBuildId()}</span>
                  <span className="settings-update-hint">
                    On a phone seeing stale data? Update to load the latest sync fixes.
                  </span>
                </div>
                <button
                  className="storage-footer-btn sync-target-action"
                  onClick={handleUpdateApp}
                  disabled={updating}
                  title="Check for a new version and reload"
                >
                  {updating ? 'Updating…' : 'Update app'}
                </button>
              </div>
              {updateMsg && <div className="settings-update-msg">{updateMsg}</div>}
            </div>

            <InstallSettingsSection onOpen={() => setInstallOpen(true)} appName={APP_NAME} />

            <div className="settings-dialog-section">
              <div className="settings-dialog-section-title">Mission</div>
              <div className="settings-mission-hint">
                A short north star, pinned to the top of your board.
              </div>
              <textarea
                className="settings-mission-input"
                rows={2}
                maxLength={200}
                placeholder="e.g. Build calm tools and be present with the people I love."
                value={mission}
                onChange={(e) => {
                  setMissionInput(e.target.value)
                  setMissionStatement(e.target.value)
                }}
              />
            </div>

            <div className="settings-dialog-section">
              <div className="settings-dialog-section-title">AI agent settings</div>
              <div className="settings-mission-hint">
                Config for the overnight agent, saved as <code>{AI_SETTINGS_FILE}</code> in
                your active source (next to <code>{PLAN_FILE}</code>). The agent reads this
                file on every run.
              </div>
              {!aiLoaded ? (
                <div className="settings-update-msg">Loading…</div>
              ) : !aiExists && (aiText === '' || aiText == null) ? (
                <div className="settings-update-row">
                  <div className="settings-update-info">
                    <span className="settings-update-hint">
                      No settings file yet. Create one from a starter template, then fill in your values.
                    </span>
                  </div>
                  <button
                    className="storage-footer-btn sync-target-action"
                    onClick={seedAiSettings}
                    disabled={aiBusy}
                    title={`Create ${AI_SETTINGS_FILE} from a template`}
                  >
                    {aiBusy ? 'Creating…' : 'Create from template'}
                  </button>
                </div>
              ) : (
                <>
                  <textarea
                    className="settings-ai-input"
                    rows={12}
                    spellCheck={false}
                    placeholder={`# Overnight Agent — user settings\n\nFill in your paths, accounts and preferences…`}
                    value={aiText ?? ''}
                    onChange={(e) => { setAiText(e.target.value); if (aiMsg) setAiMsg('') }}
                  />
                  <div className="settings-update-row">
                    <div className="settings-update-info">
                      <span className="settings-update-hint">
                        Keep real paths and email addresses out of any public repo.
                      </span>
                    </div>
                    <button
                      className="storage-footer-btn sync-target-action"
                      onClick={saveAiSettings}
                      disabled={aiBusy}
                      title={`Save ${AI_SETTINGS_FILE}`}
                    >
                      {aiBusy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}
              {aiMsg && <div className="settings-update-msg">{aiMsg}</div>}
            </div>

            {isMulti && (
              <div className="settings-dialog-section">
                <div className="settings-dialog-section-title">Sources</div>
                {sources.map(s => {
                  const icon = PROVIDER_ICONS[s.providerType] || '📁'
                  const isActive = s.id === activeId
                  return (
                    <div key={s.id} className={`storage-footer-source-row${isActive ? ' active' : ''}`}>
                      <span className="storage-footer-source-icon">{icon}</span>
                      <span className="storage-footer-source-name">{s.name}</span>
                      {failedSourceIds.has(s.id) && <span title="Authentication required" style={{color:'#f59e0b'}}>⚠</span>}
                      {isActive && !failedSourceIds.has(s.id) && <span className="storage-footer-source-active">●</span>}
                      {!isActive && (
                        <button
                          className="sync-target-remove"
                          style={{ marginLeft: 'auto' }}
                          onClick={() => askRemoveSource(s.id, s.name, s.providerType === PROVIDERS.ONEDRIVE || s.providerType === PROVIDERS.GOOGLE_DRIVE)}
                          disabled={busy}
                          title={`Remove ${s.name}`}
                          aria-label={`Remove ${s.name}`}
                        >🗑</button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div className="settings-dialog-section">
              <div className="settings-dialog-section-title">Storage</div>

              {/* Browser Storage */}
              <div className={`sync-target-card${activePrimary === PROVIDERS.LOCAL_STORAGE ? ' active-source' : ''}`}>
                <div className="sync-target-main">
                  <span className="sync-target-icon">{PROVIDER_ICONS[PROVIDERS.LOCAL_STORAGE]}</span>
                  <div>
                    <div className="sync-target-name">Browser Storage</div>
                    <div className="sync-target-status">Saves in this browser. Private, fast, works offline.</div>
                  </div>
                </div>
                <div className="sync-target-actions">
                  {activePrimary === PROVIDERS.LOCAL_STORAGE
                    ? <span className="sync-active-badge">● Active</span>
                    : <button className="storage-footer-btn sync-target-action" onClick={useBrowserStorage} disabled={busy}>Use this</button>
                  }
                  {localStorageSource && localStorageSource.id !== activeId && (
                    <button
                      className="sync-target-remove"
                      onClick={() => askRemoveSource(localStorageSource.id, 'Browser Storage')}
                      disabled={busy || !emptySources[localStorageSource.id]}
                      title={emptySources[localStorageSource.id] ? 'Remove Browser Storage' : 'Has data — cannot remove'}
                      aria-label="Remove Browser Storage"
                    >🗑</button>
                  )}
                </div>
              </div>

              {/* Local Folders — one card per FSA source, plus an "Add" affordance */}
              {fsaSupported && fsaSources.map(s => {
                const isActive = s.id === activeId
                const provider = getProvider(s.id)
                const restoredName = provider?.folderName?.() || ''
                const displayName = restoredName || s.name || 'Local Folder'
                return (
                  <div key={s.id} className={`sync-target-card${isActive ? ' active-source' : ''}`}>
                    <div className="sync-target-main">
                      <span className="sync-target-icon">📂</span>
                      <div>
                        <div className="sync-target-name">{displayName}</div>
                        <div className="sync-target-status">
                          {isActive
                            ? 'Active — stored as Markdown in this folder'
                            : 'Local Folder — switch to use'}
                        </div>
                      </div>
                    </div>
                    <div className="sync-target-actions">
                      {isActive
                        ? <span className="sync-active-badge">● Active</span>
                        : <button className="storage-footer-btn sync-target-action" onClick={() => selectLocalFolder(s.id)} disabled={busy}>Use this</button>
                      }
                      <button
                        className="storage-footer-btn sync-target-action"
                        onClick={() => changeLocalFolder(s.id)}
                        disabled={busy}
                        title="Pick a different folder for this source"
                      >
                        Change
                      </button>
                      {isActive && (
                        <button
                          className="storage-footer-btn sync-target-action"
                          onClick={() => askRemoveSource(s.id, displayName, false, true)}
                          disabled={busy}
                          title="Disconnect this folder — your files stay on disk"
                        >
                          Close folder
                        </button>
                      )}
                      {!isActive && (
                        <button
                          className="sync-target-remove"
                          onClick={() => askRemoveSource(s.id, displayName)}
                          disabled={busy || !emptySources[s.id]}
                          title={emptySources[s.id] ? 'Disconnect this folder' : 'Has data — cannot remove'}
                          aria-label={`Remove ${displayName}`}
                        >🗑</button>
                      )}
                    </div>
                  </div>
                )
              })}
              {fsaSupported && (
                <div className="sync-target-card sync-target-add">
                  <div className="sync-target-main">
                    <span className="sync-target-icon">➕</span>
                    <div>
                      <div className="sync-target-name">
                        {fsaSources.length === 0 ? 'Local Folder' : 'Add another local folder'}
                      </div>
                      <div className="sync-target-status">
                        {fsaSources.length === 0
                          ? 'Store in a folder on this device — readable by AI agents.'
                          : 'Connect a second folder (e.g. Work + Personal).'}
                      </div>
                    </div>
                  </div>
                  <div className="sync-target-actions">
                    <button
                      className="storage-footer-btn sync-target-action"
                      onClick={addLocalFolder}
                      disabled={busy}
                    >
                      {busy ? '...' : fsaSources.length === 0 ? 'Choose folder' : 'Add folder'}
                    </button>
                  </div>
                </div>
              )}

              {/* AI agent collapsible */}
              {fsaSupported && (
                <details className="settings-ai-details">
                  <summary>💡 Use with AI agents</summary>
                  <div className="settings-ai-callout-body">
                    A local folder stores plain Markdown — any AI tool can read and write your files directly:
                    <ul>
                      <li>Ask Copilot, Claude, or ChatGPT to summarise your week</li>
                      <li>Use Cursor or any AI editor to bulk-edit journals</li>
                      <li>Write scripts or shell automations to process tasks</li>
                    </ul>
                  </div>
                </details>
              )}
            </div>

            <div className="settings-dialog-section">
              <div
                className="settings-dialog-section-title settings-files-title"
                onClick={() => setFilesOpen(o => !o)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilesOpen(o => !o) } }}
                title="Browse and delete the files stored in the active source"
              >
                <span className={`settings-files-caret${filesOpen ? ' open' : ''}`}>▸</span>
                Files in {activeSourceName}
                {fileList && <span className="settings-files-count">({fileList.length})</span>}
              </div>

              {filesOpen && (
                <div className="settings-files-body">
                  <div className="settings-files-hint">
                    Remove individual files with ✕. Delete everything to fully clear this source.
                    Deletions sync to your connected backups.
                  </div>

                  <div className="settings-files-actions">
                    <button
                      className="storage-footer-btn sync-target-action"
                      onClick={loadFileList}
                      disabled={filesBusy}
                      title="Refresh the file list"
                    >
                      {filesBusy ? 'Loading…' : 'Refresh'}
                    </button>
                    {fileList && fileList.length > 0 && (
                      <button
                        className="storage-footer-btn settings-files-clear"
                        onClick={deleteAllFiles}
                        disabled={filesBusy}
                        title="Delete every file in this source"
                      >
                        Delete all
                      </button>
                    )}
                  </div>

                  {filesError && <div className="storage-footer-error">⚠️ {filesError}</div>}

                  {fileList === null && !filesBusy && (
                    <div className="settings-files-empty">Expand to load files…</div>
                  )}
                  {fileList && fileList.length === 0 && !filesBusy && (
                    <div className="settings-files-empty">No files in this source.</div>
                  )}

                  {fileList && fileList.length > 0 && (
                    <ul className="settings-files-list">
                      {fileList.map(f => (
                        <li key={f.path} className="settings-files-row">
                          <span className="settings-files-path" title={f.path}>{f.path}</span>
                          <button
                            className="settings-files-x"
                            onClick={() => deleteOneFile(f.path)}
                            disabled={deletingPath === f.path || filesBusy}
                            title={`Delete ${f.path}`}
                            aria-label={`Delete ${f.path}`}
                          >
                            {deletingPath === f.path ? '…' : '✕'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="settings-dialog-section">
              <div className="settings-dialog-section-title">Backup & sync</div>
              <div className="sync-target-card">
                <div className="sync-target-main">
                  <span className="sync-target-icon">{PROVIDER_ICONS[PROVIDERS.GOOGLE_DRIVE]}</span>
                  <div>
                    <div className="sync-target-name">Google Drive</div>
                    <div className={`sync-target-status ${googleDrive.status}`}>
                      {SYNC_LABELS[googleDrive.status] || googleDrive.status}
                    </div>
                  </div>
                </div>
                <div className="sync-target-actions">
                  <button
                    className="storage-footer-btn sync-target-action"
                    onClick={googleDrive.status === TARGET_STATUS.DISCONNECTED || googleDrive.status === TARGET_STATUS.RECONNECT_NEEDED ? connectGoogleDrive : syncGoogleDrive}
                    disabled={busy}
                  >
                    {busy ? 'Working...' : backupActionLabel(googleDrive.status)}
                  </button>
                  {googleDrive.status !== TARGET_STATUS.DISCONNECTED && (
                    <button
                      className="sync-target-remove"
                      title="Disconnect Google Drive"
                      onClick={() => disconnectTarget(PROVIDERS.GOOGLE_DRIVE, 'Google Drive')}
                      disabled={busy}
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
              {googleDrive.message && <div className="storage-footer-error">{googleDrive.message}</div>}
              <div className="sync-target-card">
                <div className="sync-target-main">
                  <span className="sync-target-icon">{PROVIDER_ICONS[PROVIDERS.ONEDRIVE]}</span>
                  <div>
                    <div className="sync-target-name">OneDrive</div>
                    <div className={`sync-target-status ${oneDrive.status}`}>
                      {SYNC_LABELS[oneDrive.status] || oneDrive.status}
                    </div>
                  </div>
                </div>
                <div className="sync-target-actions">
                  <button
                    className="storage-footer-btn sync-target-action"
                    onClick={oneDrive.status === TARGET_STATUS.DISCONNECTED || oneDrive.status === TARGET_STATUS.RECONNECT_NEEDED ? connectOneDrive : syncOneDrive}
                    disabled={busy}
                  >
                    {busy ? 'Working...' : backupActionLabel(oneDrive.status)}
                  </button>
                  {oneDrive.status !== TARGET_STATUS.DISCONNECTED && (
                    <button
                      className="sync-target-remove"
                      title="Disconnect OneDrive"
                      onClick={() => disconnectTarget(PROVIDERS.ONEDRIVE, 'OneDrive')}
                      disabled={busy}
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
              {oneDrive.message && <div className="storage-footer-error">{oneDrive.message}</div>}
              <div className="storage-footer-note">
                You can keep using {APP_NAME} without signing in. If you edit offline, backup resumes when you reconnect.
              </div>
            </div>

            {error && <div className="storage-footer-error">⚠️ {error}</div>}
          </div>
        </div>
      )}

      {removeConfirm && (
        <div className="dialog-overlay" onClick={() => !busy && setRemoveConfirm(null)}>
          <div className="settings-dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="settings-dialog-header">
              <h3>{removeConfirm.isFolder ? `Close ${removeConfirm.name}?` : `Remove ${removeConfirm.name}?`}</h3>
              <button className="settings-dialog-close" onClick={() => !busy && setRemoveConfirm(null)} disabled={busy}>✕</button>
            </div>
            <div className="settings-dialog-section">
              <div className="storage-footer-note">
                {removeConfirm.isCloud
                  ? 'Your local data is safe. This removes the cloud connection; you can reconnect any time by signing in again.'
                  : removeConfirm.isFolder
                  ? 'Your files stay on disk — nothing is deleted. The planner disconnects this folder and resets to empty browser storage, like a fresh start. You can re-open the folder any time.'
                  : 'This storage is empty — there are no tasks or journals to lose. You can add it again later.'}
              </div>
              <div className="storage-footer-actions">
                <button className="storage-footer-btn secondary" onClick={() => setRemoveConfirm(null)} disabled={busy}>Cancel</button>
                <button className="storage-footer-btn danger" onClick={confirmRemoveSource} disabled={busy}>
                  {busy
                    ? (removeConfirm.isFolder ? 'Closing…' : 'Removing...')
                    : (removeConfirm.isFolder ? 'Close folder' : 'Remove')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
// Combined Focus Plan view — same UI as FocusPlanView but synthesised
// from every source's focus-plan.md. Each rendered task row remembers
// which source it came from so right-click actions, drag-to-defer, edits
// and deletes can be routed back to the correct source's storage.
//
// Per-source Priorities sections are rendered separately (so numbering
// from different sources doesn't collide); each one is fully editable
// and writes back to its source.
function CombinedFocusPlanView({ sources, onNavigate }) {
  const [perSource, setPerSource] = useState(null) // [{ source, content, sections }]
  const [completedTaskLookup, setCompletedTaskLookup] = useState({})
  const [bridgeDialog, setBridgeDialog] = useState(null)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [addDialog, setAddDialog] = useState(null) // { section }
  const [moveDialog, setMoveDialog] = useState(null)

  // Reload all sources' focus-plan.md content.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const results = await Promise.all(sources.map(async (s) => {
          try {
            const text = await storage.readFromSource(s.id, PLAN_FILE)
            const migrated = migratePrioritiesSections(text) ?? text
            // SELF_HEAL_IDS (temporary): renumber runaway/foreign outlier IDs
            // for this source, writing back + renaming journals if anything changed.
            let healed = migrated
            try {
              const journalIds = withDeletedIdTombstones(await storage.journalIdsFromSource(s.id))
              const res = selfHealOutlierIds(migrated, { journalIds })
              if (res.changed) {
                await storage.writeToSource(s.id, PLAN_FILE, res.content)
                for (const [oldId, newId] of res.idMap) {
                  const fromPath = `journal/task-${oldId}.md`
                  try {
                    const jc = await storage.readFromSource(s.id, fromPath)
                    if (typeof jc === 'string') {
                      await storage.writeToSource(s.id, `journal/task-${newId}.md`, jc.replace(/^# Task \d+:/, `# Task ${newId}:`))
                      await storage.removeFromSource(s.id, fromPath)
                    }
                  } catch { /* no journal — fine */ }
                }
                healed = res.content
              }
            } catch { /* healing is best-effort */ }
            return { source: s, content: healed, sections: parseFocusPlan(healed) }
          } catch {
            return { source: s, content: '', sections: [] }
          }
        }))
        if (!cancelled) setPerSource(results)
      } catch (e) {
        if (!cancelled) setError(e.message || String(e))
      }
    })()
    return () => { cancelled = true }
  }, [sources, reloadKey])

  // Pull completed-task labels from every source so linked-id chains can
  // resolve names that have already been archived.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const merged = {}
      await Promise.all(sources.map(async (s) => {
        try {
          const text = await storage.readFromSource(s.id, COMPLETED_FILE)
          if (!text) return
          const sections = parseFocusPlan(text)
          for (const sec of sections) Object.assign(merged, buildTaskIdLookup(sec.lines))
        } catch { /* ignore */ }
      }))
      if (!cancelled) setCompletedTaskLookup(merged)
    })()
    return () => { cancelled = true }
  }, [sources, reloadKey])

  if (error) return <div className="placeholder"><h1>✨ Combined</h1><p>Failed to load: {error}</p></div>
  if (!perSource) return <div className="placeholder"><h1>✨ Combined</h1><p>Loading…</p></div>

  // ── Build merged tables and source lookup maps ──────────────────────
  // For each task section (Today / Deferred), concatenate the body lines
  // from every source. We keep the original raw rows untouched so:
  //   - Task IDs render exactly as they do in the per-source view.
  //   - Right-click handlers can match by raw line text and route the
  //     write back to the right source.
  //
  // Note: TaskSection works off table-shaped `lines` (header row,
  // separator row, then data rows). We re-emit a fresh header from the
  // first source that provides one so the columns line up.

  const lineToSource = new Map() // rawLine -> sourceId
  const taskIdToSource = new Map() // taskId -> sourceId (for priority operations)

  const buildMergedSection = (title) => {
    let header = null
    let separator = null
    const dataLines = []
    const dataSourceIds = []
    for (const { source, sections } of perSource) {
      const sec = sections.find(s => s.title === title)
      if (!sec) continue
      for (const line of sec.lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('|')) continue
        if (trimmed.includes('---')) {
          if (!separator) separator = line
          continue
        }
        const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
        if (cells.length === 0) continue
        if (cells[0] === 'ID' || cells[0] === '#') {
          if (!header) header = line
          continue
        }
        dataLines.push(line)
        dataSourceIds.push(source.id)
        lineToSource.set(trimmed, source.id)
        const idCell = cells[0]
        const localId = idCell.indexOf(',[') !== -1
          ? idCell.substring(0, idCell.indexOf(',[')).trim()
          : idCell
        if (localId) taskIdToSource.set(localId, source.id)
      }
    }
    if (!header) header = '| ID | 🎯 | Task | Priority | Added | Linked ID |'
    if (!separator) separator = '|---|---|------|----------|-------|-----------|'
    // `sourceIds` is parallel to the data rows (not the header/separator) so the
    // combined view can tag each rendered row with its owning source (#39).
    return { lines: [header, separator, ...dataLines], sourceIds: dataSourceIds }
  }

  const todayMerged = buildMergedSection('Today')
  const deferredMerged = buildMergedSection('Deferred')
  const todaySectionLines = todayMerged.lines
  const todaySourceIds = todayMerged.sourceIds
  const deferredSectionLines = deferredMerged.lines
  const deferredSourceIds = deferredMerged.sourceIds

  // Build merged lookups for resolveManagerPriority / linked tasks.
  // taskLookup is many-to-one (taskId → name). On collision we keep the
  // first source's entry — combined view doesn't try to disambiguate
  // identical IDs across sources (vanishingly rare in practice).
  const currentTaskLookup = {}
  const taskPriorityLookup = {}
  const linkedIdMap = {}
  const adoLookup = {}
  // Per-source task lookups for the Add Task dialog's linked-task search.
  const perSourceTaskLookup = {}
  for (const { source, sections } of perSource) {
    const srcLookup = {}
    for (const sec of sections) {
      if (sec.title !== 'Today' && sec.title !== 'Deferred') continue
      Object.assign(currentTaskLookup, buildTaskIdLookup(sec.lines))
      Object.assign(taskPriorityLookup, buildTaskPriorityLookup(sec.lines))
      Object.assign(srcLookup, buildTaskIdLookup(sec.lines))
      Object.assign(linkedIdMap, buildLinkedIdMap(sec.lines))
      Object.assign(adoLookup, buildAdoLookup(sec.lines))
    }
    perSourceTaskLookup[source.id] = srcLookup
  }
  const taskLookup = { ...completedTaskLookup, ...currentTaskLookup }
  const activeTaskIds = Object.keys(currentTaskLookup)

  // ── Source-routing helpers ──────────────────────────────────────────
  // Each handler below identifies the source from either the raw line
  // text or a task id, reads that source's current content, applies the
  // pure operation from focusPlanOps, and writes back via writeToSource.

  const sourceForLine = (rawLine) => lineToSource.get(rawLine.trim())
  const sourceForTask = (taskId) => taskIdToSource.get(String(taskId))
  // #39: prefer the row's own source tag over the ambiguous text/id lookup so
  // destructive ops route to the correct source when two folders collide.
  const sourceForRow = (row, rawLine) => resolveRowSourceId(row, rawLine, lineToSource)

  const applyOp = async (sourceId, opFn) => {
    if (!sourceId) return
    const text = await storage.readFromSource(sourceId, PLAN_FILE)
    const result = opFn(text)
    const newContent = typeof result === 'string' ? result : result.content
    if (newContent === text) return
    await storage.writeToSource(sourceId, PLAN_FILE, newContent)
    setReloadKey(k => k + 1)
  }

  // ── Today / Deferred handlers ──────────────────────────────────────

  const handleTaskAction = (action, rawLine, fromSection, toSection, sourceIdHint) =>
    applyOp(sourceIdHint || sourceForLine(rawLine), c => ops.opMoveBetweenSections(c, rawLine, fromSection, toSection))

  const handleChangePriority = (rawLine, oldPriority, newPriority, sourceIdHint) =>
    applyOp(sourceIdHint || sourceForLine(rawLine), c => ops.opChangePriority(c, rawLine, oldPriority, newPriority))

  const handleSnoozeTask = (rawLine, snoozeUntil, sourceIdHint) =>
    applyOp(sourceIdHint || sourceForLine(rawLine), c => ops.opSetTaskSnooze(c, rawLine, snoozeUntil))

  const handleRenameTask = (rawLine, newTaskName, sourceIdHint) =>
    applyOp(sourceIdHint || sourceForLine(rawLine), c => ops.opRenameTask(c, rawLine, newTaskName))

  const handleChangeLinkedId = (rawLine, newLinkedId, sourceIdHint) =>
    applyOp(sourceIdHint || sourceForLine(rawLine), c => ops.opChangeLinkedId(c, rawLine, newLinkedId))

  const handleLinkToAdoBugDb = (rawLine, adoLink, sourceIdHint) =>
    applyOp(sourceIdHint || sourceForLine(rawLine), c => ops.opLinkToAdoBugDb(c, rawLine, adoLink))

  const handleDeleteTask = async (rawLine, fromSection, journalPath, taskId, row) => {
    const sid = sourceForRow(row, rawLine)
    if (!sid) return

    // Check for incoming links across ALL sources to bridge
    if (taskId && linkedIdMap) {
      const incoming = []
      for (const [fId, tId] of Object.entries(linkedIdMap)) {
        if (tId === String(taskId)) {
          incoming.push({ fromId: fId, fromName: taskLookup[fId] || '' })
        }
      }
      if (incoming.length > 0) {
        const idCol = row['ID']
        const nextIdRawValue = (typeof idCol === 'object' && idCol.linkedId) ? idCol.linkedId : ''
        const nextIdNum = nextIdRawValue.match(/(\d+)/)?.[1]
        setBridgeDialog({
          incomingLinks: incoming,
          removedTaskName: row['Task'] || `Task ${taskId}`,
          nextTaskId: nextIdNum,
          nextTaskName: nextIdNum ? taskLookup[nextIdNum] : '',
          onConfirm: async () => {
            // Apply bridge to ALL sources because linkers could be anywhere
            await Promise.all(sources.map(async (src) => {
              const text = await storage.readFromSource(src.id, PLAN_FILE)
              const bridged = ops.opBridgeLinks(text, taskId, nextIdRawValue)
              if (bridged !== text) {
                await storage.writeToSource(src.id, PLAN_FILE, bridged)
              }
            }))
            await applyOp(sid, c => ops.opDeleteTask(c, rawLine))
            if (taskId) recordDeletedId(taskId)
            if (journalPath) await storage.removeFromSource(sid, journalPath).catch(() => {})
            setBridgeDialog(null)
            setReloadKey(k => k + 1)
          }
        })
        return
      }
    }

    await applyOp(sid, c => ops.opDeleteTask(c, rawLine))
    if (taskId) recordDeletedId(taskId)
    if (journalPath) {
      try { await storage.removeFromSource(sid, journalPath) } catch (e) { console.error('Failed to delete journal:', e) }
    }
  }

  const handlePromoteTodo = async (todoText, parentTaskId) => {
    // Promote into the same source as the parent task.
    const sid = sourceForTask(parentTaskId) || sources[0]?.id
    if (!sid) return
    const journalIds = withDeletedIdTombstones(await storage.journalIdsFromSource(sid))
    await applyOp(sid, c => ops.opPromoteTodoToTask(c, todoText, parentTaskId, journalIds))
  }

  const handleAdd = async ({ task, priority, linkedTask, section, sourceId }) => {
    if (!sourceId) return
    const journalIds = withDeletedIdTombstones(await storage.journalIdsFromSource(sourceId))
    await applyOp(sourceId, c => ops.opAddTask(c, { task, priority, linkedTask, section }, journalIds))
  }

  const handleCreateJournal = async (taskId, taskName) => {
    const sid = sourceForTask(taskId)
    if (!sid) return
    const cleanName = (taskName || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
    const journalPath = `journal/task-${taskId}.md`
    try {
      await storage.writeToSource(sid, journalPath, `# Task ${taskId}: ${cleanName}\n\n- TODO: \n`)
      onNavigate(journalPath)
    } catch (e) {
      console.error('Failed to create journal:', e)
    }
  }

  const handleMoveToCompleted = async (rawLine, row, fromSection) => {
    const sid = sourceForRow(row, rawLine)
    if (!sid) return
    const taskId = extractTaskId(row)

    // Check for incoming links across ALL sources to bridge
    if (taskId && linkedIdMap) {
      const incoming = []
      for (const [fId, tId] of Object.entries(linkedIdMap)) {
        if (tId === String(taskId)) {
          incoming.push({ fromId: fId, fromName: taskLookup[fId] || '' })
        }
      }
      if (incoming.length > 0) {
        const idCol = row['ID']
        const nextIdRawValue = (typeof idCol === 'object' && idCol.linkedId) ? idCol.linkedId : ''
        const nextIdNum = nextIdRawValue.match(/(\d+)/)?.[1]
        setBridgeDialog({
          incomingLinks: incoming,
          removedTaskName: row['Task'] || `Task ${taskId}`,
          nextTaskId: nextIdNum,
          nextTaskName: nextIdNum ? taskLookup[nextIdNum] : '',
          onConfirm: async () => {
            // Apply bridge to ALL sources because linkers could be anywhere
            await Promise.all(sources.map(async (src) => {
              const text = await storage.readFromSource(src.id, PLAN_FILE)
              const bridged = ops.opBridgeLinks(text, taskId, nextIdRawValue)
              if (bridged !== text) {
                await storage.writeToSource(src.id, PLAN_FILE, bridged)
              }
            }))
            setBridgeDialog(null)
            await performMoveToCompletedCombined(rawLine, row, fromSection, sid)
          }
        })
        return
      }
    }
    await performMoveToCompletedCombined(rawLine, row, fromSection, sid)
  }

  const performMoveToCompletedCombined = async (rawLine, row, fromSection, sid) => {
    const taskId = extractTaskId(row)
    const taskName = row['Task'] || ''
    const priority = row['Work Priority'] || row['Mngr Priority'] || row['Priority'] || '-'
    let todoItems = []
    if (taskId) {
      try {
        const j = await storage.checkJournalFromSource(sid, taskId)
        if (j.exists) {
          const todos = await storage.getTodosFromSource(sid, j.path)
          todoItems = todos.map(t => t.text)
        }
      } catch (e) { console.error('Failed to fetch journal todos:', e) }
    }
    const completedRow = ops.buildCompletedRow({ taskId, taskName, priority, todoItems })
    // Write the focus-plan deletion and the completed-plan append in
    // sequence against the same source.
    const focusText = await storage.readFromSource(sid, PLAN_FILE)
    const newFocus = ops.opRemoveTaskFromFocusPlan(focusText, rawLine, fromSection)
    let completedText = ''
    try { completedText = await storage.readFromSource(sid, COMPLETED_FILE) } catch { /* file may not exist */ }
    const newCompleted = ops.opAppendToCompleted(completedText, completedRow)
    await storage.writeToSource(sid, COMPLETED_FILE, newCompleted)
    await storage.writeToSource(sid, PLAN_FILE, newFocus)
    setReloadKey(k => k + 1)
  }

  // Right-click → "Move to {source}" works the same as in FocusPlanView,
  // except that the "from" source is determined by the row's source map
  // rather than the active provider.
  const findRawLineForTaskIdInSource = (sourceId, id) => {
    const entry = perSource.find(p => p.source.id === sourceId)
    if (!entry) return null
    for (const sec of entry.sections) {
      if (sec.title !== 'Today' && sec.title !== 'Deferred') continue
      for (const line of sec.lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('|')) continue
        const cells = trimmed.split('|').slice(1, -1).map(c => c.trim())
        if (cells.length === 0) continue
        const idCell = cells[0]
        const localId = idCell.indexOf(',[') !== -1
          ? idCell.substring(0, idCell.indexOf(',['))
          : idCell
        if (localId === String(id)) return { rawLine: trimmed, sectionTitle: sec.title }
      }
    }
    return null
  }

  const handleMoveToSource = (rawLine, row, taskId, targetSourceId, explicitFromSourceId = null) => {
    if (!targetSourceId || !taskId) return
    const fromSourceId = explicitFromSourceId || sourceForRow(row, rawLine)
    if (!fromSourceId || fromSourceId === targetSourceId) return
    const target = sources.find(s => s.id === targetSourceId)
    if (!target) return
    const fromEntry = perSource.find(p => p.source.id === fromSourceId)
    if (!fromEntry) return
    const fromManagerPriorities = (() => {
      const sec = fromEntry.sections.find(s => isPrioritiesSection(s.title))
      return sec ? parseManagerPriorities(sec.lines) : {}
    })()
    const fromLinkedMap = {}
    const fromActiveIds = []
    for (const sec of fromEntry.sections) {
      if (sec.title !== 'Today' && sec.title !== 'Deferred') continue
      Object.assign(fromLinkedMap, buildLinkedIdMap(sec.lines))
      fromActiveIds.push(...Object.keys(buildTaskIdLookup(sec.lines)))
    }
    const moveSet = computeMoveSet(taskId, fromManagerPriorities, fromLinkedMap, fromActiveIds)
    const movingTasks = [...moveSet].map(id => ({
      id,
      name: taskLookup[id] || (id === taskId ? (row['Task'] || '') : ''),
      isPriority: !!fromManagerPriorities[id],
    }))
    const brokenLinks = computeBrokenLinks(moveSet, fromLinkedMap, taskLookup)
    setMoveDialog({ target, fromSourceId, taskId, rawLine, movingTasks, brokenLinks })
  }

  const performMoveToSource = async ({ target, fromSourceId, movingTasks }) => {
    const fromEntry = perSource.find(p => p.source.id === fromSourceId)
    if (!fromEntry) return
    const movingIds = new Set(movingTasks.map(t => t.id))
    const movingRows = []
    for (const t of movingTasks) {
      const found = findRawLineForTaskIdInSource(fromSourceId, t.id)
      if (found) movingRows.push({ ...found, taskId: t.id })
    }
    if (movingRows.length === 0) return

    const removalSet = new Set(movingRows.map(r => r.rawLine))
    const fromLines = fromEntry.content.split('\n')
    let inPriorities = false
    const newFromLines = []
    for (const line of fromLines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('## ')) {
        inPriorities = isPrioritiesSection(trimmed.replace(/^##\s+/, ''))
        newFromLines.push(line)
        continue
      }
      if (removalSet.has(trimmed)) continue
      if (inPriorities) {
        const m = trimmed.match(/^\d+\.\s+(.+)$/)
        if (m && movingIds.has(m[1].trim())) continue
      }
      newFromLines.push(line)
    }
    // Renumber
    const renumbered = []
    let pInside = false
    let pIdx = 1
    for (const line of newFromLines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('## ')) {
        pInside = isPrioritiesSection(trimmed.replace(/^##\s+/, ''))
        if (pInside) pIdx = 1
        renumbered.push(line)
        continue
      }
      if (pInside) {
        const m = line.match(/^(\s*)\d+\.\s+(.+)$/)
        if (m) { renumbered.push(`${m[1]}${pIdx++}. ${m[2]}`); continue }
      }
      renumbered.push(line)
    }

    // Build target content
    let targetContent = ''
    try { targetContent = await storage.readFromSource(target.id, PLAN_FILE) }
    catch {
      targetContent = '# Focus Plan\n\n## Today\n\n| ID | 🎯 | Task | Priority | Added | Linked ID |\n|---|---|------|----------|-------|-----------|\n\n## Deferred\n\n| ID | 🎯 | Task | Priority | Added | Linked ID |\n|---|---|------|----------|-------|-----------|\n'
    }
    const tLines = targetContent.split('\n')
    // Renumber moving tasks into the target's own sequence (no foreign IDs).
    const targetBase = maxTaskIdInRows(targetContent)
    const targetJournalIds = withDeletedIdTombstones(await storage.journalIdsFromSource(target.id))
    const { idMap, rows: renumberedRows } = renumberMovedRows(movingRows, targetBase, targetJournalIds)
    let inToday = false
    let todayInsertIdx = -1
    for (let i = 0; i < tLines.length; i++) {
      const trimmed = tLines[i].trim()
      if (trimmed.startsWith('## ')) {
        inToday = trimmed.replace(/^##\s+/, '') === 'Today'
        continue
      }
      if (inToday && trimmed.startsWith('|') && trimmed.includes('---')) {
        todayInsertIdx = i + 1
        break
      }
    }
    if (todayInsertIdx === -1) {
      tLines.push('', '## Today', '', '| ID | 🎯 | Task | Priority | Added | Linked ID |', '|---|---|------|----------|-------|-----------|')
      todayInsertIdx = tLines.length
    }
    tLines.splice(todayInsertIdx, 0, ...renumberedRows.map(r => r.newRawLine))

    const priorityIdsMoving = movingTasks.filter(t => t.isPriority).map(t => idMap.get(String(t.id)) || String(t.id))
    if (priorityIdsMoving.length > 0) {
      let pStart = -1
      let pEnd = tLines.length
      for (let i = 0; i < tLines.length; i++) {
        const trimmed = tLines[i].trim()
        if (trimmed.startsWith('## ') && isPrioritiesSection(trimmed.replace(/^##\s+/, ''))) pStart = i
        else if (pStart !== -1 && trimmed.startsWith('## ')) { pEnd = i; break }
      }
      if (pStart === -1) {
        tLines.push('', '## Priorities', '')
        pStart = tLines.length - 2
        pEnd = tLines.length
      }
      let maxNum = 0
      for (let i = pStart + 1; i < pEnd; i++) {
        const m = tLines[i].trim().match(/^(\d+)\.\s+/)
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10))
      }
      const newEntries = priorityIdsMoving.map((id, i) => `${maxNum + i + 1}. ${id}`)
      let insertAt = pEnd
      while (insertAt > pStart + 1 && tLines[insertAt - 1].trim() === '') insertAt--
      tLines.splice(insertAt, 0, ...newEntries)
    }

    // Move journals — renumber filename + title to the new target ID.
    for (const r of renumberedRows) {
      const fromPath = `journal/task-${r.oldId}.md`
      const toPath = `journal/task-${r.newId}.md`
      try {
        const journalContent = await storage.readFromSource(fromSourceId, fromPath)
        if (typeof journalContent === 'string' && journalContent.length > 0) {
          await storage.writeToSource(target.id, toPath, retitleJournal(journalContent, r.newId))
          await storage.removeFromSource(fromSourceId, fromPath)
        }
      } catch { /* no journal — skip */ }
    }

    await storage.writeToSource(target.id, PLAN_FILE, tLines.join('\n'))
    await storage.writeToSource(fromSourceId, PLAN_FILE, renumbered.join('\n'))
    setReloadKey(k => k + 1)
  }

  // ── Per-source priorities ──────────────────────────────────────────
  // For each source we render its own ManagerPrioritiesSection so
  // numbering stays scoped to that source. Edits write back to the
  // source via the same op functions FocusPlanView would use.

  const buildPriorityHandlers = (sourceId) => ({
    onUpdate: (newLines) =>
      applyOp(sourceId, c => ops.opUpdateManagerPriorities(c, newLines)),
    onAddAndPrioritize: async (taskName, prioritySectionTitle) => {
      const journalIds = withDeletedIdTombstones(await storage.journalIdsFromSource(sourceId))
      await applyOp(sourceId, c => ops.opAddAndPrioritize(c, taskName, prioritySectionTitle, journalIds))
    },
    onPromoteToManagerPriority: (taskId) =>
      applyOp(sourceId, c => ops.opPromoteToManagerPriority(c, taskId)),
    onRemoveFromManagerPriority: (taskId) =>
      applyOp(sourceId, c => ops.opRemoveFromManagerPriority(c, taskId)),
  })

  // Expose promote/remove to the right-click menu by routing the task id
  // back to its owning source.
  const handlePromoteToManagerPriority = (taskId) => {
    const sid = sourceForTask(taskId)
    if (!sid) return
    return buildPriorityHandlers(sid).onPromoteToManagerPriority(taskId)
  }
  const handleRemoveFromManagerPriority = (taskId) => {
    const sid = sourceForTask(taskId)
    if (!sid) return
    return buildPriorityHandlers(sid).onRemoveFromManagerPriority(taskId)
  }

  // ── Render ──────────────────────────────────────────────────────────

  const scrollToPriorities = () => {
    const el = document.querySelector('[id^="combined-priorities-"]')
    if (el) el.scrollIntoView({ behavior: 'smooth' })
  }

  // Aggregate manager priorities across all sources for sort/colour
  // hints in TaskSection. Entries from different sources don't collide
  // unless task IDs do — same caveat as taskLookup above.
  const managerPriorities = {}
  for (const { sections } of perSource) {
    const sec = sections.find(s => isPrioritiesSection(s.title))
    if (sec) Object.assign(managerPriorities, parseManagerPriorities(sec.lines))
  }

  return (
    <div className="focus-plan-view combined-view">
      <h1>✨ Combined Focus Plan</h1>

      <TaskSection
        title="Today"
        tableLines={todaySectionLines}
        lineSourceIds={todaySourceIds}
        onNavigate={onNavigate}
        defaultOpen={true}
        managerPriorities={managerPriorities}
        onScrollToPriorities={scrollToPriorities}
        onTaskAction={handleTaskAction}
        onMoveToCompleted={handleMoveToCompleted}
        onAddClick={() => setAddDialog({ section: 'Today' })}
        onCreateJournal={handleCreateJournal}
        onChangePriority={handleChangePriority}
        onSnoozeTask={handleSnoozeTask}
        onDeleteTask={handleDeleteTask}
        onPromoteTodo={handlePromoteTodo}
        onRenameTask={handleRenameTask}
        onChangeLinkedId={handleChangeLinkedId}
        onLinkToAdoBugDb={handleLinkToAdoBugDb}
        taskLookup={taskLookup}
        taskPriorityLookup={taskPriorityLookup}
        activeTaskIds={activeTaskIds}
        linkedIdMap={linkedIdMap}
        adoLookup={adoLookup}
        onPromoteToManagerPriority={handlePromoteToManagerPriority}
        onRemoveFromManagerPriority={handleRemoveFromManagerPriority}
        otherSources={sources}
        onMoveToSource={handleMoveToSource}
      />

      <TaskSection
        title="Deferred"
        tableLines={deferredSectionLines}
        lineSourceIds={deferredSourceIds}
        onNavigate={onNavigate}
        defaultOpen={false}
        managerPriorities={managerPriorities}
        onScrollToPriorities={scrollToPriorities}
        onTaskAction={handleTaskAction}
        onMoveToCompleted={handleMoveToCompleted}
        onAddClick={() => setAddDialog({ section: 'Deferred' })}
        onCreateJournal={handleCreateJournal}
        onChangePriority={handleChangePriority}
        onSnoozeTask={handleSnoozeTask}
        onDeleteTask={handleDeleteTask}
        onPromoteTodo={handlePromoteTodo}
        onRenameTask={handleRenameTask}
        onChangeLinkedId={handleChangeLinkedId}
        onLinkToAdoBugDb={handleLinkToAdoBugDb}
        taskLookup={taskLookup}
        taskPriorityLookup={taskPriorityLookup}
        activeTaskIds={activeTaskIds}
        linkedIdMap={linkedIdMap}
        adoLookup={adoLookup}
        onPromoteToManagerPriority={handlePromoteToManagerPriority}
        onRemoveFromManagerPriority={handleRemoveFromManagerPriority}
        otherSources={sources}
        onMoveToSource={handleMoveToSource}
      />

      {perSource.map(({ source, sections }) => {
        const pri = sections.find(s => isPrioritiesSection(s.title))
        if (!pri) return null
        const taskSections = sections.filter(s => s.title === 'Today' || s.title === 'Deferred')
        const localTaskLookup = {}
        const localLinkedMap = {}
        for (const sec of taskSections) {
          Object.assign(localTaskLookup, buildTaskIdLookup(sec.lines))
          Object.assign(localLinkedMap, buildLinkedIdMap(sec.lines))
        }
        const localManagerPriorities = parseManagerPriorities(pri.lines)
        const tasksByPriority = {}
        for (const sec of taskSections) {
          const { headers, rows } = parseMarkdownTable(sec.lines)
          const priorityCol = headers.find(h => h.includes('🎯')) || '🎯'
          for (const row of rows) {
            const id = extractTaskId(row)
            if (!id) continue
            if (localManagerPriorities[id]) continue
            const resolved = resolveManagerPriority(id, localLinkedMap, localManagerPriorities)
            if (resolved) {
              if (!tasksByPriority[resolved.id]) tasksByPriority[resolved.id] = []
              tasksByPriority[resolved.id].push({
                id,
                task: row['Task'] || '',
                priority: row[priorityCol] || '',
                section: sec.title,
              })
            }
          }
        }
        const handlers = buildPriorityHandlers(source.id)
        return (
          <ManagerPrioritiesSection
            key={source.id}
            lines={pri.lines}
            defaultOpen={false}
            onUpdate={handlers.onUpdate}
            onAddAndPrioritize={(name) => handlers.onAddAndPrioritize(name, pri.title)}
            tasksByPriority={tasksByPriority}
            taskLookup={{ ...completedTaskLookup, ...localTaskLookup }}
            title={`${source.name} — Priorities`}
            sectionId={`combined-priorities-${source.id}`}
            sourceId={source.id}
            otherSources={sources.filter(s => s.id !== source.id)}
            onMoveToSource={handleMoveToSource}
          />
        )
      })}

      {bridgeDialog && (
        <LinkBridgeDialog
          incomingLinks={bridgeDialog.incomingLinks}
          removedTaskName={bridgeDialog.removedTaskName}
          nextTaskId={bridgeDialog.nextTaskId}
          nextTaskName={bridgeDialog.nextTaskName}
          onClose={() => setBridgeDialog(null)}
          onConfirm={bridgeDialog.onConfirm}
        />
      )}

      {addDialog && (
        <AddTaskDialog
          section={addDialog.section}
          sources={sources}
          defaultSourceId={sources[0]?.id}
          perSourceTaskLookup={perSourceTaskLookup}
          onClose={() => setAddDialog(null)}
          onAdd={async (args) => { await handleAdd(args); setAddDialog(null) }}
        />
      )}

      {moveDialog && (
        <MoveToSourceDialog
          targetName={moveDialog.target.name}
          movingTasks={moveDialog.movingTasks}
          brokenLinks={moveDialog.brokenLinks}
          onClose={() => setMoveDialog(null)}
          onConfirm={async () => {
            const dlg = moveDialog
            await performMoveToSource(dlg)
          }}
        />
      )}

    </div>
  )
}

function App() {
  // 'loading' | 'pick-storage' | 'ready'
  const [appState, setAppState] = useState('loading')
  const [files, setFiles] = useState([])
  const [folderName, setFolderName] = useState('')
  const [, setStorageProvider] = useState('')
  // selectedFile uses qualified paths in multi-source mode (`${sourceId}::${path}`),
  // plain paths in single-source mode. The dispatcher in handleSelectFile/etc.
  // copes with both shapes.
  const [syncStatus, setSyncStatus] = useState(storage.getSyncStatus())
  const [selectedFile, setSelectedFile] = useState(PLAN_FILE)
  const [content, setContent] = useState('')
  const selectedFileRef = useRef(PLAN_FILE)
  const contentRef = useRef(null)
  // Remember where the board was scrolled so returning from a journal lands you
  // back at the same viewpoint instead of jumping to the top (task #334).
  const boardScrollRef = useRef(0)
  const [pendingBoardScrollRestore, setPendingBoardScrollRestore] = useState(false)
  const [pendingScrollToTaskId, setPendingScrollToTaskId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Board search query, lifted so the mobile header can host the search input
  // (#284) while FocusPlanView still owns the filtering logic.
  const [boardSearch, setBoardSearch] = useState('')
  // Mission statement: the user's north star, set in Settings and pinned at the
  // top of the board. Subscribe so a change in Settings updates the banner live.
  const [mission, setMission] = useState(getMissionStatement())
  useEffect(() => subscribeMissionStatement(setMission), [])
  // Re-render trigger for the source list when Settings mutates it.
  const [sourcesVersion, setSourcesVersion] = useState(0)
  // Sources that failed to restore on init (cloud sources needing re-authentication).
  const [failedSourceIds, setFailedSourceIds] = useState(new Set())
  // Re-read every render so post-init/post-mutation state is always fresh.
  // sourcesVersion is the explicit reactivity trigger.
  void sourcesVersion
  const sources = getSources()

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
          { name: PLAN_FILE, type: 'file', path: `${COMBINED_ID}::${PLAN_FILE}` },
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
    // Capture the board's scroll position when leaving it, and arrange to
    // restore it when returning (task #334). Skip restore when a specific task
    // scroll is already pending — that takes precedence.
    const leavingBoard = selectedFileRef.current === PLAN_FILE
    if (leavingBoard && contentRef.current) {
      boardScrollRef.current = contentRef.current.scrollTop
    }
    const returningToBoard = !leavingBoard && (path || qualifiedPath) === PLAN_FILE
    if (returningToBoard && !pendingScrollToTaskId) {
      setPendingBoardScrollRestore(true)
    }
    setSelectedFile(qualifiedPath)
    selectedFileRef.current = path
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
      if (target === PLAN_FILE) {
        // Run the legacy Work/Personal Priorities → unified Priorities migration once.
        const migrated = migratePrioritiesSections(text)
        const startContent = migrated ?? text
        if (migrated && migrated !== text) {
          await storage.write(target, migrated)
        }
        const updatedContent = await ensureUniqueIds(startContent, async (newContent) => {
          await storage.write(target, newContent)
        })
        // SELF_HEAL_IDS (temporary): fix any runaway/foreign outlier IDs.
        const healedContent = await selfHealRunawayIds(updatedContent, async (newContent) => {
          await storage.write(target, newContent)
        })
        setContent(healedContent)
      } else {
        setContent(text)
      }
    } catch {
      setContent('')
    }
  }

  const initWithProvider = async (providerId) => {
    // Only seed the starter template on a genuinely fresh, local-only install.
    // If a backup target is already configured, the remote is authoritative —
    // seeding here would let template rows merge into the real synced data
    // (the spirit of food-tracker fix #36). We pull from the remote instead.
    const hasBackup = storage.getSyncStatus().aggregate !== TARGET_STATUS.DISCONNECTED
    if (!hasBackup) {
      await storage.scaffold()
    }
    await loadMissionStatement()
    // Make the folder self-documenting for external agents. Version-gated and
    // idempotent, so this is safe to run on every init (new and existing users).
    storage.ensureAgentsDoc().catch(() => {})
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
    const liveSources = getSources()
    const defaultFile = liveSources.length > 1 ? `${COMBINED_ID}::${PLAN_FILE}` : PLAN_FILE
    handleSelectFile(defaultFile)
    // Journal read/unread (task #311): once the board's initial journals have
    // had a chance to be tracked, close the seeding window so pre-existing
    // journals are treated as already-seen (no day-one "wall of stars") while
    // journals that gain new content afterward will flag as unread.
    setTimeout(() => readStateService.completeInitialSeeding(), 3000)
  }

  useEffect(() => {
    (async () => {
      try {
        // Configure local-first storage with background sync support
        storage.configureLocalFirstStorage()

        // Initialise the storage provider. Returns true if init handled
        // everything, false if a hard fallback to pick-storage UI is needed.
        const initialised = await initStorage()
        if (!initialised) {
          setAppState('pick-storage')
          return
        }

        // Register the folder-sync service worker (served from /folder-sync/)
        // so push+pull runs off the main thread, then restore sync targets.
        await storage.registerSyncWorker()

        // Always restore sync targets and start background sync after the
        // storage provider is ready. This is what consumes the OAuth ?code=
        // query param after a Sign-in redirect (via the pending-target marker
        // in sessionStorage) and what enables the background push/pull loop.
        await storage.restoreSyncTargets()
        storage.startAutoSync()

        // Note: when a previously-connected backup target can no longer sync
        // (e.g. OneDrive refresh token revoked), the folder-sync engine itself
        // redirects the user to sign in on page load — it watches the service
        // worker's status and triggers the reconnect round trip event-driven,
        // once the SW reports `reconnect-required`. Doing it here synchronously
        // raced ahead of that signal and could never reliably fire.
      } catch (e) {
        console.error('Storage init failed:', e)
        setAppState('pick-storage')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Returns true if storage was initialised, false if the caller should
  // surface the pick-storage UI.
  const initStorage = async () => {
    // 1. If returning from OAuth redirect with a pending migration, finish it
    if (hasPendingMigration()) {
      const migratedTo = await resumePendingMigration()
      if (migratedTo) {
        window.location.reload()
        return true
      }
    }

    // 2. Load (and one-shot migrate) the multi-source registry.
    loadSources()
    migrateLegacy()
    const registry = getSources()

    if (registry.length > 0) {
      // If we're returning from a re-auth OAuth redirect (for an existing source),
      // restore that source FIRST so it consumes the ?code= param.
      const pendingReauthId = consumePendingReauth()
      if (pendingReauthId) {
        try { await restoreSource(pendingReauthId) } catch { /* ok — will retry later */ }
      }

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
      if (pendingReauthId) restoredIds.add(pendingReauthId) // already restored above
      if (scaffoldedAddId) restoredIds.add(scaffoldedAddId)
      let firstHealthyId = pendingReauthId || scaffoldedAddId || null
      const failed = new Set()
      for (const s of getSources()) {
        if (restoredIds.has(s.id)) continue
        try {
          const p = await restoreSource(s.id)
          if (p) {
            restoredIds.add(s.id)
            if (!firstHealthyId) firstHealthyId = s.id
          } else {
            failed.add(s.id)
          }
        } catch {
          failed.add(s.id)
        }
      }
      if (failed.size > 0) setFailedSourceIds(failed)
      // Pick the saved active source if it restored, otherwise the first that did.
      const savedActive = getActiveSourceId()
      const targetId = restoredIds.has(savedActive) ? savedActive : firstHealthyId
      if (targetId) {
        await setActiveSource(targetId)
        const active = getSources().find(s => s.id === targetId)
        await initWithProvider(active.providerType)
        return true
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
      return true
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
    return true
  }

  // Subscribe to sync status changes
  useEffect(() => {
    return storage.subscribeSyncStatus((status) => setSyncStatus(status))
  }, [])

  // Track the visual viewport height so the app shell (and the chat composer at
  // its bottom) stays above the on-screen keyboard on mobile. visualViewport
  // shrinks when the keyboard opens; we mirror its height into a CSS variable
  // consumed by `.app`. Pairs with `interactive-widget=resizes-content` (the
  // Android path) for full coverage including iOS Safari.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const apply = () => root.style.setProperty('--app-height', `${Math.round(vv.height)}px`)
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      root.style.removeProperty('--app-height')
    }
  }, [])

  // Re-read current file when local storage changes (e.g. after sync pull),
  // and refresh the file tree so newly pulled files (e.g. journals) appear.
  useEffect(() => {
    let treeTimer = null
    const unsub = storage.onLocalChange(async (changedPath) => {
      const current = selectedFileRef.current
      if (current && changedPath === current) {
        try {
          const text = await storage.read(current)
          setContent(text)
        } catch { /* ignore */ }
      }
      if (changedPath === SETTINGS_FILE) {
        await loadMissionStatement()
      }
      // Debounced tree refresh — a single sync may touch many files.
      clearTimeout(treeTimer)
      treeTimer = setTimeout(() => { loadFiles().catch(() => {}) }, 400)
    })
    return () => { clearTimeout(treeTimer); unsub() }
  }, [])

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

  // Restore the saved board scroll position after returning from a journal so
  // "back" lands on the same viewpoint (task #334). Runs once content for the
  // board has rendered; rAF waits for layout/paint before setting scrollTop.
  useEffect(() => {
    if (!pendingBoardScrollRestore) return
    if (selectedFileRef.current !== PLAN_FILE || !content) return
    setPendingBoardScrollRestore(false)
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = boardScrollRef.current
    })
  }, [content, pendingBoardScrollRestore])

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
  const isCombinedFocusPlan = selSourceId === COMBINED_ID && (selPath === PLAN_FILE || selPath === '')
  const localPath = selPath || selectedFile
  const isFocusPlan = !isCombinedFocusPlan && localPath === PLAN_FILE
  const isCompletedPlan = !isCombinedFocusPlan && localPath === COMPLETED_FILE
  const isJournal = !isCombinedFocusPlan && !isFocusPlan && !isCompletedPlan &&
    /(^|\/)journal\//.test(localPath) && localPath.endsWith('.md')

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
          />
        </div>
        <StorageFooter
          folderName={folderName}
          syncStatus={syncStatus}
          failedSourceIds={failedSourceIds}
          onDataChanged={loadFiles}
        />
      </aside>
      <main ref={contentRef} className={`content${isJournal ? ' content-chat' : ''}`}>
        <div className="mobile-nav-bar">
          {(() => {
            // Sync status is folded into the Files button (#274): the button owns
            // the backup state, since files + sync are the same concern. Synced is
            // the assumed default and shows nothing ("no news is good news"); only
            // attention-worthy states render a glyph (#333). A bare pulsing dot read
            // as ambiguous, so we now use recognizable icons: a spinning ↻ while
            // backing up and an exclamation when backup needs attention (error /
            // reconnect). "Not backed up" (disconnected) also shows nothing now —
            // it isn't actionable, so we treat it like synced (task #336).
            const aggStatus = syncStatus?.aggregate ?? TARGET_STATUS.DISCONNECTED
            const syncClass = aggStatus.replace(/[^a-z-]/g, '')
            const syncLabel = SYNC_LABELS[aggStatus] || 'Sync status'
            const isSyncing = aggStatus === TARGET_STATUS.SYNCING || aggStatus === TARGET_STATUS.PENDING
            const isError = aggStatus === TARGET_STATUS.ERROR || aggStatus === TARGET_STATUS.RECONNECT_NEEDED
            const showSyncDot = aggStatus !== TARGET_STATUS.SYNCED && aggStatus !== TARGET_STATUS.DISCONNECTED
            return (
              <button
                className={`mobile-menu-btn sync-${syncClass}`}
                onClick={() => setSidebarOpen(true)}
                aria-label={`Open ${APP_NAME} menu — ${syncLabel}`}
                title={syncLabel}
              >
                <span className="mobile-menu-btn-label">☰ {APP_NAME}</span>
                {isSyncing && (
                  <span className="files-sync-icon syncing" aria-hidden="true">↻</span>
                )}
                {isError && (
                  <span className="files-sync-icon error" aria-hidden="true">!</span>
                )}
                {showSyncDot && !isSyncing && !isError && (
                  <span className={`files-sync-dot ${syncClass}`} aria-hidden="true" />
                )}
              </button>
            )
          })()}
          {selectedFile && <span className="mobile-file-name">{(selPath || selectedFile).replace(/.*\//, '')}</span>}
          {isFocusPlan && (
            <div className="mobile-board-search is-expanded">
              <span className="board-search-icon" aria-hidden="true">🔍</span>
              <input
                type="text"
                className={`board-search-input${mission ? ' has-mission' : ''}`}
                placeholder={boardSearchPlaceholder(true, mission)}
                value={boardSearch}
                onChange={(e) => setBoardSearch(e.target.value)}
                aria-label="Search tasks"
                inputMode="search"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setBoardSearch('')
                    e.currentTarget.blur()
                  }
                }}
              />
              {boardSearch && (
                <button
                  type="button"
                  className="board-search-clear"
                  onClick={() => setBoardSearch('')}
                  title="Clear search"
                  aria-label="Clear search"
                >✕</button>
              )}
            </div>
          )}
        </div>
        {mission && !isJournal && !isFocusPlan && (
          <div className="mission-banner" role="note" aria-label="Mission statement">
            <span className="mission-banner-icon" aria-hidden="true">✦</span>
            <p className="mission-banner-text">{mission}</p>
          </div>
        )}
        {isCombinedFocusPlan ? (
          <CombinedFocusPlanView sources={sources} onNavigate={handleNavigate} />
        ) : content ? (
          isFocusPlan ? (
            <FocusPlanView
              content={content}
              onNavigate={handleNavigate}
              onContentUpdate={handleContentUpdate}
              otherSources={sources.filter(s => s.id !== getActiveSourceId())}
              search={boardSearch}
              onSearchChange={setBoardSearch}
              mission={mission}
              syncStatus={syncStatus}
            />
          ) : isCompletedPlan ? (
            <CompletedPlanView
              content={content}
              onNavigate={handleNavigate}
            />
          ) : isJournal ? (
            <JournalChatView
              content={content}
              filePath={localPath}
              onContentUpdate={handleContentUpdate}
              onNavigate={handleNavigate}
              onOpenSidebar={() => setSidebarOpen(true)}
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
