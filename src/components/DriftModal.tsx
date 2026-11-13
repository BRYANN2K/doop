import { useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import type { DriftComparison } from '../../shared/drift'
import { classifyDriftUrl } from '../../shared/drift'
import { api, errorMessage } from '../lib/api'
import { hasLocalDrift } from '../lib/localDrift'
import { useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'

/** Designed-vs-shipped review for one frame: a URL to capture beside it,
 *  the pixel score, a diff overlay (slider / difference) between the two
 *  renders, and the button that sends the gaps to the resident agent. */
export function DriftModal({ frame, onClose }: { frame: Frame; onClose: () => void }) {
  const t = useT()
  const pushNotice = useStore((s) => s.pushNotice)
  const [url, setUrl] = useState('')
  const [running, setRunning] = useState(false)
  const [analyzing, setAnalyzing] = useState<'idle' | 'running' | 'queued'>('idle')
  const [comparison, setComparison] = useState<DriftComparison | null>(null)
  const [slider, setSlider] = useState(50)
  const [difference, setDifference] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)

  const kind = url.trim() ? classifyDriftUrl(url.trim()) : undefined
  const localWithoutDesktop = kind?.kind === 'local' && !hasLocalDrift()

  async function compare() {
    if (running || !url.trim() || localWithoutDesktop) return
    setRunning(true)
    try {
      const { comparison } = await api.compareDrift(frame.id, url.trim())
      setComparison(comparison)
      setAnalyzing('idle')
    } catch (err) {
      pushNotice(errorMessage(err, t('stage.driftCompareFailed')))
    } finally {
      setRunning(false)
    }
  }

  async function analyze() {
    if (!comparison || analyzing !== 'idle') return
    setAnalyzing('running')
    try {
      await api.analyzeDrift(frame.id, comparison.id)
      setAnalyzing('queued')
      pushNotice(t('stage.driftAnalyzeQueued'))
    } catch (err) {
      setAnalyzing('idle')
      pushNotice(errorMessage(err, t('stage.driftCompareFailed')))
    }
  }

  /* the wipe is a press-and-drag over the comparison, not an <input type=range>
     — the component layer composes primitives instead */
  function slideTo(clientX: number) {
    const rect = splitRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    setSlider(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }

  const designSrc = `/i/${frame.id}.png?scale=1`
  const shippedSrc = comparison?.shippedFrameId ? `/i/${comparison.shippedFrameId}.png?scale=1` : undefined
  const score = comparison?.score

  return (
    <Modal size="lg" onClose={onClose}>
      <ModalTitle className="break-words">{t('stage.driftTitle', { name: frame.name })}</ModalTitle>
      <ModalLede>{t('stage.driftLede')}</ModalLede>
      <div className="mt-5 flex gap-2">
        <Input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void compare()
          }}
          placeholder={t('stage.driftUrlPlaceholder')}
          className="flex-1"
        />
        <Button onClick={() => void compare()} disabled={running || !url.trim() || localWithoutDesktop}>
          {running ? t('stage.driftComparing') : t('stage.driftCompare')}
        </Button>
      </div>
      {kind?.kind === 'local' && (
        <p className="mt-2 text-body text-muted-foreground">
          {localWithoutDesktop ? t('stage.driftLocalNeedsDesktop') : t('stage.driftLocalNote')}
        </p>
      )}
      {comparison && (
        <div className="mt-5">
          <div className="flex items-center gap-3">
            <span className="text-body font-medium">
              {score !== undefined ? t('stage.driftScore', { score }) : t('stage.driftNoScore')}
            </span>
            <span className="text-caption text-muted-foreground">{comparison.finalUrl ?? comparison.url}</span>
            <label className="ml-auto flex items-center gap-1.5 text-caption text-muted-foreground">
              <Checkbox checked={difference} onChange={(e) => setDifference(e.target.checked)} />
              {t('stage.driftDifference')}
            </label>
          </div>
          {shippedSrc && (
            <div
              ref={splitRef}
              className="relative mt-2 w-full cursor-ew-resize touch-none select-none overflow-hidden rounded-card border border-border bg-white"
              style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
              role="slider"
              aria-label={t('stage.driftSlider')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(slider)}
              tabIndex={0}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                slideTo(e.clientX)
              }}
              onPointerMove={(e) => {
                if (e.buttons) slideTo(e.clientX)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setSlider((v) => Math.max(0, v - 2))
                if (e.key === 'ArrowRight') setSlider((v) => Math.min(100, v + 2))
              }}
            >
              <img
                src={designSrc}
                alt={t('stage.driftDesign')}
                className="absolute inset-0 h-full w-full object-cover object-top"
                draggable={false}
              />
              <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${slider}%)` }}>
                <img
                  src={shippedSrc}
                  alt={t('stage.driftShipped')}
                  className="h-full w-full object-cover object-top"
                  style={difference ? { mixBlendMode: 'difference' } : undefined}
                  draggable={false}
                />
              </div>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-white/80 shadow"
                style={{ left: `${slider}%` }}
              />
            </div>
          )}
          <ModalActions className="mt-4">
            {analyzing === 'queued' ? (
              <span className="text-body text-muted-foreground">{t('stage.driftAnalyzeQueued')}</span>
            ) : (
              <Button onClick={() => void analyze()} disabled={analyzing === 'running'}>
                {analyzing === 'running' ? t('stage.driftAnalyzing') : t('stage.driftAnalyze')}
              </Button>
            )}
          </ModalActions>
        </div>
      )}
    </Modal>
  )
}
