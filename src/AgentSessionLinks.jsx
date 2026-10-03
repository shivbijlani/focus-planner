// The 🤖 row badge: links a board row to the agent session(s) working it
// (docs/spec/Domain-agent-metadata.md, "What the user sees" and "UI rules").
//   one device  -> one 🤖 per session, no device name anywhere
//   2+ devices  -> one "🤖 N" button opening a menu labelled by device name
// Stale links stay, dimmed, with "last seen" in the tooltip; a session the host never reported a
// link for is a 🤖 that is not a link.
import { useEffect, useRef, useState } from 'react'
import { lastSeenText } from './agentMetadata/lastSeen.js'

function titleFor(link, withDevice) {
  const who = withDevice ? ` on ${link.deviceName}` : ''
  const base = link.url ? `Open agent session${who}` : `Agent session${who} (no link reported)`
  return link.stale ? `${base} — agent last seen ${lastSeenText(link.lastSeenMs)}` : base
}

function SessionLink({ link, withDevice, children, className = '' }) {
  const cls = `journal-link agent-session-link${link.stale ? ' is-stale' : ''}${className ? ` ${className}` : ''}`
  if (!link.url) {
    return <span className={cls} title={titleFor(link, withDevice)} data-testid="agent-session-link">{children}</span>
  }
  return (
    <a
      href={link.url}
      className={cls}
      title={titleFor(link, withDevice)}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="agent-session-link"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  )
}

export default function AgentSessionLinks({ links }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  if (!links || !links.length) return null
  const devices = new Set(links.map((l) => l.deviceKey))
  if (devices.size === 1) {
    return links.map((l) => (
      <SessionLink key={`${l.deviceKey}|${l.sessionId}`} link={l} withDevice={false}>🤖</SessionLink>
    ))
  }
  const allStale = links.every((l) => l.stale)
  return (
    <span className="agent-session-multi" ref={ref}>
      <button
        type="button"
        className={`journal-link agent-session-link agent-session-count${allStale ? ' is-stale' : ''}`}
        title={`${links.length} agent sessions on ${devices.size} devices`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="agent-session-menu-button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o) }}
      >
        🤖 {links.length}
      </button>
      {open && (
        <span className="agent-session-menu" role="menu" data-testid="agent-session-menu">
          {links.map((l) => (
            <SessionLink key={`${l.deviceKey}|${l.sessionId}`} link={l} withDevice className="agent-session-menu-item">
              🤖 {l.deviceName}{l.stale ? ` · last seen ${lastSeenText(l.lastSeenMs)}` : ''}
            </SessionLink>
          ))}
        </span>
      )}
    </span>
  )
}
