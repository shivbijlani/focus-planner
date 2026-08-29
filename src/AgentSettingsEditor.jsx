import { useEffect, useMemo, useState } from 'react'
import * as storage from './storage/storage.js'
import { PLAN_FILE } from './config/branding.js'
import { AI_SETTINGS_FILE, AI_SETTINGS_TEMPLATE } from './config/aiSettings.js'
import { groupSettingsForm, serializeSettingsForm, hasSettingsForm } from './config/userSettingsForm.js'
import { partitionAgentSettings } from './config/agentSettingsVisibility.js'

function AgentSettingsEditor({ activeSourceId, onSaved }) {
  const [aiText, setAiText] = useState(null)
  const [aiLoaded, setAiLoaded] = useState(false)
  const [aiExists, setAiExists] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMsg, setAiMsg] = useState('')
  const [aiMode, setAiMode] = useState('form')

  useEffect(() => {
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
  }, [activeSourceId])

  const hasForm = hasSettingsForm(aiText)
  const groups = useMemo(() => groupSettingsForm(aiText), [aiText])
  const { user: userGroups, advanced: advancedGroups } = useMemo(
    () => partitionAgentSettings(groups),
    [groups]
  )

  const seedAiSettings = async () => {
    setAiBusy(true)
    setAiMsg('')
    try {
      await storage.write(AI_SETTINGS_FILE, AI_SETTINGS_TEMPLATE)
      setAiText(AI_SETTINGS_TEMPLATE)
      setAiExists(true)
      setAiMode('form')
      setAiMsg('Created — fill in your values and save.')
      onSaved?.(AI_SETTINGS_TEMPLATE)
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
      const nextText = aiText ?? ''
      await storage.write(AI_SETTINGS_FILE, nextText)
      setAiExists(true)
      setAiMsg('Saved.')
      onSaved?.(nextText)
    } catch (e) {
      setAiMsg(`Couldn't save: ${e?.message || e}`)
    } finally {
      setAiBusy(false)
    }
  }

  const updateFormRow = (rowIndex, nextValue) => {
    const values = groups
      .flatMap((g) => g.rows)
      .sort((a, b) => a.index - b.index)
      .map((row) => row.value)
    values[rowIndex] = nextValue
    setAiText(serializeSettingsForm(aiText, values))
    if (aiMsg) setAiMsg('')
  }

  const renderGroups = (gs) => gs.map((group) => (
    <fieldset className="settings-ai-form-group" key={group.section || 'ungrouped'}>
      {group.section && (
        <legend className="settings-ai-form-legend">{group.section}</legend>
      )}
      {group.rows.map((row) => (
        <label className="settings-ai-field" key={row.index}>
          <span className="settings-ai-field-label">{row.label}</span>
          <input
            type="text"
            className="settings-ai-field-input"
            spellCheck={false}
            value={row.value}
            onChange={(e) => updateFormRow(row.index, e.target.value)}
          />
        </label>
      ))}
    </fieldset>
  ))

  return (
    <section className="agent-settings-page" aria-labelledby="agent-settings-title">
      <div className="agent-settings-page-header">
        <div>
          <p className="agent-settings-eyebrow">{AI_SETTINGS_FILE}</p>
          <h1 id="agent-settings-title">Agent settings</h1>
          <p className="agent-settings-description">
            Config for the overnight agent, saved in your active source next to <code>{PLAN_FILE}</code>.
            The agent reads this file on every run.
          </p>
        </div>
      </div>

      <div className="agent-settings-card">
        {!aiLoaded ? (
          <div className="settings-update-msg">Loading…</div>
        ) : !aiExists && (aiText === '' || aiText == null) ? (
          <div className="settings-update-row agent-settings-create-row">
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
            <div className="settings-ai-modes" role="tablist" aria-label="Settings editor mode">
              <button
                type="button"
                role="tab"
                aria-selected={aiMode === 'form'}
                className={`settings-ai-mode-btn${aiMode === 'form' ? ' is-active' : ''}`}
                onClick={() => setAiMode('form')}
                disabled={!hasForm}
                title={hasForm ? 'Edit each setting in its own field' : 'No structured rows to edit — use Raw'}
              >
                Form
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={aiMode === 'raw'}
                className={`settings-ai-mode-btn${aiMode === 'raw' ? ' is-active' : ''}`}
                onClick={() => setAiMode('raw')}
                title="Edit the raw markdown"
              >
                Raw
              </button>
            </div>
            {aiMode === 'form' && hasForm ? (
              <div className="settings-ai-form">
                {renderGroups(userGroups)}
                {advancedGroups.length > 0 && (
                  <details className="settings-ai-advanced">
                    <summary className="settings-ai-advanced-summary">
                      Advanced settings — paths, accounts &amp; internals (rarely need changing)
                    </summary>
                    <div className="settings-ai-advanced-body">
                      {renderGroups(advancedGroups)}
                    </div>
                  </details>
                )}
                <div className="settings-ai-form-hint">
                  Prose-only settings (the <code>## Preferences</code> notes) aren’t shown here — switch to <strong>Raw</strong> to edit those.
                </div>
              </div>
            ) : (
              <textarea
                className="settings-ai-input"
                rows={20}
                spellCheck={false}
                placeholder={`# Overnight Agent — user settings\n\nFill in your paths, accounts and preferences…`}
                value={aiText ?? ''}
                onChange={(e) => { setAiText(e.target.value); if (aiMsg) setAiMsg('') }}
              />
            )}
            <div className="settings-update-row agent-settings-save-row">
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
    </section>
  )
}

export default AgentSettingsEditor
