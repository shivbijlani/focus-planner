import { useEffect, useState } from 'react'
import * as storage from './storage/storage.js'
import { PLAN_FILE } from './config/branding.js'
import { handleGateKeyDown } from './agentGateEditor.js'
import {
  AGENT_GATE_FILE,
  AGENT_GATE_DOC,
  REVERSIBLE_HEADING,
  ALWAYS_ASK_HEADING,
  parseAgentGate,
  serializeAgentGate,
  addGateLine,
  removeGateLine,
} from './config/agentGate.js'

/**
 * One column: a line-oriented list plus the box that appends to it.
 *
 * Deliberately controlled (the draft lives in the parent) so the component is a
 * pure function of its props and its handlers can be exercised without a DOM.
 */
export function GateList({
  id, title, hint, placeholder, items = [], draft = '',
  onDraftChange, onAdd, onRemove, disabled = false,
}) {
  return (
    <section className="agent-gate-list" aria-labelledby={`${id}-title`}>
      <h2 className="agent-gate-list-title" id={`${id}-title`}>{title}</h2>
      <p className="agent-gate-list-hint">{hint}</p>
      <ul className="agent-gate-items">
        {items.length === 0 ? (
          <li className="agent-gate-empty">Nothing here yet.</li>
        ) : items.map((text, i) => (
          <li className="agent-gate-item" key={`${i}:${text}`}>
            <span className="agent-gate-item-text">{text}</span>
            <button
              type="button"
              className="agent-gate-remove"
              onClick={() => onRemove?.(i)}
              disabled={disabled}
              title={`Remove: ${text}`}
              aria-label={`Remove: ${text}`}
            >×</button>
          </li>
        ))}
      </ul>
      <input
        type="text"
        className="agent-gate-input"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        aria-label={`Add to ${title}`}
        onChange={(e) => onDraftChange?.(e.target.value)}
        onKeyDown={(e) => handleGateKeyDown(e, { draft, onAdd, onDraftChange })}
      />
      <p className="agent-gate-input-hint">Press Enter to add</p>
    </section>
  )
}

/**
 * Full-page editor for `agent-gate.md` (#288).
 *
 * Two line-oriented lists, one save. Because the point of this file is that a
 * *human* wrote it, the editor is careful in two ways:
 *
 *  - It keeps the file's original text and splices only the list bullets on
 *    save, so a preamble or note written by hand survives.
 *  - If the file could not be read, saving is blocked. Showing empty lists after
 *    a failed read and then letting Save through would silently erase the gate.
 */
function AgentGateEditor({ activeSourceId, onSaved }) {
  const [reversible, setReversible] = useState([])
  const [alwaysAsk, setAlwaysAsk] = useState([])
  const [sourceText, setSourceText] = useState('')
  const [drafts, setDrafts] = useState({ reversible: '', alwaysAsk: '' })
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setLoadError('')
    setMsg('')
    setDirty(false)
    setDrafts({ reversible: '', alwaysAsk: '' })
    ;(async () => {
      try {
        const raw = await storage.read(AGENT_GATE_FILE)
        if (cancelled) return
        const hasFile = raw != null && String(raw).trim() !== ''
        // No file yet: show the starter lists so the page is never blank, and
        // let the first Save create it (serialize seeds the canonical doc).
        const seed = hasFile ? raw : AGENT_GATE_DOC
        const parsed = parseAgentGate(seed)
        setSourceText(hasFile ? raw : '')
        setReversible(parsed.reversible)
        setAlwaysAsk(parsed.alwaysAsk)
        if (!hasFile) setMsg('Starter list — save to create the file.')
      } catch (e) {
        if (cancelled) return
        setLoadError(e?.message || String(e))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [activeSourceId])

  const touch = () => { setDirty(true); setMsg('') }

  const setDraft = (key) => (value) => setDrafts((d) => ({ ...d, [key]: value }))
  const addTo = (key) => (text) => {
    const apply = key === 'reversible' ? setReversible : setAlwaysAsk
    apply((list) => {
      const next = addGateLine(list, text)
      if (next.length !== list.length) touch()
      return next
    })
  }
  const removeFrom = (key) => (index) => {
    const apply = key === 'reversible' ? setReversible : setAlwaysAsk
    apply((list) => {
      const next = removeGateLine(list, index)
      if (next.length !== list.length) touch()
      return next
    })
  }

  const save = async () => {
    setBusy(true)
    setMsg('')
    try {
      // Whole-file write: rebuild the document from its own text so nothing the
      // user wrote around the lists is lost, then write it in one go.
      const nextText = serializeAgentGate(sourceText, { reversible, alwaysAsk })
      await storage.write(AGENT_GATE_FILE, nextText)
      setSourceText(nextText)
      setDirty(false)
      setMsg('Saved.')
      onSaved?.(nextText)
    } catch (e) {
      setMsg(`Couldn't save: ${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="agent-gate-page" aria-labelledby="agent-gate-title">
      <div className="agent-gate-page-header">
        <div>
          <p className="agent-gate-eyebrow">{AGENT_GATE_FILE}</p>
          <h1 id="agent-gate-title">Agent gate</h1>
          <p className="agent-gate-description">
            When the overnight agent may act on its own, and when it has to stop and ask.
            Saved in your active source next to <code>{PLAN_FILE}</code>. You write this file;
            the agent only reads it, so anything here counts as your standing instruction.
          </p>
        </div>
      </div>

      <div className="agent-gate-card">
        {!loaded ? (
          <div className="settings-update-msg">Loading…</div>
        ) : loadError ? (
          <div className="settings-update-msg">
            Couldn’t read {AGENT_GATE_FILE}: {loadError}
          </div>
        ) : (
          <>
            <div className="agent-gate-columns">
              <GateList
                id="agent-gate-reversible"
                title={REVERSIBLE_HEADING}
                hint="The agent does these without asking."
                placeholder="Add something the agent can just do…"
                items={reversible}
                draft={drafts.reversible}
                onDraftChange={setDraft('reversible')}
                onAdd={addTo('reversible')}
                onRemove={removeFrom('reversible')}
                disabled={busy}
              />
              <GateList
                id="agent-gate-always-ask"
                title={ALWAYS_ASK_HEADING}
                hint="The agent always pauses before these."
                placeholder="Add something the agent must ask about…"
                items={alwaysAsk}
                draft={drafts.alwaysAsk}
                onDraftChange={setDraft('alwaysAsk')}
                onAdd={addTo('alwaysAsk')}
                onRemove={removeFrom('alwaysAsk')}
                disabled={busy}
              />
            </div>
            <div className="settings-update-row agent-gate-save-row">
              <div className="settings-update-info">
                <span className="settings-update-hint">
                  {dirty ? 'Unsaved changes.' : 'Both lists are saved together, in one file.'}
                </span>
              </div>
              <button
                className="storage-footer-btn sync-target-action"
                onClick={save}
                disabled={busy}
                title={`Save ${AGENT_GATE_FILE}`}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
        {msg && <div className="settings-update-msg">{msg}</div>}
      </div>
    </section>
  )
}

export default AgentGateEditor
