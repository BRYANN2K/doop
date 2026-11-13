/** ⌘F across every page of a canvas — the wire shape of GET /api/canvases/:id/find. */

export interface CanvasFindHit {
  frameId: string
  pageId: string
  pageName: string
  frameName: string
  /** where the text was found */
  where: 'name' | 'text' | 'code'
  /** this hit's place among its frame's text hits (name hits are -1) */
  n: number
  before: string
  text: string
  after: string
}

export interface CanvasFindResult {
  hits: CanvasFindHit[]
  /** every match counted, including those past the cap */
  total: number
  /** frames with at least one match */
  frames: number
}
