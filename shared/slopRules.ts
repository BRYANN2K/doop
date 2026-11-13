/**
 * Anti-slop lint: deterministic checks over a frame's rendered document.
 *
 * The rules encode the checkable part of the Design Library's anti-slop
 * rulebook (the AS-* frames — see SLOP_RULES for the imported wording and
 * UNAUTOMATED_RULES for the ones that still need a human eye). They run the
 * same way in the frame's iframe (a `doop:slop-snapshot` request) and in the
 * server's headless browser: shared/slopCollect.ts turns a rendered document
 * into a SlopSnapshot, this file scores it.
 */

export type SlopSeverity = 'error' | 'warning'

export interface SlopIssue {
  /** the rule that fired, e.g. 'AS-COL-02' — AS-* ids match the rulebook */
  ruleId: string
  severity: SlopSeverity
  message: string
  /** the element's data-doop-id when it has one — clicking the issue picks it */
  elementId?: string
  /** css selector resolving the element inside the frame document */
  selector?: string
  /** the offending value, for the report ("contrast 2.1:1") */
  detail?: string
}

export interface FrameLint {
  /** 100 minus deductions, floored at 0 */
  score: number
  errors: number
  warnings: number
  issues: SlopIssue[]
  checkedAt: number
  /** bump when rule behaviour changes, so stale results are recognizable */
  version: number
  /** 'dom' when computed styles were available, 'static' when only the html was */
  engine: 'dom' | 'static'
  /** the element walk hit its cap — a very deep document may not be fully checked */
  truncated?: boolean
}

export const SLOP_RULES_VERSION = 1

/* ---- the snapshot the collector produces ---- */

export interface SlopRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SlopElement {
  selector: string
  /** data-doop-id, when the element carries one */
  elementId?: string
  /** selector of the parent element, for sibling grouping */
  parentSelector?: string
  tag: string
  role?: string
  /** own + descendant visible text, trimmed (capped by the collector) */
  text?: string
  /** length of the element's own text nodes only */
  ownTextLength: number
  rect: SlopRect
  color: string
  /** the background the text actually sits on (first opaque ancestor), rgb() */
  bg?: string
  /** a gradient or image in the background chain makes bg unreliable */
  bgUncertain: boolean
  font: string
  fontSizePx: number
  fontWeight: number
  fontStyle: string
  letterSpacingPx: number
  lineHeightPx: number
  textTransform: string
  radiusPx: number
  boxShadow: string
  textShadow: string
  backgroundImage: string
  /** computed background-clip ('text' marks gradient text) */
  backgroundClip: string
  /** top, right, bottom, left */
  borderWidthsPx: [number, number, number, number]
  borderStyle: string
  borderColors: string
  opacity: number
  outlineStyle: string
  outlineWidthPx: number
  backdropFilter: string
  filter: string
  transitionProperty: string
  transitionDurationMs: number
  transitionTiming: string
  animationName: string
  animationIteration: string
  /** button/link/input/…, role=button…, tabindex, onclick */
  interactive: boolean
  /** exposes a name (text, aria-label, title, img alt) */
  named: boolean
  /** rounded + bordered or shadowed — the shape the nested-card rule looks for */
  cardish: boolean
  /** an ancestor of this element is cardish */
  cardAncestor: boolean
  headingLevel?: number
  /** image elements: the load state and source for broken/placeholder checks */
  imgSrc?: string
  imgBroken?: boolean
}

export interface SlopSnapshot {
  width: number
  height: number
  elements: SlopElement[]
  /** body innerText, for the copy rules */
  allText: string
  /** inline <style> contents, for motion and reduced-motion checks */
  styleText: string
  truncated?: boolean
}

/* ---- rule metadata: the rulebook wording, imported from the AS-* frames ---- */

export interface SlopRuleMeta {
  id: string
  severity: SlopSeverity
  /** short title shown with issues */
  title: string
  /** the reference rule text, from the AS-* frame (the merged auditor checklist) */
  ref: string
}

export const SLOP_RULES: SlopRuleMeta[] = [
  {
    id: 'AS-A11Y-01',
    severity: 'error',
    title: 'Contrast on the real background',
    ref: 'fail if <4.5:1 body / <3:1 large+UI on the real background',
  },
  {
    id: 'AS-A11Y-02',
    severity: 'warning',
    title: 'Focus ring + themed browser surfaces',
    ref: 'fail if outline removed without :focus-visible',
  },
  {
    id: 'AS-A11Y-03',
    severity: 'warning',
    title: 'Target size + heading order',
    ref: 'fail if target <24px or heading levels skip',
  },
  {
    id: 'AS-A11Y-04',
    severity: 'error',
    title: 'Names for icon-only controls',
    ref: 'fail if icon-only control unnamed or decorative svg exposed',
  },
  {
    id: 'AS-COL-01',
    severity: 'error',
    title: 'No default purple gradient brand',
    ref: 'fail if stops in hue 245–300° or Tailwind indigo/violet/purple',
  },
  {
    id: 'AS-COL-02',
    severity: 'error',
    title: 'Solid text, no gradient text',
    ref: 'fail if background-clip:text gradient on body/UI',
  },
  {
    id: 'AS-COL-03',
    severity: 'error',
    title: 'No glow on dark',
    ref: 'fail if zero-offset colored shadow or colored blur shadow on dark',
  },
  {
    id: 'AS-COL-04',
    severity: 'warning',
    title: 'No halos, spotlights or aurora blobs',
    ref: 'fail if saturated radial-to-transparent or blurred orb behind content',
  },
  {
    id: 'AS-COPY-01',
    severity: 'error',
    title: 'Cut buzzwords',
    ref: 'fail if buzzword regex matches',
  },
  {
    id: 'AS-COPY-03',
    severity: 'warning',
    title: 'Verb + object on every action',
    ref: 'fail if primary CTA is Get started/Learn more/Submit or verb changes in flow',
  },
  {
    id: 'AS-COPY-05',
    severity: 'warning',
    title: 'No em dashes or formatting slop in UI copy',
    ref: 'fail if em dashes in short UI copy or ≥8 per page',
  },
  {
    id: 'AS-COPY-06',
    severity: 'error',
    title: 'No invented numbers or testimonials',
    ref: 'fail if unsourced “10K+ teams”, 99.9%, 5 stars, generic testimonial names',
  },
  {
    id: 'AS-COPY-07',
    severity: 'error',
    title: 'Realistic, varied sample content',
    ref: 'fail if lorem, John Doe, Acme, identical-length data',
  },
  {
    id: 'AS-IMG-01',
    severity: 'error',
    title: 'No emoji as icons',
    ref: 'fail if emoji/pictograph code points in buttons, links, headings, lists, CSS content',
  },
  {
    id: 'AS-IMG-04',
    severity: 'warning',
    title: 'Real artwork or none, no broken images',
    ref: 'fail if blobs/orbs/floating figures/shape-assembled scenes, empty src, placeholder hosts',
  },
  {
    id: 'AS-IMG-06',
    severity: 'error',
    title: "Don't invent logos, avatars or faces",
    ref: 'fail if Acme/Logoipsum/pravatar/gradient initials as proof',
  },
  {
    id: 'AS-LAY-02',
    severity: 'warning',
    title: 'No identical card grids',
    ref: 'fail if ≥3 same-size same-structure cards carry the block',
  },
  {
    id: 'AS-LAY-03',
    severity: 'error',
    title: 'Never nest cards',
    ref: 'fail if bordered/shadowed rounded box inside another',
  },
  {
    id: 'AS-LAY-08',
    severity: 'error',
    title: 'Inset content properly',
    ref: 'fail if text <8px from container edge or <16px from viewport edge',
  },
  {
    id: 'AS-MOT-02',
    severity: 'warning',
    title: 'Size durations by usage',
    ref: 'fail if control >400ms (P0 >500) or dropdown/modal open >300ms',
  },
  {
    id: 'AS-MOT-03',
    severity: 'error',
    title: 'Never ease-in on entrances',
    ref: 'fail if ease-in / slow-start bezier on appear',
  },
  {
    id: 'AS-MOT-09',
    severity: 'error',
    title: 'Animate exact properties, never transition: all',
    ref: 'fail if transition: all / animating width,height,top,left,box-shadow',
  },
  {
    id: 'AS-MOT-11',
    severity: 'warning',
    title: 'Reduced motion, gated hover, press feedback',
    ref: 'fail if no prefers-reduced-motion',
  },
  {
    id: 'AS-MOT-12',
    severity: 'warning',
    title: 'No decorative liveness',
    ref: 'fail if decorative pulse dot, fake caret, unpausable marquee, reflex bounce',
  },
  {
    id: 'AS-SURF-01',
    severity: 'warning',
    title: 'Border or shadow, not both',
    ref: 'fail if ≥3 cards have hairline border + ≥16px blur shadow',
  },
  {
    id: 'AS-SURF-02',
    severity: 'warning',
    title: 'Tier the elevation',
    ref: 'fail if identical shadow on >5 elements',
  },
  {
    id: 'AS-SURF-03',
    severity: 'warning',
    title: 'Radius by hierarchy, concentric',
    ref: 'fail if ≥24px on large containers, same radius everywhere, inner=outer, tall pills',
  },
  {
    id: 'AS-SURF-04',
    severity: 'warning',
    title: 'Glass only over moving content',
    ref: 'fail if glass on glass, >2 backdrop-filters',
  },
  {
    id: 'AS-SURF-05',
    severity: 'error',
    title: 'No colored side stripe on cards',
    ref: 'fail if border-left/right ≥2px accent on rounded card',
  },
  {
    id: 'AS-SURF-06',
    severity: 'warning',
    title: 'No costume hard-offset shadows',
    ref: 'fail if hard offset shadow outside a committed brutalist item',
  },
  {
    id: 'AS-SURF-07',
    severity: 'warning',
    title: 'Grids and noise only from the subject',
    ref: 'fail if repeating-gradient or hairline grid bg with no canvas/map meaning',
  },
  {
    id: 'AS-TYPE-01',
    severity: 'warning',
    title: 'Choose the display face on purpose',
    ref: 'fail if h1 is a default font with no rationale',
  },
  {
    id: 'AS-TYPE-02',
    severity: 'warning',
    title: 'Build hierarchy with real size steps',
    ref: 'fail if h1/h2/body ratios all <1.25',
  },
  {
    id: 'AS-TYPE-03',
    severity: 'error',
    title: 'Delete the eyebrow above headings',
    ref: 'fail if small uppercase tracked label or pill directly precedes h1–h3',
  },
  {
    id: 'AS-TYPE-04',
    severity: 'warning',
    title: 'One color and style per headline',
    ref: 'fail if one word is a different color/italic/gradient',
  },
  {
    id: 'AS-TYPE-05',
    severity: 'warning',
    title: 'No reflex italic-serif hero',
    ref: 'fail if h1 italic serif ≥48px outside editorial',
  },
  {
    id: 'AS-TYPE-06',
    severity: 'warning',
    title: 'Tracking and leading per size',
    ref: 'fail if tracking <−0.04em or body lh <1.3',
  },
  {
    id: 'AS-TYPE-07',
    severity: 'warning',
    title: 'Cap the measure, balance the wraps',
    ref: 'fail if lines >80ch',
  },
  {
    id: 'AS-TYPE-11',
    severity: 'error',
    title: 'Respect size floors',
    ref: 'fail if body <12px, UI text <11px',
  },
  {
    id: 'SLOP-FONTS',
    severity: 'warning',
    title: 'No more than two font families',
    ref: 'a frame that sets text in three or more families reads as unedited',
  },
  {
    id: 'SLOP-DATA-01',
    severity: 'warning',
    title: 'No charts as decoration',
    ref: 'fail if charts/rings/sparklines with no real data/axes (AS-DATA-01)',
  },
  {
    id: 'SLOP-COMP-03',
    severity: 'warning',
    title: 'Native elements and visible labels',
    ref: 'fail if div-buttons, placeholder-only inputs (AS-COMP-03)',
  },
]

/** The AS-* rules no deterministic check covers — kept so reports can say
 *  honestly what still needs eyes. (reason = why it is not automatable.) */
export const UNAUTOMATED_RULES: { id: string; title: string; reason: string }[] = [
  {
    id: 'AS-TYPE-09',
    title: 'Tabular numerals for changing numbers',
    reason: 'needs judgement of which numbers change',
  },
  {
    id: 'AS-COL-05',
    title: 'Give the palette roles, tint the neutrals',
    reason: 'palette intent is judgement, not measurement',
  },
  {
    id: 'AS-COL-07',
    title: "Don't swap one default for another",
    reason: 'detecting the next fashion is a moving target',
  },
  { id: 'AS-LAY-01', title: 'No stock page order', reason: 'section ordering is a structural judgement' },
  { id: 'AS-LAY-04', title: 'Give spacing a rhythm', reason: 'rhythm across a whole page defies per-element rules' },
  { id: 'AS-LAY-06', title: 'No hero-metric template', reason: 'needs the meaning of the numbers, not their styles' },
  { id: 'AS-LAY-07', title: 'Keep the hero headline short', reason: 'word counting cannot judge a headline' },
  {
    id: 'AS-COPY-02',
    title: 'Pass the portability test',
    reason: 'whether copy names the subject needs comprehension',
  },
  { id: 'AS-COPY-04', title: 'Remove AI cadence', reason: 'rhetorical patterns need reading, not regex' },
  {
    id: 'AS-COPY-09',
    title: 'Errors name the fix, empty states invite one action',
    reason: 'message helpfulness is judgement',
  },
  {
    id: 'AS-MOT-01',
    title: 'Name the purpose; never animate keyboard actions',
    reason: 'purpose is not visible in CSS',
  },
  {
    id: 'AS-MOT-04',
    title: 'Never scale from 0; grow from the trigger',
    reason: 'transform origins play out over time',
  },
  { id: 'AS-MOT-05', title: 'Close faster than you open', reason: 'open/close pairing needs interaction' },
  {
    id: 'AS-MOT-06',
    title: 'Keep travel and blur on the token scale',
    reason: 'animated values live in keyframes, not computed style',
  },
  { id: 'AS-MOT-07', title: 'Stagger 40ms, total under 300ms', reason: 'stagger is spread across elements and delays' },
  {
    id: 'AS-MOT-08',
    title: 'One authored moment, not fade-up everywhere',
    reason: 'same-reveal counting needs motion playback',
  },
  { id: 'AS-MOT-13', title: 'Keep content visible at rest', reason: 'rest state depends on scripts that may not run' },
  { id: 'AS-IMG-02', title: 'One icon family, one stroke', reason: 'stroke/family matching is visual comparison' },
  { id: 'AS-IMG-03', title: 'No icon tile above the heading', reason: 'needs the composition, not one element' },
  { id: 'AS-IMG-07', title: 'Keep backgrounds subordinate', reason: 'subordination is judged on the render' },
  { id: 'AS-COMP-01', title: 'Design every state', reason: 'states exist on interaction, not in the DOM' },
  { id: 'AS-COMP-02', title: 'Keep dimensions stable', reason: 'stability shows across state changes' },
  {
    id: 'AS-COMP-04',
    title: 'No decorative chips; modal only when earned',
    reason: 'earning a modal is product judgement',
  },
  {
    id: 'AS-COMP-06',
    title: "Don't ship the unmodified default kit",
    reason: 'a kit is recognized by eye, not by rules',
  },
  { id: 'AS-DATA-02', title: 'Rank the metrics', reason: 'metric ranking is a product decision' },
  {
    id: 'AS-DATA-03',
    title: 'Unit, period and comparison on every number',
    reason: 'context sufficiency needs reading',
  },
  { id: 'AS-DATA-04', title: 'Color encodes meaning, not decoration', reason: 'meaning is semantic, not stylistic' },
  {
    id: 'AS-DATA-05',
    title: 'Tables for records, not card mosaics',
    reason: 'records vs. mosaics is a structure call',
  },
  { id: 'AS-A11Y-05', title: 'Honor user preferences', reason: 'preference handling spans settings outside one frame' },
]

/* ------------------------------------------------------------------ */
/* helpers                                                             */

const MAX_ISSUES_PER_RULE = 3
const MAX_ISSUES = 40

interface Ctx {
  snap: SlopSnapshot
  issues: SlopIssue[]
  perRule: Map<string, number>
}

function add(ctx: Ctx, meta: SlopRuleMeta, el: SlopElement | undefined, message: string, detail?: string) {
  if (ctx.issues.length >= MAX_ISSUES) return
  const seen = ctx.perRule.get(meta.id) ?? 0
  if (seen >= MAX_ISSUES_PER_RULE) return
  ctx.perRule.set(meta.id, seen + 1)
  ctx.issues.push({
    ruleId: meta.id,
    severity: meta.severity,
    message,
    ...(el?.elementId ? { elementId: el.elementId } : {}),
    ...(el?.selector ? { selector: el.selector } : {}),
    ...(detail ? { detail } : {}),
  })
}

function meta(id: string): SlopRuleMeta {
  const m = SLOP_RULES.find((r) => r.id === id)
  if (!m) throw new Error(`unknown slop rule ${id}`)
  return m
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseColor(value: string | undefined): Rgba | null {
  if (!value) return null
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(value)
  if (!m) return null
  let a = m[4] === undefined ? 1 : parseFloat(m[4])
  if (m[4]?.endsWith('%')) a /= 100
  return { r: +(m[1] ?? 0), g: +(m[2] ?? 0), b: +(m[3] ?? 0), a }
}

/** WCAG relative luminance of an rgb() triple. */
export function luminance(c: Rgba): number {
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

/** WCAG contrast ratio between two rgb() colors. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 0–360 hue of an rgb() color; undefined for achromatic. */
function hueOf(c: Rgba): number | undefined {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 0.02) return undefined
  const d = max - min
  let h = 0
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return (((h * 60) % 360) + 360) % 360
}

/** 0–1 saturation of an rgb() color. */
function saturationOf(c: Rgba): number {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === 0) return 0
  return (max - min) / max
}

/** Colors a `*-gradient(...)` image paints with, as rgb strings. */
export function gradientStops(backgroundImage: string): string[] {
  const stops: string[] = []
  const re = /(?:rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8})/g
  let m: RegExpExecArray | null
  /* gradients only — the element's other images (url()) are skipped by the
     caller passing just the gradient portions */
  while ((m = re.exec(backgroundImage))) stops.push(m[0])
  return stops
}

function hexToRgba(hex: string): Rgba | null {
  const h = hex.replace('#', '')
  const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join('') : h
  if (full.length !== 6 && full.length !== 8) return null
  const n = parseInt(full, 16)
  if (!Number.isFinite(n)) return null
  return full.length === 8
    ? { r: (n >> 24) & 255, g: (n >> 16) & 255, b: (n >> 8) & 255, a: (n & 255) / 255 }
    : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
}

export function cssColorToRgba(value: string): Rgba | null {
  return parseColor(value) ?? hexToRgba(value)
}

/* box-shadow parsing: split layers, each `inset? x y blur spread color` */
interface ShadowLayer {
  x: number
  y: number
  blur: number
  spread: number
  color: Rgba | null
}

function parseShadows(shadow: string): ShadowLayer[] {
  if (!shadow || shadow === 'none') return []
  const layers: ShadowLayer[] = []
  /* split on commas not inside parens */
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of shadow) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  for (const part of parts) {
    const nums = part.match(/-?[\d.]+px/g)?.map((v) => parseFloat(v)) ?? []
    const color = cssColorToRgba(part)
    if (nums.length >= 2) {
      layers.push({ x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color })
    }
  }
  return layers
}

/* ---- copy patterns (checked on visible text and raw html) ---- */

const BUZZWORDS =
  /\b(seamless(?:ly)?|delve|dive (?:deep )?in|elevate|unlock|unleash|supercharge|revolutioni[sz]e|cutting[- ]edge|empower(?:ing)?|leverage|game[- ]chang\w+|next[- ]generation|world[- ]class|reimagine|harness|streamline\w*|robust|scalable solution|best[- ]in[- ]class|transformative|innovative solution|effortless(?:ly)?|turbocharge)\b/i

const FAKE_PROOF =
  /\b(?:\d+[,.]?\d*\s*[kKmMbB]\+?\s+(?:users|teams|companies|developers|customers)|99\.9\s*%|\d+(?:\.\d+)?\s*(?:\/\s*5|stars?)\b|rated\s+\d)/i

const PLACEHOLDER_TEXT =
  /lorem\s+ipsum|dolor\s+sit\s+amet|john\s+doe|jane\s+doe|john\s+smith|jane\s+smith|\bfoo\b.*\bbar\b|acme\s+(?:corp|inc|co\b)|your (?:logo|brand|company) here/i

const GENERIC_CTA = /^(get started|learn more|submit|click here|sign up|try now|try it free|book a demo|contact us)$/i

const PLACEHOLDER_HOSTS =
  /placehold\.(?:co|it)|via\.placeholder\.com|dummyimage\.com|picsum\.photos|pravatar\.cc|ui-avatars\.com|logoipsum|loremflickr|lorem ipsum|source\.unsplash\.com/i

/* emoji used as a standalone glyph: element text is nothing but emoji/VS16/ZWJ */
const EMOJI_ONLY =
  /^(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{E0020}-\u{E007F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2B50}\u{203C}\u{2049}\u{00A9}\u{00AE}]|\s|\u{FE0F}|\u{200D}|\u{20E3})+$/u

const LARGE_TEXT_PX = 24
const LARGE_TEXT_BOLD_PX = 18.66

function isLargeText(el: SlopElement): boolean {
  return el.fontSizePx >= LARGE_TEXT_PX || (el.fontSizePx >= LARGE_TEXT_BOLD_PX && el.fontWeight >= 700)
}

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary'])

/* ------------------------------------------------------------------ */
/* rules                                                               */

function checkContrast(ctx: Ctx) {
  const m = meta('AS-A11Y-01')
  for (const el of ctx.snap.elements) {
    if (el.ownTextLength === 0 || el.bgUncertain) continue
    const fg = parseColor(el.color)
    const bg = parseColor(el.bg)
    if (!fg || !bg) continue
    /* translucent text gets a pass — the effective color is unknowable here */
    if (fg.a < 1 || bg.a < 1) continue
    const ratio = contrastRatio(fg, bg)
    const floor = isLargeText(el) ? 3 : 4.5
    if (ratio < floor) {
      add(ctx, m, el, `${el.tag} text has ${ratio.toFixed(1)}:1 contrast (needs ${floor}:1)`, `${el.color} on ${el.bg}`)
    }
  }
}

function checkFocus(ctx: Ctx) {
  const m = meta('AS-A11Y-02')
  if (/:focus-visible/.test(ctx.snap.styleText)) return
  for (const el of ctx.snap.elements) {
    if (!el.interactive || INTERACTIVE_TAGS.has(el.tag)) continue
    if (el.outlineStyle === 'none' || (el.outlineWidthPx === 0 && el.outlineStyle !== 'auto')) {
      add(ctx, m, el, `${el.tag} removes its outline with no :focus-visible fallback`)
    }
  }
}

function checkTargetsAndHeadings(ctx: Ctx) {
  const m = meta('AS-A11Y-03')
  for (const el of ctx.snap.elements) {
    if (!el.interactive || el.ownTextLength === 0) continue
    if (el.rect.w > 0 && el.rect.h > 0 && (el.rect.w < 24 || el.rect.h < 24)) {
      add(ctx, m, el, `${el.tag} target is ${Math.round(el.rect.w)}×${Math.round(el.rect.h)}px (<24px)`)
    }
  }
  let lastLevel = 0
  for (const el of ctx.snap.elements) {
    if (!el.headingLevel) continue
    if (lastLevel && el.headingLevel > lastLevel + 1) {
      add(ctx, m, el, `heading level skips h${lastLevel} → h${el.headingLevel}`)
      break
    }
    lastLevel = el.headingLevel
  }
}

function checkIconNames(ctx: Ctx) {
  const m = meta('AS-A11Y-04')
  for (const el of ctx.snap.elements) {
    if (!el.interactive || el.named) continue
    add(ctx, m, el, `${el.tag} is interactive but exposes no name`)
  }
}

function checkPurpleGradient(ctx: Ctx) {
  const m = meta('AS-COL-01')
  for (const el of ctx.snap.elements) {
    const img = el.backgroundImage
    if (!img || !img.includes('gradient')) continue
    for (const stop of gradientStops(img)) {
      const c = cssColorToRgba(stop)
      if (!c) continue
      const hue = hueOf(c)
      if (hue !== undefined && hue >= 240 && hue <= 305 && saturationOf(c) > 0.15) {
        add(ctx, m, el, `${el.tag} uses the default purple/indigo gradient`, stop)
        break
      }
    }
  }
}

function checkGradientText(ctx: Ctx) {
  const m = meta('AS-COL-02')
  for (const el of ctx.snap.elements) {
    if (el.backgroundClip === 'text' && el.backgroundImage.includes('gradient')) {
      add(ctx, m, el, `${el.tag} renders text as a gradient`)
    }
  }
}

function checkGlow(ctx: Ctx) {
  const m = meta('AS-COL-03')
  for (const el of ctx.snap.elements) {
    for (const s of parseShadows(el.boxShadow)) {
      if (s.blur < 10 || !s.color) continue
      if (saturationOf(s.color) >= 0.2 && s.color.a >= 0.15) {
        add(ctx, m, el, `${el.tag} glows with a colored ${Math.round(s.blur)}px blur shadow`, el.boxShadow)
        break
      }
    }
  }
}

function checkHalo(ctx: Ctx) {
  const m = meta('AS-COL-04')
  for (const el of ctx.snap.elements) {
    if (/radial-gradient|conic-gradient/.test(el.backgroundImage)) {
      /* a saturated radial glow that fades to transparent behind content */
      const stops = gradientStops(el.backgroundImage).map(cssColorToRgba)
      const saturated = stops.some((c) => c && saturationOf(c) > 0.3)
      const fades = /transparent|rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(el.backgroundImage)
      if (saturated && fades) {
        add(ctx, m, el, `${el.tag} paints a halo/aurora blob`, undefined)
        continue
      }
    }
    const blur = /blur\(\s*([\d.]+)px\s*\)/.exec(el.filter)
    const blurPx = blur?.[1] ? parseFloat(blur[1]) : 0
    if (blur && blurPx >= 30) {
      add(ctx, m, el, `${el.tag} is a ${blur[1]}px blurred shape`)
    }
  }
}

function checkBuzzwords(ctx: Ctx) {
  const m = meta('AS-COPY-01')
  const hit = BUZZWORDS.exec(ctx.snap.allText)
  if (hit) add(ctx, m, undefined, `buzzword “${hit[0]}” in copy`, hit[0])
}

function checkGenericCta(ctx: Ctx) {
  const m = meta('AS-COPY-03')
  for (const el of ctx.snap.elements) {
    if (!el.interactive || !el.text) continue
    const label = el.text.replace(/\s+/g, ' ').trim()
    if (label.length <= 24 && GENERIC_CTA.test(label)) {
      add(ctx, m, el, `generic CTA “${label}”`)
    }
  }
}

function checkEmDash(ctx: Ctx) {
  const m = meta('AS-COPY-05')
  const dashes = (ctx.snap.allText.match(/—/g) ?? []).length
  for (const el of ctx.snap.elements) {
    if (!el.text) continue
    if (el.text.length < 80 && el.text.includes('—')) {
      add(ctx, m, el, `em dash in short UI copy: “${el.text.trim().slice(0, 50)}”`)
    }
  }
  if (dashes >= 8) add(ctx, m, undefined, `${dashes} em dashes across the page`)
}

function checkFakeProof(ctx: Ctx) {
  const m = meta('AS-COPY-06')
  const hit = FAKE_PROOF.exec(ctx.snap.allText)
  if (hit) add(ctx, m, undefined, `unsourced proof “${hit[0]}”`, hit[0])
}

function checkPlaceholderText(ctx: Ctx) {
  const m = meta('AS-COPY-07')
  const hit = PLACEHOLDER_TEXT.exec(ctx.snap.allText)
  if (hit) add(ctx, m, undefined, `placeholder copy “${hit[0]}”`, hit[0])
}

function checkEmoji(ctx: Ctx) {
  const m = meta('AS-IMG-01')
  for (const el of ctx.snap.elements) {
    const text = el.text?.trim()
    if (!text || text.length > 12) continue
    /* an element that is only emoji glyphs reads as an icon stand-in */
    if (/\p{Extended_Pictographic}/u.test(text) && EMOJI_ONLY.test(text)) {
      add(ctx, m, el, `emoji used as an icon: “${text}”`)
    }
  }
}

function checkBrokenImages(ctx: Ctx) {
  const m = meta('AS-IMG-04')
  for (const el of ctx.snap.elements) {
    if (el.tag !== 'img') continue
    if (el.imgBroken) add(ctx, m, el, 'image fails to load')
    else if (!el.imgSrc) add(ctx, m, el, 'image has no src')
  }
}

function checkInventedLogos(ctx: Ctx) {
  const m = meta('AS-IMG-06')
  for (const el of ctx.snap.elements) {
    const src = el.imgSrc || ''
    if (src && PLACEHOLDER_HOSTS.test(src)) {
      add(ctx, m, el, `placeholder image source: ${src.slice(0, 80)}`)
      continue
    }
    if (el.backgroundImage.includes('url(') && PLACEHOLDER_HOSTS.test(el.backgroundImage)) {
      add(ctx, m, el, 'placeholder image in background')
    }
  }
}

function checkNestedCards(ctx: Ctx) {
  const m = meta('AS-LAY-03')
  for (const el of ctx.snap.elements) {
    if (el.cardish && el.cardAncestor) add(ctx, m, el, `${el.tag} card sits inside another card`)
  }
}

function checkCardGrid(ctx: Ctx) {
  const m = meta('AS-LAY-02')
  const groups = new Map<string, SlopElement[]>()
  for (const el of ctx.snap.elements) {
    if (!el.cardish || !el.parentSelector || el.rect.w < 60 || el.rect.h < 40) continue
    const key = `${el.parentSelector}|${el.tag}|${Math.round(el.rect.w)}x${Math.round(el.rect.h)}`
    const list = groups.get(key) ?? []
    list.push(el)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    if (list.length >= 3) {
      add(ctx, m, list[0], `${list.length} identical cards in one row`)
    }
  }
}

function checkInsets(ctx: Ctx) {
  const m = meta('AS-LAY-08')
  const { width, height } = ctx.snap
  for (const el of ctx.snap.elements) {
    if (el.ownTextLength === 0) continue
    const r = el.rect
    if (r.w <= 0 || r.h <= 0) continue
    /* text that bleeds right to the frame's edge has no inset */
    if (r.x < 16 || r.x + r.w > width - 16 || r.y < 16 || r.y + r.h > height - 16) {
      add(ctx, m, el, `${el.tag} text sits within 16px of the frame edge`)
    }
  }
}

function checkDurations(ctx: Ctx) {
  const m = meta('AS-MOT-02')
  for (const el of ctx.snap.elements) {
    if (el.transitionDurationMs > 500) {
      add(ctx, m, el, `${el.tag} transitions over ${el.transitionDurationMs}ms`)
    }
  }
}

function checkEaseIn(ctx: Ctx) {
  const m = meta('AS-MOT-03')
  for (const el of ctx.snap.elements) {
    if (/ease-in\b|cubic-bezier\(\s*0\.\d+\s*,\s*0\s*,/.test(el.transitionTiming) && el.transitionDurationMs > 0) {
      add(ctx, m, el, `${el.tag} eases in on entrance`)
    }
  }
}

const LAYOUT_PROPS = new Set(['width', 'height', 'top', 'left', 'right', 'bottom', 'box-shadow', 'margin', 'padding'])

function checkTransitionAll(ctx: Ctx) {
  const m = meta('AS-MOT-09')
  for (const el of ctx.snap.elements) {
    const props = el.transitionProperty
    if (!props || props === 'none' || el.transitionDurationMs <= 0) continue
    if (props === 'all') {
      add(ctx, m, el, `${el.tag} uses transition: all`)
      continue
    }
    const bad = props
      .split(',')
      .map((p) => p.trim())
      .filter((p) => LAYOUT_PROPS.has(p))
    if (bad.length) add(ctx, m, el, `${el.tag} animates layout: ${bad.join(', ')}`)
  }
  if (/transition[^;}]*\ball\b/.test(ctx.snap.styleText)) {
    add(ctx, m, undefined, 'stylesheet contains transition: all')
  }
}

function checkReducedMotion(ctx: Ctx) {
  const m = meta('AS-MOT-11')
  const hasMotion =
    /@keyframes|animation|transition/.test(ctx.snap.styleText) ||
    ctx.snap.elements.some((el) => el.transitionDurationMs > 0 || el.animationName !== 'none')
  if (hasMotion && !/prefers-reduced-motion/.test(ctx.snap.styleText)) {
    add(ctx, m, undefined, 'motion has no prefers-reduced-motion fallback')
  }
}

function checkLiveness(ctx: Ctx) {
  const m = meta('AS-MOT-12')
  for (const el of ctx.snap.elements) {
    if (el.animationName !== 'none' && /infinite/.test(el.animationIteration)) {
      add(ctx, m, el, `${el.tag} runs an infinite ${el.animationName} animation`)
    }
  }
}

function checkBorderAndShadow(ctx: Ctx) {
  const m = meta('AS-SURF-01')
  for (const el of ctx.snap.elements) {
    const bordered = el.borderWidthsPx.some((w, i) => w >= 0.5 && el.borderStyle.split(/\s+/)[i % 4] !== 'none')
    const blurry = parseShadows(el.boxShadow).some((s) => s.blur >= 16)
    if (bordered && blurry) add(ctx, m, el, `${el.tag} has both a border and a blur shadow`)
  }
}

function checkSameShadow(ctx: Ctx) {
  const m = meta('AS-SURF-02')
  const counts = new Map<string, SlopElement[]>()
  for (const el of ctx.snap.elements) {
    if (el.boxShadow === 'none') continue
    const list = counts.get(el.boxShadow) ?? []
    list.push(el)
    counts.set(el.boxShadow, list)
  }
  for (const [shadow, list] of counts) {
    if (list.length > 5) add(ctx, m, list[0], `${list.length} elements share one shadow`, shadow.slice(0, 60))
  }
}

function checkRadii(ctx: Ctx) {
  const m = meta('AS-SURF-03')
  const radii = new Map<number, SlopElement>()
  for (const el of ctx.snap.elements) {
    if (el.radiusPx <= 0) continue
    radii.set(el.radiusPx, radii.get(el.radiusPx) ?? el)
    /* a big container carrying a big radius reads as blobby */
    if (el.radiusPx >= 24 && Math.max(el.rect.w, el.rect.h) >= 240) {
      add(
        ctx,
        m,
        el,
        `${el.tag} uses a ${Math.round(el.radiusPx)}px radius on a ${Math.round(Math.max(el.rect.w, el.rect.h))}px container`,
      )
    }
    /* a pill is for chips, not for tall surfaces */
    if (el.rect.h >= 64 && el.radiusPx >= Math.min(el.rect.w, el.rect.h) / 2 - 1) {
      add(ctx, m, el, `${el.tag} is a ${Math.round(el.rect.h)}px-tall pill`)
    }
  }
  if (radii.size > 4) {
    const first = [...radii.values()][0]
    add(
      ctx,
      m,
      first,
      `${radii.size} different radii — no consistent scale`,
      [...radii.keys()].sort((a, b) => a - b).join('px, ') + 'px',
    )
  }
}

function checkGlass(ctx: Ctx) {
  const m = meta('AS-SURF-04')
  const glassy = ctx.snap.elements.filter((el) => /blur/.test(el.backdropFilter))
  if (glassy.length > 2) {
    add(ctx, m, glassy[2], `${glassy.length} elements use backdrop blur`)
  }
}

function checkSideStripe(ctx: Ctx) {
  const m = meta('AS-SURF-05')
  for (const el of ctx.snap.elements) {
    if (el.radiusPx < 4) continue
    const [top, right, bottom, left] = el.borderWidthsPx
    if (Math.max(top, bottom) >= Math.max(right, left)) continue
    const stripeW = Math.max(right, left)
    if (stripeW < 2) continue
    const color = cssColorToRgba(el.borderColors)
    if (color && saturationOf(color) > 0.2) {
      add(ctx, m, el, `${el.tag} has a colored ${Math.round(stripeW)}px side stripe`, el.borderColors)
    }
  }
}

function checkCostumeShadow(ctx: Ctx) {
  const m = meta('AS-SURF-06')
  for (const el of ctx.snap.elements) {
    for (const s of parseShadows(el.boxShadow)) {
      if (s.blur <= 1 && s.spread >= 0 && Math.max(Math.abs(s.x), Math.abs(s.y)) >= 4) {
        add(ctx, m, el, `${el.tag} has a hard offset shadow`, el.boxShadow)
        break
      }
    }
  }
}

function checkGridBg(ctx: Ctx) {
  const m = meta('AS-SURF-07')
  for (const el of ctx.snap.elements) {
    if (/repeating-(?:linear|conic)-gradient/.test(el.backgroundImage)) {
      add(ctx, m, el, `${el.tag} has a repeating-gradient grid/stripe background`)
    }
  }
  if (/repeating-(?:linear|conic)-gradient/.test(ctx.snap.styleText)) {
    add(ctx, m, undefined, 'stylesheet paints a repeating-gradient grid')
  }
}

const DEFAULT_FONTS =
  /\b(inter|roboto|arial|helvetica|helvetica neue|system-ui|-apple-system|segoe ui|geist|space grotesk|plus jakarta sans|fraunces|open sans|lato|montserrat|sans-serif|sans)\b/i

/* keyword faces a family list carries as fallbacks — they say nothing about
   how many faces the design actually chose */
const GENERIC_FACES =
  /^(sans-serif|serif|monospace|system-ui|ui-(?:sans|serif|mono|monospace|rounded)|sans|cursive|fantasy|-apple-system|blinkmacsystemfont|segoe ui|emoji|math|fangsong)$/

function checkDefaultFont(ctx: Ctx) {
  const m = meta('AS-TYPE-01')
  for (const el of ctx.snap.elements) {
    if (!el.headingLevel || el.headingLevel > 2) continue
    const family = (el.font.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '')
    if (DEFAULT_FONTS.test(family)) {
      add(ctx, m, el, `h${el.headingLevel} sits in the default face “${family}”`)
      break
    }
  }
}

function checkSizeSteps(ctx: Ctx) {
  const m = meta('AS-TYPE-02')
  const sizeOf = (level: number) =>
    Math.max(0, ...ctx.snap.elements.filter((el) => el.headingLevel === level).map((el) => el.fontSizePx))
  const h1 = sizeOf(1)
  const h2 = sizeOf(2)
  const body = Math.max(
    0,
    ...ctx.snap.elements.filter((el) => el.tag === 'p' && el.ownTextLength > 20).map((el) => el.fontSizePx),
  )
  if (h1 && h2 && body && h1 / h2 < 1.25 && h2 / body < 1.25) {
    add(ctx, m, undefined, `type steps too flat: h1 ${h1}px / h2 ${h2}px / body ${body}px`)
  }
}

function checkEyebrow(ctx: Ctx) {
  const m = meta('AS-TYPE-03')
  const headings = ctx.snap.elements.filter((el) => el.headingLevel !== undefined && el.headingLevel <= 3)
  for (const el of ctx.snap.elements) {
    if (!el.text || el.text.length > 60 || el.fontSizePx > 13) continue
    if (el.textTransform !== 'uppercase' || el.letterSpacingPx < el.fontSizePx * 0.05) continue
    const head = headings.find(
      (h) => h.rect.y >= el.rect.y - 4 && h.rect.y - (el.rect.y + el.rect.h) <= 80 && h.rect.x < el.rect.x + el.rect.w,
    )
    if (head) add(ctx, m, el, `eyebrow “${el.text.trim()}” above h${head.headingLevel}`)
  }
}

function checkMixedHeadline(ctx: Ctx) {
  const m = meta('AS-TYPE-04')
  /* a heading whose children set a different color or an italic slant on a
     word: the collector flags it with a different descendant style */
  for (const el of ctx.snap.elements) {
    if (!el.headingLevel) continue
    const parent = el
    const kid = ctx.snap.elements.find(
      (e) => e.parentSelector === parent.selector && (e.color !== parent.color || e.fontStyle !== parent.fontStyle),
    )
    if (kid && kid.ownTextLength > 0) {
      add(ctx, m, kid, `one word styled differently inside h${el.headingLevel}`)
      break
    }
  }
}

function checkItalicSerif(ctx: Ctx) {
  const m = meta('AS-TYPE-05')
  for (const el of ctx.snap.elements) {
    if (el.headingLevel !== 1 || el.fontSizePx < 48) continue
    if (el.fontStyle === 'italic' && /serif/i.test(el.font) && !/sans/i.test(el.font.split(',')[0] ?? '')) {
      add(ctx, m, el, `h1 in reflex italic serif (${Math.round(el.fontSizePx)}px)`)
      break
    }
  }
}

function checkTrackingLeading(ctx: Ctx) {
  const m = meta('AS-TYPE-06')
  for (const el of ctx.snap.elements) {
    if (el.ownTextLength === 0) continue
    if (el.fontSizePx > 0 && el.letterSpacingPx / el.fontSizePx < -0.04) {
      add(ctx, m, el, `${el.tag} tracking is ${(el.letterSpacingPx / el.fontSizePx).toFixed(2)}em`)
      continue
    }
    if (el.ownTextLength > 20 && el.lineHeightPx > 0 && el.lineHeightPx / el.fontSizePx < 1.3) {
      add(ctx, m, el, `${el.tag} body line-height is ${(el.lineHeightPx / el.fontSizePx).toFixed(2)} (<1.3)`)
    }
  }
}

function checkMeasure(ctx: Ctx) {
  const m = meta('AS-TYPE-07')
  for (const el of ctx.snap.elements) {
    if (el.ownTextLength < 40 || el.fontSizePx <= 0) continue
    /* average glyph ~0.5em: chars per line estimate */
    const charsPerLine = el.rect.w / (el.fontSizePx * 0.5)
    if (charsPerLine > 80) {
      add(ctx, m, el, `${el.tag} text runs ~${Math.round(charsPerLine)}ch per line`)
    }
  }
}

function checkSizeFloors(ctx: Ctx) {
  const m = meta('AS-TYPE-11')
  for (const el of ctx.snap.elements) {
    if (el.ownTextLength === 0) continue
    if (el.fontSizePx < 11) {
      add(ctx, m, el, `${el.tag} text is ${el.fontSizePx}px (<11px floor)`)
    } else if (el.fontSizePx < 12 && el.ownTextLength > 20) {
      add(ctx, m, el, `${el.tag} body text is ${el.fontSizePx}px (<12px floor)`)
    }
  }
}

function checkFontFamilies(ctx: Ctx) {
  const m = meta('SLOP-FONTS')
  const families = new Map<string, SlopElement>()
  for (const el of ctx.snap.elements) {
    if (el.ownTextLength === 0) continue
    const first = (el.font.split(',')[0] ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase()
    if (!families.has(first)) families.set(first, el)
  }
  /* generic keywords are fallbacks, not a chosen face — only named ones count */
  const named = [...families.keys()].filter((f) => f !== '' && !GENERIC_FACES.test(f))
  if (named.length > 2) {
    add(ctx, m, [...families.values()][0], `${named.length} font families on one frame: ${named.join(', ')}`)
  }
}

function checkDecorativeChart(ctx: Ctx) {
  const m = meta('SLOP-DATA-01')
  for (const el of ctx.snap.elements) {
    if (el.tag !== 'svg') continue
    /* a chart-shaped svg with no text inside is decoration pretending to be data */
    if (el.ownTextLength === 0 && el.rect.w > 60 && el.rect.h > 40) {
      add(ctx, m, el, 'svg chart carries no labels or numbers')
    }
  }
}

function checkDivButton(ctx: Ctx) {
  const m = meta('SLOP-COMP-03')
  for (const el of ctx.snap.elements) {
    if (!el.interactive || INTERACTIVE_TAGS.has(el.tag) || el.role) continue
    add(ctx, m, el, `${el.tag} acts as a control but is not a button/link`)
  }
}

/* the rules, run in report order */
const CHECKS: { id: string; run: (ctx: Ctx) => void }[] = [
  { id: 'AS-A11Y-01', run: checkContrast },
  { id: 'AS-A11Y-02', run: checkFocus },
  { id: 'AS-A11Y-03', run: checkTargetsAndHeadings },
  { id: 'AS-A11Y-04', run: checkIconNames },
  { id: 'AS-COL-01', run: checkPurpleGradient },
  { id: 'AS-COL-02', run: checkGradientText },
  { id: 'AS-COL-03', run: checkGlow },
  { id: 'AS-COL-04', run: checkHalo },
  { id: 'AS-COPY-01', run: checkBuzzwords },
  { id: 'AS-COPY-03', run: checkGenericCta },
  { id: 'AS-COPY-05', run: checkEmDash },
  { id: 'AS-COPY-06', run: checkFakeProof },
  { id: 'AS-COPY-07', run: checkPlaceholderText },
  { id: 'AS-IMG-01', run: checkEmoji },
  { id: 'AS-IMG-04', run: checkBrokenImages },
  { id: 'AS-IMG-06', run: checkInventedLogos },
  { id: 'AS-LAY-02', run: checkCardGrid },
  { id: 'AS-LAY-03', run: checkNestedCards },
  { id: 'AS-LAY-08', run: checkInsets },
  { id: 'AS-MOT-02', run: checkDurations },
  { id: 'AS-MOT-03', run: checkEaseIn },
  { id: 'AS-MOT-09', run: checkTransitionAll },
  { id: 'AS-MOT-11', run: checkReducedMotion },
  { id: 'AS-MOT-12', run: checkLiveness },
  { id: 'AS-SURF-01', run: checkBorderAndShadow },
  { id: 'AS-SURF-02', run: checkSameShadow },
  { id: 'AS-SURF-03', run: checkRadii },
  { id: 'AS-SURF-04', run: checkGlass },
  { id: 'AS-SURF-05', run: checkSideStripe },
  { id: 'AS-SURF-06', run: checkCostumeShadow },
  { id: 'AS-SURF-07', run: checkGridBg },
  { id: 'AS-TYPE-01', run: checkDefaultFont },
  { id: 'AS-TYPE-02', run: checkSizeSteps },
  { id: 'AS-TYPE-03', run: checkEyebrow },
  { id: 'AS-TYPE-04', run: checkMixedHeadline },
  { id: 'AS-TYPE-05', run: checkItalicSerif },
  { id: 'AS-TYPE-06', run: checkTrackingLeading },
  { id: 'AS-TYPE-07', run: checkMeasure },
  { id: 'AS-TYPE-11', run: checkSizeFloors },
  { id: 'SLOP-FONTS', run: checkFontFamilies },
  { id: 'SLOP-DATA-01', run: checkDecorativeChart },
  { id: 'SLOP-COMP-03', run: checkDivButton },
]

function finish(snap: SlopSnapshot, issues: SlopIssue[], engine: FrameLint['engine'], checkedAt: number): FrameLint {
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  return {
    score: Math.max(0, 100 - errors * 15 - warnings * 4),
    errors,
    warnings,
    issues,
    checkedAt,
    version: SLOP_RULES_VERSION,
    engine,
    ...(snap.truncated ? { truncated: true } : {}),
  }
}

/** Score a rendered-document snapshot (iframe or headless browser produced it). */
export function lintSnapshot(snap: SlopSnapshot, checkedAt = Date.now()): FrameLint {
  const ctx: Ctx = { snap, issues: [], perRule: new Map() }
  for (const check of CHECKS) check.run(ctx)
  return finish(snap, ctx.issues, 'dom', checkedAt)
}

/** What the linter can say about an HTML string without a browser: the copy
 *  and stylesheet rules still apply; DOM rules stay silent. Server-side
 *  fallback when no renderer is available, and the cheap test path. */
export function lintStaticHtml(html: string, checkedAt = Date.now()): FrameLint {
  const snap = staticSnapshot(html)
  const ctx: Ctx = { snap, issues: [], perRule: new Map() }
  for (const id of ['AS-COPY-01', 'AS-COPY-05', 'AS-COPY-06', 'AS-COPY-07', 'AS-MOT-09', 'AS-MOT-11', 'AS-SURF-07']) {
    CHECKS.find((c) => c.id === id)!.run(ctx)
  }
  return finish(snap, ctx.issues, 'static', checkedAt)
}

/** The snapshot shape a bare HTML string implies: no elements, but the text
 *  a reader would see and the CSS a stylesheet would hold. */
export function staticSnapshot(html: string): SlopSnapshot {
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  const inlineStyles = [...html.matchAll(/style="([^"]*)"/gi)].map((m) => m[1])
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    width: 0,
    height: 0,
    elements: [],
    allText: text.slice(0, 100_000),
    styleText: styleBlocks.concat(inlineStyles).join('\n').slice(0, 200_000),
  }
}

/* a small helper for callers reporting a lint result in prose */
export function lintSummary(lint: FrameLint): string {
  if (lint.issues.length === 0) return `lint clean (score ${lint.score})`
  const parts = [`lint score ${lint.score}: ${lint.errors} error(s), ${lint.warnings} warning(s)`]
  return parts.join('')
}
