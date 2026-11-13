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
import { FramePreview } from './FramePreview'
import { FindPreview } from './FindPreview'

interface Hit {
  frame: Frame
  /** the match's place among its frame's matches, which a single replace names */
  n: number
  match: TextMatch
}

/** Where ⌘F looks: the open page (find and replace, on the HTML the client
 *  holds) or every page of the canvas (find only, answered by the server). */
type Scope = 'page' | 'canvas'

/** One frame in the all-pages results, with every match found in it. */
interface FrameGroup {
  frameId: string
  pageId: string
  pageName: string
  /** library frames are named `<library_id> — <label>` */
  id: string | null
  label: string
  hits: CanvasFindHit[]
  /** the distinct things matched inside: library ids when the snippet holds one */
  inside: { label: string; hit: CanvasFindHit }[]
}

const LIBRARY_ID = /[a-z][\w-]*\.[\w.-]*[\w]/gi

function splitFrameName(name: string): { id: string | null; label: string } {
  const at = name.indexOf(' — ')
  if (at > 0 && /^[\w.§-]+$/.test(name.slice(0, at).trim())) {
    return { id: name.slice(0, at).trim(), label: name.slice(at + 3).trim() }
  }
  return { id: null, label: name }
}

function groupByFrame(hits: CanvasFindHit[], query: string): FrameGroup[] {
  const q = query.trim().toLowerCase()
  const groups: FrameGroup[] = []
  const byId = new Map<string, FrameGroup>()
  for (const hit of hits) {
    let g = byId.get(hit.frameId)
    if (!g) {
      g = {
        frameId: hit.frameId,
        pageId: hit.pageId,
        pageName: hit.pageName,
        ...splitFrameName(hit.frameName),
        hits: [],
        inside: [],
      }
      byId.set(hit.frameId, g)
      groups.push(g)
    }
    g.hits.push(hit)
    if (hit.where === 'name') continue
    /* a library sheet's matches are its variants' ids: list those, once each */
    const around = hit.before + hit.text + hit.after
    const ids = [...around.matchAll(LIBRARY_ID)].map((m) => m[0]).filter((id) => id.toLowerCase().includes(q))
    const label = ids.find((id) => id !== g.id) ?? `${hit.before.slice(-24)}${hit.text}${hit.after.slice(0, 24)}`.trim()
    if (!g.inside.some((x) => x.label === label)) g.inside.push({ label, hit })
  }
  return groups.sort((a, b) => relevance(b, q) - relevance(a, q))
}

/* what you searched for first: a frame named for it, then a sheet holding
   variants of it, then passing mentions; section headers (§) last */
function relevance(g: FrameGroup, q: string): number {
  const id = (g.id ?? '').toLowerCase()
  const label = g.label.toLowerCase()
  let score = 0
  if (id.includes(q)) score += 1000
  if (id.split(/[.-]/).includes(q)) score += 400
  if (label.includes(q)) score += 300
  score += Math.min(variantIds(g).length, 30) * 25
  score += Math.min(g.hits.length, 20)
  if (g.label.startsWith('§') || id.startsWith('§')) score -= 2000
  return score
}

const looksLikeId = (s: string) => /^[a-z][\w-]*\.[\w.-]+$/i.test(s)
const variantIds = (g: FrameGroup) => g.inside.filter((x) => looksLikeId(x.label))

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
  const remoteHits = useMemo(
    () => (scope === 'canvas' && remote?.q === query.trim() ? remote.hits : []),
    [scope, remote, query],
  )
  /* all pages: one row per frame, stepped frame by frame */
  const groups = useMemo(() => groupByFrame(remoteHits, query), [remoteHits, query])
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [hovered, setHovered] = useState<string | null>(null)
  /* a variant picked in an expanded row: the preview frames that one */
  const [focusPick, setFocusPick] = useState<{ frameId: string; label: string } | null>(null)
  const listLength = scope === 'canvas' ? groups.length : hits.length
  const active = listLength ? Math.min(cursor, listLength - 1) : -1

  function flyToHit(hit: CanvasFindHit) {
    const s = useStore.getState()
    s.select(hit.frameId)
    s.requestFlyTo(hit.frameId)
    if (hit.where === 'text') pickWhenLoaded(hit.frameId, query.trim(), hit.n, matchCase)
  }

  function goRemote(index: number) {
    const group = groups[index]
    if (!group) return
    setCursor(index)
    setFocusPick(null)
    /* the frame's first readable match is picked; a name match just frames it */
    flyToHit(group.hits.find((h) => h.where === 'text') ?? group.hits[0]!)
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
            total: listLength,
          })
        : t('actions.findNone')

  return (
    <div
      role="search"
      aria-label={t('actions.findLabel')}
      className={cn(
        'absolute z-40 flex flex-col gap-1.5 rounded-panel bg-surface p-2 shadow-float',
        scope === 'canvas' ? 'w-[min(460px,calc(100vw-24px))]' : 'w-[min(360px,calc(100vw-24px))]',
      )}
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
      {scope === 'canvas' && groups.length > 0 && (
        <>
          {/* the frame under the pointer, else the active one, live and framed on what matched */}
          {(() => {
            const shown = groups.find((g) => g.frameId === hovered) ?? groups[Math.max(active, 0)]
            if (!shown) return null
            const q = query.trim()
            const focus =
              focusPick?.frameId === shown.frameId
                ? focusPick.label
                : (variantIds(shown)[0]?.label ??
                  (shown.id && shown.id.toLowerCase().includes(q.toLowerCase()) ? shown.id : q))
            return <FindPreview frameId={shown.frameId} focus={focus} />
          })()}
          <p className="px-1 text-caption text-ink-faint">
            {t('actions.findFramesSummary', { frames: groups.length, total: remote?.total ?? remoteHits.length })}
          </p>
          <ul
            className="max-h-80 overflow-y-auto"
            aria-label={t('actions.findLabel')}
            onMouseLeave={() => setHovered(null)}
          >
            {groups.slice(0, 300).map((g, i) => {
              const expanded = open.has(g.frameId)
              const variants = variantIds(g).length
              return (
                <li key={g.frameId}>
                  <div
                    className={cn(
                      'flex items-center gap-2 rounded-row px-1.5 py-1',
                      i === active ? 'bg-paper-deep' : 'hover:bg-sub',
                    )}
                    onMouseEnter={() => setHovered(g.frameId)}
                  >
                    <Pressable
                      focus="none"
                      onClick={() => go(i)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className="h-[30px] w-[46px] flex-none overflow-hidden rounded-tag bg-sub ring-1 ring-line-soft">
                        <FramePreview frameId={g.frameId} empty={null} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-caption text-ink">{g.id ?? g.label}</span>
                        <span className="truncate text-caption text-ink-faint">
                          {g.id ? `${g.label} · ` : ''}
                          {g.pageName}
                        </span>
                      </span>
                    </Pressable>
                    <span className="flex-none text-caption text-ink-faint tabular-nums">
                      {variants
                        ? t('actions.findVariants', { count: variants })
                        : t('actions.findMatches', { count: g.hits.length })}
                    </span>
                    {g.inside.length > 0 ? (
                      <IconButton
                        size="sm"
                        aria-label={t('actions.findShowInside')}
                        aria-expanded={expanded}
                        onClick={() =>
                          setOpen((prev) => {
                            const next = new Set(prev)
                            if (next.has(g.frameId)) next.delete(g.frameId)
                            else next.add(g.frameId)
                            return next
                          })
                        }
                      >
                        <ChevronRightIcon
                          width={14}
                          height={14}
                          aria-hidden
                          className={cn('transition-transform', expanded && 'rotate-90')}
                        />
                      </IconButton>
                    ) : (
                      <span className="size-7 flex-none" />
                    )}
                  </div>
                  {expanded && (
                    <ul className="pb-1 pl-[62px]">
                      {g.inside.slice(0, 40).map((x) => (
                        <li key={x.label}>
                          <Pressable
                            focus="none"
                            onClick={() => {
                              setCursor(i)
                              setFocusPick({ frameId: g.frameId, label: x.label })
                              flyToHit(x.hit)
                            }}
                            className="w-full truncate rounded-row px-1.5 py-0.5 text-left font-mono text-caption text-ink-soft hover:bg-sub"
                          >
                            {x.label}
                          </Pressable>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </>
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
