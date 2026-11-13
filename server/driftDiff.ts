import sharp from 'sharp'
import { DRIFT_CHANNEL_DELTA, DRIFT_SCORE_MAX_SIDE } from '../shared/drift.ts'

export interface DriftScore {
  /** percent of pixels that differ beyond DRIFT_CHANNEL_DELTA, 0–100 */
  score: number
  diffPixels: number
  totalPixels: number
  width: number
  height: number
}

/**
 * The pixel-diff score between the designed render and the shipped capture.
 * Both rasters are flattened on white (what a viewer sees), capped to
 * DRIFT_SCORE_MAX_SIDE, and padded to a common top-left-anchored box — a
 * shipped page shorter than the design reads as missing content, not as
 * "nothing to compare".
 */
export async function pixelScore(designPng: Buffer, shippedPng: Buffer): Promise<DriftScore> {
  const [aMeta, bMeta] = await Promise.all([sharp(designPng).metadata(), sharp(shippedPng).metadata()])
  const width = Math.min(Math.max(aMeta.width ?? 1, bMeta.width ?? 1), DRIFT_SCORE_MAX_SIDE)
  const height = Math.min(Math.max(aMeta.height ?? 1, bMeta.height ?? 1), DRIFT_SCORE_MAX_SIDE)

  const normalize = (buf: Buffer, meta: sharp.Metadata) => {
    const w = Math.min(meta.width ?? width, DRIFT_SCORE_MAX_SIDE)
    const h = Math.min(meta.height ?? height, DRIFT_SCORE_MAX_SIDE)
    return sharp(buf)
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .resize(w, h, { fit: 'fill' })
      .extend({
        top: 0,
        left: 0,
        bottom: Math.max(0, height - h),
        right: Math.max(0, width - w),
        background: '#ffffff',
      })
      .raw()
      .toBuffer({ resolveWithObject: true })
  }

  const [a, b] = await Promise.all([normalize(designPng, aMeta), normalize(shippedPng, bMeta)])
  const stride = a.info.channels
  const totalPixels = width * height
  let diffPixels = 0
  for (let i = 0; i < totalPixels * stride; i += stride) {
    let delta = 0
    for (let c = 0; c < 3; c += 1) {
      delta = Math.max(delta, Math.abs((a.data[i + c] ?? 255) - (b.data[i + c] ?? 255)))
    }
    if (delta > DRIFT_CHANNEL_DELTA) diffPixels += 1
  }
  return {
    score: totalPixels === 0 ? 0 : Math.round((diffPixels / totalPixels) * 10_000) / 100,
    diffPixels,
    totalPixels,
    width,
    height,
  }
}
