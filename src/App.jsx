import { useState, useEffect, useRef, useMemo, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import './mobile-board.css'
import * as storage from './storage/storage.js'
import { setActiveProvider, getActiveProvider, PROVIDERS, TARGET_STATUS, getProviderName } from './storage/storage.js'
import { IndexedDbProvider } from './storage/indexeddb-provider.js'
import { makeSyncStatusCoalescer } from './storage/syncStatusCoalesce.js'
import {
  loadSources, getSources, getActiveSourceId, getActiveSource, setActiveSource,
  addSource, getProvider, restoreSource, getHiddenSources,
  isMultiSourceNoticeDismissed, dismissMultiSourceNotice,
} from './storage/sources.js'
import { extractTaskId, parseManagerPriorities, resolveManagerPriority, sortTasksByPriority, isNeededForUrgentTask } from './taskSort.js'
// SELF_HEAL_IDS (temporary): renumber runaway/foreign task IDs on load. Safe to
// delete this import + selfHealIds.js + its call site once all devices healed.
import { selfHealOutlierIds } from './selfHealIds.js'
import { recordDeletedId, getActiveTombstoneIds } from './idTombstones.js'
import { scrollToAndFlashTask } from './scrollToTask.js'
import { filterRowsAndRawLines, normalizeQuery, boardSearchPlaceholder } from './boardSearch.js'
import { parseMarkdownTable, displayHeader } from './boardTable.js'
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
import SkillsSection from './SkillsSection.jsx'
import { parseSkillsSection, hasRenderableSkills } from './skillsSection.js'
import * as ops from './focusPlanOps.js'
import { deleteJournalForTask } from './journalDelete.js'
import { parseTgLink } from '../packages/telegram-bridge/src/deepLink.js'
import { renderJournalLines } from './markdown/markdownRender.jsx'
import { useTaskDoc, journalDeepLink } from './docsIndex.js'
import { hideDocsFolder } from './fileTreeFilter.js'

// Docs' task chip / 📔 link opens the planner at `#journal=<id>` (plans/docs-app-design.md §3).
// Captured once at load: init can run more than once (StrictMode, source switches), and the
// hash is cleared after the first run, so later runs must still honour it until the user
// navigates somewhere themselves.
let pendingJournalDeepLink = typeof window !== 'undefined' ? journalDeepLink(window.location.hash) : null
import { APP_NAME, PLAN_FILE, COMPLETED_FILE } from './config/branding.js'
import { linkedNavFallbackFile } from './linkedNav.js'
import { clampMenuPosition, menuMaxHeight } from './menuPosition.js'
import { parseJournalChat, formatChatDay, appendJournalMessage, formatCloseOutComment, insertTodoLine, stripEmptyTodoLines } from './journalChat.js'
import * as readStateService from './readState/readStateService.js'
import { enqueueJournalLoad, waitForInitialJournalLoads } from './journalLoadQueue.js'
import {
  JOURNAL_EXISTENCE,
  canCreateJournal,
  journalStateFromError,
  journalStateFromResult,
} from './journalLoadState.js'
import { sameFileTree } from './fileTreeEqual.js'
import { journalReadStateId } from './sourcePath.js'
import { getMissionStatement, loadMissionStatement, setMissionStatement, subscribeMissionStatement } from './missionStatement.js'
import { SETTINGS_FILE } from './storage/settings.js'
import {
  TASK_SETTINGS_FILE,
  DEFAULT_TASK_SETTINGS,
  readTaskSettings,
  setTaskSetting,
} from './storage/taskSettings.js'
import { gatherDiagnostics, formatDiagnosticsReport } from './storage/diagnostics.js'
import { AI_SETTINGS_FILE } from './config/aiSettings.js'
import { AGENT_GATE_FILE } from './config/agentGate.js'
import AgentSettingsEditor from './AgentSettingsEditor.jsx'
import AgentGateEditor from './AgentGateEditor.jsx'
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
import {
  disableDiagnostics,
  enableDiagnostics,
  isDiagEnabled,
} from '../packages/diagnostics/src/index.js'
import '../packages/install-prompt/src/styles/install-prompt.css'

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

  // #640: position after measuring, by writing straight to the node.
  //
  // NOT via setState. Measuring requires the menu to be in the DOM, so the correction can only
  // happen in a layout effect — and setState there is a cascading render the lint rule rightly
  // rejects. Since the only thing that changes is this element's own style, the effect writes it
  // directly: one pass, no re-render, and no frame where the menu is drawn at the wrong place.
  useLayoutEffect(() => {
    if (sheet) return
    const el = menuRef.current
    if (!el) return
    const vh = window.innerHeight
    const vw = window.innerWidth
    const cap = menuMaxHeight(vh)
    // Applied BEFORE measuring, so the height read below is the height the menu will actually
    // occupy rather than its unconstrained scroll height. Clamping against the taller figure
    // would push a long menu further up than it needs to go.
    if (cap != null) {
      el.style.maxHeight = `${cap}px`
      el.style.overflowY = 'auto'
    }
    const r = el.getBoundingClientRect()
    const { top, left } = clampMenuPosition({
      x, y, width: r.width, height: r.height, viewportWidth: vw, viewportHeight: vh,
    })
    el.style.top = `${top}px`
    el.style.left = `${left}px`
  }, [x, y, sheet, options])

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

  // Desktop: the existing positioned menu, clamped to the viewport (#640).
  //
  // It is `position: fixed`, so a menu opened near the bottom edge used to run off the fold with
  // no way to reach the entries below it — scrolling the page moves the page, not the menu, and
  // `.context-menu` sets `overflow: hidden`. Measured after render because the height depends on
  // how many options this particular menu has; `useLayoutEffect` so the correction happens
  // before paint rather than as a visible jump.
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

function SnoozePickerModal({ currentSnoozeUntil, onClose, onSave }) {
  const today = getTodayDateString()
  const defaultDate = currentSnoozeUntil && currentSnoozeUntil > today
    ? currentSnoozeUntil
    : addDaysToDateString(today, 3)
  const [customDate, setCustomDate] = useState(defaultDate || '')
  const presets = [
    { label: 'This weekend', hint: 'Saturday', date: getNextSaturdayDateString(today) },
    { label: 'Next week', hint: '7 days', date: addDaysToDateString(today, 7) },
    { label: 'In 3 days', hint: 'Soon', date: addDaysToDateString(today, 3) },
  ].filter(p => p.date && p.date > today)

  const saveDate = (value) => {
    const date = normalizeDateOnly(value)
    if (!date || date <= today) {
      window.alert('Choose a future date.')
      return
    }
    onSave(date)
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog snooze-picker-dialog" onClick={e => e.stopPropagation()}>
        <h3>💤 Snooze task</h3>
        <p className="dialog-hint">Move this task to Deferred until it should return to Today.</p>
        <div className="snooze-preset-list">
          {presets.map(preset => (
            <button
              key={preset.label}
              type="button"
              className="snooze-preset-btn"
              onClick={() => saveDate(preset.date)}
            >
              <span>{preset.label}</span>
              <small>{formatSnoozeDate(preset.date)} · {preset.hint}</small>
            </button>
          ))}
        </div>
        <label className="snooze-date-label">
          Custom date
          <input
            type="date"
            value={customDate}
            min={addDaysToDateString(today, 1) || today}
            onChange={e => setCustomDate(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') saveDate(customDate)
              if (e.key === 'Escape') onClose()
            }}
          />
        </label>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="dialog-save-btn" onClick={() => saveDate(customDate)}>Snooze</button>
        </div>
      </div>
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

// Fixed set of close-out outcomes offered when completing a task. Kept short so
// completion stays fast; free-text notes cover anything not listed here.
const CLOSE_OUT_OUTCOMES = ['Done by me', 'Canceled', 'Done by someone else', 'No longer needed', 'Other']

// Shown when a task is moved to Completed. Lets the user optionally record how
// the task ended (outcome) and a closing comment, both of which are written to
// the task journal. Completion stays one action away: "Skip & Complete" (or
// Cmd/Ctrl+Enter) finishes immediately with no notes.
function CloseOutDialog({ taskName, onClose, onConfirm }) {
  const [outcome, setOutcome] = useState('')
  const [comment, setComment] = useState('')
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onConfirm(outcome, comment)
    }
  }
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog closeout-dialog" onClick={e => e.stopPropagation()}>
        <h3>✅ Complete &ldquo;{taskName}&rdquo;</h3>
        <p className="dialog-hint">
          Optionally capture how this ended and any closing notes — handy later for
          reviews &amp; postmortems. Both are optional.
        </p>
        <label className="closeout-label">
          Outcome
          <select
            className="closeout-select"
            value={outcome}
            onChange={e => setOutcome(e.target.value)}
            autoFocus
          >
            <option value="">— none —</option>
            {CLOSE_OUT_OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="closeout-label">
          Closing comment
          <textarea
            className="closeout-textarea"
            rows={4}
            value={comment}
            onChange={e => setComment(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What was the result? Why? Anything worth remembering…"
          />
        </label>
        <div className="dialog-actions">
          <button onClick={() => onConfirm('', '')}>Skip &amp; Complete</button>
          <button className="dialog-save-btn" onClick={() => onConfirm(outcome, comment)}>Complete</button>
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
function AddTaskDialog({ section, onClose, onAdd, taskLookup, activeTaskIds }) {
  const [task, setTask] = useState('')
  const [priority, setPriority] = useState('🟡')
  const [linkedTask, setLinkedTask] = useState('')
  const [showLinkPicker, setShowLinkPicker] = useState(false)
  const dialogRef = useRef(null)
  const inputRef = useRef(null)

  const effectiveTaskLookup = taskLookup || {}
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
      onAdd({ task: task.trim(), priority, linkedTask: linkedTask.trim(), section })
      onClose()
    }
  }

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} className="add-task-dialog" data-testid="add-task-dialog">
        <h3>Add Task to {section}</h3>
        <form onSubmit={handleSubmit}>
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
              <select value={priority} onChange={(e) => setPriority(e.target.value)} data-testid="add-task-priority">
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

// Count the .md files a tree node contains, recursing into subfolders. Used to
// render a file-count badge next to each folder (task #371) so a folder like
// journal/ shows how many files it actually holds — making any client-side
// truncation immediately visible at a glance instead of silently short.
function countTreeFiles(item) {
  if (item.type === 'file') return 1
  return (item.children || []).reduce((sum, child) => sum + countTreeFiles(child), 0)
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
                {(() => {
                  const count = countTreeFiles(item)
                  return count > 0 ? <span className="folder-count">{count}</span> : null
                })()}
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

// The board table reader lives in boardTable.js (#426) so it can be unit-tested.

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
function TaskRow({ row, sourceId, headers, onNavigate, managerPriorities, onScrollToPriorities, onContextMenu, rawLine, onChangePriority, onPromoteTodo, onRenameTask, onChangeLinkedId, taskLookup, taskPriorityLookup, activeTaskIds, linkedIdMap, adoLookup, loadOrder = 0, onClearSearch }) {
  const taskId = extractTaskId(row)
  const readStateId = journalReadStateId(sourceId, taskId)
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [todos, setTodos] = useState(null)
  const [todosLoading, setTodosLoading] = useState(Boolean(taskId))
  const [journalState, setJournalState] = useState({
    existence: JOURNAL_EXISTENCE.UNKNOWN,
    path: null,
    contentStatus: 'loading',
  })
  const journalPath = journalState.path
  const [journalChecked, setJournalChecked] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [isEditingLinkedId, setIsEditingLinkedId] = useState(false)
  const [telegram, setTelegram] = useState(null)
  const isMobile = useIsMobile()
  
  const journalProvider = getActiveProvider()
  // Docs (#3.2 of plans/docs-app-design.md): the task's catch-up doc, when docs/index.json binds one.
  const taskDoc = useTaskDoc(journalProvider, taskId)
  
  // Check and read the journal as one queued operation. The provider is captured
  // now and namespaces de-duplication, so a source switch cannot reuse an
  // unfinished promise (or read through the mutable active-provider singleton).
  useEffect(() => {
    if (!taskId || journalChecked || !journalProvider) return
    let cancelled = false
    const controller = new AbortController()
    enqueueJournalLoad({
      provider: journalProvider,
      taskId,
      priority: loadOrder,
      signal: controller.signal,
    })
      .then(({ exists, path, content }) => {
        if (cancelled) return
        setJournalState(journalStateFromResult({ exists, path }))
        if (exists) {
          setTodos(storage.parseTodos(content) || [])
          setTelegram(parseTgLink(content))
          readStateService.migrateSeenState(taskId, readStateId)
          readStateService.track(readStateId, content)
        } else {
          readStateService.resolveInitialSeedCandidate(readStateId)
        }
        setTodosLoading(false)
        setJournalChecked(true)
      })
      .catch((error) => {
        if (cancelled) return
        setJournalState(previous => journalStateFromError(error, previous))
        setTodos([])
        setTodosLoading(false)
        setJournalChecked(true)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [journalChecked, journalProvider, loadOrder, readStateId, taskId])

  const retryJournalLoad = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setJournalState(previous => ({ ...previous, contentStatus: 'loading' }))
    setTodosLoading(true)
    setJournalChecked(false)
  }

  const [isJournalUnread, setIsJournalUnread] = useState(false)

  // Read/unread indicator (task #311): the row renders the boolean from the
  // read-state service and re-renders when the service announces a change. The
  // raw content is handed to the service by the single journal read above.
  useEffect(() => {
    if (!taskId) return
    const update = () => setIsJournalUnread(readStateService.isUnread(readStateId))
    update()
    return readStateService.subscribe(readStateId, update)
  }, [readStateId, taskId])
  
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
    onContextMenu(e, rawLine, row, journalPath, taskId, telegram, journalState.existence, taskDoc)
  }

  // Mobile (#335): visible kebab opens the same row-action sheet — no hidden
  // right-click / press-and-hold gesture required.
  const handleKebab = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e, rawLine, row, journalPath, taskId, telegram, journalState.existence, taskDoc)
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

            // Scroll to the linked task's row if it's currently in the DOM.
            // Returns true when it found and scrolled to the row.
            const scrollToLinkedRow = () => {
              const targetRow = document.querySelector(`tr[data-task-id="${linkedId}"]`)
              if (!targetRow) return false
              targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
              targetRow.classList.add('highlight-flash')
              setTimeout(() => targetRow.classList.remove('highlight-flash'), 1500)
              return true
            }

            // Only fall back to the completed board when the linked task is
            // genuinely not among the active tasks (#394). A live task that is
            // merely hidden (collapsed section / search filter) stays on the
            // plan board and must never be routed to completed.md.
            const navigateToFallbackBoard = () => {
              onNavigate(linkedNavFallbackFile(linkedId, activeTaskIds, PLAN_FILE, COMPLETED_FILE), linkedId)
            }

            // Task might be in a collapsed section — expand collapsed ones and retry.
            const expandCollapsedAndRetry = () => {
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
                  if (!scrollToLinkedRow()) navigateToFallbackBoard()
                }, 100)
              } else {
                navigateToFallbackBoard()
              }
            }

            const navigateToLinkedId = (e) => {
              e.stopPropagation()
              if (!linkedId) return
              // Already on this page and visible?
              if (scrollToLinkedRow()) return
              // #394: a live task hidden by an active search filter must not be
              // mistaken for a completed task. If the task is active (not
              // missing), clear the search filter and retry the scroll before
              // ever falling back to another board.
              if (!isLinkedTaskMissing && onClearSearch) {
                onClearSearch()
                setTimeout(() => {
                  if (!scrollToLinkedRow()) expandCollapsedAndRetry()
                }, 150)
                return
              }
              expandCollapsedAndRetry()
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
                      if (tid !== oldLinkedId) onChangeLinkedId(rawLine, tid)
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
                          <span className="journal-icons">
                            {/* #373/#389: the task list row offers two entry points —
                                a Journal icon and a Chat icon. #389: the 📔 Journal
                                icon opens the readable journal (chat thread) — the raw
                                markdown source is one tap away via the in-view toggle. */}
                            <a
                              href="#"
                              className="journal-link journal-link-note"
                              title="Open Journal"
                              onClick={(e) => {
                                e.preventDefault()
                                readStateService.emitJournalOpened(readStateId)
                                onNavigate(journalPath, null, 'chat')
                              }}
                            >
                              📔
                              {/* #373: the unread (★) presence badge belongs on the
                                  Journal icon — that's the surface with new entries —
                                  not on 💬 Chat. Teams-style corner overlay. */}
                              {isJournalUnread ? (
                                <span
                                  className="journal-badge journal-badge-unread"
                                  aria-label="New journal entries since you last opened this"
                                  title="New entries since you last opened this"
                                >★</span>
                              ) : null}
                            </a>
                            {/* #389: the 💬 Chat icon only exists when there is an
                                actual chat thread to open — i.e. a Telegram deep link.
                                With no Telegram link there is no separate chat surface
                                (the 📔 Journal icon already opens the readable chat view),
                                so we render nothing rather than a dead second icon. */}
                            {telegram?.url && (
                              <a
                                href={telegram.url}
                                className="journal-link journal-link-chat journal-link-tg"
                                title="Open Telegram chat thread"
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => {
                                  // Telegram-active tasks: the Chat icon opens the
                                  // Telegram thread instead of the in-app chat (task #352).
                                  e.stopPropagation()
                                }}
                              >
                                💬
                                {/* #373: the Chat icon carries no presence badge — the ↗
                                    Telegram pip was removed per feedback. The unread ★
                                    lives on the Journal icon. */}
                              </a>
                            )}
                            {/* Docs §3.2: the third link of the trio — 📄 the task's catch-up
                                doc — only when docs/index.json binds one. Its badge is about
                                the DOC (unread revision / needs you); ★ stays on 📔. */}
                            {taskDoc && (
                              <a
                                href={taskDoc.href}
                                className="journal-link journal-link-doc"
                                title={taskDoc.needsYou ? 'Catch-up doc — needs you' : taskDoc.unread ? `Catch-up doc — new revision r${taskDoc.rev}` : 'Open catch-up doc'}
                                onClick={(e) => e.stopPropagation()}
                              >
                                📄
                                {taskDoc.needsYou ? (
                                  <span className="journal-badge doc-badge-needs" aria-label="Needs you">!</span>
                                ) : taskDoc.unread ? (
                                  <span className="journal-badge doc-badge-unread" aria-label="New revision">●</span>
                                ) : null}
                              </a>
                            )}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  {!isMobile && !isEditing && leadUpPreview}
                  {todosLoading && <span className="todo-loading">...</span>}
                  {journalState.contentStatus === 'error' && (
                    <button
                      type="button"
                      className="journal-load-retry"
                      onClick={retryJournalLoad}
                      title="The journal could not be loaded. Retry without creating or overwriting it."
                    >
                      Journal unavailable — Retry
                    </button>
                  )}
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
        {/* Mobile (#335): chat + kebab get their own trailing column at the
            row's right edge — kebab all the way right, chat just before it —
            with real 40px tap targets that never overlap the task text. */}
        {isMobile && (
          <td className="row-actions-cell">
            {!isEditing && (
              <>
                <div className="row-actions">
                  {taskDoc ? (
                    // Docs §3.2 / Q10 default: when the task has a catch-up doc, the single
                    // rail slot shows 📄 (the doc is the thing to read); 💬 Telegram and
                    // 📔 Journal move to the kebab.
                    <a
                      href={taskDoc.href}
                      className="row-action-btn doc-action"
                      aria-label="Open catch-up doc"
                      title="Open catch-up doc"
                      onClick={(e) => { e.stopPropagation() }}
                    >
                      <span className="journal-glyph">
                        📄
                        {taskDoc.needsYou ? (
                          <span className="journal-badge doc-badge-needs" aria-label="Needs you">!</span>
                        ) : taskDoc.unread ? (
                          <span className="journal-badge doc-badge-unread" aria-label="New revision">●</span>
                        ) : null}
                      </span>
                    </a>
                  ) : journalPath && (
                    telegram?.url ? (
                      // #352: Telegram-active tasks show the 💬 Chat icon, which
                      // opens the Telegram thread externally (↗ badge).
                      <a
                        href={telegram.url}
                        className="row-action-btn chat-action journal-action-tg"
                        aria-label="Open Telegram chat thread"
                        title="Open Telegram chat thread"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => { e.stopPropagation() }}
                      >
                        💬
                      </a>
                    ) : (
                      // #373: with no Telegram, the single mobile rail icon falls
                      // back to 📔 Journal; #389: it opens the readable journal (chat
                      // thread), with raw source a tap away via the in-view toggle.
                      <a
                        href="#"
                        className="row-action-btn journal-action"
                        aria-label="Open Journal"
                        title="Open Journal"
                        onClick={(e) => {
                          e.preventDefault()
                          readStateService.emitJournalOpened(readStateId)
                          onNavigate(journalPath, null, 'chat')
                        }}
                      >
                        {/* #373: wrap glyph + pip so the ★ hugs the emoji corner (like
                            desktop) instead of floating in the 36px tap target. */}
                        <span className="journal-glyph">
                          📔
                          {isJournalUnread ? (
                            <span
                              className="journal-badge journal-badge-unread"
                              aria-label="New journal entries since you last opened this"
                              title="New entries since you last opened this"
                            >★</span>
                          ) : null}
                        </span>
                      </a>
                    )
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
function TaskSection({ title, tableLines, onNavigate, defaultOpen = true, managerPriorities, onScrollToPriorities, onTaskAction, onMoveToCompleted, onAddTask, onAddClick, onCreateJournal, onChangePriority, onSnoozeTask, onDeleteTask, onPromoteTodo, onRenameTask, onChangeLinkedId, onLinkToAdoBugDb, taskLookup, taskPriorityLookup, activeTaskIds, linkedIdMap, adoLookup, onPromoteToManagerPriority, onRemoveFromManagerPriority, onDeferBelow, searchQuery = '', onClearSearch, taskSettings = {}, onToggleTaskSetting }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const { headers, rows, rawLines } = parseMarkdownTable(tableLines)
  const seedCandidateKey = rows
    .map((row) => {
      const taskId = extractTaskId(row)
      if (!taskId) return null
      return journalReadStateId(getActiveSourceId(), taskId)
    })
    .filter(Boolean)
    .join('\n')
  useEffect(() => {
    readStateService.registerInitialSeedCandidates(seedCandidateKey.split('\n').filter(Boolean))
  }, [seedCandidateKey])
  const [contextMenu, setContextMenu] = useState(null)
  // #346: separate state for the kebab's "Change priority" submenu.
  const [priorityMenu, setPriorityMenu] = useState(null)
  const [snoozePicker, setSnoozePicker] = useState(null)
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

  const handleContextMenu = (e, rawLine, row, journalPath, taskId, telegram, journalExistence, taskDoc) => {
    const options = []
    const rowSourceId = getActiveSourceId()
    const rowReadStateId = journalReadStateId(rowSourceId, taskId)
    const qualifiedJournalPath = journalPath
    const currentSnoozeUntil = row.snoozeUntil || parseSnoozeUntil(rawLine)

    if (title === 'Today') {
      options.push({
        label: 'Defer',
        icon: '📅',
        action: () => onTaskAction('defer', rawLine, 'Today', 'Deferred')
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
    } else if (title === 'Deferred' && !currentSnoozeUntil) {
      options.push({
        label: 'Move to Today',
        icon: '⬆️',
        action: () => onTaskAction('move', rawLine, 'Deferred', 'Today')
      })
    }

    if (onSnoozeTask) {
      options.push({
        label: currentSnoozeUntil ? 'Reschedule snooze…' : 'Snooze…',
        icon: '💤',
        action: () => setSnoozePicker({
          rawLine,
                    currentSnoozeUntil,
        }),
      })
      if (currentSnoozeUntil) {
        options.push({
          label: 'Un-snooze',
          icon: '☀️',
          action: () => onSnoozeTask(rawLine, null),
        })
      }
    }

    // Add "Move to Completed" option for both Today and Deferred
    options.push({
      label: 'Move to Completed',
      icon: '✅',
      action: () => onMoveToCompleted(rawLine, row, title)
    })

    // Mobile #373: the rail shows ONE icon; its counterpart lives in the kebab.
    // With Telegram the rail icon is 💬 Chat → Telegram, so 📔 Journal goes here.
    // Without Telegram the rail falls back to 📔 Journal, so in-app 💬 Chat goes here.
    // Docs §3.2: with a catch-up doc the rail is 📄, so BOTH 💬 Telegram and 📔 Journal go here.
    if (isMobile && taskDoc) {
      if (telegram?.url) {
        options.push({
          label: 'Open Telegram',
          icon: '💬',
          action: () => { window.open(telegram.url, '_blank', 'noopener,noreferrer') }
        })
      }
      if (journalPath && taskId) {
        options.push({
          label: 'Open journal',
          icon: '📔',
          action: () => {
            readStateService.emitJournalOpened(rowReadStateId)
            onNavigate(qualifiedJournalPath, null, 'chat')
          }
        })
      }
    } else if (isMobile && journalPath && taskId) {
      if (telegram?.url) {
        options.push({
          label: 'Open journal',
          icon: '📔',
          action: () => {
            readStateService.emitJournalOpened(rowReadStateId)
            onNavigate(qualifiedJournalPath, null, 'chat')
          }
        })
      } else {
        options.push({
          label: 'Open chat',
          icon: '💬',
          action: () => {
            readStateService.emitJournalOpened(rowReadStateId)
            onNavigate(qualifiedJournalPath, null, 'chat')
          }
        })
      }
    }

    // Add "Create Journal" option if no journal exists and we have a task ID
    if (canCreateJournal(journalExistence) && taskId) {
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
                  }),
      })
    }

    // #379: per-task AI controls. Compact kebab toggles for the two opt-ins
    // — AI-assisted and persistent session — defaulting to off so existing
    // tasks with no recorded settings keep their current (non-AI) behavior.
    if (taskId && onToggleTaskSetting) {
      const settingsKey = taskId
      const currentTaskSettings = taskSettings[settingsKey] || DEFAULT_TASK_SETTINGS
      options.push({
        label: `AI-assisted: ${currentTaskSettings.aiAssisted ? 'On' : 'Off'}`,
        icon: '🤖',
        action: () => onToggleTaskSetting(taskId, { aiAssisted: !currentTaskSettings.aiAssisted }),
      })
      options.push({
        label: `Persistent session: ${currentTaskSettings.persistentSession ? 'On' : 'Off'}`,
        icon: '🧷',
        action: () => onToggleTaskSetting(taskId, { persistentSession: !currentTaskSettings.persistentSession }),
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
    <div className="task-section" data-testid={`task-section-${title}`}>
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
            1. Snoozed tasks live in Deferred until their return date<br/>
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
              {visibleRows.map((row, i) => {
                const journalSourceId = getActiveSourceId()
                return (
                <TaskRow
                  key={`${journalSourceId || 'active'}-${extractTaskId(row) || 'row'}-${i}`}
                  row={row} 
                  sourceId={journalSourceId}
                  loadOrder={i}
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
                  adoLookup={adoLookup}
                  onClearSearch={onClearSearch}/>
                )
              })}
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
            action: () => onChangePriority(priorityMenu.rawLine, priorityMenu.idCell, icon),
          }))}
          onClose={() => setPriorityMenu(null)}
        />
      )}
      {snoozePicker && (
        <SnoozePickerModal
          currentSnoozeUntil={snoozePicker.currentSnoozeUntil}
          onClose={() => setSnoozePicker(null)}
          onSave={(date) => onSnoozeTask(snoozePicker.rawLine, date)}
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
    <div className="task-section manager-priorities-section" id={sectionId} data-testid={`task-section-${title}`}>
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
                <li key={id} className="priority-item">
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

function useCompleteInitialReadStateSeeding(ready) {
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    waitForInitialJournalLoads()
      .then(() => {
        if (!cancelled) readStateService.completeInitialSeeding()
      })
    return () => { cancelled = true }
  }, [ready])
}

function FocusPlanView({ content, onNavigate, onContentUpdate, sourceId, search: searchProp, onSearchChange, mission, syncStatus, onDataChanged }) {
  const [completedTaskLookup, setCompletedTaskLookup] = useState({})
  // Per-task AI-assisted / persistent-session opt-ins (#379), keyed by task ID.
  // Loaded from task-settings.json independently of plan content since it's a
  // separate sidecar file; refreshed on remote sync pulls to that file too.
  const [taskSettings, setTaskSettingsMap] = useState({})
  const [bridgeDialog, setBridgeDialog] = useState(null)
  const [closeOutDialog, setCloseOutDialog] = useState(null)
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

  // TaskRow effects enqueue every initial journal lookup/read during this mount.
  // Keep first-load seeding open until that bounded queue has fully drained so
  // slow rows are still established as seen rather than appearing newly unread.
  useCompleteInitialReadStateSeeding(true)
  
  // Find sections
  const taskSections = sections.filter(s => 
    s.title === 'Today' || s.title === 'Deferred'
  )
  const managerPrioritiesSection = sections.find(s => isPrioritiesSection(s.title))

  // Read-only `## Skills` inventory (#188). `null` when the board has no such
  // heading, in which case nothing is rendered at all — no empty placeholder.
  const skills = parseSkillsSection(sections)

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

  // Load per-task AI-controls settings (#379) and keep them fresh across
  // remote sync pulls that touch task-settings.json.
  useEffect(() => {
    let cancelled = false
    const load = () => readTaskSettings()
      .then(file => { if (!cancelled) setTaskSettingsMap(file.tasks) })
      .catch((error) => {
        console.error('Failed to load task settings:', error)
        if (!cancelled) setTaskSettingsMap({})
      })
    load()
    const unsub = storage.onLocalChange((path) => { if (path === TASK_SETTINGS_FILE) load() })
    return () => { cancelled = true; unsub() }
  }, [sourceId])

  // Toggle one per-task AI-controls opt-in. Reads-modifies-writes
  // task-settings.json in the active source (single-source view).
  const handleToggleTaskSetting = async (taskId, patch) => {
    try {
      const next = await setTaskSetting(taskId, patch)
      setTaskSettingsMap(next.tasks)
    } catch (error) {
      console.error('Failed to update task settings:', error)
      alert(error.message || 'Could not update task settings.')
    }
  }

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
  }, [coarsePointer, setSearch])

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
    const newContent = ops.opSnoozeTask(content, rawLine, snoozeUntil)
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
            await deleteJournalForTask({
              journalPath,
              taskId,
              checkJournal: storage.checkJournal,
              remove: storage.remove,
              onError: (e) => console.error('Failed to delete journal:', e),
            })
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
    
    // Also delete the journal if the task has one. The path is resolved at
    // delete time rather than taken from lazily-loaded row state, so deleting a
    // row whose journal was still loading no longer orphans the file (#185).
    await deleteJournalForTask({
      journalPath,
      taskId,
      checkJournal: storage.checkJournal,
      remove: storage.remove,
      onError: (e) => console.error('Failed to delete journal:', e),
    })
  }

  const handleMoveToCompleted = async (rawLine, row, fromSection) => {
    const taskId = extractTaskId(row)
    // Show the close-out dialog first so the user can optionally record how the
    // task ended. Completion proceeds (with the existing link-bridge check) only
    // after they confirm; clicking the overlay cancels the whole action.
    setCloseOutDialog({
      taskName: row['Task'] || (taskId ? `Task ${taskId}` : 'this task'),
      onConfirm: async (outcome, comment) => {
        setCloseOutDialog(null)
        await runCompletion(rawLine, row, fromSection, taskId, { outcome, comment })
      }
    })
  }

  const runCompletion = async (rawLine, row, fromSection, taskId, closeout) => {
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
            await performMoveToCompleted(rawLine, row, fromSection, bridged, closeout)
          }
        })
        return
      }
    }
    await performMoveToCompleted(rawLine, row, fromSection, content, closeout)
  }

  const performMoveToCompleted = async (rawLine, row, fromSection, currentContent, closeout = {}) => {
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
    // Stamp the optional close-out outcome inline so the completed board shows it.
    const closeOutcome = (closeout.outcome || '').replace(/\|/g, '/').trim()
    if (closeOutcome) {
      completedTaskName += ` · _${closeOutcome}_`
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

    // Write the optional close-out comment into the task journal so it's kept
    // with the task's history (useful for later reviews/postmortems).
    const closeOutText = formatCloseOutComment(closeout.outcome, closeout.comment)
    if (taskId && closeOutText) {
      try {
        const journalData = await storage.checkJournal(taskId)
        if (journalData.exists) {
          const journalContent = await storage.read(journalData.path)
          await storage.write(journalData.path, appendJournalMessage(journalContent, closeOutText))
        }
      } catch (e) {
        console.error('Failed to write close-out to journal:', e)
      }
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
    for (const id of Object.keys(taskSettings)) journalIds.add(Number(id))

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
    for (const id of Object.keys(taskSettings)) journalIds.add(Number(id))
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
    for (const id of Object.keys(taskSettings)) journalIds.add(Number(id))

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
      // Refresh the sidebar tree so the newly created journal appears in the
      // hamburger pane immediately. Without this, the file is written to disk
      // (and syncs to the cloud) but the cached file list never learns about
      // it, so the journal looks "missing" until a full reload (task #371).
      await onDataChanged?.()
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
    // #426: this used a hardcoded `parts[6]`, which is the last cell of the OLD
    // 6-column schema. `Wake` is inserted immediately BEFORE `Linked ID`, so on
    // a 7-column Deferred row `parts[6]` is the **Wake** cell — setting a task's
    // parent wrote the parent id into the wake date and left the real link
    // untouched. #307 fixed exactly this in `opChangeLinkedId` but missed this
    // duplicate, which is the copy wired into the single-source view. Delegate
    // rather than keeping a second implementation that can drift again.
    const next = ops.opChangeLinkedId(content, rawLine, newLinkedId)
    if (next !== content) await onContentUpdate(next)
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
          onClearSearch={() => { setSearch(''); setSearchForced(false) }}
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
          taskSettings={taskSettings}
          onToggleTaskSetting={handleToggleTaskSetting}
        />
      ))}

      {hasRenderableSkills(skills) && (
        <SkillsSection headers={skills.headers} rows={skills.rows} notes={skills.notes} />
      )}

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

      {closeOutDialog && (
        <CloseOutDialog
          taskName={closeOutDialog.taskName}
          onClose={() => setCloseOutDialog(null)}
          onConfirm={closeOutDialog.onConfirm}
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

// A single completed-task row. Checks whether the task still has a journal and,
// if so, renders a 📓 link to open it — mirroring the active task rows so a
// completed task's history stays one click away (#366).
function CompletedTaskRow({ row, headers, priorityCol, getPriorityClass, onNavigate }) {
  const idValue = row['#'] || row['ID']
  const taskId = typeof idValue === 'object'
    ? idValue.id?.match(/\d+/)?.[0]
    : String(idValue).match(/\d+/)?.[0]
  const sourceId = getActiveSourceId()
  const readStateId = journalReadStateId(sourceId, taskId)

  const [journalPath, setJournalPath] = useState(null)
  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    storage.checkJournal(taskId)
      .then(data => { if (!cancelled && data.exists) setJournalPath(data.path) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [taskId])

  return (
    <tr className={getPriorityClass(row[priorityCol])} data-task-id={taskId || undefined}>
      {headers.map((h, ci) => {
        const val = row[h]
        if ((h === '#' || h === 'ID') && typeof val === 'object') {
          return <td key={ci}>{parseLinks(val.id, onNavigate)}</td>
        }
        if (h === 'Task') {
          return (
            <td key={ci}>
              {renderCellWithTooltips(val, onNavigate)}
              {journalPath && (
                <a
                  href="#"
                  className="journal-link"
                  title="Open journal"
                  onClick={(e) => {
                    e.preventDefault()
                    readStateService.emitJournalOpened(readStateId)
                    onNavigate(journalPath)
                  }}
                >
                  📓
                </a>
              )}
            </td>
          )
        }
        return <td key={ci}>{renderCellWithTooltips(val, onNavigate)}</td>
      })}
    </tr>
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
              {rows.map((row, ri) => (
                <CompletedTaskRow
                  key={ri}
                  row={row}
                  headers={headers}
                  priorityCol={priorityCol}
                  getPriorityClass={getPriorityClass}
                  onNavigate={onNavigate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---- Journal chat rendering ----------------------------------------------

// View switcher between the Chat thread and the raw Journal (markdown source).
// Desktop (>768px / fine pointer): a two-button segmented control with both
// "Journal" and "Chat" always visible, active one highlighted. Mobile (<=768px
// or coarse pointer): collapses via CSS to a single toggle showing only the
// view you're NOT in — matching the original one-button behaviour. Both drive
// off the same showRaw state (Journal = showRaw:true, Chat = showRaw:false).
function JournalChatToggle({ showRaw, setShowRaw }) {
  // #373: a single "switch to the other view" button. You never see a button
  // for the view you're already on — on Chat you're offered Journal, and on
  // Journal (raw) you're offered Chat. The two-icon picker lives on the task
  // list page instead (see the board row icons).
  return (
    <div className="jc-view-switch" role="group" aria-label="Switch between Journal and Chat views">
      {showRaw ? (
        <button
          className="jc-switch-btn"
          onClick={() => setShowRaw(false)}
          title="Switch to Chat thread"
        >💬 Chat</button>
      ) : (
        <button
          className="jc-switch-btn"
          onClick={() => setShowRaw(true)}
          title="Switch to Journal (raw markdown source)"
        >📔 Journal</button>
      )}
    </div>
  )
}

// Docs §3.2: the 💬 Telegram · 📔 Journal · 📄 Catch-up trio in the journal header.
// Renders nothing unless the task has a Telegram thread or a catch-up doc, so
// journals without either look exactly as before.
function JournalTrio({ content, taskId }) {
  const doc = useTaskDoc(getActiveProvider(), taskId)
  const tg = useMemo(() => parseTgLink(content), [content])
  if (!doc && !tg?.url) return null
  return (
    <nav className="jc-trio" aria-label="Task links">
      {tg?.url && (
        <a className="jc-trio-link" href={tg.url} target="_blank" rel="noopener noreferrer" title="Open Telegram chat thread">💬</a>
      )}
      <span className="jc-trio-link is-current" title="Journal (you are here)" aria-current="page">📔</span>
      {doc && (
        <a className="jc-trio-link" href={doc.href} title={doc.needsYou ? 'Catch-up doc — needs you' : 'Open catch-up doc'}>
          📄{doc.needsYou ? <span className="journal-badge doc-badge-needs">!</span> : doc.unread ? <span className="journal-badge doc-badge-unread">●</span> : null}
        </a>
      )}
    </nav>
  )
}

// Append a new "me" message to journal markdown, merging into today's bubble.
function JournalChatView({ content, filePath, onContentUpdate, onNavigate, onOpenSidebar, initialView = 'chat' }) {
  // #373: the view the task list icons chose to open. 'journal' opens the raw
  // markdown source; anything else opens the chat thread.
  const [showRaw, setShowRaw] = useState(initialView === 'journal')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [showAttachmentDialog, setShowAttachmentDialog] = useState(false)
  const threadRef = useRef(null)
  const inputRef = useRef(null)
  const parsed = useMemo(() => parseJournalChat(content), [content])
  const taskId = taskIdFromJournalPath(filePath)

  // Re-honour the requested view when the task or the caller's choice changes.
  useEffect(() => {
    setShowRaw(initialView === 'journal')
  }, [filePath, initialView])

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
    // #645: an unfilled `- [ ] ` matches the todo extractor with empty text, so sending one
    // would add a blank row to the task list. Stripped here rather than at insert, so the
    // empty line stays available to type into while the draft is open.
    const text = stripEmptyTodoLines(draft)
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

  // #645: produce a well-formed todo line so adding one does not require remembering
  // `- [ ]`. Deliberately NOT insertIntoDraft above -- that joins with a space, which would
  // bury the checkbox mid-sentence where the extractor cannot see it.
  const handleInsertTodo = () => {
    const next = insertTodoLine(draft)
    setDraft(next)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      // Cursor after the box, ready to type the todo itself.
      el.setSelectionRange(next.length, next.length)
    })
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
        headerExtra={<JournalChatToggle showRaw={showRaw} setShowRaw={setShowRaw} />}
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
        <JournalTrio content={content} taskId={taskId} />
        <JournalChatToggle showRaw={showRaw} setShowRaw={setShowRaw} />
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
        <button
          type="button"
          className="jc-attach-btn"
          onClick={handleInsertTodo}
          title="Insert a todo"
          aria-label="Insert a todo"
        >
          ☑️
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
        <button className="jc-send-btn" onClick={handleSend} disabled={!stripEmptyTodoLines(draft) || sending}>
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
            <li><strong>Storage source</strong> — the board uses one source at a time. Switch among saved sources in <em>Settings</em>.</li>
            <li><strong>Sync targets</strong> — OneDrive and Google Drive can back up the active source without becoming board sources.</li>
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

// Collapsible Settings section header (#372/#4): a clickable, keyboard-accessible
// title with a caret that toggles its section open/closed, mirroring the existing
// Files section idiom. The section body is hidden via CSS when its parent
// `.settings-dialog-section` carries the `collapsed` class.
function SettingsSectionTitle({ id, label, collapsed, onToggle, className = '' }) {
  return (
    <div
      className={`settings-dialog-section-title settings-section-toggle ${className}`.trim()}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onClick={() => onToggle(id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(id) } }}
      title={collapsed ? 'Expand section' : 'Collapse section'}
    >
      <span className={`settings-section-caret${collapsed ? '' : ' open'}`} aria-hidden="true">▸</span>
      {label}
    </div>
  )
}

function StorageFooter({ syncStatus, onDataChanged, onOpenFile }) {
  const [open, setOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // File manager (Settings → Files): browse + delete files in the active source.
  const [filesOpen, setFilesOpen] = useState(false)
  const [fileList, setFileList] = useState(null) // null = not loaded yet; [] = empty
  const [filesBusy, setFilesBusy] = useState(false)
  const [filesError, setFilesError] = useState('')
  const [deletingPath, setDeletingPath] = useState(null)
  // Collapsible Settings sections (#372/#4): per-section open/closed state,
  // persisted to localStorage so choices stick across app opens. Absent = open.
  const [sectionCollapsed, setSectionCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fp-settings-collapsed') || '{}') || {} }
    catch { return {} }
  })
  const toggleSection = (id) => setSectionCollapsed(prev => {
    const next = { ...prev, [id]: !prev[id] }
    try { localStorage.setItem('fp-settings-collapsed', JSON.stringify(next)) } catch { /* ignore */ }
    return next
  })
  // Mission statement editor (Settings → Mission).
  const [mission, setMissionInput] = useState(getMissionStatement())
  useEffect(() => subscribeMissionStatement(setMissionInput), [])
  // App update (force latest service worker — fixes "stale build on mobile").
  const [updating, setUpdating] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(isDiagEnabled())
  // Diagnostics report (Settings → App version & diagnostics): a copyable
  // snapshot of storage/sync state. Complements the capture toggle above —
  // the toggle decides whether events are recorded, this renders the report.
  const [diagText, setDiagText] = useState('')
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagMsg, setDiagMsg] = useState('')
  const oneDrive = targetStatus(syncStatus, PROVIDERS.ONEDRIVE)
  const aggregate = syncStatus?.aggregate ?? TARGET_STATUS.DISCONNECTED
  const syncClass = aggregate.replace(/[^a-z-]/g, '')

  const sources = getSources()
  const activeId = getActiveSourceId()
  const isMulti = sources.length > 1
  const fsaSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  const close = () => { setOpen(false); setError('') }
  const openAgentSettingsFile = () => {
    close()
    onOpenFile?.(AI_SETTINGS_FILE)
  }

  const switchSource = async (sourceId) => {
    setBusy(true)
    setError('')
    try {
      const source = sources.find(item => item.id === sourceId)
      const provider = getProvider(sourceId)
      if (!source || !provider) throw new Error('Storage source is unavailable.')
      const restored = await provider.restore()
      if (!restored && source.providerType === PROVIDERS.FSA) {
        const handle = await provider.pick()
        if (!handle) { setBusy(false); return }
        await provider.scaffold()
      } else if (!restored) {
        await setActiveSource(sourceId)
        await provider.pick()
        return
      }
      await setActiveSource(sourceId)
      window.location.reload()
    } catch (e) {
      if (!e.message?.toLowerCase().includes('aborted') && !e.message?.includes('Redirecting')) {
        setError(e.message || 'Could not switch storage source')
      }
      setBusy(false)
    }
  }

  const chooseProvider = async (providerType) => {
    const existing = sources.find(source => source.providerType === providerType)
    if (existing) {
      await switchSource(existing.id)
      return
    }
    setBusy(true)
    setError('')
    try {
      const source = addSource({ providerType })
      const provider = getProvider(source.id)
      if (providerType === PROVIDERS.FSA) {
        const handle = await provider.pick()
        if (!handle) { setBusy(false); return }
        await provider.scaffold()
      } else if (providerType === PROVIDERS.LOCAL_STORAGE) {
        await provider.restore()
        await provider.scaffold()
      } else {
        await setActiveSource(source.id)
        await provider.pick()
        return
      }
      await setActiveSource(source.id)
      window.location.reload()
    } catch (e) {
      if (!e.message?.toLowerCase().includes('aborted') && !e.message?.includes('Redirecting')) {
        setError(e.message || 'Could not open storage source')
      }
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
    || getProviderName(getActiveSource()?.providerType)
    || 'this source'

  const loadFileList = async () => {
    setFilesBusy(true)
    setFilesError('')
    try {
      // Browse through the active-provider singleton, which is the restored
      // instance the rest of the app uses.
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

  const runDiagnostics = async () => {
    setDiagBusy(true)
    setDiagMsg('')
    try {
      const data = await gatherDiagnostics()
      const text = formatDiagnosticsReport(data)
      setDiagText(text)
      let copied = false
      try { await navigator.clipboard.writeText(text); copied = true } catch { /* clipboard may be blocked */ }
      let saved = false
      try { await storage.write('diagnostics.md', text); saved = true } catch { /* ignore */ }
      setDiagMsg(`${copied ? 'Copied to clipboard' : 'Ready below'}${saved ? ' · saved as diagnostics.md' : ''}`)
    } catch (e) {
      setDiagMsg('Failed: ' + (e?.message || e))
    } finally {
      setDiagBusy(false)
    }
  }

  const toggleDiagnostics = () => {
    if (diagnosticsEnabled) disableDiagnostics()
    else enableDiagnostics()
    setDiagnosticsEnabled(isDiagEnabled())
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

      {open && createPortal(
        <div className="dialog-overlay" onClick={close}>
          <div className="settings-dialog" onClick={e => e.stopPropagation()}>
            <div className="settings-dialog-header">
              <h3>Settings</h3>
              <button className="settings-dialog-close" onClick={close}>✕</button>
            </div>

            <InstallSettingsSection onOpen={() => setInstallOpen(true)} appName={APP_NAME} />

            <div className={`settings-dialog-section${sectionCollapsed.mission ? ' collapsed' : ''}`}>
              <SettingsSectionTitle id="mission" label="Mission" collapsed={!!sectionCollapsed.mission} onToggle={toggleSection} />
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

            <div className="settings-dialog-subtle settings-agent-settings-hint">
              <span>
                Agent settings now live in <code>{AI_SETTINGS_FILE}</code>. Open that file to use the full-page editor.
              </span>
              <button
                type="button"
                className="settings-link-button"
                onClick={openAgentSettingsFile}
              >
                Open {AI_SETTINGS_FILE}
              </button>
            </div>

            {isMulti && (
              <div className={`settings-dialog-section${sectionCollapsed.sources ? ' collapsed' : ''}`}>
                <SettingsSectionTitle id="sources" label="Storage source" collapsed={!!sectionCollapsed.sources} onToggle={toggleSection} />
                <p className="settings-dialog-subtle">Only one source is open at a time. These saved sources are separate from sync targets and backups.</p>
                {sources.map(source => (
                  <div key={source.id} className={`storage-footer-source-row${source.id === activeId ? ' active' : ''}`}>
                    <span className="storage-footer-source-icon">{PROVIDER_ICONS[source.providerType] || '📁'}</span>
                    <span className="storage-footer-source-name">{source.name}</span>
                    {source.id === activeId
                      ? <span className="storage-footer-source-active">● Active</span>
                      : <button className="storage-footer-btn sync-target-action" onClick={() => switchSource(source.id)} disabled={busy}>Use {source.name}</button>}
                  </div>
                ))}
              </div>
            )}

            <div className={`settings-dialog-section${sectionCollapsed.storage ? ' collapsed' : ''}`}>
              <SettingsSectionTitle id="storage" label="Storage & backups" collapsed={!!sectionCollapsed.storage} onToggle={toggleSection} />
              <div className={`sync-target-card${getActiveSource()?.providerType === PROVIDERS.LOCAL_STORAGE ? ' active-source' : ''}`}>
                <div className="sync-target-main">
                  <span className="sync-target-icon">{PROVIDER_ICONS[PROVIDERS.LOCAL_STORAGE]}</span>
                  <div>
                    <div className="sync-target-name">Browser Storage</div>
                    <div className="sync-target-status">A storage source saved in this browser.</div>
                  </div>
                </div>
                <div className="sync-target-actions">
                  {getActiveSource()?.providerType === PROVIDERS.LOCAL_STORAGE
                    ? <span className="sync-active-badge">● Active</span>
                    : <button className="storage-footer-btn sync-target-action" onClick={() => chooseProvider(PROVIDERS.LOCAL_STORAGE)} disabled={busy}>Use this</button>}
                </div>
              </div>
              {fsaSupported && (
                <div className={`sync-target-card${getActiveSource()?.providerType === PROVIDERS.FSA ? ' active-source' : ''}`}>
                  <div className="sync-target-main">
                    <span className="sync-target-icon">📂</span>
                    <div>
                      <div className="sync-target-name">Local Folder</div>
                      <div className="sync-target-status">A storage source in a folder on this device.</div>
                    </div>
                  </div>
                  <div className="sync-target-actions">
                    {getActiveSource()?.providerType === PROVIDERS.FSA
                      ? <span className="sync-active-badge">● Active</span>
                      : <button className="storage-footer-btn sync-target-action" onClick={() => chooseProvider(PROVIDERS.FSA)} disabled={busy}>Choose folder</button>}
                  </div>
                </div>
              )}
              <p className="settings-dialog-subtle">The cloud options below are sync targets and backups, not additional board sources.</p>

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

            <div className={`settings-dialog-section${sectionCollapsed.backup ? ' collapsed' : ''}`}>
              <SettingsSectionTitle id="backup" label="Backup & sync" collapsed={!!sectionCollapsed.backup} onToggle={toggleSection} />
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

            <div className={`settings-dialog-section${sectionCollapsed.appDiagnostics ? ' collapsed' : ''}`}>
              <SettingsSectionTitle
                id="appDiagnostics"
                label="App version & diagnostics"
                collapsed={!!sectionCollapsed.appDiagnostics}
                onToggle={toggleSection}
              />
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
              <div className="settings-update-row settings-diagnostics-row">
                <div className="settings-update-info">
                  <span className="settings-update-build">
                    Diagnostics {diagnosticsEnabled ? 'on' : 'off'}
                  </span>
                  <span className="settings-update-hint">
                    Keeps a bounded in-memory flight recorder for on-demand troubleshooting. Off by default.
                  </span>
                </div>
                <button
                  className="storage-footer-btn sync-target-action"
                  onClick={toggleDiagnostics}
                  aria-pressed={diagnosticsEnabled}
                  title={`${diagnosticsEnabled ? 'Disable' : 'Enable'} diagnostics`}
                >
                  {diagnosticsEnabled ? 'Turn off' : 'Turn on'}
                </button>
              </div>
              <div className="settings-diagnostics">
                <div className="settings-update-hint">
                  A copyable snapshot of storage &amp; sync state (files, size, quota, journal
                  coverage, token expiry). Safe to share — it never includes your tokens.
                </div>
                <div className="settings-diagnostics-actions">
                  <button
                    className="storage-footer-btn sync-target-action"
                    onClick={runDiagnostics}
                    disabled={diagBusy}
                    title="Gather diagnostics, copy to clipboard, and save as diagnostics.md"
                  >
                    {diagBusy ? 'Gathering…' : 'Copy diagnostics'}
                  </button>
                  {diagMsg && <span className="settings-diagnostics-msg">{diagMsg}</span>}
                </div>
                {diagText && (
                  <textarea
                    className="settings-diagnostics-output"
                    readOnly
                    value={diagText}
                    rows={12}
                    onFocus={(e) => e.target.select()}
                    aria-label="Diagnostics report"
                  />
                )}
              </div>
              <div className="settings-update-row settings-diagnostics-row">
                <div className="settings-update-info">
                  <span className="settings-update-build">Privacy</span>
                  <span className="settings-update-hint">
                    Your data stays in your browser and the storage you connect. No servers, no analytics.
                  </span>
                </div>
                <a
                  className="storage-footer-btn sync-target-action settings-link-btn"
                  href={`${import.meta.env.BASE_URL}privacy.html`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Privacy policy
                </a>
              </div>
            </div>

            {error && <div className="storage-footer-error">⚠️ {error}</div>}
          </div>
        </div>,
        document.body
      )}


    </>
  )
}
function App() {
  // 'loading' | 'pick-storage' | 'ready'
  const [appState, setAppState] = useState('loading')
  const [files, setFiles] = useState([])
  const [folderName, setFolderName] = useState('')
  const [, setStorageProvider] = useState('')
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
  // #373: which view (chat|journal) the task list icons asked to open into.
  const [journalInitialView, setJournalInitialView] = useState('chat')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Board search query, lifted so the mobile header can host the search input
  // (#284) while FocusPlanView still owns the filtering logic.
  const [boardSearch, setBoardSearch] = useState('')
  // Mission statement: the user's north star, set in Settings and pinned at the
  // top of the board. Subscribe so a change in Settings updates the banner live.
  const [mission, setMission] = useState(getMissionStatement())
  useEffect(() => subscribeMissionStatement(setMission), [])
  const [sourceNotice, setSourceNotice] = useState(null)
  const snoozeSweepInFlightRef = useRef(false)
  const contentWriteInFlightRef = useRef(false)
  const [snoozeTimerNonce, setSnoozeTimerNonce] = useState(0)

  const sweepCurrentPlanSnoozes = useCallback(async () => {
    const target = selectedFile
    if (target !== PLAN_FILE) return
    if (snoozeSweepInFlightRef.current || contentWriteInFlightRef.current) return
    snoozeSweepInFlightRef.current = true
    try {
      const text = await storage.read(target)
      const nextContent = ops.opApplySnoozeTransitions(text, getTodayDateString())
      if (nextContent !== text) {
        contentWriteInFlightRef.current = true
        try {
          await storage.write(target, nextContent)
          setContent(nextContent)
        } finally {
          contentWriteInFlightRef.current = false
        }
      }
    } catch (e) {
      console.error('Failed to apply snooze transitions:', e)
    } finally {
      snoozeSweepInFlightRef.current = false
    }
  }, [selectedFile])

  const loadFiles = async () => {
    try {
      const data = hideDocsFolder(await storage.getFiles())
      setFiles(prev => sameFileTree(prev, data) ? prev : data)
    } catch (err) {
      console.error('Failed to load files:', err)
    }
  }

  const handleSelectFile = async (qualifiedPath) => {
    const target = qualifiedPath
    // Capture the board's scroll position when leaving it, and arrange to
    // restore it when returning (task #334). Skip restore when a specific task
    // scroll is already pending — that takes precedence.
    const leavingBoard = selectedFileRef.current === PLAN_FILE
    if (leavingBoard && contentRef.current) {
      boardScrollRef.current = contentRef.current.scrollTop
    }
    const returningToBoard = !leavingBoard && target === PLAN_FILE
    if (returningToBoard && !pendingScrollToTaskId) {
      setPendingBoardScrollRestore(true)
    }
    setSelectedFile(target)
    selectedFileRef.current = target
    setSidebarOpen(false)

    try {
      const text = await storage.read(target)
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
        const snoozeContent = ops.opApplySnoozeTransitions(healedContent, getTodayDateString())
        if (snoozeContent !== healedContent) {
          await storage.write(target, snoozeContent)
        }
        setContent(snoozeContent)
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
    // Create the initial saved choice when this is a fresh install.
    if (getSources().length === 0) {
      const src = addSource({ providerType: providerId, name: storage.folderName() || getProviderName(providerId) })
      await setActiveSource(src.id)
    }
    const hiddenSources = getHiddenSources()
    if (hiddenSources.length > 0 && !isMultiSourceNoticeDismissed()) {
      setSourceNotice(hiddenSources.map(source => source.name))
    }
    await loadFiles()
    setFolderName(storage.folderName())
    setStorageProvider(providerId)
    setAppState('ready')
    const deepTask = pendingJournalDeepLink
    if (deepTask != null) {
      if (journalDeepLink(window.location.hash) != null) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      }
      setJournalInitialView('chat')
      handleSelectFile(`journal/task-${deepTask}.md`)
    } else {
      handleSelectFile(PLAN_FILE)
    }
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
    loadSources()
    const activeSource = getActiveSource()
    if (activeSource) {
      const provider = await restoreSource(activeSource.id)
      if (!provider) return false
      await setActiveSource(activeSource.id)
      await initWithProvider(activeSource.providerType)
      return true
    }

    const fallback = new IndexedDbProvider()
    await fallback.restore()
    setActiveProvider(fallback)
    await initWithProvider(PROVIDERS.LOCAL_STORAGE)
    return true
  }

  // Subscribe to sync status changes. The engine fires a status object on every
  // backup nudge; most are value-identical and rapid save cycles flip the state
  // back and forth many times a second. Feeding each straight into React state
  // thrashes the board and defeats Playwright's quiescence gate (#133), so route
  // them through a coalescer that dedups identical churn and coalesces bursts.
  useEffect(() => {
    const coalescer = makeSyncStatusCoalescer({ apply: setSyncStatus })
    const unsubscribe = storage.subscribeSyncStatus((status) => coalescer.push(status))
    return () => {
      coalescer.cancel()
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let debounceTimer = null
    const scheduleSweep = () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        if (document.visibilityState && document.visibilityState !== 'visible') return
        sweepCurrentPlanSnoozes()
      }, 150)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleSweep()
    }
    window.addEventListener('focus', scheduleSweep)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearTimeout(debounceTimer)
      window.removeEventListener('focus', scheduleSweep)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [sweepCurrentPlanSnoozes])

  useEffect(() => {
    const target = selectedFile
    if (target !== PLAN_FILE || !content) return
    const delay = ops.nextWakeTimeoutMs(content, new Date())
    if (delay === null) return
    const timer = setTimeout(() => {
      Promise.resolve(sweepCurrentPlanSnoozes()).finally(() => setSnoozeTimerNonce(k => k + 1))
    }, delay)
    return () => clearTimeout(timer)
  }, [content, selectedFile, snoozeTimerNonce, sweepCurrentPlanSnoozes])

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

  // Refresh the sidebar tree when the tab regains focus/visibility. External
  // processes (e.g. the overnight agent, or OneDrive/Drive sync from another
  // device) can add journals to the folder while this tab is open. The browser
  // cannot observe those filesystem writes — `onLocalChange` only fires for the
  // app's own writes and sync pulls — so without this, externally-added files
  // (e.g. an agent-created journal) stay invisible in the sidebar until a manual
  // reload. Re-fetching the tree on focus/visibility picks them up as soon as
  // the user returns to the tab. Debounced so a focus+visibility burst triggers
  // only one reload. (task #371)
  useEffect(() => {
    let refreshTimer = null
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => { loadFiles().catch(() => {}) }, 300)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleRefresh()
    }
    window.addEventListener('focus', scheduleRefresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(refreshTimer)
      window.removeEventListener('focus', scheduleRefresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const handleStorageReady = async (providerId) => {
    await initWithProvider(providerId)
  }

  const handleNavigate = (path, scrollToTaskId, initialView) => {
    pendingJournalDeepLink = null
    if (scrollToTaskId) setPendingScrollToTaskId(scrollToTaskId)
    // #373: honour the icon that was clicked (Journal vs Chat). Default to chat.
    setJournalInitialView(initialView === 'journal' ? 'journal' : 'chat')
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
    try {
      contentWriteInFlightRef.current = true
      await storage.write(selectedFile, newContent)
      setContent(newContent)
    } catch (err) {
      console.error('Failed to update file:', err)
      throw err
    } finally {
      contentWriteInFlightRef.current = false
    }
  }

  if (appState === 'loading') {
    return <div className="loading">Loading planner...</div>
  }

  if (appState === 'pick-storage') {
    return <StoragePicker onReady={handleStorageReady} />
  }

  const localPath = selectedFile
  const isFocusPlan = localPath === PLAN_FILE
  const isCompletedPlan = localPath === COMPLETED_FILE
  const isAgentSettingsFile = localPath === AI_SETTINGS_FILE
  const isAgentGateFile = localPath === AGENT_GATE_FILE
  const isJournal = !isFocusPlan && !isCompletedPlan &&
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
          onDataChanged={loadFiles}
          onOpenFile={handleSelectFile}
        />
      </aside>
      <main ref={contentRef} className={`content${isJournal ? ' content-chat' : ''}`}>
        {sourceNotice && (
          <div className="source-notice" role="status">
            <span>
              Only {getActiveSource()?.name || 'one storage source'} is shown. Not shown: {sourceNotice.join(', ')}.
              {' '}Switch sources in Settings. Other sources and their data remain untouched.
            </span>
            <button
              type="button"
              onClick={() => { dismissMultiSourceNotice(); setSourceNotice(null) }}
              aria-label="Dismiss storage source notice"
            >Dismiss</button>
          </div>
        )}
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
          {selectedFile && <span className="mobile-file-name">{selectedFile.replace(/.*\//, '')}</span>}
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
        {mission && !isJournal && !isFocusPlan && !isAgentSettingsFile && !isAgentGateFile && (
          <div className="mission-banner" role="note" aria-label="Mission statement">
            <span className="mission-banner-icon" aria-hidden="true">✦</span>
            <p className="mission-banner-text">{mission}</p>
          </div>
        )}
        {isAgentSettingsFile ? (
          <AgentSettingsEditor
            activeSourceId={getActiveSourceId()}
            onSaved={(text) => {
              setContent(text)
              loadFiles().catch(() => {})
            }}
          />
        ) : isAgentGateFile ? (
          <AgentGateEditor
            activeSourceId={getActiveSourceId()}
            onSaved={(text) => {
              setContent(text)
              loadFiles().catch(() => {})
            }}
          />
        ) : content ? (
          isFocusPlan ? (
            <FocusPlanView
              content={content}
              onNavigate={handleNavigate}
              onContentUpdate={handleContentUpdate}
              sourceId={getActiveSourceId()}
              search={boardSearch}
              onSearchChange={setBoardSearch}
              mission={mission}
              syncStatus={syncStatus}
              onDataChanged={loadFiles}
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
              initialView={journalInitialView}
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
