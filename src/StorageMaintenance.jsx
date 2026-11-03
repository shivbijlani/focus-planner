import { useState } from 'react'
import * as storage from './storage/storage.js'
import { cleanupCategory, downloadArchive, makeFileArchive } from './storage/fileCleanup.js'

export default function StorageMaintenance({ showClutter, onShowClutter, onDataChanged }) {
  const [candidates, setCandidates] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [archived, setArchived] = useState(false)
  const canList = typeof storage.getActiveProvider()?.listAllPaths === 'function'

  const run = async action => {
    setBusy(true)
    setError('')
    setMessage('')
    try { await action() }
    catch (error) {
      console.error('Planner maintenance failed:', error)
      setError(error.message || 'Maintenance failed')
    } finally { setBusy(false) }
  }
  const changeSelection = next => { setSelected(next); setArchived(false) }
  const scan = () => run(async () => {
    const paths = await storage.getActiveProvider().listAllPaths()
    setCandidates(paths.filter(path => cleanupCategory(path)).sort())
    changeSelection(new Set())
  })
  const archive = () => run(async () => {
    downloadArchive(await makeFileArchive([...selected], path => storage.read(path)))
    setArchived(true)
    setMessage('Recovery archive downloaded. Keep it before deleting these files.')
  })
  const remove = () => {
    if (!selected.size || !archived || !window.confirm(
      `Delete these ${selected.size} selected files from the active source and connected backups? Keep the downloaded recovery archive. Journals and conflict copies not selected here stay intact. Wait for backup to finish before resetting.`,
    )) return
    run(async () => {
      for (const path of selected) {
        await storage.remove(path)
        setCandidates(previous => previous.filter(item => item !== path))
        setSelected(previous => { const next = new Set(previous); next.delete(path); return next })
      }
      setArchived(false)
      setMessage('Selected files deleted locally. Wait for backup to finish before resetting so the deletions reach the cloud.')
      onDataChanged?.()
    })
  }

  return <div className="settings-dialog-section">
    <h3 className="settings-dialog-section-title">Clean up &amp; reset</h3>
    <label>
      <input type="checkbox" checked={showClutter} onChange={event => onShowClutter(event.target.checked)} />
      {' '}Show technical files in the sidebar
    </label>
    <p className="settings-dialog-subtle">Hidden files are kept and still backed up. Journals, supporting documents, and personal folders stay visible. Agent settings remain available above.</p>
    {canList && <>
      <button className="storage-footer-btn sync-target-action" disabled={busy} onClick={scan}>Review cleanup candidates</button>
      {candidates && <>
        <p className="settings-dialog-subtle">{candidates.length} candidate files. Nothing is selected automatically. Conflict copies, Docs, and live task journals are not cleanup candidates. Old backups may contain unique edits.</p>
        <button className="storage-footer-btn sync-target-action" disabled={busy} onClick={() => changeSelection(new Set(candidates))}>Select all candidates</button>
        {['Tooling leftovers', 'Old backup copies'].map(category =>
          <button key={category} className="storage-footer-btn sync-target-action" disabled={busy} onClick={() => changeSelection(new Set(candidates.filter(path => cleanupCategory(path) === category)))}>
            Select {category.toLowerCase()}
          </button>,
        )}
        <ul className="settings-files-list">
          {candidates.map(path => <li key={path} className="settings-files-row">
            <label><input type="checkbox" disabled={busy} checked={selected.has(path)} onChange={event => {
              const next = new Set(selected)
              if (event.target.checked) next.add(path)
              else next.delete(path)
              changeSelection(next)
            }} /> {path}</label>
          </li>)}
        </ul>
        <p>{selected.size} selected</p>
        <button className="storage-footer-btn sync-target-action" disabled={busy || !selected.size} onClick={archive}>Download selected files for recovery</button>
        <button className="storage-footer-btn settings-files-clear" disabled={busy || !selected.size || !archived} onClick={remove}>Delete selected files</button>
      </>}
    </>}
    {busy && <p role="status">Working...</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="storage-footer-error">{error}</p>}
    <p className="settings-dialog-subtle">Reset signs Planner out and clears only this browser, including unsynced files. Cloud backups and local folders are not deleted. Signing in restores whatever remains in the backup.</p>
    <a className="storage-footer-btn sync-target-action" href={`${import.meta.env.BASE_URL}reset.html`}>Reset this browser...</a>
  </div>
}
