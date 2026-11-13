/**
 * Drift review: comparing what a frame was DESIGNED as with what actually
 * shipped. The server captures the shipped page at the frame's width and
 * scores the pixel difference. A localhost/private URL is captured through
 * the owner's desktop app (server/driftBridge.ts), which answers fetches
 * over a long-poll — the server itself can never reach a user's machine.
 */

/** The shipped-page capture never exceeds this height, whichever page. */
export const DRIFT_MAX_HEIGHT = 6_000
/** A pixel counts as different when any RGB channel moves past this. */
export const DRIFT_CHANNEL_DELTA = 24
/** Score rasters are normalized to this bounding box so a huge page costs
 *  a bounded compare. */
export const DRIFT_SCORE_MAX_SIDE = 1_600
/** One desktop fetch: per-resource cap and its device-side deadline. */
export const DRIFT_FETCH_MAX_BYTES = 10_000_000
export const DRIFT_FETCH_TIMEOUT_MS = 20_000
/** How many requests one local capture may proxy through the desktop. */
export const DRIFT_MAX_LOCAL_REQUESTS = 150
/** The local-fetch bridge: poll length, device liveness window and request
 *  TTL (mirrors shared/localRepo.ts). */
export const DRIFT_POLL_MS = 20_000
export const DRIFT_ONLINE_MS = 45_000
export const DRIFT_REQUEST_TTL_MS = 60_000

export type DriftSeverity = 'minor' | 'major' | 'critical'
export const DRIFT_SEVERITIES = ['minor', 'major', 'critical'] as const
export function isDriftSeverity(value: unknown): value is DriftSeverity {
  return typeof value === 'string' && (DRIFT_SEVERITIES as readonly string[]).includes(value)
}

/** Where a comparison was asked from. */
export type DriftSource = 'ui' | 'mcp' | 'webhook'

/** Who produced the shipped capture: the server (public URL) or the
 *  owner's desktop (local URL). */
export type DriftVia = 'server' | 'desktop'

/** One designed-vs-shipped comparison. `score` is the percent of pixels
 *  that differ (0 = identical, 100 = nothing alike). */
export interface DriftComparison {
  id: string
  canvasId: string
  frameId: string
  /** the frame holding the shipped capture, placed beside the designed frame */
  shippedFrameId?: string
  /** the URL the user asked to compare against */
  url: string
  /** where navigation actually ended (after redirects) */
  finalUrl?: string
  score?: number
  diffPixels?: number
  totalPixels?: number
  via: DriftVia
  source: DriftSource
  /** display name of the asker — a user, an agent, 'CI' */
  requestedBy: string
  createdAt: number
}

/** A fetch the server hands to the desktop app for a local capture. The
 *  bridge pins every request to the capture's origin, so the desktop only
 *  ever talks to the address the user asked about. */
export interface DriftFetchRequest {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  /** base64 request body, when the page issues one */
  body?: string
}

/** What the desktop answers for one bridged fetch. */
export interface DriftFetchResult {
  ok: boolean
  status?: number
  headers?: Record<string, string>
  /** base64 response body */
  body?: string
  error?: string
}

export type DriftUrlClass = { kind: 'public' } | { kind: 'local' } | { kind: 'invalid'; reason: string }

/** Rough classification WITHOUT network: 'invalid' is never fetchable,
 *  'local' can only be reached from a machine sharing the address (the
 *  desktop), 'public' is a candidate for the server — which still resolves
 *  and pins it before connecting (server/publicUrl.ts). Over-matching to
 *  'local' only costs a failed desktop fetch; the public side stays behind
 *  the full SSRF checks. */
export function classifyDriftUrl(raw: string): DriftUrlClass {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'invalid', reason: 'not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', reason: 'only http(s) URLs are allowed' }
  }
  if (url.username || url.password) {
    return { kind: 'invalid', reason: 'URLs containing credentials are not allowed' }
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
  return isLocalHost(host) ? { kind: 'local' } : { kind: 'public' }
}

/** The hostname side of publicUrl.parsePublicHttpUrl's blocklist: names and
 *  literal addresses a server can never consider public. DNS names that
 *  merely RESOLVE privately are the server check's job, not this one's. */
function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (!host.includes('.') && !host.includes(':')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [a, b, c] = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3])]
    if (a > 255 || b > 255 || c > 255) return false
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    )
  }
  if (!host.includes(':')) return false
  return (
    host === '::' ||
    host.startsWith('::') ||
    /^f[cd]/.test(host) ||
    /^fe[89a-f]/.test(host) ||
    /^ff/.test(host) ||
    host.startsWith('64:ff9b') ||
    host.startsWith('100::') ||
    host.startsWith('2001:db8') ||
    host.startsWith('2002:')
  )
}
