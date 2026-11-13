import { describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'
import { findInCanvas, frameSearchText } from '../server/canvasFind.ts'

const frame = (id: string, name: string, html: string, pageId: string, y = 0): Frame =>
  ({ id, canvasId: 'c1', name, html, x: 0, y, width: 400, height: 300, pageId }) as unknown as Frame

const canvas = (frames: Frame[]): Canvas =>
  ({
    id: 'c1',
    name: 'Library',
    pages: [
      { id: 'p1', name: '01 · Auth' },
      { id: 'p2', name: '02 · Forms' },
    ],
    frames,
  }) as unknown as Canvas

describe('frameSearchText', () => {
  it('keeps what a person reads and the strings scripts render, not markup or CSS', () => {
    const { text, code } = frameSearchText(
      '<style>.otp{color:red}</style><h1>Enter the code</h1><p>Sent &amp; ready</p>' +
        '<script>const C=[["cp.scb-otp-input","OTP input"]];render(C)</script>',
    )
    expect(text).toBe('Enter the code Sent & ready')
    expect(code).toContain('cp.scb-otp-input')
    expect(code).toContain('OTP input')
    expect(text).not.toContain('color')
  })
})

describe('findInCanvas', () => {
  const lib = canvas([
    frame('f3', 'Sign up', '<p>Verify with an OTP code</p>', 'p2'),
    frame('f1', 'cp.scb-otp — OTP inputs (8)', '<div>Code</div>', 'p1', 100),
    frame('f2', 'Login', '<script>const I=[["auth.otp-6","six boxes"]]</script>', 'p1', 0),
    frame('f4', 'Pricing', '<p>Nothing here</p>', 'p2'),
  ])

  it('finds the term in names, text and script strings, across pages, in reading order', () => {
    const r = findInCanvas(lib, 'otp')
    expect(r.frames).toBe(3)
    expect(r.hits.map((h) => [h.frameId, h.where])).toEqual([
      ['f2', 'code'],
      ['f1', 'name'],
      ['f3', 'text'],
    ])
    expect(r.hits[2]).toMatchObject({ pageName: '02 · Forms', text: 'OTP', n: 0 })
  })

  it('respects match case and an empty query', () => {
    expect(findInCanvas(lib, 'OTP', { matchCase: true }).frames).toBe(2)
    expect(findInCanvas(lib, '   ').hits).toEqual([])
  })
})
