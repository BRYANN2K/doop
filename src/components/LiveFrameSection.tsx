import { useState } from 'react'
import type { Frame } from '../../shared/types'
import { liveFrameHtml, parseLiveUrl } from '../../shared/liveFrame'
import { api, errorMessage } from '../lib/api'
import { frameCenterPosition, stageViewportSize } from '../lib/framePlacement'
import { recordCreate } from '../lib/history'
import { useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { AppIcon } from './ui/brand-mark'
import { Button } from './ui/button'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { ImportStepFooter, ImportStepHeader } from './ImportSources'

const DEFAULT_LIVE_SIZE = { width: 1280, height: 800 }

/** The import modal's "Live frame" step: a dev-server URL plus the frame's
 *  size. The URL is the only thing validated here — parseLiveUrl is the same
 *  gate the mounted iframe and the MCP tool go through, so a bad URL can
 *  never become a live frame. The frame lands centered in the viewport like
 *  the "New frame" button's. */
export function LiveFrameSection({
  canvasId,
  onBack,
  onCreated,
}: {
  canvasId: string
  onBack: () => void
  onCreated: (frame: Frame) => void
}) {
  const t = useT()
  const [url, setUrl] = useState('')
  const [width, setWidth] = useState(String(DEFAULT_LIVE_SIZE.width))
  const [height, setHeight] = useState(String(DEFAULT_LIVE_SIZE.height))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const size = {
    width: Math.min(Math.max(Math.round(Number(width)) || 0, 50), 10000),
    height: Math.min(Math.max(Math.round(Number(height)) || 0, 50), 10000),
  }
  const parsed = url.trim() ? parseLiveUrl(url) : null

  async function create() {
    const live = parseLiveUrl(url)
    if (!live) {
      setError(t('canvas.liveFrameUrlInvalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { x, y } = frameCenterPosition(useStore.getState().viewport, stageViewportSize(), size)
      const frame = await api.createFrame(canvasId, {
        name: live.host + new URL(live.url).pathname.replace(/\/$/, ''),
        html: liveFrameHtml(live.url),
        x,
        y,
        ...size,
        pageId: useStore.getState().activePageId ?? undefined,
      })
      recordCreate(frame)
      onCreated(frame)
    } catch (err) {
      setError(errorMessage(err, t('canvas.liveFrameFailed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ImportStepHeader
        icon={<AppIcon brand="live-app" size={40} />}
        title={t('canvas.liveFrameTitle')}
        lede={t('canvas.liveFrameLede')}
      />
      <Field className="mt-[22px]" label={t('canvas.liveFrameUrl')} labelVariant="form" htmlFor="live-url">
        <Input
          id="live-url"
          variant="well"
          inputSize="lg"
          className="font-mono"
          autoFocus
          placeholder="http://localhost:4321/contact"
          value={url}
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
        />
      </Field>
      <div className="mt-3 flex gap-3">
        <Field className="flex-1" label={t('canvas.liveFrameWidth')} labelVariant="form" htmlFor="live-width">
          <Input
            id="live-width"
            variant="well"
            inputSize="lg"
            inputMode="numeric"
            value={width}
            disabled={busy}
            onChange={(e) => setWidth(e.target.value.replace(/[^\d]/g, ''))}
          />
        </Field>
        <Field className="flex-1" label={t('canvas.liveFrameHeight')} labelVariant="form" htmlFor="live-height">
          <Input
            id="live-height"
            variant="well"
            inputSize="lg"
            inputMode="numeric"
            value={height}
            disabled={busy}
            onChange={(e) => setHeight(e.target.value.replace(/[^\d]/g, ''))}
          />
        </Field>
      </div>
      {error && <p className="mt-2.5 text-body text-accent-ink">{error}</p>}
      <ImportStepFooter note={t('canvas.liveFrameNote')} onBack={onBack} backDisabled={busy}>
        <Button variant="primary" disabled={busy || !parsed} onClick={() => void create()}>
          {busy ? t('canvas.liveFrameCreating') : t('canvas.liveFrameCreate')}
        </Button>
      </ImportStepFooter>
    </>
  )
}
