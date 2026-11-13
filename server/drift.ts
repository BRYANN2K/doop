import { nanoid } from 'nanoid'
import { desc, eq } from 'drizzle-orm'
import type { Actor, Frame } from '../shared/types.ts'
import {
  DRIFT_MAX_HEIGHT,
  DRIFT_MAX_LOCAL_REQUESTS,
  classifyDriftUrl,
  type DriftComparison,
  type DriftSource,
  type DriftVia,
} from '../shared/drift.ts'
import { db } from './db/index.ts'
import { driftComparisons } from './db/schema.ts'
import { storeAsset } from './assets.ts'
import { placeImage } from './placeImage.ts'
import { openIsolatedPage, renderFrame } from './screenshot.ts'
import { assertPublicNetworkUrl, guardPublicPageRequests } from './publicUrl.ts'
import { navigateWebsitePage, WebsiteCaptureUnavailableError } from './websiteAccess.ts'
import { localDrift, localFetchFor } from './driftBridge.ts'
import { pixelScore, type DriftScore } from './driftDiff.ts'
import { env } from './env.ts'

/* Drift review (shared/drift.ts): capture the shipped page at the frame's
 * width, place it beside the frame as a "Shipped" image frame, and score
 * how far the two renders drift apart. Public URLs render through the same
 * guarded path as imports; local URLs render there too, but every byte is
 * fetched on the owner's desktop (driftBridge.ts). */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 DoopDrift/1.0'
const NAV_TIMEOUT_MS = 25_000
/** Gap left between the designed frame and its shipped capture. */
const SHIPPED_GAP_X = 80

/** The asker sent something the compare can never run: URL validation. */
export class DriftInputError extends Error {}
/** A local URL with no desktop app online to serve it. */
export class DriftLocalUnavailableError extends Error {}

export interface UrlCapture {
  png: Buffer
  finalUrl: string
  title: string
  width: number
  height: number
}

/** Render `url` at the frame's width in the shared headless browser and
 *  screenshot the page top, capped at DRIFT_MAX_HEIGHT. `local` swaps the
 *  transport to the owner's desktop and skips the public-address checks —
 *  the origin pin inside localFetchFor is the boundary instead. */
export async function captureUrl(
  url: URL,
  width: number,
  options: { local?: boolean; userId?: string } = {},
): Promise<UrlCapture> {
  const local = options.local === true
  let spent = 0
  const spend = () => ++spent <= DRIFT_MAX_LOCAL_REQUESTS
  const origin = url.origin
  const isolated = await openIsolatedPage()
  const { page } = isolated
  try {
    await guardPublicPageRequests(page, {
      /* For local captures the bridge serves every byte, so even a remote
         isolated renderer cannot shortcut the desktop path. */
      ...(local
        ? { privateHosts: true, offNetwork: false, fetchUrl: localFetchFor(options.userId ?? '', origin, spend) }
        : {}),
    })
    const viewportWidth = Math.max(1, Math.round(width))
    await page.setViewport({ width: viewportWidth, height: 900 })
    await page.setUserAgent(UA)
    await navigateWebsitePage(
      page,
      url.href,
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS },
      { settleMs: 900 },
    )
    /* Public navigations re-check where they landed; a local capture stays
       inside its origin pin by construction. */
    const finalUrl = local ? page.url() : (await assertPublicNetworkUrl(page.url())).href
    const contentHeight = await page
      .evaluate(() => Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0, 900))
      .catch(() => 900)
    const height = Math.max(1, Math.min(Math.ceil(contentHeight), DRIFT_MAX_HEIGHT))
    await page.setViewport({ width: viewportWidth, height })
    const png = Buffer.from(await page.screenshot({ type: 'png' }))
    const title = await page.title().catch(() => '')
    return { png, finalUrl, title, width: viewportWidth, height }
  } finally {
    await isolated.close()
  }
}

/* ------------------------------------------------------------------ */
/* the comparison                                                     */
/* ------------------------------------------------------------------ */

/** Overridable seams for tests (and for the caller that fakes a capture). */
export interface DriftDeps {
  capture: typeof captureUrl
  renderDesign: (frame: Frame) => Promise<Buffer>
  score: (designPng: Buffer, shippedPng: Buffer) => Promise<DriftScore>
  /** DNS+IP check on a public URL before it may be navigated. */
  assertPublic: typeof assertPublicNetworkUrl
  now: () => number
}

export const driftDeps: DriftDeps = {
  capture: captureUrl,
  renderDesign: (frame) => renderFrame(frame, 1, { maxHeight: DRIFT_MAX_HEIGHT }),
  score: pixelScore,
  assertPublic: assertPublicNetworkUrl,
  now: () => Date.now(),
}

export interface CompareResult {
  comparison: DriftComparison
  shipped: Frame
  /** the design's own render at comparison time — MCP answers with it */
  designPng?: Buffer
  /** the shipped capture's PNG */
  shippedPng?: Buffer
}

/**
 * The whole compare: classify → capture → shipped frame → pixel score →
 * record. Throws DriftInputError on a bad URL, DriftLocalUnavailableError
 * when a local URL has no desktop to fetch it, WebsiteCaptureUnavailableError
 * when the page won't render.
 */
export async function compareFrameWithUrl(
  input: { frame: Frame; url: string; actor: Actor; userId: string; source: DriftSource },
  deps: DriftDeps = driftDeps,
): Promise<CompareResult> {
  const { frame } = input
  const kind = classifyDriftUrl(input.url)
  if (kind.kind === 'invalid') throw new DriftInputError(kind.reason)

  const requested = new URL(input.url)
  let local = kind.kind === 'local'
  if (!local) {
    try {
      await deps.assertPublic(requested)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      /* a public-looking name that resolves privately is a local address —
         only a machine on the asker's network can reach it */
      if (!/not reachable/.test(message)) {
        throw new DriftInputError(`the URL could not be resolved — ${message}`)
      }
      local = true
    }
  }

  let capture: UrlCapture
  let via: DriftVia = 'server'
  if (!local) {
    capture = await deps.capture(requested, frame.width, {})
  } else {
    if (!localDrift.online(input.userId)) {
      throw new DriftLocalUnavailableError(
        "that's a local URL — the doop desktop app on your machine fetches it for you, but it isn't online",
      )
    }
    via = 'desktop'
    capture = await deps.capture(requested, frame.width, { local: true, userId: input.userId })
  }

  /* The capture lands as a regular image frame beside the design — anyone
     can look at it, move it, comment on it; the record below keeps the link. */
  const asset = await storeAsset(
    capture.png,
    { mime: 'image/png', ext: 'png' },
    {
      canvasId: frame.canvasId,
      ownerId: input.userId,
      uploadedBy: input.actor.name,
    },
  )
  const shippedName = `Shipped — ${safeHost(capture.finalUrl)}`
  const shipped = placeImage(
    frame.canvasId,
    { url: `${env.BETTER_AUTH_URL}/a/${asset.id}.${asset.ext}`, buf: capture.png, mime: asset.mime },
    {
      name: shippedName,
      pageId: frame.pageId,
      x: frame.x + frame.width + SHIPPED_GAP_X,
      y: frame.y,
      width: Math.round(frame.width),
    },
    input.actor,
  )
  if (!shipped) throw new Error('the shipped capture could not be placed — was the frame’s page deleted?')

  /* The design renders at the same width; a failed render never blocks the
     comparison — the shipped frame already tells the story. */
  let designPng: Buffer | undefined
  let score: DriftScore | undefined
  try {
    designPng = await deps.renderDesign(frame)
    score = await deps.score(designPng, capture.png)
  } catch {
    score = undefined
    designPng = undefined
  }

  const comparison = await saveComparison({
    id: nanoid(12),
    canvasId: frame.canvasId,
    frameId: frame.id,
    shippedFrameId: shipped.id,
    url: input.url,
    finalUrl: capture.finalUrl,
    ...(score ? { score: score.score, diffPixels: score.diffPixels, totalPixels: score.totalPixels } : {}),
    via,
    source: input.source,
    requestedBy: input.actor.name,
    createdAt: deps.now(),
  })
  return { comparison, shipped, ...(designPng ? { designPng } : {}), shippedPng: capture.png }
}

/* ------------------------------------------------------------------ */
/* records                                                             */
/* ------------------------------------------------------------------ */

function toComparison(row: typeof driftComparisons.$inferSelect): DriftComparison {
  return {
    id: row.id,
    canvasId: row.canvasId,
    frameId: row.frameId,
    ...(row.shippedFrameId ? { shippedFrameId: row.shippedFrameId } : {}),
    url: row.url,
    ...(row.finalUrl ? { finalUrl: row.finalUrl } : {}),
    ...(row.score !== null ? { score: row.score } : {}),
    ...(row.diffPixels !== null ? { diffPixels: row.diffPixels } : {}),
    ...(row.totalPixels !== null ? { totalPixels: row.totalPixels } : {}),
    via: row.via === 'desktop' ? 'desktop' : 'server',
    source: (row.source === 'mcp' || row.source === 'webhook' ? row.source : 'ui') as DriftSource,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
  }
}

async function saveComparison(record: DriftComparison): Promise<DriftComparison> {
  await db.insert(driftComparisons).values({
    id: record.id,
    canvasId: record.canvasId,
    frameId: record.frameId,
    shippedFrameId: record.shippedFrameId ?? null,
    url: record.url,
    finalUrl: record.finalUrl ?? null,
    score: record.score ?? null,
    diffPixels: record.diffPixels ?? null,
    totalPixels: record.totalPixels ?? null,
    via: record.via,
    source: record.source,
    requestedBy: record.requestedBy,
    createdAt: record.createdAt,
  })
  return record
}

/** Newest-first history for one frame. */
export async function listComparisons(frameId: string): Promise<DriftComparison[]> {
  const rows = await db
    .select()
    .from(driftComparisons)
    .where(eq(driftComparisons.frameId, frameId))
    .orderBy(desc(driftComparisons.createdAt))
  return rows.map(toComparison)
}

export async function getComparison(id: string): Promise<DriftComparison | undefined> {
  const [row] = await db.select().from(driftComparisons).where(eq(driftComparisons.id, id))
  return row ? toComparison(row) : undefined
}

/** The error a caller should surface, or undefined for an unexpected throw. */
export function driftErrorMessage(error: unknown): { status: number; message: string } {
  if (error instanceof DriftInputError) return { status: 400, message: error.message }
  if (error instanceof DriftLocalUnavailableError) return { status: 422, message: error.message }
  if (error instanceof WebsiteCaptureUnavailableError) return { status: 502, message: error.message }
  return { status: 500, message: error instanceof Error ? error.message : 'the comparison failed' }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}
