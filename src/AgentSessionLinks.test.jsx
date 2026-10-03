import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AgentSessionLinks from './AgentSessionLinks.jsx'
import { lastSeenText } from './agentMetadata/lastSeen.js'

const NOW = Date.now()
const link = (over = {}) => ({
  deviceKey: 'a'.repeat(32), deviceName: 'SHIV-DESKTOP', sessionId: 's1', url: 'ghapp://sessions/s1',
  stale: false, lastSeenMs: NOW, ...over,
})

// UI rules of docs/spec/Domain-agent-metadata.md: one PC looks like a plain 🤖 link with no device
// name; two or more PCs collapse into one "🤖 N" button; nothing at all without bindings.
describe('AgentSessionLinks', () => {
  it('renders nothing without bindings', () => {
    expect(renderToStaticMarkup(<AgentSessionLinks links={[]} />)).toBe('')
    expect(renderToStaticMarkup(<AgentSessionLinks links={undefined} />)).toBe('')
  })

  it('one device: a plain 🤖 link, new tab, no device name anywhere', () => {
    const html = renderToStaticMarkup(<AgentSessionLinks links={[link()]} />)
    expect(html).toContain('href="ghapp://sessions/s1"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('title="Open agent session"')
    expect(html).not.toContain('SHIV-DESKTOP')
    expect(html).not.toContain('agent-session-menu-button')
  })

  it('one device with two sessions: one 🤖 per session', () => {
    const html = renderToStaticMarkup(<AgentSessionLinks links={[link(), link({ sessionId: 's2', url: 'ghapp://sessions/s2' })]} />)
    expect(html.match(/data-testid="agent-session-link"/g)).toHaveLength(2)
    expect(html).not.toContain('SHIV-DESKTOP')
  })

  it('stale: still a link, dimmed, with when it was last seen', () => {
    const html = renderToStaticMarkup(<AgentSessionLinks links={[link({ stale: true, lastSeenMs: NOW - 3 * 3600000 })]} />)
    expect(html).toContain('is-stale')
    expect(html).toContain('agent last seen 3 h ago')
    expect(html).toContain('href=')
  })

  it('no reported link: a 🤖 that is not a link', () => {
    const html = renderToStaticMarkup(<AgentSessionLinks links={[link({ url: null })]} />)
    expect(html).not.toContain('href=')
    expect(html).toContain('no link reported')
  })

  it('two devices: one "🤖 2" button, menu closed until clicked', () => {
    const html = renderToStaticMarkup(<AgentSessionLinks links={[link(), link({ deviceKey: 'b'.repeat(32), deviceName: 'LAPTOP', sessionId: 's9' })]} />)
    expect(html).toContain('data-testid="agent-session-menu-button"')
    expect(html).toMatch(/🤖 (<!-- -->)?2<\/button>/)
    expect(html).not.toContain('agent-session-menu"')
  })

  it('lastSeenText', () => {
    expect(lastSeenText(NOW - 5 * 60000, NOW)).toBe('5 min ago')
    expect(lastSeenText(NOW - 5 * 3600000, NOW)).toBe('5 h ago')
    expect(lastSeenText(NOW - 3 * 86400000, NOW)).toBe('3 days ago')
  })
})
