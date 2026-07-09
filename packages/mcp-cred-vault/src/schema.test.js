import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  collectMcpSecretsErrors,
  isValidMcpSecrets,
  parseMcpSecrets,
} from './schema.js'

const examplePath = fileURLToPath(new URL('../mcp-secrets.example.json', import.meta.url))
const exampleText = readFileSync(examplePath, 'utf8')

describe('mcp-secrets pointer file schema', () => {
  it('accepts the committed example file', () => {
    const parsed = parseMcpSecrets(exampleText)
    expect(parsed.version).toBe(1)
    expect(Array.isArray(parsed.secrets)).toBe(true)
    expect(parsed.secrets[0]).toMatchObject({
      server: 'telegram',
      target: 'overnight-agent:telegram-bot-token',
      envVar: 'TELEGRAM_BOT_TOKEN',
      command: 'uvx',
    })
    expect(isValidMcpSecrets(parsed)).toBe(true)
  })

  it('rejects a missing version', () => {
    const errors = collectMcpSecretsErrors({ secrets: [] })
    expect(errors).toContain('version must be a positive integer')
  })

  it('rejects a secret entry missing required fields', () => {
    const errors = collectMcpSecretsErrors({
      version: 1,
      secrets: [{ server: 'telegram' }],
    })
    expect(errors.some((e) => e.includes('secrets[0].target'))).toBe(true)
    expect(errors.some((e) => e.includes('secrets[0].envVar'))).toBe(true)
    expect(errors.some((e) => e.includes('secrets[0].command'))).toBe(true)
  })

  it('rejects an invalid env var name', () => {
    const errors = collectMcpSecretsErrors({
      version: 1,
      secrets: [{ server: 's', target: 't', envVar: '9BAD NAME', command: 'c' }],
    })
    expect(errors.some((e) => e.includes('envVar must be a valid'))).toBe(true)
  })

  it('rejects duplicate servers or targets', () => {
    const errors = collectMcpSecretsErrors({
      version: 1,
      secrets: [
        { server: 's', target: 't', envVar: 'A', command: 'c' },
        { server: 's', target: 't', envVar: 'B', command: 'c' },
      ],
    })
    expect(errors.some((e) => e.includes('server is duplicated'))).toBe(true)
    expect(errors.some((e) => e.includes('target is duplicated'))).toBe(true)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseMcpSecrets('{ not json')).toThrow(/not valid JSON/)
  })

  it('throws with details on an invalid shape', () => {
    expect(() => parseMcpSecrets('{"version":0,"secrets":[]}')).toThrow(/is invalid/)
  })
})
