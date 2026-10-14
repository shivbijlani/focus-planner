import { describe, it, expect } from 'vitest'
import vectors from '../../plugins/overnight-agent/tests/agent-metadata/vectors.json'
import { fingerprint, fingerprintText, deviceKey, safeUrl } from './fingerprint.js'

// The same vectors the publisher's node:test suite runs (docs/spec/Domain-agent-metadata.md).
describe('agent metadata vectors (shared with the publisher)', () => {
  it.each(vectors.fingerprints.map((v) => [v.name, v]))('fingerprint: %s', async (_name, v) => {
    expect(await fingerprint(v.id, v.added, v.title)).toBe(v.fingerprint)
    if (v.text) expect(fingerprintText(v.id, v.added, v.title)).toBe(v.text)
  })

  it.each(vectors.deviceKeys.map((v) => [v.id, v]))('device key: %s', async (_id, v) => {
    expect(await deviceKey(v.id)).toBe(v.key)
  })

  it.each(vectors.urls.map((v) => [v.url || '(empty)', v]))('link: %s', (_u, v) => {
    expect(safeUrl(v.url, v.sessionId) !== null).toBe(v.safe)
  })
})
