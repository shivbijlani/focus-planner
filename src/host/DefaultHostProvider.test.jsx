import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppRoot } from '../AppRoot.jsx'
import { useHost } from '#planner/host-provider'

function HostProbe() {
  const host = useHost()
  return createElement('output', null, `${host.kind}:${host.identity}`)
}

describe('default host provider', () => {
  it('provides the consumer host context inside the app root tree', () => {
    const markup = renderToStaticMarkup(
      createElement(AppRoot, null, createElement(HostProbe)),
    )
    expect(markup).toContain('consumer-web:null')
  })
})
