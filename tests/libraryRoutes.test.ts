import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The reference-library routes over the REAL server (./harness.ts): the pick
 * persists on the real database, comes back resolved to the canvases the
 * user can still open, and a canvas that is not theirs is refused.
 */

let server: Server
let owner: Client
let stranger: Client
let canvasId: string
let foreignId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('library-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('library-stranger@test.dev', 'Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Design Library' })).json()).id
  foreignId = (await (await stranger.post('/api/canvases', { name: 'Stranger Canvas' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

const library = async (c: Client) =>
  (await (await c.get('/api/library')).json()) as { canvases: { id: string; name: string; frameCount: number }[] }

describe('GET/PUT /api/library', () => {
  it('starts empty, then stores and returns the picked canvases', async () => {
    expect((await library(owner)).canvases).toEqual([])
    const res = await owner.put('/api/library', { canvasIds: [canvasId] })
    expect(res.status).toBe(200)
    expect((await res.json()).canvases).toEqual([{ id: canvasId, name: 'Design Library', frameCount: 0 }])
    /* the pick survives on the real database */
    expect((await library(owner)).canvases.map((c) => c.id)).toEqual([canvasId])
  })

  it('rejects a canvas the user cannot open', async () => {
    const res = await owner.put('/api/library', { canvasIds: [foreignId] })
    expect(res.status).toBe(400)
    /* and the earlier pick is untouched */
    expect((await library(owner)).canvases.map((c) => c.id)).toEqual([canvasId])
  })

  it('rejects a malformed body and an oversized library', async () => {
    expect((await owner.put('/api/library', {})).status).toBe(400)
    expect((await owner.put('/api/library', { canvasIds: 'abc' })).status).toBe(400)
    expect((await owner.put('/api/library', { canvasIds: [canvasId, ''] })).status).toBe(400)
    const nine = Array.from({ length: 9 }, (_, i) => (i === 0 ? canvasId : `fake-${i}`))
    expect((await owner.put('/api/library', { canvasIds: nine })).status).toBe(400)
  })

  it('an empty list clears the library', async () => {
    expect((await owner.put('/api/library', { canvasIds: [] })).status).toBe(200)
    expect((await library(owner)).canvases).toEqual([])
  })

  it('each user has their own library', async () => {
    await owner.put('/api/library', { canvasIds: [canvasId] })
    expect((await library(stranger)).canvases).toEqual([])
  })

  it('anonymous callers get nothing', async () => {
    const anon = new Client(server)
    expect((await anon.get('/api/library')).status).toBe(401)
    expect((await anon.put('/api/library', { canvasIds: [canvasId] })).status).toBe(401)
  })
})

describe('the remove-reference route', () => {
  it('answers 404 on an unknown message, before any role check', async () => {
    for (const c of [owner, stranger]) {
      const res = await c.req('/api/chat/nope/plan/references', {
        method: 'DELETE',
        body: JSON.stringify({ screen: 0, libraryId: 'x' }),
      })
      expect(res.status).toBe(404)
    }
  })
})
