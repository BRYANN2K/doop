import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { FramePreview } from './FramePreview'

/**
 * The ⌘F preview: the frame rendered live (not its top-crop image) and
 * framed on the component that matched. A library sheet holds a dozen
 * components; the one you searched for sits somewhere in the middle, so the
 * preview finds the element carrying `focus` (a library id, or the query),
 * outlines it, and zooms the frame onto it.
 *
 * The frame stays sandboxed (scripts only, no same-origin): a small script
 * injected into the document finds the element and posts its box back.
 */

const htmlCache = new Map<string, Promise<string>>()

function frameHtml(frameId: string): Promise<string> {
  const local = useStore.getState().canvas?.frames.find((f) => f.id === frameId)?.html
  if (local) return Promise.resolve(local)
  let p = htmlCache.get(frameId)
  if (!p) {
    p = api.frame(frameId).then((f) => f.html ?? '')
    p.catch(() => htmlCache.delete(frameId))
    htmlCache.set(frameId, p)
  }
  return p
}

/* runs inside the frame: find the smallest card-sized box around the text */
const FINDER = (token: string, focus: string) => `<script>(function(){
var T=${JSON.stringify(token)},F=${JSON.stringify(focus.toLowerCase())};
function find(){
  var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),n,hit=null;
  while((n=w.nextNode())){if(n.nodeValue&&n.nodeValue.toLowerCase().indexOf(F)>=0){hit=n.parentElement;break}}
  if(!hit)return null;
  var el=hit,r=el.getBoundingClientRect();
  for(var i=0;i<8&&el.parentElement&&el.parentElement!==document.body;i++){
    if(r.width>=160&&r.height>=110)break;
    el=el.parentElement;r=el.getBoundingClientRect();
  }
  el.style.outline='3px solid #7c5cff';el.style.outlineOffset='4px';el.style.borderRadius=el.style.borderRadius||'6px';
  var sx=window.scrollX,sy=window.scrollY;
  return {x:r.left+sx,y:r.top+sy,w:r.width,h:r.height};
}
function post(){var b=find();parent.postMessage({doopFindPreview:T,box:b,docW:document.documentElement.scrollWidth,docH:document.documentElement.scrollHeight},'*');return b}
/* sheets often render their items from a script after load */
window.addEventListener('load',function(){if(!post()){setTimeout(post,500);setTimeout(post,1500)}});
})();</script>`

interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function FindPreview({ frameId, focus }: { frameId: string; focus: string }) {
  const frame = useStore((s) => s.canvas?.frames.find((f) => f.id === frameId))
  const wrapRef = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<{ key: string; html: string } | null>(null)
  const [box, setBox] = useState<{ key: string; box: Box | null } | null>(null)
  const [size, setSize] = useState({ w: 444, h: 220 })
  const key = `${frameId}\n${focus}`
  const token = useRef(0)

  useEffect(() => {
    let stale = false
    void frameHtml(frameId)
      .then((html) => {
        if (stale) return
        token.current += 1
        const finder = FINDER(`${token.current}`, focus)
        const withFinder = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${finder}</body>`) : html + finder
        setDoc({ key, html: withFinder })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [frameId, focus, key])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { doopFindPreview?: string; box?: Box | null } | null
      if (!data || data.doopFindPreview !== `${token.current}`) return
      setBox({ key, box: data.box ?? null })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [key])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fw = frame?.width ?? 1440
  const fh = frame?.height ?? 900
  const target = box?.key === key ? box.box : null
  /* zoom on the matched component with a margin; otherwise fit the frame's width */
  let scale = size.w / fw
  let tx = 0
  let ty = 0
  if (target) {
    const pad = 24
    scale = Math.min((size.w - pad * 2) / target.w, (size.h - pad * 2) / target.h, 1.6)
    tx = size.w / 2 - (target.x + target.w / 2) * scale
    ty = size.h / 2 - (target.y + target.h / 2) * scale
  }

  return (
    <div ref={wrapRef} className="relative h-56 flex-none overflow-hidden rounded-row bg-sub ring-1 ring-line-soft">
      {doc?.key === key ? (
        <iframe
          title="preview"
          sandbox="allow-scripts"
          srcDoc={doc.html}
          tabIndex={-1}
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 transition-transform duration-300 ease-out"
          style={{ width: fw, height: fh, transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        />
      ) : (
        <FramePreview frameId={frameId} empty={null} />
      )}
    </div>
  )
}
