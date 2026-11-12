import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The local-project link over the REAL server (./harness.ts): the link is
 * per (canvas, user) — each editor's own — and the poll/finish bridge is
 * session-guarded with the same ownership rules as local agent's.
 */

let server: Server
let owner: Client
let member: Client
let stranger: Client
let canvasId: string

const LINK_ID = '1c8d5d6e-0000-4000-8000-000000000001'
const DEVICE = '2d9e6f7a-0000-4000-8000-000000000002'
const DEVICE_B = '3eaf809b-0000-4000-8000-000000000003'

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('repo-owner@test.dev', 'Owner')
  member = await new Client(server).signUp('repo-member@test.dev', 'Member')
  stranger = await new Client(server).signUp('repo-stranger@test.dev', 'Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Repo' })).json()).id
  await owner.post(`/api/canvases/${canvasId}/members`, { email: 'repo-member@test.dev' })
}, 70_000)

afterAll(() => server?.stop())

describe('canvas link routes', () => {
  it('starts empty and stores only the link shape', async () => {
    const status = await (await owner.get(`/api/canvases/${canvasId}/repo`)).json()
    expect(status).toEqual({ link: null, online: false, deviceMismatch: false })

    const res = await owner.post(`/api/canvases/${canvasId}/repo`, {
      linkId: LINK_ID,
      name: 'my-project',
      deviceId: DEVICE,
    })
    expect(res.status).toBe(200)
    const { link } = await res.json()
    expect(link).toMatchObject({ id: LINK_ID, name: 'my-project', deviceId: DEVICE })
    expect(link.lastUsedAt).toBeTypeOf('number')

    const after = await (await owner.get(`/api/canvases/${canvasId}/repo`)).json()
    expect(after.link.id).toBe(LINK_ID)
  })

  it('replaces the link on re-link and rejects bad bodies', async () => {
    const other = '4fbed9ac-0000-4000-8000-000000000004'
    await owner.post(`/api/canvases/${canvasId}/repo`, { linkId: other, name: 'elsewhere', deviceId: DEVICE })
    const { link } = await (await owner.get(`/api/canvases/${canvasId}/repo`)).json()
    expect(link.id).toBe(other)
    expect((await owner.post(`/api/canvases/${canvasId}/repo`, { name: 'x' })).status).toBe(400)
    expect(
      (await owner.post(`/api/canvases/${canvasId}/repo`, { linkId: 'nope', name: 'x', deviceId: DEVICE })).status,
    ).toBe(400)
  })

  it('is per user — a member keeps their own link, strangers get nothing', async () => {
    const memberLink = '5ac1eb0d-0000-4000-8000-000000000005'
    const res = await member.post(`/api/canvases/${canvasId}/repo`, {
      linkId: memberLink,
      name: 'member-project',
      deviceId: DEVICE_B,
    })
    expect(res.status).toBe(200)
    // the member sees their own link, not the owner's
    const mine = await (await member.get(`/api/canvases/${canvasId}/repo`)).json()
    expect(mine.link.id).toBe(memberLink)
    expect(mine.link.name).toBe('member-project')
    // the owner's is untouched
    const owners = await (await owner.get(`/api/canvases/${canvasId}/repo`)).json()
    expect(owners.link.name).toBe('elsewhere')
    // a stranger has no access at all
    expect((await stranger.get(`/api/canvases/${canvasId}/repo`)).status).toBe(403)
    expect(
      (
        await stranger.post(`/api/canvases/${canvasId}/repo`, {
          linkId: '6bd2fc1e-0000-4000-8000-000000000006',
          name: 'x',
          deviceId: DEVICE,
        })
      ).status,
    ).toBe(403)
  })

  it('deletes only the caller’s link', async () => {
    expect((await member.delete(`/api/canvases/${canvasId}/repo`)).status).toBe(200)
    const mine = await (await member.get(`/api/canvases/${canvasId}/repo`)).json()
    expect(mine.link).toBeNull()
    const owners = await (await owner.get(`/api/canvases/${canvasId}/repo`)).json()
    expect(owners.link).not.toBeNull()
    // deleting again is a no-op, not an error
    expect((await member.delete(`/api/canvases/${canvasId}/repo`)).status).toBe(200)
  })

  it('requires a session', async () => {
    const anon = new Client(server)
    expect((await anon.get(`/api/canvases/${canvasId}/repo`)).status).toBe(401)
    expect(
      (await anon.post(`/api/canvases/${canvasId}/repo`, { linkId: LINK_ID, name: 'x', deviceId: DEVICE })).status,
    ).toBe(401)
  })
})

describe('local-repo poll bridge', () => {
  it('requires a session and a valid body', async () => {
    const anon = new Client(server)
    expect((await anon.post('/api/local-repo/poll', { deviceId: DEVICE, grants: [] })).status).toBe(401)
    expect((await owner.post('/api/local-repo/poll', { deviceId: 'x', grants: [] })).status).toBe(400)
    expect((await owner.post('/api/local-repo/poll', { deviceId: DEVICE })).status).toBe(400)
  })

  it('a second device stands by while the first polls', async () => {
    // the first poll long-polls — abort it client-side after the check
    const controller = new AbortController()
    const first = fetch(`${server.base}/api/local-repo/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.header() },
      body: JSON.stringify({ deviceId: DEVICE, grants: [LINK_ID] }),
      signal: controller.signal,
    }).catch(() => null)
    // give the first a beat to register
    await new Promise((r) => setTimeout(r, 300))
    const second = await owner.post('/api/local-repo/poll', { deviceId: DEVICE_B, grants: [LINK_ID] })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ request: null })
    // and the link status now reports the owner's install online
    const status = await (await owner.get(`/api/canvases/${canvasId}/repo`)).json()
    expect(status.online).toBe(true)
    expect(status.deviceMismatch).toBe(false)
    controller.abort()
    await first
  })

  it('finish is owner-and-device-checked', async () => {
    const unknown = await owner.post('/api/local-repo/finish/7dc30a2f-0000-4000-8000-000000000007', {
      deviceId: DEVICE,
      ok: true,
      result: {},
    })
    expect(unknown.status).toBe(409)
    expect((await owner.post('/api/local-repo/finish/not-a-uuid', { deviceId: DEVICE, ok: true })).status).toBe(409)
    expect((await owner.post('/api/local-repo/finish/x', { deviceId: 'bad', ok: true })).status).toBe(400)
  })
})
