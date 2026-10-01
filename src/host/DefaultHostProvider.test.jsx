import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DefaultHostProvider, useHost } from '#planner/host-provider'

function HostProbe() {
  const host = useHost()
  return createElement('output', null, `${host.kind}:${host.identity}`)
}

describe('default host provider', () => {
  it('provides the consumer host context around its children', () => {
    const markup = renderToStaticMarkup(
      createElement(DefaultHostProvider, null, createElement(HostProbe)),
    )
    expect(markup).toContain('consumer-web:null')
  })
})
