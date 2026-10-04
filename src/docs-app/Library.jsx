// Docs home: Needs you / Recent / All, search by title or task number (§7 Home).
import { useEffect, useMemo, useState } from 'react'
import { deriveDocState, docHref } from '../../packages/docs-core/src/index.js'
import { loadReviewSummary, draftCount } from './docsStore.js'
import { filterLibrary, timeAgo } from './util.js'

const TABS = [['needs', 'Needs you'], ['recent', 'Recent'], ['all', 'All']]

export default function Library({ index, onOpenDoc, plannerHref, reloadKey }) {
  const [summaries, setSummaries] = useState({})
  const [loadError, setLoadError] = useState(null)
  const [tab, setTab] = useState(() => sessionStorage.getItem('fp-docs-tab') || 'needs')
  const [q, setQ] = useState('')

  useEffect(() => { sessionStorage.setItem('fp-docs-tab', tab) }, [tab])
  useEffect(() => {
    let cancelled = false
    const ids = Object.keys(index?.docs || {})
    Promise.all(ids.map(async (id) => [id, await loadReviewSummary(id)])).then((pairs) => {
      if (!cancelled) {
        setSummaries(Object.fromEntries(pairs))
        setLoadError(null)
      }
    }).catch((e) => {
      if (!cancelled) setLoadError(String(e?.message || e))
    })
    return () => { cancelled = true }
  }, [index, reloadKey])

  const cards = useMemo(() => Object.entries(index?.docs || {}).map(([id, e]) => {
    const s = summaries[id]
    const st = deriveDocState({ entry: e, review: s?.review, response: s?.response, drafts: draftCount(id) })
    return {
      id, title: e.title || id, task: e.task ?? null, primary: !!e.primary, updatedAt: e.updatedAt,
      rev: st.rev, unread: s ? st.unread : false, needsYou: st.needsYou, open: st.openCount, drafts: st.drafts, state: st.state,
    }
  }), [index, summaries])

  const list = filterLibrary(cards, tab, q)

  return (
    <div className="lib">
      <header className="lib-bar">
        <div className="lib-brand"><span className="lib-logo" aria-hidden="true">📄</span> Docs</div>
        <a className="dx-task-chip" href={plannerHref} title="Open Focus Planner">Planner ↗</a>
      </header>
      <div className="lib-search">
        <input type="search" inputMode="search" placeholder="Search title or task #" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search docs" />
      </div>
      <div className="dx-tabs lib-tabs" role="tablist">
        {TABS.map(([k, label]) => {
          const n = k === 'needs' ? filterLibrary(cards, 'needs', q).length : null
          return (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`dx-tab${tab === k ? ' is-on' : ''}`} onClick={() => setTab(k)}>
              {label}{n ? <span className="dx-count">{n}</span> : null}
            </button>
          )
        })}
      </div>
      {!index && <div className="dx-empty-page"><p>No documents yet.</p><p className="dx-hint">Catch-up docs appear here once a task's journal gets long enough for the agent to write one.</p></div>}
      {loadError && <div className="dx-empty-page" role="alert"><p>Docs data is invalid or unavailable.</p><p>{loadError}</p></div>}
      {index && list.length === 0 && <p className="dx-empty">{tab === 'needs' ? 'Nothing needs you. 🎉' : 'No documents match.'}</p>}
      <ul className="lib-list">
        {list.map((c) => (
          <li key={c.id}>
            <a className="lib-card" href={docHref(c.id)} onClick={(e) => { e.preventDefault(); onOpenDoc(c.id) }}>
              <div className="lib-card-title">{c.title}</div>
              <div className="lib-card-meta">
                {c.task != null && <span className="dx-task-chip is-static">#{c.task}</span>}
                {!c.primary && <span className="dx-pill">Supporting</span>}
                <span>r{c.rev}{c.updatedAt ? ` · updated ${timeAgo(c.updatedAt)}` : ''}</span>
              </div>
              <div className="lib-badges">
                {c.unread && <span className="dx-pill dx-pill-new">New r{c.rev}</span>}
                {c.needsYou > 0 && <span className="dx-pill dx-pill-needs">Needs you {c.needsYou}</span>}
                {c.open > 0 && <span className="dx-pill">💬 {c.open} open</span>}
                {c.drafts > 0 && <span className="dx-pill dx-pill-draft">✎ {c.drafts} draft{c.drafts === 1 ? '' : 's'}</span>}
                {c.state === 'review-submitted' && <span className="dx-pill">Sent · waiting for agent</span>}
                {c.state === 'working' && <span className="dx-pill">🤖 Agent working</span>}
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
