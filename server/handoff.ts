import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { store } from './store.ts'
import { env } from './env.ts'
import { renderFrame } from './screenshot.ts'
import { frameSearchText } from './canvasFind.ts'
import { describeTokens, tokensBrief, type DesignToken } from '../shared/designTokens.ts'
import { describerFor } from './imageDescriptions.ts'
import type { AgentModel } from './agentModel.ts'
import * as actions from './actions.ts'
import type { Canvas, ChatPlan, Frame } from '../shared/types.ts'
import type { RepoReadResult } from '../shared/localRepo.ts'
import {
  HANDOFF_CHANGE_ID,
  HANDOFF_MAX_FRAMES,
  handoffDir,
  handoffFilesProblem,
  newHandoffChangeId,
  type HandoffFile,
  type HandoffPack,
} from '../shared/handoff.ts'

/**
 * The "Ready for dev → Stip" pack: one Stip change, drafted from frames
 * and/or a chat plan. The folder mirrors what Stip's `explore` command
 * produces (proposal.md, spec.md with `- AC-n:` criteria, tasks.md,
 * evidence.md, state.json) plus doop's extras — tokens.json and the frames'
 * PNG exports under assets/. Building writes nothing: the pack goes back for
 * a human preview, and only the desktop app's `repo_write_change` lands it
 * in the linked project.
 */

/** A build failure worth a specific HTTP status. */
export class HandoffError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Sanity bounds on what the requester can override or the drafter emit. */
const MAX_DOC_CHARS = 60_000
const DRAFT_TIMEOUT_MS = 45_000
/** Per-frame visible text fed to the drafting model. */
const MAX_FRAME_TEXT = 1_800
/** The PNGs the drafter sees — same long edge as image descriptions. */
const DRAFT_IMAGE_EDGE = 1_500

export interface HandoffBuild {
  /** explicit frames; a plan without ids matches its screens by name */
  frameIds?: string[]
  /** a chat message carrying a plan card (same canvas required) */
  planMessageId?: string
  /** a plan handed directly — the MCP path */
  plan?: ChatPlan
  title?: string
  changeId?: string
  /** caller-written docs that replace the drafted ones (MCP agents write
   *  their own contract; the modal's edits happen at write time) */
  docs?: { proposal?: string; spec?: string; tasks?: string }
  /** whose small model drafts the criteria — absent: template only */
  requesterId?: string
  /** bounded read inside the linked repo, for state.json's target_before */
  readRepo?: (paths: string[]) => Promise<RepoReadResult | undefined>
  /** the frame→PNG renderer — injectable so tests don't boot Chromium */
  renderPng?: (frame: Frame) => Promise<Buffer>
}

const canvasUrl = (canvasId: string) => `${env.BETTER_AUTH_URL}/c/${canvasId}`
const frameUrl = (canvasId: string, frameId: string) => `${canvasUrl(canvasId)}?frame=${frameId}`

/* ------------------------------------------------------------------ */
/* pieces                                                              */
/* ------------------------------------------------------------------ */

function planFromMessage(messageId: string | undefined, canvasId: string): ChatPlan | undefined {
  if (!messageId) return undefined
  const message = actions.findChatMessage(messageId)
  if (!message || message.canvasId !== canvasId) throw new HandoffError('plan not found on this canvas', 404)
  if (!message.plan) throw new HandoffError('that chat message carries no plan', 400)
  return message.plan
}

const normName = (s: string) => s.trim().toLowerCase()

/** The frames the pack covers: the requested ids, else the plan's screens
 *  matched to frames by name, else every non-demo frame. Bounded to
 *  HANDOFF_MAX_FRAMES. */
function pickFrames(
  canvas: Canvas,
  frameIds: string[] | undefined,
  plan: ChatPlan | undefined,
  warnings: string[],
): Frame[] {
  const live = canvas.frames.filter((f) => !f.demo)
  let picked: Frame[] = []
  if (frameIds?.length) {
    const byId = new Map(live.map((f) => [f.id, f]))
    for (const id of frameIds) {
      const f = byId.get(id)
      if (!f) warnings.push(`frame ${id} not found — skipped`)
      else if (!picked.includes(f)) picked.push(f)
    }
  } else if (plan?.screens.length) {
    const byName = new Map(live.map((f) => [normName(f.name), f]))
    for (const screen of plan.screens) {
      const f = byName.get(normName(screen.name))
      if (f && !picked.includes(f)) picked.push(f)
    }
  } else {
    picked = live
  }
  if (picked.length > HANDOFF_MAX_FRAMES) {
    warnings.push(`only the first ${HANDOFF_MAX_FRAMES} frames are exported`)
    picked = picked.slice(0, HANDOFF_MAX_FRAMES)
  }
  return picked
}

function cleanTitle(raw: string | undefined): string | undefined {
  const t = raw?.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 120) : undefined
}

function packTitle(title: string | undefined, plan: ChatPlan | undefined, frames: Frame[]): string {
  const given = cleanTitle(title)
  if (given) return given
  if (plan) {
    const first = plan.summary.split('\n')[0]!.trim()
    if (first) return first.length > 80 ? `${first.slice(0, 77)}…` : first
  }
  if (frames.length === 1) return frames[0]!.name.trim() || 'Design handoff'
  if (frames.length) return `${frames[0]!.name.trim() || 'Screens'} + ${frames.length - 1} more`
  return 'Design handoff'
}

const assetName = (index: number, frame: Frame) =>
  `assets/${String(index + 1).padStart(2, '0')}-${
    frame.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'frame'
  }.png`

/** One PNG per frame — the export the repo keeps and the image the drafter sees. */
async function renderAssets(
  frames: Frame[],
  renderPng: (frame: Frame) => Promise<Buffer>,
  warnings: string[],
): Promise<{ frame: Frame; path: string; png: Buffer }[]> {
  const assets: { frame: Frame; path: string; png: Buffer }[] = []
  for (const [i, frame] of frames.entries()) {
    try {
      const png = await renderPng(frame)
      assets.push({ frame, path: assetName(i, frame), png })
    } catch (e) {
      warnings.push(`"${frame.name}" could not be rendered: ${e instanceof Error ? e.message : e}`)
    }
  }
  return assets
}

/* ------------------------------------------------------------------ */
/* the docs                                                            */
/* ------------------------------------------------------------------ */

interface Draft {
  intent: string
  criteria: string[]
  tasks: string[]
}

interface DocInput {
  canvas: Canvas
  title: string
  plan?: ChatPlan
  frames: Frame[]
  assets: { frame: Frame; path: string; png: Buffer }[]
  tokens: DesignToken[]
  themes: string[]
}

function frameLines(input: DocInput): string {
  const byId = new Map(input.assets.map((a) => [a.frame.id, a.path]))
  return input.frames
    .map((f) => {
      const bits = [
        `- "${f.name}" (${Math.round(f.width)}×${Math.round(f.height)}) — ${frameUrl(input.canvas.id, f.id)}`,
      ]
      if (byId.has(f.id)) bits.push(`  export \`${byId.get(f.id)}\``)
      return bits.join('\n')
    })
    .join('\n')
}

function templateDraft(input: DocInput): Draft {
  const { title, plan, frames, assets } = input
  const intent = plan
    ? `Implement the “${title}” plan as designed in Doop — the exported PNGs in assets/ are the visual reference and tokens.json carries the canvas's design tokens.`
    : `Implement the “${title}” design from the linked Doop frames — the exported PNGs in assets/ are the reference and tokens.json carries the canvas's design tokens.`
  const criteria: string[] = []
  for (const a of assets)
    criteria.push(
      `The "${a.frame.name}" screen matches its export ${a.path} (design: ${frameUrl(input.canvas.id, a.frame.id)}).`,
    )
  for (const screen of frames.filter((f) => !assets.some((a) => a.frame.id === f.id)))
    criteria.push(`The "${screen.name}" screen matches the linked frame (${frameUrl(input.canvas.id, screen.id)}).`)
  if (!assets.length && !frames.length && plan)
    for (const screen of plan.screens)
      criteria.push(
        `The "${screen.name}" screen is implemented as the plan describes (${screen.width}×${screen.height}).`,
      )
  criteria.push(
    'The implementation reuses the project’s existing components and, where they cover the same value, the design tokens in tokens.json.',
  )
  criteria.push('States the design does not show (loading, empty, error) follow the project’s existing patterns.')
  if (plan?.openQuestions?.length)
    criteria.push('The open questions in proposal.md are resolved before this change ships.')
  const tasks = [
    ...assets.map((a) => `Recreate the "${a.frame.name}" screen to match ${a.path}.`),
    ...frames
      .filter((f) => !assets.some((a) => a.frame.id === f.id))
      .map((f) => `Recreate the "${f.name}" screen to match the linked frame.`),
    ...(!frames.length && plan
      ? plan.screens.map((s) => `Implement the "${s.name}" screen (${s.width}×${s.height}).`)
      : []),
    'Wire the data and the interaction states the design does not cover.',
    'Check the implementation against every acceptance criterion in spec.md.',
  ]
  return { intent, criteria: criteria.slice(0, 12), tasks: tasks.slice(0, 12) }
}

/** The spec/proposal/tasks markdown a draft becomes — Stip's own layout. */
function docsFromDraft(input: DocInput, draft: Draft): { proposal: string; spec: string; tasks: string } {
  const { canvas, title, plan, frames, tokens, themes } = input
  const scope: string[] = []
  if (frames.length) scope.push(frameLines(input))
  else if (plan) scope.push(plan.screens.map((s) => `- "${s.name}" (${s.width}×${s.height}) — ${s.outline}`).join('\n'))
  if (tokens.length)
    scope.push(
      `- Design tokens — \`tokens.json\` (${tokens.length} tokens${themes.length ? `, themes: ${themes.join(', ')}` : ''})`,
    )
  scope.push(`- Canvas — ${canvasUrl(canvas.id)}`)
  const questions = plan?.openQuestions?.length
    ? plan.openQuestions.map((q) => `- ${q}`).join('\n')
    : '- None recorded.'
  const problem = plan?.summary?.trim()
    ? plan.summary.trim()
    : `The “${title}” design is approved in Doop and ready for development — this change brings it into the repo as a Stip change pack drafted from the design itself.`
  const proposal =
    `# ${title}\n\n## Problem\n\n${problem}\n\n## Scope\n\n${scope.join('\n')}\n\n` +
    `## Decisions and open questions\n\n${questions}\n`
  const refs = [`- Canvas: ${canvasUrl(canvas.id)}`]
  if (frames.length) refs.push(frameLines(input))
  if (tokens.length) refs.push('- Design tokens: `tokens.json`')
  const spec =
    `# ${title}\n\n## Intent\n\n${draft.intent}\n\n## Acceptance criteria\n\n` +
    `${draft.criteria.map((c, i) => `- AC-${i + 1}: ${c}`).join('\n')}\n\n## References\n\n${refs.join('\n')}\n`
  const tasks = `# Tasks — ${title}\n\n${draft.tasks.map((t) => `- [ ] ${t}`).join('\n')}\n`
  return { proposal, spec, tasks }
}

const DRAFT_PROMPT = `You draft the contract of a Stip change pack that hands a design off to a coding agent. You are shown the design (screenshots plus the plan and the canvas's design tokens). Write: a one-paragraph implementation intent; 4-10 acceptance criteria — observable, testable, each starting with a verb, naming the exported PNG files and tokens.json where relevant; and 3-8 implementation tasks in dependency order. Add responsive, empty or error-state criteria ONLY when the design shows them. Reply with ONLY a JSON object {"intent": "…", "criteria": ["…"], "tasks": ["…"]} — no fences, no commentary.`

/** Criteria the model wrote, sanitized into the doc's `- AC-n:` shape. */
function cleanDraft(raw: string): Draft | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: { intent?: unknown; criteria?: unknown; tasks?: unknown }
  try {
    data = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  const list = (v: unknown, cap: number) =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.replace(/^-?\s*AC-\d+:\s*/i, '').trim())
          .filter(Boolean)
          .slice(0, cap)
      : []
  const criteria = [...new Set(list(data.criteria, 12))]
  if (!criteria.length) return null
  const intent = typeof data.intent === 'string' && data.intent.trim() ? data.intent.trim().slice(0, 2000) : ''
  return { intent, criteria, tasks: list(data.tasks, 12) }
}

async function draftWithModel(input: DocInput, model: AgentModel): Promise<Draft | null> {
  const context = {
    title: input.title,
    canvas: input.canvas.name,
    plan: input.plan
      ? { summary: input.plan.summary, screens: input.plan.screens, openQuestions: input.plan.openQuestions ?? [] }
      : null,
    frames: input.frames.map((f) => ({
      name: f.name,
      width: Math.round(f.width),
      height: Math.round(f.height),
      asset: input.assets.find((a) => a.frame.id === f.id)?.path ?? null,
      link: frameUrl(input.canvas.id, f.id),
      text: frameSearchText(f.html ?? '').text.slice(0, MAX_FRAME_TEXT),
    })),
    tokens: input.tokens.length ? tokensBrief(input.tokens, input.themes) : null,
  }
  const content: (
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } }
    | { type: 'text'; text: string }
  )[] = [{ type: 'text', text: `Draft this change's contract.\n\n${JSON.stringify(context)}` }]
  for (const a of input.assets) {
    const jpeg = await sharp(a.png, { animated: false })
      .resize({ width: DRAFT_IMAGE_EDGE, height: DRAFT_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer()
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } })
    content.push({ type: 'text', text: `↑ export ${a.path} — "${a.frame.name}"` })
  }
  const signal = AbortSignal.timeout(DRAFT_TIMEOUT_MS)
  const result = await model.run({
    system: [{ text: DRAFT_PROMPT }],
    tools: [],
    messages: [{ role: 'user', content }],
    maxTokens: 1600,
    signal,
  })
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
  return cleanDraft(text)
}

/* ------------------------------------------------------------------ */
/* the pack                                                            */
/* ------------------------------------------------------------------ */

export async function buildHandoffPack(canvasId: string, opts: HandoffBuild): Promise<HandoffPack> {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new HandoffError('canvas not found', 404)
  const warnings: string[] = []
  const plan = opts.plan ?? planFromMessage(opts.planMessageId, canvasId)
  const frames = pickFrames(canvas, opts.frameIds, plan, warnings)
  if (!frames.length && !plan) throw new HandoffError('nothing to hand off — pass frames or a plan')
  const title = packTitle(opts.title, plan, frames)
  const changeId =
    opts.changeId ??
    newHandoffChangeId(title, () =>
      createHash('sha256').update(`${canvasId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 4),
    )
  if (!HANDOFF_CHANGE_ID.test(changeId) || changeId.length > 100)
    throw new HandoffError('changeId must be a lowercase slug')
  const assets = await renderAssets(frames, opts.renderPng ?? ((f) => renderFrame(f, 1)), warnings)
  const tokens = store.getTokens(canvasId)
  const themes = store.getTokenThemes(canvasId)
  const input: DocInput = { canvas, title, plan, frames, assets, tokens, themes }

  /* the spec's contract: caller docs win verbatim, then the requester's
     model drafts it, then the template */
  let draftedBy: HandoffPack['draftedBy'] = 'template'
  let modelLabel: string | undefined
  let docs = docsFromDraft(input, templateDraft(input))
  if (opts.docs?.proposal) docs.proposal = opts.docs.proposal.slice(0, MAX_DOC_CHARS)
  if (opts.docs?.spec) docs.spec = opts.docs.spec.slice(0, MAX_DOC_CHARS)
  if (opts.docs?.tasks) docs.tasks = opts.docs.tasks.slice(0, MAX_DOC_CHARS)
  if (!opts.docs?.spec && opts.requesterId) {
    const { model } = await describerFor(opts.requesterId, canvas.ownerId).catch(() => ({
      model: null,
      status: { label: null, reason: 'no-model' },
    }))
    if (model) {
      const draft = await draftWithModel(input, model).catch(() => null)
      if (draft?.criteria.length) {
        docs = docsFromDraft(input, { ...draft, intent: draft.intent || templateDraft(input).intent })
        draftedBy = 'agent'
        modelLabel = model.label
      } else {
        warnings.push('criteria drafting failed — template criteria used instead')
      }
    }
  }

  /* state.json as Stip's `explore` writes it; target_before hashes an
     existing target spec when the device can look */
  let targetBefore: string | null = null
  if (opts.readRepo) {
    const res = await opts.readRepo([`.workflow/specs/${changeId}.md`]).catch(() => undefined)
    const text = res?.files?.[0]?.text
    if (text) targetBefore = createHash('sha256').update(text).digest('hex')
  }
  const now = new Date().toISOString()
  const dir = handoffDir(changeId)
  const files: HandoffFile[] = [
    { path: `${dir}/proposal.md`, text: docs.proposal },
    { path: `${dir}/spec.md`, text: docs.spec },
    { path: `${dir}/tasks.md`, text: docs.tasks },
    { path: `${dir}/evidence.md`, text: '# Evidence\n\nNo verification recorded.\n' },
    {
      path: `${dir}/state.json`,
      text:
        JSON.stringify(
          {
            schema_version: 1,
            id: changeId,
            target: changeId,
            extensions: [],
            target_before: targetBefore,
            created_at: now,
            phase: 'exploring',
            updated_at: now,
          },
          null,
          2,
        ) + '\n',
    },
  ]
  if (tokens.length)
    files.push({
      path: `${dir}/tokens.json`,
      text: JSON.stringify({ tokens: describeTokens(tokens), ...(themes.length ? { themes } : {}) }, null, 2) + '\n',
    })
  for (const a of assets) files.push({ path: `${dir}/${a.path}`, base64: a.png.toString('base64') })

  const bad = handoffFilesProblem(changeId, files)
  if (bad) throw new HandoffError(`the pack failed its own checks: ${bad}`, 500)
  return {
    changeId,
    dir,
    title,
    proposal: docs.proposal,
    spec: docs.spec,
    tasks: docs.tasks,
    files,
    draftedBy,
    modelLabel,
    warnings,
  }
}
