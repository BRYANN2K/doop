/**
 * Client-side anti-slop lint: after a frame's document settles in its iframe,
 * ask the runtime for a SlopSnapshot (shared/slopCollect.ts), score it with
 * the shared rules and write the result back through the API — the server
 * relays it to the room as `frame:lint`. Agent-made changes get the same
 * result from the server (server/lint.ts); this path covers human edits.
 */
import type { Frame } from '../../shared/types'
import { lintSnapshot } from '../../shared/slopRules'
import { slopSnapshotOf } from './frameBridge'
import { api } from './api'
import { useStore } from './store'

/* an html change re-arms the wait: a stream lands in many chunks and only
   the settled document is worth scoring */
const LINT_DEBOUNCE_MS = 1500

const timers = new Map<string, number>()
/* frameId → the html a pass is currently measuring, so a second schedule
   for the same document does not stack another render of the same snapshot */
const inflight = new Map<string, string>()

export function scheduleFrameLint(frame: Frame) {
  if (!frame.html || frame.demo) return
  const html = frame.html
  if (inflight.get(frame.id) === html) return
  const timer = timers.get(frame.id)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.set(
    frame.id,
    window.setTimeout(() => {
      timers.delete(frame.id)
      void runFrameLint(frame.id, html)
    }, LINT_DEBOUNCE_MS),
  )
}

async function runFrameLint(frameId: string, html: string) {
  const current = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
  /* the document moved on while we waited — a newer schedule owns it now */
  if (!current || current.html !== html) return
  inflight.set(frameId, html)
  try {
    const snap = await slopSnapshotOf(frameId)
    /* not mounted (off-screen) or the collector failed — nothing to write */
    if (!snap) return
    const after = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
    if (!after || after.html !== html) return
    const lint = lintSnapshot(snap)
    /* show it at once; the server's frame:lint confirms it to the room */
    useStore.getState().patchFrameLocal(frameId, { lint })
    await api.setFrameLint(frameId, lint)
  } catch (error) {
    console.error('frame lint failed', error)
  } finally {
    if (inflight.get(frameId) === html) inflight.delete(frameId)
  }
}
