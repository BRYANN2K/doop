import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

/* The drift compare's own seams are stubbed (capture, design render, db
   writes): a unit test exercises classification, placement, scoring and the
   card queue without launching a browser. Same store/persist stubs as
   repoCards.test.ts. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: () => Promise.resolve(),
  deleteFrame: () => {},
}))
vi.mock('../server/db/index.ts', () => {
  /* where() answers as an awaitable [] that also chains .orderBy() — covers
     both listComparisons and getComparison */
  const where = () => Object.assign(Promise.resolve([] as unknown[]), { orderBy: () => Promise.resolve([]) })
  return {
    db: {
      insert: () => ({ values: () => Promise.resolve() }),
      select: () => ({ from: () => ({ where }) }),
    },
  }
})
vi.mock('../server/assets.ts', () => ({
  storeAsset: async () => ({ id: 'asset1', mime: 'image/png', ext: 'png', size: 100 }),
}))

const { classifyDriftUrl } = await import('../shared/drift.ts')
const { pixelScore } = await import('../server/driftDiff.ts')
const { compareFrameWithUrl, DriftInputError, DriftLocalUnavailableError, driftDeps } =
  await import('../server/drift.ts')
const { localDrift } = await import('../server/driftBridge.ts')
const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')

describe('classifyDriftUrl', () => {
  it('rejects non-http(s) schemes and credentials', () => {
    expect(classifyDriftUrl('not a url')).toEqual({ kind: 'invalid', reason: 'not a valid URL' })
    expect(classifyDriftUrl('ftp://example.com').kind).toBe('invalid')
    expect(classifyDriftUrl('file:///etc/passwd').kind).toBe('invalid')
    expect(classifyDriftUrl('https://user:pw@example.com').kind).toBe('invalid')
    expect(classifyDriftUrl('javascript:alert(1)').kind).toBe('invalid')
  })

  it('classifies loopback, private and link-local addresses as local', () => {
    for (const url of [
      'http://localhost:3000/app',
      'http://foo.localhost',
      'http://printer.local',
      'http://nas.internal',
      'http://homeserver',
      'http://127.0.0.1:8080',
      'http://10.0.0.4',
      'http://192.168.1.20',
      'http://172.16.5.5',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]:3000',
      'http://[fe80::1]',
      'http://[fd00::8]',
      'http://0.0.0.0',
    ]) {
      expect(classifyDriftUrl(url), url).toEqual({ kind: 'local' })
    }
  })

  it('classifies public names and public IPs as server candidates', () => {
    for (const url of [
      'https://preview-abc123.vercel.app',
      'https://example.com:8443/path?q=1',
      'http://8.8.8.8',
      'https://192.0.2.1.nip.io',
    ]) {
      expect(classifyDriftUrl(url), url).toEqual({ kind: 'public' })
    }
  })
})

describe('pixelScore', () => {
  const png = (width: number, height: number, background: string) =>
    sharp({ create: { width, height, channels: 3, background } })
      .png()
      .toBuffer()

  it('scores identical renders 0', async () => {
    const a = await png(40, 30, '#ffffff')
    const score = await pixelScore(a, a)
    expect(score.score).toBe(0)
    expect(score.diffPixels).toBe(0)
  })

  it('scores a fully different render 100', async () => {
    const score = await pixelScore(await png(40, 30, '#000000'), await png(40, 30, '#ffffff'))
    expect(score.score).toBe(100)
  })

  it('scores a half-changed render ~50', async () => {
    const black = await png(40, 30, '#000000')
    const half = await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: '#ffffff',
      },
    })
      .composite([{ input: await png(20, 30, '#000000'), left: 20, top: 0 }])
      .png()
      .toBuffer()
    const score = await pixelScore(black, half)
    expect(score.score).toBeGreaterThan(45)
    expect(score.score).toBeLessThan(55)
  })

  it('counts a shorter shipped page as missing content', async () => {
    /* design: white on top, black bottom — shipped: only the white part */
    const design = await sharp({
      create: { width: 40, height: 40, channels: 3, background: '#ffffff' },
    })
      .composite([{ input: await png(40, 20, '#000000'), left: 0, top: 20 }])
      .png()
      .toBuffer()
    const shipped = await png(40, 20, '#ffffff')
    const score = await pixelScore(design, shipped)
    expect(score.score).toBe(50)
  })
})

describe('compareFrameWithUrl', () => {
  let canvasId: string
  let frame: ReturnType<typeof actions.createFrame> & object

  beforeEach(() => {
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map(),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    canvasId = store.createCanvas('drift', 'kevin').id
    frame = actions.createFrame(
      canvasId,
      { name: 'Hero', x: 100, y: 200, width: 400, height: 300, html: '<p>hi</p>' },
      actor(),
    )!
  })

  const actor = () => actions.resolveActor({ name: 'kevin', kind: 'user' })

  it('places a Shipped frame beside the design and records the score', async () => {
    const shipped = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer()
    const design = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer()
    const result = await compareFrameWithUrl(
      { frame, url: 'https://preview.example.com/app', actor: actor(), userId: 'user-1', source: 'ui' },
      {
        capture: async () => ({
          png: shipped,
          finalUrl: 'https://preview.example.com/app',
          title: 'app',
          width: 400,
          height: 300,
        }),
        renderDesign: async () => design,
        score: driftDeps.score,
        assertPublic: async (u) => new URL(u),
        now: () => 42,
      },
    )
    expect(result.comparison.frameId).toBe(frame.id)
    expect(result.comparison.canvasId).toBe(canvasId)
    expect(result.comparison.shippedFrameId).toBe(result.shipped.id)
    expect(result.comparison.score).toBe(0)
    expect(result.comparison.via).toBe('server')
    expect(result.comparison.source).toBe('ui')
    expect(result.comparison.requestedBy).toBe('kevin')
    /* beside the design, on its page, one gap over */
    expect(result.shipped.pageId).toBe(frame.pageId)
    expect(result.shipped.x).toBe(frame.x + frame.width + 80)
    expect(result.shipped.y).toBe(frame.y)
    expect(result.shipped.width).toBe(400)
    expect(result.shipped.name).toContain('Shipped')
    expect(store.getFrame(result.shipped.id)?.html).toContain('/a/asset1.png')
  })

  it('refuses an invalid URL before any capture', async () => {
    await expect(
      compareFrameWithUrl({ frame, url: 'nope', actor: actor(), userId: 'u1', source: 'ui' }),
    ).rejects.toBeInstanceOf(DriftInputError)
  })

  it('refuses a local URL when no desktop is online', async () => {
    await expect(
      compareFrameWithUrl({ frame, url: 'http://localhost:3000', actor: actor(), userId: 'u1', source: 'ui' }),
    ).rejects.toBeInstanceOf(DriftLocalUnavailableError)
  })

  it('captures a local URL through the user’s desktop bridge', async () => {
    const polling = localDrift.poll('u1', 'dev-1')
    const seen: { local?: boolean; userId?: string } = {}
    try {
      const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#abcdef' } })
        .png()
        .toBuffer()
      await compareFrameWithUrl(
        { frame, url: 'http://localhost:3000/app', actor: actor(), userId: 'u1', source: 'mcp' },
        {
          capture: async (_url, _width, opts = {}) => {
            seen.local = opts.local
            seen.userId = opts.userId
            return { png, finalUrl: 'http://localhost:3000/app', title: 'dev', width: 400, height: 300 }
          },
          renderDesign: async () => png,
          score: driftDeps.score,
          assertPublic: async (u) => new URL(u),
          now: () => 42,
        },
      )
      expect(seen).toEqual({ local: true, userId: 'u1' })
    } finally {
      localDrift.dropWaiter('u1', 'dev-1')
      await polling
    }
  })

  it('keeps the comparison when the score cannot be computed', async () => {
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#abcdef' } })
      .png()
      .toBuffer()
    const result = await compareFrameWithUrl(
      { frame, url: 'https://preview.example.com', actor: actor(), userId: 'u1', source: 'webhook' },
      {
        capture: async () => ({ png, finalUrl: 'https://preview.example.com', title: 'x', width: 400, height: 300 }),
        renderDesign: async () => {
          throw new Error('no renderer')
        },
        score: driftDeps.score,
        assertPublic: async (u) => new URL(u),
        now: () => 42,
      },
    )
    expect(result.comparison.score).toBeUndefined()
    expect(result.shipped.name).toContain('Shipped')
  })
})
