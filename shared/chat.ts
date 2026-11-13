/** Canvas chat: the thread where humans talk the next design over with the
 *  resident agent before anything touches the canvas. A design ask returns a
 *  plan card; the canvas changes only when an editor presses Go design. */
import type { ChatMessage, ChatPlan, ChatPlanReference, ChatPlanScreen } from './types.ts'

/** A message over this is truncated on send, like a board card's brief. */
export const MAX_CHAT_TEXT_CHARS = 4000
/** One plan never queues more cards than this. */
export const MAX_CHAT_PLAN_SCREENS = 12
/** Library references one screen may name — the plan card stays a card. */
export const MAX_CHAT_PLAN_REFERENCES = 8
/** How much of the log a run reads back for context. */
export const CHAT_HISTORY_LINES = 60
/** In-memory and hydrated log length per canvas, same rule as comments. */
export const CHAT_LOG_CAP = 200

/** The thread a message belongs to: its own id when it starts one. */
export function chatThreadId(m: ChatMessage): string {
  return m.threadId ?? m.id
}

/** Plans a human may act on. A launched, canceled or superseded plan is read-only. */
export const OPEN_PLAN_STATUSES = ['proposed', 'approved'] as const

export function isOpenPlan(plan: ChatPlan | undefined): plan is ChatPlan & { status: 'proposed' | 'approved' } {
  return !!plan && (OPEN_PLAN_STATUSES as readonly string[]).includes(plan.status)
}

const NAME_CHARS = 120
const OUTLINE_CHARS = 2000
const REUSE_ITEM_CHARS = 300
const REF_LABEL_CHARS = 120
const REF_WHY_CHARS = 300
const ID_CHARS = 60
const QUESTION_CHARS = 500

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  return clean ? clean.slice(0, max) : undefined
}

function cleanReference(value: unknown): ChatPlanReference | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const canvasId = cleanText(raw.canvas_id ?? raw.canvasId, ID_CHARS)
  const frameId = cleanText(raw.frame_id ?? raw.frameId, ID_CHARS)
  const label = cleanText(raw.label, REF_LABEL_CHARS)
  const why = cleanText(raw.why, REF_WHY_CHARS)
  if (!canvasId || !frameId || !label || !why) return undefined
  const libraryId = cleanText(raw.library_id ?? raw.libraryId, ID_CHARS) ?? `${canvasId}:${frameId}`
  return { libraryId, canvasId, frameId, label, why }
}

/** A references list from the wire (a screen's, or a queued card's): the
 *  valid entries only, capped. Unknown shapes clean to an empty list —
 *  membership in the asker's library is checked by the caller, not here. */
export function cleanPlanReferences(value: unknown): ChatPlanReference[] {
  return (Array.isArray(value) ? value : [])
    .map(cleanReference)
    .filter((ref): ref is ChatPlanReference => !!ref)
    .slice(0, MAX_CHAT_PLAN_REFERENCES)
}

function cleanScreen(value: unknown): ChatPlanScreen | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const name = cleanText(raw.name, NAME_CHARS)
  const outline = cleanText(raw.outline, OUTLINE_CHARS)
  const width = Number(raw.width)
  const height = Number(raw.height)
  if (!name || !outline || !Number.isFinite(width) || !Number.isFinite(height)) return undefined
  const reuse = (Array.isArray(raw.reuse) ? raw.reuse : [])
    .map((item) => cleanText(item, REUSE_ITEM_CHARS))
    .filter((item): item is string => !!item)
    .slice(0, 12)
  const references = cleanPlanReferences(raw.references)
  return {
    name,
    outline,
    width: Math.max(64, Math.min(Math.round(width), 8192)),
    height: Math.max(64, Math.min(Math.round(height), 8192)),
    ...(reuse.length ? { reuse } : {}),
    ...(references.length ? { references } : {}),
  }
}

/** The plan a propose_plan call or an edit hands over, cleaned and bounded —
 *  or undefined when the shape is not a plan at all. `status` comes from the
 *  caller, never from the input: only the server moves a plan along. */
export function cleanChatPlan(value: unknown): Pick<ChatPlan, 'summary' | 'screens' | 'openQuestions'> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const summary = cleanText(raw.summary, OUTLINE_CHARS)
  const screens = (Array.isArray(raw.screens) ? raw.screens : [])
    .map(cleanScreen)
    .filter((s): s is ChatPlanScreen => !!s)
    .slice(0, MAX_CHAT_PLAN_SCREENS)
  if (!summary || screens.length === 0) return undefined
  const openQuestions = (
    Array.isArray(raw.open_questions ?? raw.openQuestions)
      ? ((raw.open_questions ?? raw.openQuestions) as unknown[])
      : []
  )
    .map((q) => cleanText(q, QUESTION_CHARS))
    .filter((q): q is string => !!q)
    .slice(0, 8)
  return { summary, screens, ...(openQuestions.length ? { openQuestions } : {}) }
}

/** What a queued board card's brief looks like for one planned screen. */
export function chatPlanCardTitle(plan: ChatPlan, screen: ChatPlanScreen): string {
  const reuse = screen.reuse?.length ? `\n\nReuse from the project: ${screen.reuse.join(', ')}.` : ''
  const refs = (screen.references ?? [])
    .map((r) => `- "${r.label}" — canvas_id=${r.canvasId}, frame_id=${r.frameId}. Why: ${r.why}`)
    .join('\n')
  const refBlock = refs
    ? `\n\nApproved library references — they are this screen's design base, not loose inspiration. Open each one (get_frame_html or screenshot_frame with its canvas_id) and build from what is actually there:\n${refs}`
    : ''
  return `${screen.name} — ${screen.outline}${reuse}${refBlock}\n\nFrom the design plan: ${plan.summary}`
}
