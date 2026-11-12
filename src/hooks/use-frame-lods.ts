import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useStore, type Viewport } from '../lib/store'
import { frameLods, liveFrameBudget, type FrameLod, type LodRect } from '../lib/frameLod'
import { CAMERA_SETTLE_MS } from '../lib/layoutZoom'

interface SettledView {
  camera: Viewport
  width: number
  height: number
}

/** How each frame on the page is drawn (see frameLod.ts), from the settled
 *  camera, the stage size, the selection, prototype mode and the running
 *  agent streams. */
export function useFrameLods(
  stageRef: RefObject<HTMLDivElement | null>,
  frames: readonly LodRect[],
): Map<string, FrameLod> {
  const [budget] = useState(liveFrameBudget)
  /* zero size until the stage is measured: nothing goes live before then,
     so a heavy canvas never mounts every document for one first paint */
  const [view, setView] = useState<SettledView>(() => ({ camera: useStore.getState().viewport, width: 0, height: 0 }))
  const selectedIds = useStore((s) => s.selectedIds)
  /* prototype connectors start at hotspots only a live document can report
     (PrototypeOverlay), so prototype mode keeps every frame live */
  const prototypeMode = useStore((s) => s.prototypeMode)
  /* a joined string, so a new stream chunk with the same streams re-renders nothing */
  const streamIds = useStore((s) => Object.keys(s.streams).join('\n'))
  /* joined strings like streamIds: an element pick, an open context menu and
     the frames peers are editing pin their frame live without re-rendering
     on every cursor move (frameCulling.ts pinned the same set) */
  const pickedFrameId = useStore((s) => s.selectedElement?.frameId)
  const menuFrameId = useStore((s) => s.ctxMenu?.frameId)
  const peerFrameIds = useStore((s) =>
    Object.values(s.presences)
      .map((p) => p.activeFrameId)
      .filter(Boolean)
      .join('\n'),
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () =>
      setView({ camera: useStore.getState().viewport, width: stage.clientWidth, height: stage.clientHeight })
    let settle = 0
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.viewport === prev.viewport) return
      window.clearTimeout(settle)
      settle = window.setTimeout(measure, CAMERA_SETTLE_MS)
    })
    const resize = new ResizeObserver(measure)
    resize.observe(stage)
    return () => {
      unsubscribe()
      resize.disconnect()
      window.clearTimeout(settle)
    }
  }, [stageRef])

  return useMemo(() => {
    const pinned = new Set(prototypeMode ? frames.map((f) => f.id) : selectedIds)
    if (pickedFrameId) pinned.add(pickedFrameId)
    if (menuFrameId) pinned.add(menuFrameId)
    for (const id of peerFrameIds.split('\n')) if (id) pinned.add(id)
    for (const id of streamIds.split('\n')) if (id) pinned.add(id)
    return frameLods(frames, view.camera, view, {
      budget,
      pinned,
      preferred: new Set(streamIds ? streamIds.split('\n') : []),
    })
  }, [frames, view, budget, selectedIds, prototypeMode, streamIds, pickedFrameId, menuFrameId, peerFrameIds])
}
