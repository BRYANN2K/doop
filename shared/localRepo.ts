/**
 * A canvas linked to a folder on someone's own computer — the "local
 * project". The desktop app keeps `linkId → absolute path` and does every
 * read itself; the server only knows the link exists and shuttles requests
 * to the device over a long-poll. The agent's `repo_list` / `repo_read` /
 * `repo_search` tools and the canvas's link chip are the two ends of this
 * file. `write_change` is the single write: it only creates a Stip change
 * folder, after a native confirmation on the device. Caps and the denylist
 * spec mirror `desktop/src-tauri/src/repo.rs`, which enforces them
 * natively — keep the two in step.
 */
import type { HandoffFile } from './handoff.ts'

/** A `repo_list` answer is one bounded tree slice. */
export const REPO_MAX_ENTRIES = 2000
/** Depth past the picked `subdir` the tree walk opens; deeper stays folded. */
export const REPO_MAX_DEPTH = 8
/** Per-file and per-call byte budgets for `repo_read`. */
export const REPO_MAX_READ_FILES = 12
export const REPO_MAX_FILE_BYTES = 128 * 1024
export const REPO_MAX_READ_BYTES = 200 * 1024
/** `repo_search`: files scanned are capped like reads; matches capped here. */
export const REPO_MAX_SEARCH_MATCHES = 100
export const REPO_MAX_QUERY_CHARS = 200
export const REPO_MAX_PATH_CHARS = 500

/** An unanswered read expires rather than queueing: reads need a live app. */
export const REPO_REQUEST_TTL_MS = 60_000
/** A write_change request waits longer: its native confirmation dialog can
 *  sit on the Mac until someone answers it. */
export const REPO_WRITE_TTL_MS = 10 * 60_000
/** How long a poll call waits for work before answering empty. */
export const REPO_POLL_MS = 20_000
/** A device counts as online this long after its last poll. */
export const REPO_ONLINE_MS = 45_000

/** Directories never listed, descended or searched (relative-path match). */
export const REPO_SKIP_DIRS = ['.git', '.svn', '.hg', 'node_modules'] as const
/**
 * Names that never read or list, matched case-insensitively against the
 * file's own name: secrets and key material stay on the machine. `*` is a
 * glob wildcard here and in `repo.rs`'s `denied_name`.
 */
export const REPO_DENY_NAMES = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.keystore',
  '*.asc',
  'id_rsa*',
  '*.kdbx',
  '*credential*',
  '*secret*',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '*.tfvars',
] as const

/** What a repo request asks the device to do. `write_change` is the only
 *  write — it creates a new `.workflow/changes/<id>/` folder, nothing else. */
export type RepoOp = 'list' | 'read' | 'search' | 'write_change'

/** The link as the server knows it — everything but the path it never sees. */
export interface RepoLink {
  /** the id the desktop app minted at pick time; names its local grant */
  id: string
  name: string
  /** the install that picked the folder; another device polling warns */
  deviceId: string
  createdAt: number
  lastUsedAt: number
}

/** `GET /api/canvases/:id/repo`: the caller's link plus who can serve it. */
export interface RepoLinkStatus {
  link: RepoLink | null
  /** a device of the caller's is polling right now */
  online: boolean
  /** the polling install is not the one that made the link — it may not hold the grant */
  deviceMismatch: boolean
}

/** A read handed to the polling desktop webview (`POST /api/local-repo/poll`). */
export interface RepoRequest {
  id: string
  linkId: string
  op: RepoOp
  args: {
    /** `list`: repo-relative start directory ('' or absent = root) */
    subdir?: string
    depth?: number
    /** `read`: repo-relative file paths, up to REPO_MAX_READ_FILES */
    paths?: string[]
    /** `search`: literal text, or a Rust-regex pattern when `regex` is set */
    query?: string
    regex?: boolean
    glob?: string
    limit?: number
    /** `write_change`: the change id and its files (shared/handoff.ts) */
    changeId?: string
    files?: HandoffFile[]
  }
}

/** What the webview posts back to `/api/local-repo/finish/:requestId`. */
export interface RepoResult {
  ok: boolean
  /** the op's payload — RepoListResult / RepoReadResult / RepoSearchResult */
  result?: unknown
  error?: string
}

export interface RepoTreeEntry {
  /** repo-relative path, `/`-separated */
  path: string
  kind: 'file' | 'dir'
  /** file bytes; absent on dirs */
  size?: number
}

export interface RepoListResult {
  entries: RepoTreeEntry[]
  /** the walk hit REPO_MAX_ENTRIES and stopped early */
  truncated: boolean
}

export interface RepoReadFile {
  path: string
  /** present on success */
  text?: string
  /** 'denied' | 'missing' | 'binary' | 'too-large' | 'unreadable' on failure */
  error?: string
}

export interface RepoReadResult {
  files: RepoReadFile[]
  /** the call hit REPO_MAX_READ_BYTES and later files were not read */
  truncated: boolean
}

export interface RepoSearchMatch {
  path: string
  line: number
  text: string
}

export interface RepoSearchResult {
  matches: RepoSearchMatch[]
  /** the scan hit REPO_MAX_SEARCH_MATCHES and stopped early */
  truncated: boolean
}

export function isRepoOp(value: unknown): value is RepoOp {
  return value === 'list' || value === 'read' || value === 'search' || value === 'write_change'
}
