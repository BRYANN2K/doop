/* The web side of live frames (shared/liveFrame.ts holds the contract). A
 * live frame only runs inside the desktop shell — the same machine hosts the
 * dev server — so everywhere else keeps showing the placeholder document the
 * frame stores, which is also what makes a live frame readable on the web. */

import type { Frame } from '../../shared/types'
import { parseLiveUrl, liveFrameUrl, snapshotFrameHtml, liveSnapshotSource } from '../../shared/liveFrame'
import { api } from './api'
import { recordCreate } from './history'
import { isDesktopShell } from './shell'
import { useStore } from './store'

type Bridge = {
  __DOOP_LIVE_SNAPSHOT__?: boolean
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
  }
}
const bridge = globalThis as Bridge

/** Whether this page can actually mount a live frame's dev page. Only the
 *  desktop shell can: the server and other machines cannot reach the Mac's
 *  localhost, and an http dev page inside the hosted https app would trip
 *  mixed-content rules besides — the stored placeholder covers every
 *  other surface. */
export const canRenderLiveFrame = isDesktopShell

/** Whether this shell can render a live page offscreen for a snapshot —
 *  shells older than live.rs show an update hint instead of the menu item. */
export const hasLiveSnapshot = () => bridge.__DOOP_LIVE_SNAPSHOT__ === true && !!bridge.__TAURI__?.core

function invokeLive<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!bridge.__TAURI__) {
    return Promise.reject(new Error('Snapshots need the Doop desktop app.'))
  }
  return bridge.__TAURI__.core.invoke<T>(command, args)
}

/* ---- reload bus: the context menu and badge bump it, the mounted frame
   listens — they are different trees over the same canvas ---------------- */

const reloadListeners = new Map<string, Set<() => void>>()

/** Ask the live frame's iframe to load its dev page again. */
export function reloadLiveFrame(frameId: string) {
  reloadListeners.get(frameId)?.forEach((cb) => cb())
}

export function onLiveFrameReload(frameId: string, cb: () => void): () => void {
  const set = reloadListeners.get(frameId) ?? new Set()
  reloadListeners.set(frameId, set)
  set.add(cb)
  return () => {
    set.delete(cb)
    if (!set.size) reloadListeners.delete(frameId)
  }
}

/**
 * Render the live frame's page offscreen (live.rs in the shell), turn the
 * captured DOM into a static frame next to it (snapshotFrameHtml stamps the
 * provenance and a `<base>` so assets resolve on this machine), and return
 * the new frame. Throws with a readable message on a dead server or a page
 * too large to store.
 */
export async function snapshotLiveFrame(frame: Frame): Promise<Frame> {
  const url = liveFrameUrl(frame.html)
  if (!url) throw new Error('This frame has no live URL.')
  const result = await invokeLive<{ html: string }>('live_snapshot', { url })
  const html = snapshotFrameHtml(result.html, url)
  const name = `${frame.name} — snapshot`.slice(0, 80)
  const snapshot = await api.createFrame(frame.canvasId, {
    name,
    html,
    x: frame.x + frame.width + 80,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    pageId: frame.pageId ?? useStore.getState().activePageId ?? undefined,
  })
  recordCreate(snapshot)
  return snapshot
}

export { parseLiveUrl, liveFrameUrl, liveSnapshotSource }
