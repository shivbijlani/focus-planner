import { describe, expect, it } from 'vitest'
import vectors from '../../plugins/overnight-agent/tests/lanes/vectors.json'
import {
  deviceServes, freshCatchAll, laneView, parseLanesFile, readLaneBoard, resolveTaskLane, serializeLanesFile, servesLane,
} from './lanes.js'

// The same vectors the engines' node:test suite runs (docs/spec/Domain-lanes.md).
const board = readLaneBoard(vectors.board.join('\n'))
const config = parseLanesFile(JSON.stringify(vectors.lanesFile, null, 2))

describe('lanes resolution vectors (shared with both engines)', () => {
  for (const r of vectors.resolution) {
    it(`${r.v}: task ${r.id}`, () => {
      expect(resolveTaskLane(r.id, board, config.tasks)).toEqual({
        lane: r.lane, source: r.source, from: r.from, problem: r.problem, candidates: r.candidates,
      })
    })
  }
})

describe('served-here vectors', () => {
  for (const [name, d] of Object.entries(vectors.devices)) {
    it(`device ${name}`, () => {
      const serves = deviceServes(config, d.key)
      const served = vectors.resolution.filter((r) => {
        const x = resolveTaskLane(r.id, board, config.tasks)
        return !x.problem && servesLane(serves, x.lane)
      }).map((r) => r.id).sort()
      expect(served).toEqual([...vectors.served[name]].sort())
    })
  }
})

describe('lanes-file validation vectors', () => {
  for (const c of vectors.validation) {
    it(c.v, () => {
      let text
      if (c.file === null) text = null
      else if (c.raw !== undefined) text = c.raw
      else if (c.oversize) text = `{"schema":"fp-agent-lanes@1","pad":"${'x'.repeat(256 * 1024)}"}`
      else if (c.manyDevices) {
        const devices = {}
        for (let i = 0; i < c.manyDevices; i++) devices[i.toString(16).padStart(32, '0')] = {}
        text = JSON.stringify({ schema: 'fp-agent-lanes@1', devices })
      } else if (c.manyTasks) {
        const tasks = {}
        for (let i = 1; i <= c.manyTasks; i++) tasks[String(i)] = 'ado'
        text = JSON.stringify({ schema: 'fp-agent-lanes@1', tasks })
      } else text = JSON.stringify(c.doc, null, 2)
      if (c.bom && text !== null) text = `\uFEFF${text}`
      const r = parseLanesFile(text)
      if (c.verdict === 'off') { expect(r).toBeNull(); return }
      expect(r.state).toBe(c.verdict)
      if (c.reason) expect(r.reason).toBe(c.reason)
      if (c.serves) for (const [k, l] of Object.entries(c.serves)) expect(r.devices[k].lanes).toEqual(l)
    })
  }
})

describe('what the user sees', () => {
  const A = vectors.devices.A.key
  const B = vectors.devices.B.key
  const C = vectors.devices.C.key
  const fresh = (key, name) => ({ key, name, stale: false, lastSeenMs: 1 })
  const view = (id, devices) => laneView(resolveTaskLane(id, board, config.tasks), config, devices)

  it('a lane a fresh device serves is "served" (A5 chip)', () => {
    expect(view('10', [fresh(A, 'WORK-LAPTOP')]).status).toBe('served')
  })
  it('a lane whose only device is stale is "waiting", naming that device', () => {
    const v = view('10', [{ key: A, name: 'WORK-LAPTOP', stale: true, lastSeenMs: 5 }])
    expect(v.status).toBe('waiting')
    expect(v.assigned).toEqual([{ key: A, name: 'WORK-LAPTOP', lastSeenMs: 5 }])
  })
  it('a lane no device is assigned is "waiting" with nobody assigned (A6)', () => {
    const v = view('35', [fresh(A, 'a'), fresh(B, 'b')])
    expect(v.status).toBe('waiting')
    expect(v.assigned).toEqual([])
  })
  it('a conflict is a problem (A7); no lane shows nothing', () => {
    expect(view('24', []).status).toBe('problem')
    expect(view('21', []).status).toBe('none')
  })
  it('two fresh catch-all devices are reported (A9); an unannounced one is not', () => {
    expect(freshCatchAll(config, [fresh(A, 'a'), fresh(B, 'b'), fresh(C, 'c')]).map((d) => d.key)).toEqual([B, C])
  })
})

describe('serializeLanesFile', () => {
  it('writes a file every reader accepts, in spec order, sorted, LF', () => {
    const text = serializeLanesFile({
      revision: 4,
      devices: { [vectors.devices.B.key]: { name: 'HOME', lanes: ['home', 'home'], catchAll: true }, [vectors.devices.A.key]: { name: 'LAPTOP', lanes: ['ado'] } },
      tasks: { 26: 'ado', 5: 'none' },
    }, new Date('2026-10-03T12:00:00.000Z'))
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).not.toContain('\r')
    const doc = JSON.parse(text)
    expect(Object.keys(doc)).toEqual(['schema', 'revision', 'updatedAt', 'devices', 'tasks'])
    expect(Object.keys(doc.devices)).toEqual([vectors.devices.B.key, vectors.devices.A.key].sort())
    expect(doc.devices[vectors.devices.B.key]).toEqual({ name: 'HOME', lanes: ['home'], catchAll: true })
    expect(doc.tasks).toEqual({ 5: 'none', 26: 'ado' })
    expect(parseLanesFile(text).state).toBe('ok')
  })
})
