import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Frame } from '../../shared/types'
import { readingOrder } from '../../shared/frameOrder'
import { useT } from '../lib/i18n'
import { usePageCanvas } from '../lib/pages'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { saveFrameHtml } from '../lib/layerEdits'
import { findInHtml, replaceInHtml, type TextMatch } from '../lib/actions/findText'
import { saveFramesHtml } from '../lib/actions/edits'
import { api } from '../lib/api'
import type { CanvasFindHit } from '../../shared/canvasFind'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Pressable } from './ui/pressable'
import { SearchField } from './ui/search-field'

interface Hit {
  frame: Frame
  /** the match's place among its frame's matches, which a single replace names */
  n: number
  match: TextMatch
}

/** Where ⌘F looks: the open page (find and replace, on the HTML the client
 *  holds) or every page of the canvas (find only, answered by the server). */
type Scope = 'page' | 'canvas'

/** How long typing settles before an all-pages search asks the server. */
const CANVAS_FIND_DEBOUNCE_MS = 220

/* After an all-pages hit flies to another page, that page's HTML arrives a
   moment later; the match inside the frame is picked once it is there. */
function pickWhenLoaded(frameId: string, query: string, n: number, matchCase: boolean) {
  const deadline = Date.now() + 4000
  const tryPick = () => {
    const s = useStore.getState()
    const frame = s.canvas?.frames.find((f) => f.id === frameId)
    if (frame?.html) {
      const match = findInHtml(frame.html, query, { matchCase })[n]
      if (match) s.pickElement({ frameId, selector: match.selector }, true)
      return
    }
    if (Date.now() < deadline) window.setTimeout(tryPick, 150)
  }
  tryPick()
}

/**
 * ⌘F: find text across the page's frames, step through the matches (↩ /
 * ⇧↩), each one picked and flown to; ⌥⌘F opens it with a replace line,
 * replacing one match or all of them as one undo step.
 */
export function FindBar({
  mode,
  step,
  onClose,
}: {
  mode: 'find' | 'replace'
  /** a step asked for from outside (the Edit menu's Find next/previous) */
  step: { dir: 1 | -1; at: number } | null
  onClose: () => void
}) {
  const t = useT()
  const page = usePageCanvas()
  const canEdit = useStore((s) => canEditOpenCanvas(s))
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [showReplace, setShowReplace] = useState(mode === 'replace')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const canvasId = useStore((s) => s.canvas?.id)
  const pageCount = useStore((s) => s.canvas?.pages?.length ?? 1)
  /* a canvas with several pages (a library) is searched whole by default */
  const [scope, setScope] = useState<Scope>(pageCount > 1 ? 'canvas' : 'page')
  const [remote, setRemote] = useState<{ q: string; hits: CanvasFindHit[]; total: number; frames: number } | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (scope !== 'canvas' || !canvasId) return
    const q = query.trim()
    if (!q) return
    let stale = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      api
        .findInCanvas(canvasId, q, matchCase)
        .then((r) => {
          if (!stale) setRemote({ q, ...r })
        })
        .catch(() => {
          if (!stale) setRemote({ q, hits: [], total: 0, frames: 0 })
        })
        .finally(() => {
          if (!stale) setSearching(false)
        })
    }, CANVAS_FIND_DEBOUNCE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [scope, canvasId, query, matchCase])

  /* ⌘F again (or ⌥⌘F) while open puts the keyboard back in the field */
  const [seenMode, setSeenMode] = useState(mode)
  if (seenMode !== mode) {
    setSeenMode(mode)
    if (mode === 'replace') setShowReplace(true)
  }
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [mode])

  const hits = useMemo<Hit[]>(() => {
    const frames = readingOrder((page?.frames ?? []).filter((f) => !f.hidden))
    return frames.flatMap((frame) =>
      findInHtml(frame.html, query, { matchCase }).map((match, n) => ({ frame, n, match })),
    )
  }, [page?.frames, query, matchCase])
  /* an answer for an older query is not shown while the new one is asked */
  const remoteHits = scope === 'canvas' && remote?.q === query.trim() ? remote.hits : []
  const listLength = scope === 'canvas' ? remoteHits.length : hits.length
  const active = listLength ? Math.min(cursor, listLength - 1) : -1

  function goRemote(index: number) {
    const hit = remoteHits[index]
    if (!hit) return
    setCursor(index)
    const s = useStore.getState()
    s.select(hit.frameId)
    s.requestFlyTo(hit.frameId)
    if (hit.where === 'text') pickWhenLoaded(hit.frameId, query.trim(), hit.n, matchCase)
  }

  function go(index: number) {
    if (scope === 'canvas') return goRemote(index)
    const hit = hits[index]
    if (!hit) return
    setCursor(index)
    const s = useStore.getState()
    s.select(hit.frame.id)
    s.pickElement({ frameId: hit.frame.id, selector: hit.match.selector }, true)
    s.requestFlyTo(hit.frame.id)
  }

  function move(dir: 1 | -1) {
    if (!listLength) return
    go(active === -1 ? 0 : (active + dir + listLength) % listLength)
  }

  /* the menus' Find next / previous */
  const [seenStep, setSeenStep] = useState(step)
  if (seenStep !== step) {
    setSeenStep(step)
    if (step) move(step.dir)
  }

  function replaceOne() {
    const hit = hits[active]
    if (!hit || hit.frame.locked || hit.match.locked) return
    const replaced = replaceInHtml(hit.frame.html, query, replacement, { matchCase, only: hit.n })
    if (replaced) saveFrameHtml(hit.frame, replaced.html)
  }

  function replaceAll() {
    const byFrame = new Map<string, Frame>()
    for (const hit of hits) if (!hit.frame.locked) byFrame.set(hit.frame.id, hit.frame)
    let count = 0
    const changes = [...byFrame.values()].flatMap((frame) => {
      const replaced = replaceInHtml(frame.html, query, replacement, { matchCase })
      if (!replaced) return []
      count += replaced.count
      return [{ frame, html: replaced.html }]
    })
    saveFramesHtml(changes)
    if (count) useStore.getState().pushNotice(t('actions.replaced', { count }))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      move(e.shiftKey ? -1 : 1)
    }
  }

  const count = !query.trim()
    ? ''
    : scope === 'canvas' && (searching || remote?.q !== query.trim())
      ? '…'
      : listLength
        ? t('actions.findCount', {
            current: active + 1,
            total: scope === 'canvas' ? (remote?.total ?? listLength) : listLength,
          })
        : t('actions.findNone')

  return (
    <div
      role="search"
      aria-label={t('actions.findLabel')}
      className="absolute z-40 flex w-[min(360px,calc(100vw-24px))] flex-col gap-1.5 rounded-panel bg-surface p-2 shadow-float"
      style={{ top: 'calc(var(--chrome-top, 0px) + 10px)', right: 'calc(var(--chrome-right, 0px) + 10px)' }}
    >
      <div className="flex items-center gap-1">
        {canEdit && (
          <IconButton
            size="sm"
            aria-label={t('actions.showReplace')}
            on={showReplace}
            onClick={() => setShowReplace((v) => !v)}
          >
            <ChevronRightIcon
              width={14}
              height={14}
              aria-hidden
              className={cn('transition-transform', showReplace && 'rotate-90')}
            />
          </IconButton>
        )}
        <SearchField
          ref={inputRef}
          className="min-w-0 flex-1"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
          placeholder={t('actions.findPlaceholder')}
          aria-label={t('actions.findPlaceholder')}
          trailing={<span className="flex-none font-mono text-caption text-ink-faint">{count}</span>}
        />
        {pageCount > 1 && (
          <IconButton
            size="sm"
            aria-label={t('actions.findAllPages')}
            title={t('actions.findAllPages')}
            on={scope === 'canvas'}
            onClick={() => {
              setScope((v) => (v === 'canvas' ? 'page' : 'canvas'))
              setCursor(0)
            }}
          >
            <span className="font-mono text-caption">{t('actions.findAllPagesShort')}</span>
          </IconButton>
        )}
        <IconButton
          size="sm"
          aria-label={t('actions.matchCase')}
          on={matchCase}
          onClick={() => setMatchCase((v) => !v)}
        >
          <span className="font-mono text-caption">Aa</span>
        </IconButton>
        <IconButton size="sm" aria-label={t('actions.previousMatch')} disabled={!listLength} onClick={() => move(-1)}>
          <ArrowUpIcon width={14} height={14} aria-hidden />
        </IconButton>
        <IconButton size="sm" aria-label={t('actions.nextMatch')} disabled={!listLength} onClick={() => move(1)}>
          <ArrowDownIcon width={14} height={14} aria-hidden />
        </IconButton>
        <IconButton size="sm" aria-label={t('actions.closeFind')} onClick={onClose}>
          <XIcon width={14} height={14} aria-hidden />
        </IconButton>
      </div>
      {canEdit && showReplace && scope === 'page' && (
        <div className="flex items-center gap-1 pl-7">
          <Input
            inputSize="sm"
            className="min-w-0 flex-1"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                replaceOne()
              }
            }}
            placeholder={t('actions.replacePlaceholder')}
            aria-label={t('actions.replacePlaceholder')}
          />
          <Button size="sm" disabled={active === -1 || !!hits[active]?.match.locked} onClick={replaceOne}>
            {t('actions.replaceOne')}
          </Button>
          <Button size="sm" disabled={!hits.length} onClick={replaceAll}>
            {t('actions.replaceAll')}
          </Button>
        </div>
      )}
      {scope === 'canvas' && remoteHits.length > 0 && (
        <ul className="max-h-72 overflow-y-auto" aria-label={t('actions.findLabel')}>
          {remoteHits.slice(0, 300).map((hit, i) => (
            <li key={`${hit.frameId}:${hit.where}:${i}`}>
              <Pressable
                focus="none"
                onClick={() => go(i)}
                className={cn(
                  'flex w-full flex-col items-start rounded-row px-2 py-1 text-left',
                  i === active ? 'bg-paper-deep' : 'hover:bg-sub',
                )}
              >
                <span className="w-full truncate text-caption text-ink-faint">
                  {hit.pageName} · {hit.frameName}
                </span>
                <span className="w-full truncate text-body text-ink-soft">
                  {hit.before}
                  <mark className="rounded-tag bg-brand/20 text-ink">{hit.text}</mark>
                  {hit.after}
                </span>
              </Pressable>
            </li>
          ))}
        </ul>
      )}
      {scope === 'page' && hits.length > 0 && (
        <ul className="max-h-56 overflow-y-auto" aria-label={t('actions.findLabel')}>
          {hits.slice(0, 200).map((hit, i) => (
            <li key={`${hit.frame.id}:${i}`}>
              <Pressable
                focus="none"
                onClick={() => go(i)}
                className={cn(
                  'flex w-full flex-col items-start rounded-row px-2 py-1 text-left',
                  i === active ? 'bg-paper-deep' : 'hover:bg-sub',
                )}
              >
                <span className="text-caption text-ink-faint">{hit.frame.name}</span>
                <span className="w-full truncate text-body text-ink-soft">
                  {hit.match.before}
                  <mark className="rounded-tag bg-brand/20 text-ink">{hit.match.text}</mark>
                  {hit.match.after}
                </span>
              </Pressable>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
