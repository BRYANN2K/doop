import type { Frame } from '../shared/types.ts'

/* Global bound on concurrent frame renders. Per-frame dedupe caps repeat
   requests but not breadth: a post-restart dashboard of 50 stale canvases,
   a canvas drawing its frames as images (src/lib/frameLod.ts), or an
   anonymous crawler walking known frame URLs would otherwise launch 50
   Chromium pages at once. Excess renders queue, they are not dropped. */
const MAX_CONCURRENT_RENDERS = 3
let active = 0
const waiting: Array<() => void> = []

/** Run `render` once a render slot is free. */
export async function withRenderSlot<T>(render: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_RENDERS) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await render()
  } finally {
    active--
    waiting.shift()?.()
  }
}

/** The device pixels one screenshot may hold. A 1440px frame at 2x keeps
 *  about 8,600 CSS px of height; past that the image is cut at the bottom
 *  rather than asking Chromium for a bitmap big enough to stall the browser
 *  every other render shares. */
export const MAX_RENDER_PIXELS = 50_000_000

/** The CSS px height a render of `frame` covers: the frame, cut at
 *  `maxHeight` and at the pixel budget. */
export function renderedHeight(frame: Pick<Frame, 'width' | 'height'>, scale: number, maxHeight?: number): number {
  const width = Math.max(1, Math.round(frame.width))
  const budget = Math.max(1, Math.floor(MAX_RENDER_PIXELS / (width * scale * scale)))
  const cap = maxHeight ? Math.round(maxHeight) : Infinity
  return Math.max(1, Math.min(Math.round(frame.height), cap, budget))
}
