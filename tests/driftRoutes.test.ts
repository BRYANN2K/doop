import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Drift routes against the real server: the CI webhook's agent-key auth
 * ladder and the session routes' validation. No comparison ever reaches a
 * browser here — public-URL captures need network, and local ones a desktop
 * that isn't polling — so every case fails or short-circuits deterministically.
 */

let server: Server
let BASE: string

beforeAll(async () => {
  server = await startServer()
  BASE = server.base
}, 70_000)

afterAll(() => server?.stop())

const webhook = (canvasId: string, body: unknown, secret?: string) =>
  fetch(`${BASE}/api/canvases/${canvasId}/drift`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  })

describe('drift routes', () => {
  let owner: Client
  let stranger: Client
  let canvasId: string
  let frameId: string
  let ownerKey: string
  let strangerKey: string

  beforeAll(async () => {
    owner = new Client(server)
    stranger = new Client(server)
    await owner.signUp('drift-owner@test.dev', 'Owner')
    await stranger.signUp('drift-stranger@test.dev', 'Stranger')

    const canvas = await (await owner.post('/api/canvases', { name: 'drift' })).json()
    canvasId = canvas.id
    const frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Hero',
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        html: '<p>hi</p>',
      })
    ).json()
    frameId = frame.id

    ownerKey = (await (await owner.post('/api/agent-keys', { name: 'ci' })).json()).secret
    strangerKey = (await (await stranger.post('/api/agent-keys', { name: 'ci' })).json()).secret
  })

  it('rejects the webhook without an agent key', async () => {
    expect((await webhook(canvasId, { frameId, url: 'https://x.example' })).status).toBe(401)
    expect((await webhook(canvasId, { frameId, url: 'https://x.example' }, 'not-a-key')).status).toBe(401)
    expect(
      (await webhook(canvasId, { frameId, url: 'https://x.example' }, 'dpk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status,
    ).toBe(401)
  })

  it('rejects the webhook for an unknown canvas', async () => {
    expect((await webhook('cv_nope', { frameId, url: 'https://x.example' }, ownerKey)).status).toBe(404)
  })

  it('rejects the webhook when the key’s account cannot edit the canvas', async () => {
    const res = await webhook(canvasId, { frameId, url: 'https://x.example' }, strangerKey)
    expect(res.status).toBe(403)
  })

  it('rejects the webhook for a frame that is not on the canvas', async () => {
    const res = await webhook(canvasId, { frameId: 'fr_nope', url: 'https://x.example' }, ownerKey)
    expect(res.status).toBe(404)
  })

  it('rejects the webhook without a url', async () => {
    expect((await webhook(canvasId, { frameId }, ownerKey)).status).toBe(400)
    expect((await webhook(canvasId, { frameId, url: '   ' }, ownerKey)).status).toBe(400)
  })

  it('refuses local URLs from CI — they need the desktop app', async () => {
    for (const url of ['http://localhost:3000', 'http://192.168.1.10', 'http://printer.local']) {
      const res = await webhook(canvasId, { frameId, url }, ownerKey)
      expect(res.status, url).toBe(422)
      expect((await res.json()).error).toMatch(/desktop/)
    }
  })

  it('requires a session on the frame routes', async () => {
    const anon = new Client(server)
    expect((await anon.post(`/api/frames/${frameId}/drift`, { url: 'https://x.example' })).status).toBe(401)
    expect((await anon.get(`/api/frames/${frameId}/drift`)).status).toBe(401)
  })

  it('hides the frame routes from an account without access', async () => {
    const res = await stranger.post(`/api/frames/${frameId}/drift`, { url: 'https://x.example' })
    expect([403, 404]).toContain(res.status)
  })

  it('validates the url before any capture', async () => {
    const res = await owner.post(`/api/frames/${frameId}/drift`, { url: 'not a url' })
    expect(res.status).toBe(400)
    expect((await owner.post(`/api/frames/${frameId}/drift`, {})).status).toBe(400)
  })

  it('reports a local URL cleanly when no desktop is online', async () => {
    const res = await owner.post(`/api/frames/${frameId}/drift`, { url: 'http://localhost:3000/app' })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/desktop/)
  })

  it('lists comparisons for the frame', async () => {
    const res = await owner.get(`/api/frames/${frameId}/drift`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('404s analyze for an unknown comparison', async () => {
    const res = await owner.post(`/api/frames/${frameId}/drift/dr_nope/analyze`, {})
    expect(res.status).toBe(404)
  })
})
