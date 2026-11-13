import { useState } from 'react'
import type { Frame } from '../../shared/types'
import { liveFrameReload, liveFrameUrl, parseLiveUrl, withLiveReload } from '../../shared/liveFrame'
import { canRenderLiveFrame, hasLiveSnapshot, reloadLiveFrame, snapshotLiveFrame } from '../lib/liveFrame'
import { api, errorMessage } from '../lib/api'
import { openExternal } from '../lib/desktop'
import { useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { Tooltip } from './ui/tooltip'
import { Pressable } from './ui/pressable'
import { IconButton } from './ui/icon-button'
import { ChevronDownIcon, CopyIcon, ExportIcon, ImageIcon, SyncIcon } from './ui/icons'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

const AUTO_RELOAD_CHOICES = [0, 15, 30, 60] as const

/** The chip a live frame wears next to its name: `LIVE · localhost:4321`,
 *  with the controls that only make sense on a live page — reload on
 *  demand, an optional auto-reload interval stored on the frame itself
 *  (so collaborators see the same cadence), and Snapshot. Everything but
 *  the placeholder reads no-ops outside the desktop shell. */
export function LiveFrameBadge({ frame }: { frame: Frame }) {
  const t = useT()
  const url = liveFrameUrl(frame.html)
  const reloadSeconds = liveFrameReload(frame.html)
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [reloading, setReloading] = useState(false)
  if (!url) return null
  const host = parseLiveUrl(url)?.host ?? url
  const live = canRenderLiveFrame()

  async function autoReload(seconds: number) {
    const html = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.html
    if (!html) return
    try {
      await api.updateFrame(frame.id, { html: withLiveReload(html, seconds) })
    } catch (err) {
      useStore.getState().pushNotice(errorMessage(err, t('stage.liveSaveFailed')))
    }
  }

  async function snapshot() {
    setSnapshotBusy(true)
    try {
      const snap = await snapshotLiveFrame(frame)
      useStore.getState().pushNotice(t('stage.liveSnapshotDone', { name: snap.name }))
    } catch (err) {
      useStore.getState().pushNotice(errorMessage(err, t('stage.liveSnapshotFailed')))
    } finally {
      setSnapshotBusy(false)
    }
  }

  function reload() {
    setReloading(true)
    reloadLiveFrame(frame.id)
    window.setTimeout(() => setReloading(false), 600)
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5 @max-[180px]/title:order-first">
      <DropdownMenu>
        <Tooltip label={live ? t('stage.liveTip') : t('stage.liveTipWeb')} side="top" align="start">
          <DropdownMenuTrigger asChild>
            <Pressable
              layout="inline"
              focus="none"
              className={cn(
                'gap-1 rounded-pill bg-brand px-1.5 py-0.5 text-micro font-medium text-white',
                'data-[state=open]:bg-brand/80 animate-[chip-in_0.25s_ease]',
              )}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="size-1.5 rounded-full bg-white" />
              <span className="@max-[180px]/title:hidden">LIVE · {host}</span>
              <ChevronDownIcon width={9} height={9} />
            </Pressable>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="start" width="sm">
          <DropdownMenuItem disabled={!live} onSelect={reload}>
            <SyncIcon width={14} height={14} className="text-ink-soft" />
            {t('stage.liveReload')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCaption>{t('stage.liveAutoReload')}</DropdownMenuCaption>
          <DropdownMenuRadioGroup value={String(reloadSeconds)} onValueChange={(v) => void autoReload(Number(v))}>
            {AUTO_RELOAD_CHOICES.map((seconds) => (
              <DropdownMenuRadioItem key={seconds} value={String(seconds)}>
                {seconds === 0 ? t('stage.liveAutoOff') : t('stage.liveAutoEvery', { seconds })}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {hasLiveSnapshot() && (
            <DropdownMenuItem disabled={snapshotBusy || !live} onSelect={() => void snapshot()}>
              <ImageIcon width={14} height={14} className="text-ink-soft" />
              {snapshotBusy ? t('stage.liveSnapshotting') : t('stage.liveSnapshot')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => (openExternal(url) ? undefined : window.open(url, '_blank'))}>
            <ExportIcon width={14} height={14} className="text-ink-soft" />
            {t('stage.liveOpenBrowser')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard
                .writeText(url)
                .then(() => useStore.getState().pushNotice(t('stage.liveUrlCopied')))
            }}
          >
            <CopyIcon width={14} height={14} className="text-ink-soft" />
            {t('stage.liveCopyUrl')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip label={t('stage.liveReload')} side="top" align="start">
        <IconButton
          aria-label={t('stage.liveReload')}
          variant="quiet"
          size="sm"
          shape="round"
          disabled={!live}
          className={cn('size-[18px] text-ink-faint', reloading && 'animate-spin [animation-duration:0.9s]')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={reload}
        >
          <SyncIcon width={11} height={11} />
        </IconButton>
      </Tooltip>
    </span>
  )
}
