import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import type { CanvasMeta } from '../../shared/types'
import { CardDescription, CardHeader, CardTitle, SettingsCard } from './ui/card'
import { Checkbox } from './ui/checkbox'
import { FrameIcon } from './ui/icons'

/* keep in step with LIBRARY_MAX_CANVASES in server/referenceLibrary.ts */
const MAX_LIBRARY_CANVASES = 8

/**
 * The reference library: the canvases the chat agent searches before it
 * proposes a plan — and the only places a plan's references may point. One
 * toggle per canvas the person can open; the pick is theirs (per user, like
 * the model connection), so a shared canvas a colleague designated never
 * leaks into their plans.
 */
export function ReferenceLibraryCard() {
  const t = useT()
  const [picked, setPicked] = useState<string[] | null>(null)
  const [canvases, setCanvases] = useState<CanvasMeta[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    api.getLibrary().then(
      (r) => setPicked(r.canvases.map((c) => c.id)),
      () => setPicked([]),
    )
    api.listCanvases().then(setCanvases, () => {})
  }, [])
  useEffect(refresh, [refresh])

  const toggle = async (id: string, on: boolean) => {
    if (!picked || busy) return
    const next = on ? [...picked, id] : picked.filter((c) => c !== id)
    setBusy(true)
    setError('')
    try {
      const r = await api.setLibrary(next)
      setPicked(r.canvases.map((c) => c.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.failedRetry'))
    } finally {
      setBusy(false)
    }
  }

  if (!picked || !canvases) return null
  const full = picked.length >= MAX_LIBRARY_CANVASES

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('settings.libraryTitle')}</CardTitle>
        <CardDescription>{t('settings.libraryDescription')}</CardDescription>
      </CardHeader>
      <div className="px-4 pb-5 pt-4 sm:px-[22px]">
        {canvases.length === 0 ? (
          <p className="text-body text-ink-faint">{t('settings.libraryNoCanvases')}</p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {canvases.map((c) => {
              const on = picked.includes(c.id)
              const disabled = busy || (!on && full)
              return (
                <li key={c.id}>
                  <label
                    className={cn(
                      'relative flex cursor-pointer items-center gap-2.5 rounded-control px-1.5 py-1.5 hover:bg-paper-deep',
                      disabled && 'cursor-default opacity-60',
                    )}
                  >
                    <Checkbox checked={on} disabled={disabled} onChange={(e) => toggle(c.id, e.target.checked)} />
                    {c.previewFrameId ? (
                      <img
                        src={`/i/${c.previewFrameId}.jpg?preview`}
                        alt=""
                        loading="lazy"
                        className="h-9 w-12 flex-none rounded-row object-cover object-top shadow-ring"
                      />
                    ) : (
                      <span className="grid h-9 w-12 flex-none place-items-center rounded-row bg-paper-deep text-ink-faint shadow-ring">
                        <FrameIcon size="rail" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-body text-ink">{c.name}</span>
                    <span className="flex-none text-caption text-ink-faint tabular-nums">
                      {t('settings.libraryFrames', { count: c.frameCount })}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-2 text-caption text-ink-faint">{t('settings.libraryCap', { count: MAX_LIBRARY_CANVASES })}</p>
        {error && <p className="mt-2 text-body text-accent-ink">{error}</p>}
      </div>
    </SettingsCard>
  )
}
