import type { Canvas } from '../shared/types.ts'
import { canvasPages, framePageId } from '../shared/pages.ts'
import type { CanvasFindResult } from '../shared/canvasFind.ts'

/**
 * ⌘F across every page of a canvas. The client only holds the HTML of the
 * open page (the rest is deferred), so a search that has to reach a library
 * of thirty pages runs here, over the HTML the server already keeps.
 *
 * A frame matches on its name, its visible text, and the strings in its
 * scripts. Many library sheets render their items from a JS array, so an id
 * like `cp.scb-otp-input` only exists there.
 */

const MAX_HITS = 1000
const CONTEXT = 32
/* a frame whose HTML repeats the term thousands of times (a generated sheet)
   would otherwise drown every other frame in the list */
const MAX_HITS_PER_FRAME = 40

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The text a person reads in the frame, and the strings its scripts carry. */
export function frameSearchText(html: string): { text: string; code: string } {
  const scripts: string[] = []
  const withoutScripts = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, body: string) => {
    scripts.push(body)
    return ' '
  })
  const text = squash(
    decode(
      withoutScripts
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
  /* only string literals: identifiers and syntax are noise to a person */
  const code = squash(
    scripts
      .flatMap((body) => body.match(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g) ?? [])
      .map((lit) => lit.slice(1, -1))
      .join(' · '),
  )
  return { text, code }
}

function matchesIn(haystack: string, needle: string, matchCase: boolean, limit: number) {
  const out: { before: string; text: string; after: string }[] = []
  if (!needle) return out
  const h = matchCase ? haystack : haystack.toLowerCase()
  const n = matchCase ? needle : needle.toLowerCase()
  let from = 0
  while (out.length < limit) {
    const at = h.indexOf(n, from)
    if (at < 0) break
    const start = Math.max(0, at - CONTEXT)
    const end = Math.min(haystack.length, at + needle.length + CONTEXT)
    out.push({
      before: (start > 0 ? '…' : '') + haystack.slice(start, at),
      text: haystack.slice(at, at + needle.length),
      after: haystack.slice(at + needle.length, end) + (end < haystack.length ? '…' : ''),
    })
    from = at + Math.max(1, needle.length)
  }
  return out
}

export function findInCanvas(canvas: Canvas, query: string, { matchCase = false } = {}): CanvasFindResult {
  const needle = query.trim()
  const result: CanvasFindResult = { hits: [], total: 0, frames: 0 }
  if (!needle) return result
  const pages = canvasPages(canvas)
  const pageOrder = new Map(pages.map((p, i) => [p.id, i]))
  const pageName = new Map(pages.map((p) => [p.id, p.name]))
  /* reading order: page by page, then top to bottom, left to right */
  const frames = canvas.frames
    .filter((f) => !f.hidden && !f.demo)
    .map((f) => ({ f, page: framePageId(canvas, f) }))
    .sort((a, b) => (pageOrder.get(a.page) ?? 0) - (pageOrder.get(b.page) ?? 0) || a.f.y - b.f.y || a.f.x - b.f.x)

  for (const { f, page } of frames) {
    const base = { frameId: f.id, pageId: page, pageName: pageName.get(page) ?? '', frameName: f.name }
    const inName = matchesIn(f.name, needle, matchCase, 1)
    const { text, code } = frameSearchText(f.html ?? '')
    const inText = matchesIn(text, needle, matchCase, MAX_HITS_PER_FRAME)
    const inCode = matchesIn(code, needle, matchCase, MAX_HITS_PER_FRAME - inText.length)
    const found = [
      ...inName.map((m) => ({ ...base, ...m, where: 'name' as const, n: -1 })),
      ...inText.map((m, n) => ({ ...base, ...m, where: 'text' as const, n })),
      ...inCode.map((m) => ({ ...base, ...m, where: 'code' as const, n: -1 })),
    ]
    if (!found.length) continue
    result.frames++
    result.total += found.length
    for (const hit of found) if (result.hits.length < MAX_HITS) result.hits.push(hit)
  }
  return result
}
