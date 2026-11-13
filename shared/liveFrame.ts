/**
 * Live frames: a frame that renders a page from the person's own dev server
 * (`http://localhost:<port>/…`) instead of a stored document. The stored HTML
 * is only the placeholder every other surface renders — web viewers and the
 * server's image pipeline see the "Open in the Doop desktop app" card, while
 * the desktop shell mounts the dev page straight into the frame's iframe
 * (same machine, so no server round-trip can reach it).
 *
 * The frame's live URL rides in a marker meta on that placeholder, exactly
 * the way design-sync frames carry `doop-sync-page` (server/ingest.ts) and
 * GitHub imports carry `doop-github-screen`: presence is the whole signal,
 * everywhere downstream just checks `isLiveFrame`. Two more metas follow it:
 * `doop-live-reload` (auto-reload interval in seconds, absent = off) and, on
 * static copies, `doop-live-snapshot` (where a snapshot was taken from).
 *
 * Every hop that can run a URL — the iframe mount, the native snapshot —
 * re-parses with `parseLiveUrl`, never trusting the marker's text: only
 * loopback http(s) addresses with no credentials are live, so a hand-edited
 * frame cannot make the shell open the network.
 */

const LIVE_META = 'doop-live'
const RELOAD_META = 'doop-live-reload'
const SNAPSHOT_META = 'doop-live-snapshot'

/* ------------------------------------------------------------------ */
/* URL validation                                                      */
/* ------------------------------------------------------------------ */

export interface LiveUrl {
  /** normalized `http(s)://host[:port]/path` as the URL parser serializes it */
  url: string
  /** `localhost:4321` — the badge and placeholder lead */
  host: string
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  /* `[::1]` comes back bracketed from URL#hostname; 127.0/8 arrives already
     normalized by the parser (hex, octal and integer forms included), which
     is why no string check would do */
  if (host === '[::1]' || host === '::1') return true
  return host.startsWith('127.') && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * The URL a live frame may point at: http(s) on this machine only — `localhost`,
 * `*.localhost`, `127.0/8` or `[::1]`, any explicit port, no credentials.
 * Everything else (a LAN IP, a public host, `file:`, `javascript:`) answers
 * null. `parseLiveUrl` is the one gate used by the client iframe mount, the
 * MCP tool and the dialog; `live.rs` re-checks the same rules in Rust before
 * rendering a snapshot, so a crafted IPC call cannot make the shell browse.
 */
export function parseLiveUrl(raw: string): LiveUrl | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!loopbackHost(url.hostname)) return null
  const host = url.port ? `${url.hostname === '[::1]' ? '[::1]' : url.hostname}:${url.port}` : url.hostname
  return { url: url.href, host }
}

/* ------------------------------------------------------------------ */
/* the stored document                                                 */
/* ------------------------------------------------------------------ */

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** True when the frame is a live frame — the marker meta is the signal. */
export function isLiveFrame(html: string): boolean {
  return html.includes(`name="${LIVE_META}"`)
}

function metaContent(html: string, name: string): string | undefined {
  const content = html.match(new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`, 'i'))?.[1]
  if (content === undefined) return undefined
  /* the marker is written already escaped; a frame built anywhere else gets
     the same treatment before its text is trusted as a URL */
  return content
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The frame's dev-server URL, or undefined when it is not live or its marker
 *  fails the loopback gate (a hand-edited frame with `example.com` in it is
 *  never mounted). */
export function liveFrameUrl(html: string): string | undefined {
  if (!isLiveFrame(html)) return undefined
  const raw = metaContent(html, LIVE_META)
  return raw ? parseLiveUrl(raw)?.url : undefined
}

/** Auto-reload interval in seconds; 0 = reload only on demand. */
export function liveFrameReload(html: string): number {
  const seconds = Number(metaContent(html, RELOAD_META))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.floor(seconds), 3600) : 0
}

/** Where a snapshot frame was captured from (undefined on every other frame). */
export function liveSnapshotSource(html: string): string | undefined {
  const raw = metaContent(html, SNAPSHOT_META)
  return raw || undefined
}

/** Same lockdown the sync/importer snapshots carry (server/ingest.ts): a
 *  placeholder or captured page must render passively anywhere a frame shows. */
const SNAPSHOT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob: http: https:',
  'font-src data: http: https:',
  'media-src data: blob: http: https:',
].join('; ')

/**
 * The document a live frame stores: marker + placeholder card. Web viewers
 * and `/i/<id>` renders show this; the desktop shell swaps it for the live
 * page, so the card is also the fallback whenever the dev server is down.
 */
export function liveFrameHtml(url: string, { reloadSeconds = 0 }: { reloadSeconds?: number } = {}): string {
  const live = parseLiveUrl(url)
  if (!live) throw new Error('not a loopback URL')
  const reloadMeta = reloadSeconds > 0 ? `<meta name="${RELOAD_META}" content="${Math.floor(reloadSeconds)}">` : ''
  return `<!doctype html>
<html>
<head>
<meta name="${LIVE_META}" content="${escapeAttr(live.url)}">
${reloadMeta}
<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}">
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    height: 100vh;
    display: grid;
    place-items: center;
    background: #f7f7f7;
    color: #5f5e5b;
  }
  .card { text-align: center; max-width: 420px; padding: 40px 32px; }
  .badge {
    display: inline-flex; align-items: center; gap: 8px;
    font: 600 13px/1 ui-monospace, monospace;
    color: #0177d3; background: rgba(1,119,211,0.08);
    border: 1px solid rgba(1,119,211,0.25); border-radius: 999px;
    padding: 7px 14px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #0177d3; }
  h1 { font-size: 17px; font-weight: 600; color: #111; margin: 20px 0 10px; }
  p { font-size: 13px; line-height: 1.5; }
  .url { font-family: ui-monospace, monospace; color: #111; word-break: break-all; }
  .hint { margin-top: 10px; font-weight: 600; color: #0177d3; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge"><span class="dot"></span>LIVE · ${escapeText(live.host)}</div>
    <h1>Live dev-server frame</h1>
    <p class="url">${escapeText(live.url)}</p>
    <p class="hint">Open in the Doop desktop app</p>
  </div>
</body>
</html>`
}

/** Rewrite the auto-reload meta in a live frame's stored HTML (seconds ≤ 0
 *  removes it). No-op past the live marker — anything else is not ours to edit. */
export function withLiveReload(html: string, seconds: number): string {
  const stripped = html
    .replace(new RegExp(`\\s*<meta\\s+name=["']${RELOAD_META}["'][^>]*>`, 'i'), '')
    .replace(new RegExp(`<meta\\s+content=["'][^"']*["']\\s+name=["']${RELOAD_META}["'][^>]*>`, 'i'), '')
  if (!(seconds > 0)) return stripped
  const meta = `<meta name="${RELOAD_META}" content="${Math.floor(seconds)}">`
  const marker = new RegExp(`(<meta\\s+name=["']${LIVE_META}["'][^>]*>)`, 'i').exec(stripped)
  return marker ? stripped.replace(marker[0], `${marker[0]}\n${meta}`) : `${meta}\n${stripped}`
}

/* ------------------------------------------------------------------ */
/* snapshots                                                           */
/* ------------------------------------------------------------------ */

/* A captured DOM can be megabytes on a real app; over this the snapshot is a
   failure, not a truncated half-page. The server keeps its own
   MAX_FRAME_HTML_BYTES ceiling on every write. */
export const SNAPSHOT_MAX_CHARS = 2_500_000

const BANNED_TAGS = 'script|noscript|iframe|frame|frameset|object|embed|applet|portal|fencedframe'

/** Mirrors `sanitizeSnapshotHtml` in server/ingest.ts — deliberately regex
 *  based: the frame's sandboxed iframe remains the real boundary, this only
 *  keeps the captured DOM passive (the app's scripts must not run again as a
 *  doop frame's scripts would). */
export function sanitizeSnapshotHtml(html: string): string {
  let out = html
  out = out.replace(new RegExp(`<(${BANNED_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '')
  out = out.replace(new RegExp(`<\\/?(?:${BANNED_TAGS})\\b[^>]*>`, 'gi'), '')
  out = out.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
  out = out.replace(/<base\b[^>]*>/gi, '')
  out = out.replace(/\s(?:on[a-z]+|srcdoc|ping)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  out = out.replace(
    /\s(href|src|action|formaction|poster|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi,
    '',
  )
  return out
}

/**
 * Turn the rendered DOM captured on the Mac into a stored static frame:
 * scrubbed, provenance meta, the same importer-grade CSP, and a `<base>` so
 * the app's relative assets still resolve on this machine (a snapshot read
 * where the dev server is not running simply keeps its text).
 */
export function snapshotFrameHtml(captured: string, sourceUrl: string): string {
  const live = parseLiveUrl(sourceUrl)
  if (!live) throw new Error('not a loopback URL')
  let out = sanitizeSnapshotHtml(captured)
  const inject =
    `<meta name="${SNAPSHOT_META}" content="${escapeAttr(live.url)}">` +
    `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}">` +
    `<base href="${escapeAttr(live.url)}">`
  const headMatch = out.match(/<head[^>]*>/i)
  if (headMatch) out = out.replace(headMatch[0], headMatch[0] + inject)
  else out = inject + out
  if (!/^\s*<!doctype/i.test(out)) out = '<!doctype html>\n' + out
  if (out.length > SNAPSHOT_MAX_CHARS) {
    throw new Error(`the page is too large to snapshot (${Math.round(out.length / 1024)} KB)`)
  }
  return out
}
