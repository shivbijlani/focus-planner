// Docs app shell: storage boot + hash routing (library, #/d/<id>?block=&comment=).
import { useCallback, useEffect, useState } from 'react'
import * as storage from '../storage/storage.js'
import { parseRoute, docHref } from '../../packages/docs-core/src/index.js'
import { bootStorage as defaultBootStorage } from '#planner/docs-bootstrap'
import { useHost } from '#planner/host-provider'
import { deploymentProfile } from '#planner/deployment-profile'
import { plannerUrl } from './util.js'
import { draftScopeKey, loadIndex } from './docsStore.js'
import Library from './Library.jsx'
import DocView from './DocView.jsx'

export default function DocsApp({ sessionKey, bootStorage = defaultBootStorage }) {
  const host = useHost()
  // The host must change its session key on account OR source changes.
  const key = JSON.stringify([sessionKey ?? host.docsSessionKey ?? null, host.identity ?? null, host.docsAccountId ?? null])
  return <div className="docs-app"><DocsSession key={key} host={host} bootStorage={bootStorage} /></div>
}

function DocsSession({ host, bootStorage }) {
  const [boot, setBoot] = useState(null)
  const [index, setIndex] = useState(undefined)
  const [indexError, setIndexError] = useState(null)
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    Promise.resolve().then(() => bootStorage({ host, profile: deploymentProfile, signal: controller.signal })).then((result) => {
      draftScopeKey(result?.draftScope)
      if (!cancelled) setBoot(result)
    }).catch((e) => { if (!cancelled) setBoot({ error: String(e?.message || e) }) })
    return () => { cancelled = true; controller.abort() }
  }, [bootStorage, host])

  const refreshIndex = useCallback(() => loadIndex().then((next) => {
    setIndex(next)
    setIndexError(null)
  }).catch((e) => {
    setIndex(null)
    setIndexError(String(e?.message || e))
  }), [])
  useEffect(() => { if (boot && !boot.error) refreshIndex() }, [boot, refreshIndex])

  // Pulled remote changes under docs/ (the agent republished, another device commented).
  useEffect(() => {
    if (!boot || boot.error) return undefined
    let t = null
    const unsub = storage.onLocalChange((name) => {
      if (!String(name || '').startsWith('docs/')) return
      clearTimeout(t)
      t = setTimeout(() => { refreshIndex(); setReloadKey((k) => k + 1) }, 250)
    })
    const onVis = () => { if (document.visibilityState === 'visible') { refreshIndex(); setReloadKey((k) => k + 1) } }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearTimeout(t); unsub?.(); document.removeEventListener('visibilitychange', onVis) }
  }, [boot, refreshIndex])

  useEffect(() => {
    const on = () => { setRoute(parseRoute(window.location.hash)); window.scrollTo({ top: 0 }) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  // In-app back stack: doc: links push history entries; back pops them.
  const openDoc = useCallback((id, block) => {
    const depth = Number(sessionStorage.getItem('fp-docs-depth') || 0)
    sessionStorage.setItem('fp-docs-depth', String(depth + 1))
    window.location.hash = docHref(id, { block })
  }, [])
  const goBack = useCallback(() => {
    const depth = Number(sessionStorage.getItem('fp-docs-depth') || 0)
    if (depth > 0) {
      sessionStorage.setItem('fp-docs-depth', String(depth - 1))
      window.history.back()
    } else {
      window.location.hash = '#/'
    }
  }, [])

  useEffect(() => {
    const title = route.view === 'doc' ? (index?.docs?.[route.docId]?.title || 'Docs') : 'Docs'
    document.title = title
  }, [route, index])

  if (!boot) return <div className="dx-loading">Opening Docs…</div>
  if (boot.error) return <div className="dx-empty-page" role="alert"><p>Couldn't open storage: {boot.error}</p></div>
  if (indexError) return <div className="dx-empty-page" role="alert"><h1>Docs unavailable</h1><p>{indexError}</p></div>
  if (!boot.hasSources && !index) {
    return (
      <div className="dx-empty-page">
        <h1>📄 Docs</h1>
        <p>Docs reads the same folder as Focus Planner. Open Focus Planner once to connect your storage, then come back.</p>
        <a className="dx-btn dx-btn-primary" href={plannerUrl()}>Open Focus Planner</a>
      </div>
    )
  }
  if (index === undefined) return <div className="dx-loading">Loading…</div>

  return <>
    {boot.warnings?.map((warning) => <div className="dx-boot-warning" role="alert" key={warning}>{warning}</div>)}
    {route.view === 'doc'
      ? <DocView key={`${draftScopeKey(boot.draftScope)}:${route.docId}`} draftScope={boot.draftScope} docId={route.docId} index={index} route={route} onOpenDoc={openDoc} onBack={goBack} reloadKey={reloadKey} />
      : <Library key={draftScopeKey(boot.draftScope)} draftScope={boot.draftScope} index={index} onOpenDoc={openDoc} plannerHref={plannerUrl()} reloadKey={reloadKey} />}
  </>
}
