import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The canvas chat over the REAL server (./harness.ts): viewers read the log,
 * commenters write plain lines, only editors can ask the agent or act on a
 * plan, and every message reaches the room over the websocket — in `init`
 * and live. Plan lifecycle itself is covered by chatActions.test.ts; the
 * routes only see plans the agent made, so here they get 404s on unknown ids.
 */

let server: Server
let owner: Client
let commenter: Client
let stranger: Client
let canvasId: string
let privateId: string

beforeAll(async () => {
  /* a free tier so mentions meter instead of always hitting resident_limit */
  server = await startServer({ RESIDENT_TASK_LIMIT: '25' })
  owner = await new Client(server).signUp('chat-owner@test.dev', 'Owner')
  commenter = await new Client(server).signUp('chat-commenter@test.dev', 'Commenter')
  stranger = await new Client(server).signUp('chat-stranger@test.dev', 'Stranger')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Chat' })).json()).id
  /* the commenter comes in over the share link's comment access */
  await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'comment' })
  /* a canvas nobody shares: the stranger's 403s are measured here */
  privateId = (await (await owner.post('/api/canvases', { name: 'Private' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

const ALLOWANCE = '/api/agent-allowance'
const allowance = async (c: Client) => (await (await c.get(ALLOWANCE)).json()) as { used: number; limit: number }

describe('history and send', () => {
  it('starts empty and takes a line', async () => {
    expect(await (await owner.get(`/api/canvases/${canvasId}/chat`)).json()).toEqual([])
    const res = await owner.post(`/api/canvases/${canvasId}/chat`, { text: 'first thought' })
    expect(res.status).toBe(200)
    const message = await res.json()
    expect(message).toMatchObject({ canvasId, from: 'Owner', text: 'first thought' })
    /* the Chat tab talks to Doop: an editor's line asks the agent with no @mention */
    expect(message.forAgent).toBe(true)
    const history = await (await owner.get(`/api/canvases/${canvasId}/chat`)).json()
    expect(history.map((m: { id: string }) => m.id)).toEqual([message.id])
  })

  it('a reply lands under its thread root', async () => {
    const root = await (await owner.post(`/api/canvases/${canvasId}/chat`, { text: 'the question' })).json()
    const reply = await (
      await owner.post(`/api/canvases/${canvasId}/chat`, { text: 'an answer', threadId: root.id })
    ).json()
    expect(reply.threadId).toBe(root.id)
    /* a reply in the same thread keeps the same root */
    const second = await (
      await owner.post(`/api/canvases/${canvasId}/chat`, { text: 'follow-up', threadId: reply.id })
    ).json()
    expect(second.threadId).toBe(root.id)
    /* a thread id from nowhere is a 404 */
    expect((await owner.post(`/api/canvases/${canvasId}/chat`, { text: 'hi', threadId: 'nope' })).status).toBe(404)
  })

  it('rejects empty and oversized input', async () => {
    expect((await owner.post(`/api/canvases/${canvasId}/chat`, { text: '   ' })).status).toBe(400)
    const res = await owner.post(`/api/canvases/${canvasId}/chat`, { text: 'x'.repeat(4100) })
    expect(res.status).toBe(200)
    expect((await res.json()).text.length).toBe(4000)
  })
})

describe('who may do what', () => {
  it('viewers read, commenters write, strangers and anon get nothing', async () => {
    expect((await commenter.get(`/api/canvases/${canvasId}/chat`)).status).toBe(200)
    const res = await commenter.post(`/api/canvases/${canvasId}/chat`, { text: 'commenter speaks' })
    expect(res.status).toBe(200)
    expect((await res.json()).from).toBe('Commenter')
    /* on a canvas the stranger shares nothing of, there is no chat at all */
    expect((await stranger.get(`/api/canvases/${privateId}/chat`)).status).toBe(403)
    expect((await stranger.post(`/api/canvases/${privateId}/chat`, { text: 'hi' })).status).toBe(403)
    const anon = new Client(server)
    expect((await anon.get(`/api/canvases/${canvasId}/chat`)).status).toBe(401)
    expect((await anon.post(`/api/canvases/${canvasId}/chat`, { text: 'hi' })).status).toBe(401)
  })

  it('a commenter cannot address the agent — mentions are editor work', async () => {
    const res = await commenter.post(`/api/canvases/${canvasId}/chat`, { text: '@Doop design a login' })
    expect(res.status).toBe(403)
    /* and the refused mention never reached the log */
    const history = await (await owner.get(`/api/canvases/${canvasId}/chat`)).json()
    expect(history.some((m: { text: string }) => m.text.includes('design a login'))).toBe(false)
  })

  it('an editor’s @mention becomes a metered ask routed to the agent', async () => {
    const before = await allowance(owner)
    const res = await owner.post(`/api/canvases/${canvasId}/chat`, { text: '@Doop plan a pricing page' })
    expect(res.status).toBe(200)
    const message = await res.json()
    expect(message.forAgent).toBe(true)
    expect(message.targetAgent).toBe('Doop')
    const after = await allowance(owner)
    expect(after.used).toBe(before.used + 1)
  })

  it('retry on a still-open ask is a conflict — and the meter is refunded', async () => {
    const ask = await (await owner.post(`/api/canvases/${canvasId}/chat`, { text: '@Doop second ask' })).json()
    const before = await allowance(owner)
    expect((await owner.post(`/api/chat/${ask.id}/retry`)).status).toBe(409)
    const after = await allowance(owner)
    expect(after.used).toBe(before.used)
  })

  it('plan routes answer 404 on an unknown message, before any role check', async () => {
    expect((await owner.post('/api/chat/nope/launch')).status).toBe(404)
    expect((await owner.post('/api/chat/nope/cancel')).status).toBe(404)
    expect((await owner.patch('/api/chat/nope/plan', { plan: {} })).status).toBe(404)
    expect((await stranger.post('/api/chat/nope/launch')).status).toBe(404)
  })
})

describe('the room hears it', () => {
  it('init carries the log and sends go out live', async () => {
    const messages: { type: string; chat?: unknown[]; message?: { text: string } }[] = []
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
    const got = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timed out')), 8000)
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d))
        messages.push(msg)
        if (msg.type === 'chat' && msg.message?.text === 'live line') {
          clearTimeout(timer)
          resolve()
        }
      })
      ws.on('error', reject)
    })
    await new Promise<void>((resolve) => ws.on('open', resolve))
    ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'chat-test', name: 't', kind: 'user' }))
    await new Promise((r) => setTimeout(r, 300))
    await owner.post(`/api/canvases/${canvasId}/chat`, { text: 'live line' })
    await got
    ws.close()
    const init = messages.find((m) => m.type === 'init')!
    expect(Array.isArray(init.chat)).toBe(true)
    expect((init.chat as { text: string }[]).some((m) => m.text === 'first thought')).toBe(true)
  })
})
