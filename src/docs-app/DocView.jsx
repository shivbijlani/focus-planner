// The phone-first document view (plans/docs-app-design.md §7 "Doc view" + "Commenting").
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MarkdownBlocks } from '../markdown/MarkdownBlocks.jsx'
import {
  parseDocHref, docHref, reanchor, commentStatus, changedBlockIds, outline, linkedFrom, newCommentId,
  INTENT_META,
} from '../../packages/docs-core/src/index.js'
import {
  loadDoc, loadHistory, loadDrafts, saveDrafts, sendDrafts, markRead, reopen,
} from './docsStore.js'
import { selectionToAnchor, blockAnchor, blockTexts, rangeFor, paintHighlights, BLOCK_SEL } from './selection.js'
import { CommentSheet, CommentsPanel, OutlineSheet, HistorySheet } from './Sheets.jsx'
import { timeAgo, plannerJournalHref, excerpt } from './util.js'

const BASE = import.meta.env?.BASE_URL || '/'
const DISP_SHORT = { answered: 'Answered', done: 'Done', 'needs-you': 'Needs you', declined: 'Declined' }

const Block = memo(function Block({ block, changed, count, notes, linkHandler, onBadge }) {
  return (
    <section className={`dv-block dv-k-${block.kind}${changed ? ' is-changed' : ''}${count > 0 ? ' has-badge' : ''}`} id={`blk-${block.id}`}>
      <div className="dv-block-body" data-block={block.id}>
        <MarkdownBlocks lines={block.lines} options={{ fences: true, linkHandler }} />
      </div>
      {count > 0 && (
        <button type="button" className="dv-badge" onClick={() => onBadge(block.id)} aria-label={`${count} comments on this section`}>💬 {count}</button>
      )}
      {notes?.length > 0 && (
        <div className="dv-notes">
          {notes.map((n) => (
            <button type="button" key={n.id} className={`dv-note dv-disp-${n.disposition.status}`} onClick={() => onBadge(block.id, n.id)}>
              <span className="dv-note-icon">{INTENT_META[n.intent]?.icon}</span>
              <span className="dv-note-text">🤖 {DISP_SHORT[n.disposition.status] || n.disposition.status} r{n.disposition.rev}{n.disposition.note ? ` — ${excerpt(n.disposition.note, 80)}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
})

function useIsWide() {
  const q = '(min-width: 900px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches)
  useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const on = () => setWide(m.matches)
    m.addEventListener?.('change', on)
    return () => m.removeEventListener?.('change', on)
  }, [])
  return wide
}

export default function DocView({ docId, index, route, onOpenDoc, onBack, reloadKey }) {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [drafts, setDrafts] = useState(() => loadDrafts(docId))
  const [baseline, setBaseline] = useState(null) // { readRev, changed:Set }
  const [viewing, setViewing] = useState(null) // { rev, parsed, changed }
  const [placements, setPlacements] = useState({})
  const [pill, setPill] = useState(null)
  const [sheet, setSheet] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const [sending, setSending] = useState(false)
  const articleRef = useRef(null)
  const markedReadRef = useRef(false)
  const wide = useIsWide()

  const entry = index?.docs?.[docId] || null
  const taskId = entry?.task ?? null

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600) }

  // Load (and reload on remote change) the doc, its review and response.
  useEffect(() => {
    let cancelled = false
    loadDoc(docId, index).then(async (d) => {
      if (cancelled) return
      if (!d) { setLoadError('This document is not on this device yet.'); return }
      setData(d)
      setLoadError(null)
      setBaseline((prev) => {
        if (prev && prev.docId === docId) return prev
        const readRev = d.review.readRev || 0
        const rev = d.parsed.header?.rev ?? d.response.rev
        const b = { docId, readRev, rev, changed: new Set() }
        if (readRev > 0 && readRev < rev) {
          loadHistory(docId, readRev, index?.docs?.[docId]).then((h) => {
            if (!cancelled && h) setBaseline({ ...b, changed: changedBlockIds(d.parsed, h) })
          })
        }
        return b
      })
    }).catch((e) => !cancelled && setLoadError(String(e?.message || e)))
    return () => { cancelled = true }
  }, [docId, index, reloadKey])

  useEffect(() => { setDrafts(loadDrafts(docId)); markedReadRef.current = false; setViewing(null); setBaseline(null) }, [docId])
  useEffect(() => { saveDrafts(docId, drafts) }, [docId, drafts])

  const rev = data ? (data.parsed.header?.rev ?? data.response.rev) : 0
  const shown = viewing ? viewing.parsed : data?.parsed
  const changed = useMemo(() => (viewing ? viewing.changed : baseline?.changed || new Set()), [viewing, baseline])
  const readOnly = !!viewing

  // All comments (sent + drafts) with derived status, disposition and placement.
  const items = useMemo(() => {
    if (!data) return []
    const disp = data.response.dispositions || {}
    const sent = Object.entries(data.review.comments || {}).map(([id, c]) => ({
      id, ...c, status: commentStatus(c, disp[id]), reopened: c.status === 'reopened', disposition: disp[id] || null,
    }))
    const local = drafts.map((d) => ({ ...d, status: 'draft', disposition: null }))
    return [...local, ...sent].map((it) => {
      const placed = placements[it.id]
      const group = it.status === 'resolved' ? 'resolved' : (placed?.status === 'outdated' ? 'outdated' : 'open')
      return { ...it, placed, group }
    })
  }, [data, drafts, placements])

  // Re-anchor every comment against the rendered text after each render of the doc.
  useLayoutEffect(() => {
    if (!data || viewing || !articleRef.current) return
    const texts = blockTexts(articleRef.current)
    const next = {}
    for (const c of Object.entries(data.review.comments || {})) next[c[0]] = reanchor(c[1].anchor, texts)
    for (const d of drafts) next[d.id] = reanchor(d.anchor, texts)
    setPlacements((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }, [data, drafts, viewing])

  // Paint highlights: open sent comments, drafts, and the focused one.
  useEffect(() => {
    const root = articleRef.current
    if (!root || viewing) return undefined
    const focusId = sheet?.type === 'comments' ? sheet.focusId : null
    const groups = { 'docs-comment': [], 'docs-draft': [], 'docs-focus': [] }
    for (const it of items) {
      if (it.group !== 'open') continue
      const r = rangeFor(root, it.placed)
      if (!r) continue
      if (it.id === focusId) groups['docs-focus'].push(r)
      else if (it.status === 'draft') groups['docs-draft'].push(r)
      else groups['docs-comment'].push(r)
    }
    return paintHighlights(root, groups)
  }, [items, viewing, sheet])

  // Native selection → our floating pill (iOS won't let us extend its own menu).
  useEffect(() => {
    if (readOnly) return undefined
    let t = null
    const onChange = () => {
      clearTimeout(t)
      t = setTimeout(() => {
        if (!articleRef.current) return
        const got = selectionToAnchor(articleRef.current)
        setPill((p) => {
          if (got) return { mode: 'selection', ...got }
          return p?.mode === 'block' ? p : null
        })
      }, 120)
    }
    document.addEventListener('selectionchange', onChange)
    return () => { clearTimeout(t); document.removeEventListener('selectionchange', onChange) }
  }, [readOnly])

  // Tap-hold a block (no text selected) → "Comment on this paragraph".
  const pressRef = useRef(null)
  const onPointerDown = (e) => {
    if (readOnly || e.button > 0) return
    const body = e.target.closest?.(BLOCK_SEL)
    if (!body) return
    const x = e.clientX
    const y = e.clientY
    clearTimeout(pressRef.current?.t)
    pressRef.current = {
      x, y,
      t: setTimeout(() => {
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed) return
        const r = body.getBoundingClientRect()
        setPill({ mode: 'block', anchor: blockAnchor(body), rect: { top: r.top, bottom: Math.min(r.bottom, y + 24), left: r.left, right: r.right, width: r.width } })
      }, 600),
    }
  }
  const cancelPress = (e) => {
    const p = pressRef.current
    if (!p) return
    if (e?.type === 'pointermove' && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 10) return
    clearTimeout(p.t)
    pressRef.current = null
  }
  const onContextMenu = (e) => {
    const sel = window.getSelection()
    if (readOnly || (sel && !sel.isCollapsed)) return
    const body = e.target.closest?.(BLOCK_SEL)
    if (!body) return
    e.preventDefault()
    const r = body.getBoundingClientRect()
    setPill({ mode: 'block', anchor: blockAnchor(body), rect: { top: r.top, bottom: Math.min(r.bottom, e.clientY + 24), left: r.left, right: r.right, width: r.width } })
  }

  // Tap on highlighted text opens its comment.
  const onArticleClick = (e) => {
    if (readOnly) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    if (e.target.closest?.('a,button')) return
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY)
      || (document.caretPositionFromPoint && (() => { const p = document.caretPositionFromPoint(e.clientX, e.clientY); if (!p) return null; const r = document.createRange(); r.setStart(p.offsetNode, p.offset); return r })())
    if (!pos) return
    for (const it of items) {
      if (it.group !== 'open') continue
      const r = rangeFor(articleRef.current, it.placed)
      try {
        if (r && r.isPointInRange(pos.startContainer, pos.startOffset)) { setSheet({ type: 'comments', tab: 'open', focusId: it.id }); return }
      } catch { /* detached */ }
    }
    if (pill?.mode === 'block') setPill(null)
  }

  const clearSelection = () => { try { window.getSelection()?.removeAllRanges() } catch { /* ignore */ } }

  const addDraft = (anchor, intent, body) => {
    const d = { id: newCommentId(), anchor, intent, body: body || '', createdAt: new Date().toISOString(), rev }
    setDrafts((ds) => [...ds, d])
    return d
  }

  const onPillComment = () => {
    const a = pill?.anchor
    setPill(null)
    if (a) setSheet({ type: 'comment', anchor: a })
  }
  const onPillApprove = () => {
    const a = pill?.anchor
    setPill(null)
    clearSelection()
    if (!a) return
    addDraft(a, 'approve', '')
    flash(`✅ Approved “${excerpt(a.quote, 40)}” — draft saved`)
  }

  const saveComment = ({ intent, body }) => {
    if (sheet.editId) {
      setDrafts((ds) => ds.map((d) => (d.id === sheet.editId ? { ...d, intent, body } : d)))
    } else {
      addDraft(sheet.anchor, intent, body)
    }
    setSheet(null)
    clearSelection()
    flash('Draft saved')
  }

  const doSend = async () => {
    if (!drafts.length || sending) return
    setSending(true)
    try {
      const { review } = await sendDrafts(docId, drafts, rev)
      setData((d) => ({ ...d, review }))
      const n = drafts.length
      setDrafts([])
      flash(`Sent ${n} comment${n === 1 ? '' : 's'} to the agent`)
    } catch (e) {
      flash(`Couldn't send: ${e?.message || e}`)
    } finally {
      setSending(false)
    }
  }

  const doMarkRead = useCallback(async (quiet) => {
    if (!data || viewing) return
    if ((data.review.readRev || 0) >= rev) return
    try {
      const review = await markRead(docId, rev)
      setData((d) => ({ ...d, review }))
      if (!quiet) flash(`Marked r${rev} as read`)
    } catch { /* offline: try again next time */ }
  }, [data, viewing, rev, docId])

  // readRev advances when the reader reaches the end of the doc.
  const endRef = useRef(null)
  useEffect(() => {
    const el = endRef.current
    if (!el || !data || viewing || typeof IntersectionObserver === 'undefined') return undefined
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting) && !markedReadRef.current) {
        markedReadRef.current = true
        doMarkRead(true)
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [data, viewing, doMarkRead])

  const scrollToBlock = useCallback((id, flashIt = true) => {
    const el = document.getElementById(`blk-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (flashIt) { el.classList.add('is-flash'); setTimeout(() => el.classList.remove('is-flash'), 1600) }
  }, [])

  // Deep link: ?block= and ?comment=
  useEffect(() => {
    if (!data || !route) return
    if (route.block) setTimeout(() => scrollToBlock(route.block), 150)
    if (route.comment) setSheet({ type: 'comments', tab: 'open', focusId: route.comment })
  }, [data, route, scrollToBlock])

  const linkHandler = useCallback((href, label, key) => {
    const d = parseDocHref(href)
    if (d) {
      const known = !!index?.docs?.[d.docId]
      return (
        <a key={key} href={docHref(d.docId, { block: d.block })} className={`doc-link${known ? '' : ' is-missing'}`}
          onClick={(e) => { e.preventDefault(); onOpenDoc(d.docId, d.block) }}>📄 {label}</a>
      )
    }
    const j = href.match(/^journal\/task-(\d+)\.md$/)
    if (j) return <a key={key} href={plannerJournalHref(j[1], BASE)} className="internal-link">{label}</a>
    return null
  }, [index, onOpenDoc])

  const onBadge = useCallback((blockId, focusId) => {
    setSheet({ type: 'comments', tab: 'open', focusId: focusId || null, block: blockId })
  }, [])

  const blockCounts = useMemo(() => {
    const m = {}
    for (const it of items) {
      if (it.group !== 'open') continue
      const b = it.placed?.block || it.anchor?.block
      m[b] = (m[b] || 0) + 1
    }
    return m
  }, [items])
  const blockNotes = useMemo(() => {
    const m = {}
    for (const it of items) {
      if (!it.disposition || it.group === 'outdated') continue
      const b = it.placed?.block || it.anchor?.block
      ;(m[b] = m[b] || []).push(it)
    }
    return m
  }, [items])

  const changedList = useMemo(() => (shown?.blocks || []).filter((b) => changed.has(b.id)).map((b) => b.id), [shown, changed])
  const nextChange = () => {
    const y = window.innerHeight * 0.35
    const next = changedList.find((id) => (document.getElementById(`blk-${id}`)?.getBoundingClientRect().top ?? 0) > y + 4) || changedList[0]
    if (next) scrollToBlock(next)
  }

  const viewRev = async (r) => {
    setSheet(null)
    if (r == null) { setViewing(null); return }
    const [h, prev] = await Promise.all([
      loadHistory(docId, r, entry),
      r > 1 ? loadHistory(docId, r - 1, entry) : null,
    ])
    if (!h) { flash(`r${r} isn't in history`); return }
    setViewing({ rev: r, parsed: h, changed: prev ? changedBlockIds(h, prev) : new Set() })
    window.scrollTo({ top: 0 })
  }

  if (loadError) {
    return (
      <div className="dv">
        <AppBar title={entry?.title || docId} onBack={onBack} />
        <div className="dx-empty-page"><p>{loadError}</p><p className="dx-hint">If you just created it, give sync a moment and pull to refresh.</p></div>
      </div>
    )
  }
  if (!data) return <div className="dv"><AppBar title={entry?.title || ''} onBack={onBack} /><div className="dx-loading">Loading…</div></div>

  const openCount = items.filter((i) => i.group === 'open').length
  const revisions = data.response.revisions?.length ? data.response.revisions : [{ rev, at: data.parsed.header?.published, summary: '' }]
  const viewingSummary = viewing ? revisions.find((r) => r.rev === viewing.rev)?.summary : null
  const from = linkedFrom(index, docId)
  const status = shown.statusLine
  const published = viewing ? revisions.find((r) => r.rev === viewing.rev)?.at : data.parsed.header?.published

  return (
    <div className={`dv${wide && sheet?.type === 'comments' ? ' has-side' : ''}`}>
      <AppBar
        title={shown.title || entry?.title || docId}
        onBack={onBack}
        taskId={taskId}
        commentCount={openCount}
        onComments={() => setSheet({ type: 'comments', tab: 'open' })}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        menu={[
          { label: 'Outline', icon: '☰', action: () => setSheet({ type: 'outline' }) },
          { label: 'Version history', icon: '🕘', action: () => setSheet({ type: 'history' }) },
          { label: `Comments (${openCount})`, icon: '💬', action: () => setSheet({ type: 'comments', tab: 'open' }) },
          ...(viewing ? [] : [{ label: 'Mark read', icon: '✓', action: () => doMarkRead(false) }]),
        ]}
      />

      <button type="button" className={`dv-status${status ? '' : ' is-plain'}`} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        <span className="dv-status-text">{status || shown.title}</span>
        <span className="dv-status-meta">r{viewing ? viewing.rev : rev}{published ? ` · ${timeAgo(published)}` : ''}</span>
      </button>

      {viewing && (
        <div className="dv-version-banner">
          <span>Viewing <b>r{viewing.rev}</b>{viewingSummary ? ` — ${viewingSummary}` : ''}</span>
          <button type="button" className="dx-btn dx-btn-small" onClick={() => setViewing(null)}>Back to current</button>
        </div>
      )}
      {!viewing && changedList.length > 0 && (
        <div className="dv-changes-banner">
          <span>{changedList.length} section{changedList.length === 1 ? '' : 's'} changed since you read r{baseline.readRev}</span>
          <button type="button" className="dx-btn dx-btn-small" onClick={nextChange}>Next change ↓</button>
        </div>
      )}

      <article
        className="dv-page"
        ref={articleRef}
        onPointerDown={onPointerDown}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerMove={cancelPress}
        onContextMenu={onContextMenu}
        onClick={onArticleClick}
      >
        <h1 className="dv-title">{shown.title}</h1>
        {taskId != null && <Trio taskId={taskId} telegram={entry?.telegramUrl} current />}
        {shown.blocks.map((b) => (
          <Block
            key={`${viewing ? viewing.rev : 'cur'}-${b.id}`}
            block={b}
            changed={changed.has(b.id)}
            count={viewing ? 0 : blockCounts[b.id] || 0}
            notes={viewing ? null : blockNotes[b.id]}
            linkHandler={linkHandler}
            onBadge={onBadge}
          />
        ))}
        <footer className="dv-foot" ref={endRef}>
          {from.length > 0 && (
            <div className="dv-linked-from">
              <div className="dv-foot-label">Linked from</div>
              {from.map((id) => (
                <a key={id} href={docHref(id)} className="doc-link" onClick={(e) => { e.preventDefault(); onOpenDoc(id) }}>📄 {index.docs[id]?.title || id}</a>
              ))}
            </div>
          )}
          {taskId != null && <Trio taskId={taskId} telegram={entry?.telegramUrl} current />}
          <div className="dv-foot-meta">{docId} · r{rev}{data.parsed.header?.by ? ` · published by ${data.parsed.header.by}` : ''}</div>
        </footer>
      </article>

      {!viewing && changedList.length > 1 && !sheet && (
        <button type="button" className="dv-fab" onClick={nextChange} aria-label="Next change">↓ Next change</button>
      )}

      {pill && !sheet && (
        <SelectionPill rect={pill.rect} mode={pill.mode} onComment={onPillComment} onApprove={onPillApprove} onDismiss={() => setPill(null)} />
      )}

      {drafts.length > 0 && !viewing && (!sheet || (wide && sheet.type === 'comments')) && (
        <div className="dv-sendbar">
          <span>{drafts.length} draft{drafts.length === 1 ? '' : 's'} on this device</span>
          <button type="button" className="dx-btn dx-btn-primary" onClick={doSend} disabled={sending}>
            {sending ? 'Sending…' : `Send to agent (${drafts.length})`}
          </button>
        </div>
      )}

      {sheet?.type === 'comment' && (
        <CommentSheet
          quote={sheet.anchor.quote}
          initial={sheet.editId ? drafts.find((d) => d.id === sheet.editId) : null}
          onSave={saveComment}
          onCancel={() => setSheet(null)}
          onDelete={sheet.editId ? () => { setDrafts((ds) => ds.filter((d) => d.id !== sheet.editId)); setSheet(null) } : null}
        />
      )}
      {sheet?.type === 'comments' && (
        <CommentsPanel
          items={sheet.block ? items.filter((i) => (i.placed?.block || i.anchor?.block) === sheet.block || i.id === sheet.focusId) : items}
          side={wide}
          initialTab={sheet.tab}
          focusId={sheet.focusId}
          onClose={() => setSheet(null)}
          onGoTo={(it) => {
            if (!wide) setSheet(null)
            else setSheet((s) => ({ ...s, focusId: it.id }))
            setTimeout(() => scrollToBlock(it.goBlock || it.placed?.block || it.anchor?.block), 60)
          }}
          onEdit={(it) => setSheet({ type: 'comment', anchor: it.anchor, editId: it.id })}
          onReopen={async (it) => {
            try {
              const review = await reopen(docId, it.id, rev)
              setData((d) => ({ ...d, review }))
              flash('Reopened — the agent will see it on the next review')
            } catch (e) { flash(`Couldn't reopen: ${e?.message || e}`) }
          }}
        />
      )}
      {sheet?.type === 'outline' && (
        <OutlineSheet items={outline(shown)} onClose={() => setSheet(null)} onGo={(id) => { setSheet(null); setTimeout(() => scrollToBlock(id), 60) }} />
      )}
      {sheet?.type === 'history' && (
        <HistorySheet revisions={revisions} currentRev={rev} viewingRev={viewing?.rev} onClose={() => setSheet(null)} onView={viewRev} />
      )}

      {toast && <div className="dx-toast" role="status">{toast}</div>}
    </div>
  )
}

export function Trio({ taskId, telegram, current }) {
  return (
    <nav className="dx-trio" aria-label="Task links">
      {telegram && <a className="dx-trio-link" href={telegram} target="_blank" rel="noopener noreferrer">💬 Telegram</a>}
      <a className="dx-trio-link" href={plannerJournalHref(taskId, BASE)}>📔 Journal</a>
      <span className={`dx-trio-link${current ? ' is-current' : ''}`} aria-current={current ? 'page' : undefined}>📄 Catch-up</span>
    </nav>
  )
}

function AppBar({ title, onBack, taskId, commentCount, onComments, menu, menuOpen, setMenuOpen }) {
  return (
    <header className="dv-appbar">
      <button type="button" className="dx-icon-btn" onClick={onBack} aria-label="Back">‹</button>
      <div className="dv-appbar-title" title={title}>{title}</div>
      {taskId != null && <a className="dx-task-chip" href={plannerJournalHref(taskId, BASE)} title="Open the task's journal in Focus Planner">#{taskId}</a>}
      {onComments && (
        <button type="button" className="dx-icon-btn dv-comments-btn" onClick={onComments} aria-label={`Comments (${commentCount})`}>
          💬{commentCount > 0 && <span className="dx-dot-count">{commentCount}</span>}
        </button>
      )}
      {menu && (
        <div className="dx-menu-wrap">
          <button type="button" className="dx-icon-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="More" aria-expanded={menuOpen}>⋮</button>
          {menuOpen && (
            <>
              <div className="dx-menu-scrim" onClick={() => setMenuOpen(false)} />
              <ul className="dx-menu" role="menu">
                {menu.map((m) => (
                  <li key={m.label}><button type="button" role="menuitem" onClick={() => { setMenuOpen(false); m.action() }}><span>{m.icon}</span>{m.label}</button></li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </header>
  )
}

function SelectionPill({ rect, mode, onComment, onApprove, onDismiss }) {
  const vw = window.innerWidth
  const vh = window.visualViewport?.height || window.innerHeight
  const width = mode === 'block' ? 260 : 220
  // Below the selection: iOS draws its own callout above it.
  let top = rect.bottom + 12
  if (top > vh - 70) top = Math.max(8, rect.top - 60)
  const left = Math.max(8, Math.min(vw - width - 8, (rect.left + rect.right) / 2 - width / 2))
  const keep = (e) => e.preventDefault() // keep the native selection alive while tapping
  return (
    <div className="dx-pill-bar" style={{ top, left, width }} role="toolbar" aria-label="Comment on selection" onPointerDown={keep} onMouseDown={keep}>
      <button type="button" onClick={onComment}>💬 {mode === 'block' ? 'Comment on this paragraph' : 'Comment'}</button>
      {mode !== 'block' && <button type="button" onClick={onApprove}>✅ Approve</button>}
      {mode === 'block' && <button type="button" className="dx-pill-x" onClick={onDismiss} aria-label="Dismiss">✕</button>}
    </div>
  )
}
