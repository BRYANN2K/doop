import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The handoff routes over the REAL server (./harness.ts): building is view
 * work, writing is edit work + a linked project + the polling desktop app.
 * The write rides the same poll/finish bridge the repo reads use — here the
 * "desktop app" is a raw fetch answering the dispatched request.
 */

let server: Server
let owner: Client
let stranger: Client
let canvasId: string

const LINK_ID = '8a2c1e4f-0000-4000-8000-0000000000a1'
const DEVICE = '9b3d2f5a-0000-4000-8000-0000000000b2'

const specFile = (changeId: string) => ({
  path: `.workflow/changes/${changeId}/spec.md`,
  text: '# Spec\n\n- AC-1: it works\n',
})

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('handoff-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('handoff-stranger@test.dev', 'Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Handoff' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

describe('POST /api/canvases/:id/handoff', () => {
  it('requires a session and canvas access', async () => {
    const anon = new Client(server)
    expect((await anon.post(`/api/canvases/${canvasId}/handoff`, {})).status).toBe(401)
    expect((await stranger.post(`/api/canvases/${canvasId}/handoff`, {})).status).toBe(403)
  })

  it('refuses a build with nothing to hand off', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/handoff`, {})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/nothing to hand off/)
  })
})

describe('POST /api/canvases/:id/handoff/write', () => {
  it('validates the pack before touching the device', async () => {
    const changeId = 'new-change-1'
    expect((await stranger.post(`/api/canvases/${canvasId}/handoff/write`, { changeId, files: [] })).status).toBe(403)
    /* a path outside the change folder never leaves the server */
    const escape = await owner.post(`/api/canvases/${canvasId}/handoff/write`, {
      changeId,
      files: [{ path: `.workflow/changes/${changeId}/../evil.md`, text: 'x' }],
    })
    expect(escape.status).toBe(400)
    const dup = await owner.post(`/api/canvases/${canvasId}/handoff/write`, {
      changeId,
      files: [specFile(changeId), specFile(changeId)],
    })
    expect(dup.status).toBe(400)
    const badId = await owner.post(`/api/canvases/${canvasId}/handoff/write`, {
      changeId: 'Nope',
      files: [specFile('nope')],
    })
    expect(badId.status).toBe(400)
  })

  it('needs a link, then the device holding its grant', async () => {
    const changeId = 'new-change-1'
    const noLink = await owner.post(`/api/canvases/${canvasId}/handoff/write`, {
      changeId,
      files: [specFile(changeId)],
    })
    expect(noLink.status).toBe(409)
    await owner.post(`/api/canvases/${canvasId}/repo`, { linkId: LINK_ID, name: 'my-project', deviceId: DEVICE })
    const offline = await owner.post(`/api/canvases/${canvasId}/handoff/write`, {
      changeId,
      files: [specFile(changeId)],
    })
    expect(offline.status).toBe(502)
    expect((await offline.json()).error).toMatch(/isn't online/)
  })

  it('dispatches write_change to the polling app and returns its folder', async () => {
    const changeId = 'new-change-2'
    /* the app: long-poll holding the link's grant, answer, finish */
    const poll = fetch(`${server.base}/api/local-repo/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.header() },
      body: JSON.stringify({ deviceId: DEVICE, grants: [LINK_ID] }),
    })
    /* the device must be registered before the write dispatches to it */
    await new Promise((r) => setTimeout(r, 300))
    const write = owner.post(`/api/canvases/${canvasId}/handoff/write`, { changeId, files: [specFile(changeId)] })
    const { request } = await (await poll).json()
    expect(request).toMatchObject({ linkId: LINK_ID, op: 'write_change' })
    expect(request.args.changeId).toBe(changeId)
    expect(request.args.files).toHaveLength(1)
    const done = await owner.post(`/api/local-repo/finish/${request.id}`, {
      deviceId: DEVICE,
      ok: true,
      result: { dir: `.workflow/changes/${changeId}`, written: [`${changeId}/spec.md`], repo: 'my-project' },
    })
    expect(done.status).toBe(200)
    const res = await write
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result.dir).toBe(`.workflow/changes/${changeId}`)
  })

  it('maps the app’s refusal — the native dialog declined — to 409', async () => {
    const changeId = 'new-change-3'
    const poll = fetch(`${server.base}/api/local-repo/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.header() },
      body: JSON.stringify({ deviceId: DEVICE, grants: [LINK_ID] }),
    })
    await new Promise((r) => setTimeout(r, 300))
    const write = owner.post(`/api/canvases/${canvasId}/handoff/write`, { changeId, files: [specFile(changeId)] })
    const { request } = await (await poll).json()
    await owner.post(`/api/local-repo/finish/${request.id}`, { deviceId: DEVICE, ok: false, error: 'cancelled' })
    const res = await write
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('cancelled')
  })
})
