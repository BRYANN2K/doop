/**
 * The "Ready for dev → Stip" handoff pack: a Stip change the server drafts
 * from frames or a chat plan, previewed in the canvas UI, then written into
 * the linked local project through the desktop app's `repo_write_change`.
 * One pack is one NEW `.workflow/changes/<change-id>/` directory — every
 * file in it is created fresh, so a write can never overwrite repo content.
 *
 * The folder mirrors what Stip's own `explore` produces — proposal.md,
 * spec.md (`- AC-n:` criteria), tasks.md, evidence.md, state.json — plus
 * the doop extras: tokens.json (the canvas's design tokens) and
 * assets/*.png (frame exports). The caps mirror `desktop/src-tauri/src/
 * repo.rs`, which re-checks everything natively — keep the two in step.
 */

/** Where Stip changes live inside a repo. */
export const HANDOFF_ROOT = '.workflow/changes'

/** Stip change ids are lowercase slugs — workflow.py's `SLUG`. */
export const HANDOFF_CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const HANDOFF_MAX_CHANGE_ID = 100

/** A pack's file list and byte budgets, enforced server- AND device-side. */
export const HANDOFF_MAX_FILES = 24
export const HANDOFF_MAX_FILE_BYTES = 4 * 1024 * 1024
export const HANDOFF_MAX_BYTES = 12 * 1024 * 1024

/** PNG exports in one pack stay a handful — each costs a render. */
export const HANDOFF_MAX_FRAMES = 6

/** The one file a pack writes: text (utf-8) or base64 (binary), never both. */
export interface HandoffFile {
  /** repo-relative path, always inside `.workflow/changes/<changeId>/` */
  path: string
  text?: string
  base64?: string
}

/** What `POST /api/canvases/:id/handoff` answers — the whole pack, nothing written. */
export interface HandoffPack {
  /** the change id — the pack's folder is `.workflow/changes/<changeId>` */
  changeId: string
  /** `HANDOFF_ROOT/<changeId>` */
  dir: string
  title: string
  /** the three editable docs, verbatim as they appear in `files` */
  proposal: string
  spec: string
  tasks: string
  files: HandoffFile[]
  /** who drafted the spec's criteria: the requester's model or the template */
  draftedBy: 'agent' | 'template'
  /** the model's display label when draftedBy is 'agent' */
  modelLabel?: string
  /** non-fatal build notes — a frame whose render failed, a skipped id */
  warnings: string[]
}

/** What `POST …/handoff/write` answers on success. */
export interface HandoffWriteResult {
  dir: string
  written: string[]
  /** the link's display name — the folder's basename on the Mac */
  repo: string
}

export function handoffDir(changeId: string): string {
  return `${HANDOFF_ROOT}/${changeId}`
}

/** Slugify a title into a Stip change id, with a random tail so a second
 *  pack of the same frame lands in its own folder (ids must be new — a
 *  write creates files, it never replaces them). */
export function newHandoffChangeId(seed: string, rand: () => string = defaultRand): string {
  const slug = seed
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return `${slug || 'change'}-${rand()}`
}

function defaultRand(): string {
  return Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
}

/** Why `path` cannot belong to change `changeId`, or null when it can.
 *  Checks shape only — byte budgets live in `handoffFilesProblem`. */
export function handoffPathProblem(changeId: string, path: string): string | null {
  const prefix = `${handoffDir(changeId)}/`
  if (!path.startsWith(prefix)) return `path must start with ${prefix}`
  const rel = path.slice(prefix.length)
  if (!rel || rel.length > 400) return 'path is empty or too long'
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.' || seg === '..') return 'path has empty or dot segments'
  }
  if (/[\\:*?"<>|\0]/.test(rel)) return 'path has characters a repo should not carry'
  return null
}

/**
 * Why this file set cannot be written as change `changeId`, or null when it
 * can. Mirrors the native check in repo.rs: slug id, every path under the
 * change's own folder, new-style file entries only, bounded count and bytes.
 */
export function handoffFilesProblem(changeId: string, files: readonly HandoffFile[]): string | null {
  if (!HANDOFF_CHANGE_ID.test(changeId) || changeId.length > HANDOFF_MAX_CHANGE_ID)
    return 'changeId must be a lowercase slug'
  if (!files.length) return 'no files'
  if (files.length > HANDOFF_MAX_FILES) return `at most ${HANDOFF_MAX_FILES} files per change`
  let total = 0
  const seen = new Set<string>()
  for (const f of files) {
    const bad = handoffPathProblem(changeId, f.path)
    if (bad) return `${f.path || '(empty path)'}: ${bad}`
    if (seen.has(f.path)) return `${f.path}: duplicate path`
    seen.add(f.path)
    const hasText = typeof f.text === 'string'
    const hasBin = typeof f.base64 === 'string'
    if (hasText === hasBin) return `${f.path}: exactly one of text or base64 is required`
    const bytes = hasText ? new TextEncoder().encode(f.text!).length : base64ByteLength(f.base64!)
    if (bytes === null) return `${f.path}: invalid base64`
    if (bytes > HANDOFF_MAX_FILE_BYTES) return `${f.path}: over the ${HANDOFF_MAX_FILE_BYTES}-byte file cap`
    total += bytes
  }
  if (total > HANDOFF_MAX_BYTES) return `pack is over the ${HANDOFF_MAX_BYTES}-byte total cap`
  return null
}

/** Decoded length of a base64 string, or null when it isn't base64. */
export function base64ByteLength(b64: string): number | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return (b64.length / 4) * 3 - pad
}
