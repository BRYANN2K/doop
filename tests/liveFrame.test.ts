import { describe, expect, it } from 'vitest'
import {
  SNAPSHOT_MAX_CHARS,
  isLiveFrame,
  liveFrameHtml,
  liveFrameReload,
  liveFrameUrl,
  liveSnapshotSource,
  parseLiveUrl,
  sanitizeSnapshotHtml,
  snapshotFrameHtml,
  withLiveReload,
} from '../shared/liveFrame.ts'

describe('parseLiveUrl', () => {
  it('accepts loopback http(s) URLs and normalizes them', () => {
    expect(parseLiveUrl('http://localhost:4321/contact')?.url).toBe('http://localhost:4321/contact')
    expect(parseLiveUrl('https://localhost')?.host).toBe('localhost')
    expect(parseLiveUrl('http://app.localhost:3000')?.host).toBe('app.localhost:3000')
    expect(parseLiveUrl('http://127.0.0.1:8080/a?b=c')?.url).toBe('http://127.0.0.1:8080/a?b=c')
    /* the URL parser normalizes the sneaky spellings of 127.0.0.1 before the
       host is checked — no string check could catch them all */
    expect(parseLiveUrl('http://2130706433:3000')?.url).toBe('http://127.0.0.1:3000/')
    expect(parseLiveUrl('http://0x7f000001')?.url).toBe('http://127.0.0.1/')
    expect(parseLiveUrl('http://127.1:3000')?.url).toBe('http://127.0.0.1:3000/')
    expect(parseLiveUrl('  http://localhost:3000  ')?.url).toBe('http://localhost:3000/')
  })

  it('rejects anything that is not plain loopback http(s)', () => {
    for (const url of [
      '',
      'not a url',
      'http://example.com',
      'https://localhost.attacker.com',
      'http://192.168.1.20:3000',
      'http://10.0.0.4',
      'http://0.0.0.0:3000',
      'http://[::1]:5173',
      'http://0x80000001',
      'file:///etc/hosts',
      'javascript:alert(1)',
      'ftp://localhost/x',
      'http://user:pw@localhost:3000',
      'ws://localhost:3000',
    ]) {
      expect(parseLiveUrl(url), url).toBeNull()
    }
  })

  it('keeps the explicit port in the badge label, hides the default one', () => {
    expect(parseLiveUrl('http://localhost:4321/contact')?.host).toBe('localhost:4321')
    expect(parseLiveUrl('http://localhost:80')?.host).toBe('localhost')
  })
})

describe('liveFrameHtml / the live frame type', () => {
  const html = liveFrameHtml('http://localhost:4321/contact')

  it('marks the stored document so every surface can tell the frame is live', () => {
    expect(isLiveFrame(html)).toBe(true)
    expect(isLiveFrame('<html><body>regular</body></html>')).toBe(false)
    expect(liveFrameUrl(html)).toBe('http://localhost:4321/contact')
    expect(liveFrameUrl('<html><body>regular</body></html>')).toBeUndefined()
  })

  it('renders the placeholder card with the LIVE badge and the desktop hint', () => {
    expect(html).toContain('LIVE · localhost:4321')
    expect(html).toContain('Open in the Doop desktop app')
    expect(html).toContain('http://localhost:4321/contact')
    /* the stored document is passive: nothing to run, and a CSP that keeps
       it that way anywhere a frame shows */
    expect(html).not.toContain('<script')
    expect(html).toContain("script-src 'none'")
  })

  it('escapes the URL inside the document', () => {
    const tricky = liveFrameHtml('http://localhost:3000/?q="><script>')
    expect(tricky).not.toContain('<script>')
    expect(liveFrameUrl(tricky)).toBe('http://localhost:3000/?q=%22%3E%3Cscript%3E')
  })

  it('refuses to build a live frame for a non-loopback URL', () => {
    expect(() => liveFrameHtml('https://example.com')).toThrow()
  })

  it('a hand-edited marker with a bad URL is live-shaped but never mounts', () => {
    const forged = html.replace('http://localhost:4321/contact', 'https://example.com')
    expect(isLiveFrame(forged)).toBe(true)
    expect(liveFrameUrl(forged)).toBeUndefined()
  })
})

describe('withLiveReload', () => {
  const html = liveFrameHtml('http://localhost:3000/')

  it('defaults to reload on demand only', () => {
    expect(liveFrameReload(html)).toBe(0)
  })

  it('stores the interval on the frame and reads it back', () => {
    const every30 = withLiveReload(html, 30)
    expect(liveFrameReload(every30)).toBe(30)
    /* off again removes the meta outright, and the live marker survives */
    const off = withLiveReload(every30, 0)
    expect(liveFrameReload(off)).toBe(0)
    expect(isLiveFrame(off)).toBe(true)
    expect(liveFrameUrl(off)).toBe('http://localhost:3000/')
  })

  it('caps absurd intervals and ignores junk', () => {
    expect(liveFrameReload(withLiveReload(html, 99999))).toBe(3600)
    const junk = html.replace('<head>', '<head><meta name="doop-live-reload" content="abc">')
    expect(liveFrameReload(junk)).toBe(0)
  })
})

describe('snapshotFrameHtml', () => {
  const captured = `<!doctype html><html><head><script src="app.js"></script><style>p{color:red}</style></head>
<body><h1 onclick="x()">Hi</h1><iframe src="x"></iframe><a href="javascript:bad()">bad</a><img src="/logo.png"></body></html>`

  it('freezes a captured DOM into a stored static frame', () => {
    const html = snapshotFrameHtml(captured, 'http://localhost:4321/contact')
    /* scripts, frames, handlers and javascript: URLs are scrubbed so the
       snapshot is passive wherever a frame shows */
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('javascript:')
    /* provenance + the same lockdown CSP the importers stamp */
    expect(html).toContain('name="doop-live-snapshot"')
    expect(html).toContain('http://localhost:4321/contact')
    expect(html).toContain("script-src 'none'")
    /* relative assets resolve against the dev server on this machine */
    expect(html).toContain('<base href="http://localhost:4321/contact">')
    expect(html).toContain('<img src="/logo.png">')
    expect(html).toContain('p{color:red}')
    expect(liveSnapshotSource(html)).toBe('http://localhost:4321/contact')
    /* a snapshot is a normal static frame — not live itself */
    expect(isLiveFrame(html)).toBe(false)
  })

  it('adds a doctype when the capture lacks one', () => {
    expect(snapshotFrameHtml('<html><body>x</body></html>', 'http://localhost')).toMatch(/^<!doctype/i)
  })

  it('refuses a non-loopback source before wrapping anything', () => {
    expect(() => snapshotFrameHtml(captured, 'https://example.com')).toThrow()
  })

  it('refuses a page too large to store', () => {
    const huge = `<html><body>${'x'.repeat(SNAPSHOT_MAX_CHARS)}</body></html>`
    expect(() => snapshotFrameHtml(huge, 'http://localhost')).toThrow(/too large/)
  })
})

describe('sanitizeSnapshotHtml', () => {
  it('strips the dangerous and keeps the design', () => {
    const out = sanitizeSnapshotHtml(
      '<div onmouseover="x()"><p>keep</p><form action="javascript:x()"></form><meta http-equiv="refresh" content="0;url=x"><base href="x">',
    )
    expect(out).not.toContain('onmouseover')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('http-equiv')
    expect(out).not.toContain('<base')
    expect(out).toContain('<p>keep</p>')
  })
})
