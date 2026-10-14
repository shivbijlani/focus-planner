// Devices & lanes (docs/spec/Domain-lanes.md, "App rules"): assign lanes to the PCs that run the
// Overnight Agent, and set one task's lane from the row menu. The app is the only writer of
// agent-lanes.json; every write re-reads the file first (updateLanes).
//
// Invisible to a single-PC user: the settings section renders only when two or more devices have
// announced themselves in agent-metadata/ or the lanes file already exists, and the row menu offers
// "Lane…" only when the file exists and validates.
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getActiveProvider, remove as removeFile, write as writeFile } from './storage/storage.js'
import { useAnnouncedDevices } from './useAgentMetadata.js'
import { removeLanes, resetLanes, updateLanes, useLanes } from './useLanes.js'
import { deviceServes, freshCatchAll, isLaneName } from './lanes/lanes.js'
import { lastSeenText } from './agentMetadata/lastSeen.js'

const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function knownLanes(config) {
  const set = new Set()
  for (const d of Object.values(config?.devices ?? {})) for (const l of d.lanes) set.add(l)
  for (const l of Object.values(config?.tasks ?? {})) if (l !== 'none') set.add(l)
  return [...set].sort(ordinal)
}

function LaneNameInput({ onAdd, placeholder = 'new lane, e.g. ado' }) {
  const [text, setText] = useState('')
  const name = text.trim().toLowerCase()
  const valid = isLaneName(name)
  return (
    <span className="lanes-add">
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        aria-label="Lane name"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && valid) { onAdd(name); setText('') } }}
      />
      <button type="button" className="storage-footer-btn" disabled={!valid} onClick={() => { onAdd(name); setText('') }}>Add</button>
      {text && !valid && <span className="lanes-hint">letters, digits and hyphens, starting with a letter (not none/any/all)</span>}
    </span>
  )
}

export default function LanesSettingsSection() {
  const provider = getActiveProvider()
  const lanes = useLanes(provider, { force: true })
  const announced = useAnnouncedDevices(provider)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const rows = useMemo(() => {
    const byKey = new Map(announced.map((d) => [d.key, { ...d, announced: true }]))
    for (const [k, d] of Object.entries(lanes.config?.devices ?? {})) {
      if (!byKey.has(k)) byKey.set(k, { key: k, name: d.name || k.slice(0, 8), stale: true, lastSeenMs: null, announced: false })
    }
    return [...byKey.values()].sort((a, b) => ordinal(a.name.toLowerCase(), b.name.toLowerCase()) || ordinal(a.key, b.key))
  }, [announced, lanes.config])

  const fileExists = lanes.status === 'ok' || lanes.status === 'invalid'
  if (!provider || (announced.length < 2 && !fileExists)) return null

  const run = async (fn) => {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(false) }
  }
  const edit = (mutate) => run(() => updateLanes(provider, writeFile, mutate))
  const entryFor = (draft, row) => {
    const e = draft.devices[row.key] ?? { lanes: [], catchAll: false }
    if (row.announced) e.name = row.name
    draft.devices[row.key] = e
    return e
  }

  const config = lanes.status === 'ok' ? lanes.config : null
  const catchAllFresh = config ? freshCatchAll(config, announced) : announced.filter((d) => !d.stale)
  const servedLanes = new Set(Object.values(config?.devices ?? {}).flatMap((d) => d.lanes))
  const orphanLanes = [...new Set(Object.values(config?.tasks ?? {}))].filter((l) => l !== 'none' && !servedLanes.has(l)).sort(ordinal)

  return (
    <div className="settings-dialog-section lanes-settings" data-testid="lanes-settings">
      <h4 className="lanes-title">Devices &amp; lanes</h4>
      <p className="settings-dialog-subtle">
        Each PC that runs the Overnight Agent appears here. Give a PC one or more lanes and it works only tasks in those
        lanes (a <code>#lane:name</code> tag in the title, the row menu&apos;s Lane…, or a parent&apos;s lane). A catch-all PC also
        works tasks with no lane; a PC with nothing assigned is catch-all.
      </p>
      {lanes.status === 'invalid' && (
        <div className="lanes-banner" role="alert">
          <code>agent-lanes.json</code> is broken ({lanes.config.reason}); agents on every PC are paused.
          <button type="button" className="storage-footer-btn" disabled={busy}
            onClick={() => { if (window.confirm('Replace agent-lanes.json with an empty valid file? Every lane assignment in it is lost.')) run(() => resetLanes(provider, writeFile)) }}>
            Replace with an empty file
          </button>
        </div>
      )}
      {lanes.status !== 'invalid' && (
        <ul className="lanes-devices">
          {rows.map((row) => {
            const serves = deviceServes(config, row.key)
            const seen = !row.announced ? 'not seen' : row.stale ? `last seen ${lastSeenText(row.lastSeenMs)}` : 'online'
            return (
              <li key={row.key} className="lanes-device" data-testid="lanes-device">
                <span className="lanes-device-name">{row.name}</span>
                <span className={`lanes-device-seen${row.stale ? ' is-stale' : ''}`}>{seen}</span>
                <span className="lanes-device-lanes">
                  {serves.lanes.map((l) => (
                    <span key={l} className="lane-chip lane-chip-served">
                      {l}
                      <button type="button" aria-label={`Remove lane ${l} from ${row.name}`} disabled={busy}
                        onClick={() => edit((d) => { const e = entryFor(d, row); e.lanes = e.lanes.filter((x) => x !== l) })}>✕</button>
                    </span>
                  ))}
                </span>
                <LaneNameInput onAdd={(l) => edit((d) => { const e = entryFor(d, row); if (!e.lanes.includes(l)) e.lanes.push(l) })} />
                <label className="lanes-catchall">
                  <input type="checkbox" checked={serves.catchAll} disabled={busy}
                    onChange={(ev) => edit((d) => { entryFor(d, row).catchAll = ev.target.checked })} />
                  catch-all{serves.assigned ? '' : ' (nothing assigned)'}
                </label>
                {!row.announced && (
                  <button type="button" className="storage-footer-btn" disabled={busy}
                    onClick={() => edit((d) => { delete d.devices[row.key] })}>Remove</button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {catchAllFresh.length >= 2 && (
        <p className="lanes-warning" data-testid="lanes-catchall-warning">
          ⚠ {catchAllFresh.map((d) => d.name).join(' and ')} are both catch-all: they may both pick the same task with no lane.
        </p>
      )}
      {orphanLanes.length > 0 && (
        <p className="lanes-warning">⚠ No PC serves {orphanLanes.map((l) => `“${l}”`).join(', ')}; tasks in it wait.</p>
      )}
      {error && <p className="lanes-error" role="alert">{error}</p>}
      {fileExists && (
        <button type="button" className="storage-footer-btn lanes-off" disabled={busy}
          onClick={() => { if (window.confirm('Turn lanes off? Every PC goes back to working every task.')) run(() => removeLanes(provider, removeFile)) }}>
          Turn lanes off
        </button>
      )}
    </div>
  )
}

/** The row menu's "Lane…": set, opt out of, or clear this task's assignment in agent-lanes.json. */
export function LanePicker({ picker, config, onClose }) {
  const provider = getActiveProvider()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { taskId, resolution, tags, assigned } = picker
  const choose = async (lane) => {
    setBusy(true); setError('')
    try {
      await updateLanes(provider, writeFile, (d) => { if (lane === null) delete d.tasks[taskId]; else d.tasks[taskId] = lane })
      onClose()
    } catch (e) { setError(String(e?.message ?? e)) } finally { setBusy(false) }
  }
  const current = resolution.problem
    ? `conflicting or invalid lanes (${resolution.candidates.join(', ')})`
    : resolution.lane
      ? `${resolution.lane}${resolution.source === 'inherited' ? ` (inherited from task ${resolution.from})` : ''}`
      : resolution.source ? 'no lane (opted out)' : 'no lane'
  return createPortal(
    <div className="dialog-overlay" onClick={onClose}>
      <div className="settings-dialog lane-picker" onClick={(e) => e.stopPropagation()} data-testid="lane-picker">
        <div className="settings-dialog-header">
          <h3>Lane for task {taskId}</h3>
          <button className="settings-dialog-close" onClick={onClose}>✕</button>
        </div>
        <p className="settings-dialog-subtle">Now: {current}</p>
        {tags.length > 0 ? (
          <p className="settings-dialog-subtle">
            This task&apos;s lane comes from <code>#lane:{tags[0]}</code> in its title. Edit the title to change it.
          </p>
        ) : (
          <div className="lane-picker-choices">
            {knownLanes(config).map((l) => (
              <button key={l} type="button" className="storage-footer-btn" disabled={busy || assigned === l} onClick={() => choose(l)}>{l}</button>
            ))}
            <LaneNameInput onAdd={(l) => choose(l)} />
            <button type="button" className="storage-footer-btn" disabled={busy || assigned === 'none'} onClick={() => choose('none')}>No lane (opt out of its parent&apos;s)</button>
            {assigned && (
              <button type="button" className="storage-footer-btn" disabled={busy} onClick={() => choose(null)}>Clear (inherit)</button>
            )}
          </div>
        )}
        {error && <p className="lanes-error" role="alert">{error}</p>}
      </div>
    </div>,
    document.body,
  )
}
