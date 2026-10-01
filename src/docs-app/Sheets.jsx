// Sheets and panels for the Docs doc view: comment composer, comments panel,
// outline and version history (plans/docs-app-design.md §7).
import { useEffect, useRef, useState } from 'react'
import { INTENTS, INTENT_META } from '../../packages/docs-core/src/index.js'
import { excerpt, timeAgo } from './util.js'

export function Sheet({ title, onClose, children, className = '', side = false }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className={`dx-sheet-layer${side ? ' dx-side' : ''}`} role="dialog" aria-label={title}>
      <div className="dx-scrim" onClick={onClose} />
      <div className={`dx-sheet ${className}`}>
        <div className="dx-sheet-grip" aria-hidden="true" />
        <div className="dx-sheet-head">
          <h2>{title}</h2>
          <button type="button" className="dx-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="dx-sheet-body">{children}</div>
      </div>
    </div>
  )
}

export function IntentChips({ value, onChange }) {
  return (
    <div className="dx-intents" role="radiogroup" aria-label="Intent">
      {INTENTS.map((i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={value === i}
          className={`dx-chip dx-intent-${i}${value === i ? ' is-on' : ''}`}
          onClick={() => onChange(i)}
        >{INTENT_META[i].icon} {INTENT_META[i].label}</button>
      ))}
    </div>
  )
}

export function CommentSheet({ quote, initial, onSave, onCancel, onDelete }) {
  const [intent, setIntent] = useState(initial?.intent || 'question')
  const [body, setBody] = useState(initial?.body || '')
  const ref = useRef(null)
  useEffect(() => { const t = setTimeout(() => ref.current?.focus(), 250); return () => clearTimeout(t) }, [])
  const canSave = intent === 'approve' || body.trim().length > 0
  return (
    <Sheet title={initial ? 'Edit comment' : 'Comment'} onClose={onCancel} className="dx-comment-sheet">
      <blockquote className="dx-quote">{excerpt(quote, 220)}</blockquote>
      <IntentChips value={intent} onChange={setIntent} />
      <textarea
        ref={ref}
        className="dx-textarea"
        rows={3}
        placeholder={intent === 'approve' ? 'Optional note with your approval…' : 'Your comment…'}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="dx-sheet-actions">
        {onDelete && <button type="button" className="dx-btn dx-btn-danger" onClick={onDelete}>Delete draft</button>}
        <span className="dx-spacer" />
        <button type="button" className="dx-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="dx-btn dx-btn-primary" disabled={!canSave} onClick={() => onSave({ intent, body: body.trim() })}>Save draft</button>
      </div>
      <p className="dx-hint">Drafts stay on this device until you tap <b>Send to agent</b>.</p>
    </Sheet>
  )
}

const TAB_LABEL = { open: 'Open', outdated: 'Outdated', resolved: 'Resolved' }
const DISP_LABEL = { answered: 'Answered', done: 'Done', 'needs-you': 'Needs you', declined: 'Declined' }

export function CommentsPanel({ items, side, initialTab = 'open', focusId, onClose, onGoTo, onEdit, onReopen }) {
  const [tab, setTab] = useState(initialTab)
  const counts = { open: 0, outdated: 0, resolved: 0 }
  for (const it of items) counts[it.group]++
  const list = items.filter((it) => it.group === tab)
  return (
    <Sheet title="Comments" onClose={onClose} side={side} className="dx-comments">
      <div className="dx-tabs" role="tablist">
        {Object.keys(TAB_LABEL).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`dx-tab${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]} <span className="dx-count">{counts[t]}</span>
          </button>
        ))}
      </div>
      {list.length === 0 && <p className="dx-empty">No {TAB_LABEL[tab].toLowerCase()} comments.</p>}
      <ul className="dx-comment-list">
        {list.map((it) => (
          <li key={it.id} className={`dx-comment${focusId === it.id ? ' is-focus' : ''}`} data-comment={it.id}>
            <div className="dx-comment-head">
              <span className="dx-intent-icon" title={INTENT_META[it.intent]?.label}>{INTENT_META[it.intent]?.icon || '💬'}</span>
              {it.status === 'draft' && <span className="dx-pill dx-pill-draft">Draft</span>}
              {it.status === 'needs-you' && <span className="dx-pill dx-pill-needs">Needs you</span>}
              {it.reopened && it.status !== 'resolved' && <span className="dx-pill">Reopened</span>}
              {it.placed?.status === 'moved' && <span className="dx-pill" title="The text moved to another paragraph">Moved</span>}
              <span className="dx-spacer" />
              <span className="dx-meta">{it.rev ? `r${it.rev}` : ''}{it.createdAt ? ` · ${timeAgo(it.createdAt)}` : ''}</span>
            </div>
            <button type="button" className="dx-comment-quote" onClick={() => onGoTo(it)} disabled={it.group === 'outdated'} title={it.group === 'outdated' ? 'This text is no longer in the document' : 'Go to text'}>
              “{excerpt(it.anchor?.quote, 140)}”
            </button>
            {it.body && <p className="dx-comment-body">{it.body}</p>}
            {it.disposition && (
              <div className={`dx-disposition dx-disp-${it.disposition.status}`}>
                <span>🤖 {DISP_LABEL[it.disposition.status] || it.disposition.status} in r{it.disposition.rev}</span>
                {it.disposition.note && <span> — {it.disposition.note}</span>}
                {it.disposition.blocks?.[0] && (
                  <button type="button" className="dx-link-btn" onClick={() => onGoTo({ ...it, goBlock: it.disposition.blocks[0] })}>see answer</button>
                )}
              </div>
            )}
            <div className="dx-comment-actions">
              {it.status === 'draft' && <button type="button" className="dx-link-btn" onClick={() => onEdit(it)}>Edit</button>}
              {it.group === 'resolved' && <button type="button" className="dx-link-btn" onClick={() => onReopen(it)}>Reopen</button>}
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

export function OutlineSheet({ items, onClose, onGo }) {
  return (
    <Sheet title="Outline" onClose={onClose}>
      {items.length === 0 && <p className="dx-empty">This document has no headings.</p>}
      <ul className="dx-outline">
        {items.map((h) => (
          <li key={h.id} style={{ paddingLeft: `${(h.level - 2) * 16}px` }}>
            <button type="button" className="dx-link-btn" onClick={() => onGo(h.id)}>{h.text}</button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

export function HistorySheet({ revisions, currentRev, viewingRev, onClose, onView }) {
  const sorted = [...revisions].sort((a, b) => b.rev - a.rev)
  return (
    <Sheet title="Version history" onClose={onClose}>
      <ul className="dx-history">
        {sorted.map((r) => (
          <li key={r.rev}>
            <button type="button" className={`dx-history-item${(viewingRev ?? currentRev) === r.rev ? ' is-on' : ''}`} onClick={() => onView(r.rev === currentRev ? null : r.rev)}>
              <span className="dx-history-rev">r{r.rev}{r.rev === currentRev ? ' · current' : ''}</span>
              <span className="dx-meta">{timeAgo(r.at)}{r.by ? ` · ${r.by}` : ''}</span>
              <span className="dx-history-summary">{r.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
