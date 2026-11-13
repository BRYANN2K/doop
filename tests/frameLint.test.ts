import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* The lint write path end to end: PUT /api/frames/:id/lint validates the
   payload, stores it as derived metadata (no updatedAt/updatedBy churn, no
   history) and GET returns it with the frame. */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

const LINT = {
  score: 78,
  errors: 1,
  warnings: 2,
  checkedAt: 123,
  version: 1,
  engine: 'dom',
  issues: [
    {
      ruleId: 'AS-COL-02',
      severity: 'error',
      message: 'span renders text as a gradient',
      selector: '[data-doop-id="t1"]',
      elementId: 't1',
    },
    { ruleId: 'AS-COPY-03', severity: 'warning', message: 'generic CTA "Learn more"' },
    { ruleId: 'AS-TYPE-11', severity: 'warning', message: 'p text is 11px (<12px floor)' },
  ],
}

describe('frame lint', () => {
  let client: Client
  let canvasId: string
  let frameId: string

  beforeAll(async () => {
    client = new Client(server)
    await client.signUp('lint@test.dev', 'Linter')
    canvasId = (await (await client.post('/api/canvases', { name: 'Lint' })).json()).id
    frameId = (await (await client.post(`/api/canvases/${canvasId}/frames`, { name: 'Hero' })).json()).id
  })

  async function frame() {
    const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
    return canvas.frames.find((f: { id: string }) => f.id === frameId)
  }

  it('rejects a malformed payload', async () => {
    const res = await client.put(`/api/frames/${frameId}/lint`, { lint: { score: 110, issues: [] } })
    expect(res.status).toBe(400)
  })

  it('rejects a payload without the lint envelope', async () => {
    const res = await client.put(`/api/frames/${frameId}/lint`, { score: 90 })
    expect(res.status).toBe(400)
  })

  it('stores a valid lint and returns it with the frame', async () => {
    const res = await client.put(`/api/frames/${frameId}/lint`, { lint: LINT })
    expect(res.status).toBe(200)
    const f = await frame()
    expect(f.lint.score).toBe(78)
    expect(f.lint.errors).toBe(1)
    expect(f.lint.issues).toHaveLength(3)
    expect(f.lint.issues[0].ruleId).toBe('AS-COL-02')
    expect(f.lint.issues[0].elementId).toBe('t1')
  })

  it('does not touch updatedAt, updatedBy or the html', async () => {
    const before = await frame()
    await client.put(`/api/frames/${frameId}/lint`, { lint: { ...LINT, score: 100, issues: [] } })
    const after = await frame()
    expect(after.lint.score).toBe(100)
    expect(after.lint.issues).toHaveLength(0)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.updatedBy).toBe(before.updatedBy)
    expect(after.html).toBe(before.html)
  })

  it('refuses a lint write from a stranger', async () => {
    const stranger = new Client(server)
    await stranger.signUp('lint-viewer@test.dev', 'Viewer')
    const res = await stranger.put(`/api/frames/${frameId}/lint`, { lint: { ...LINT, score: 1 } })
    expect(res.status).toBe(403)
    expect((await frame()).lint.score).toBe(100)
  })
})
