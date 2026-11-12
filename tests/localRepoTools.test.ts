import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoLink } from '../shared/localRepo.ts'

/* The repo_* resident tools against a stubbed bridge: they resolve the
   requester's link fresh on every call, shape the wire args, and surface a
   device failure as an ordinary tool error — the run goes on. */

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

vi.mock('../server/localRepo.ts', () => ({
  linkFor: vi.fn(),
  repoToolCall: vi.fn(),
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { execTool, REPO_TOOLS, RESIDENT_TOOL_NAMES } = await import('../server/resident.ts')
const { linkFor, repoToolCall } = await import('../server/localRepo.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
const run = (repoUserId?: string) => ({
  mutatedFrames: new Set<string>(),
  sourceFrames: new Set<string>(),
  verificationFrames: new Set<string>(),
  verifiedFrames: new Set<string>(),
  rewriteDrafts: new Map<string, string>(),
  vision: false,
  imagesGenerated: 0,
  repliedThreads: new Set<string>(),
  awaitingThreads: new Set<string>(),
  tokenWrites: 0,
  arrangeWrites: 0,
  ...(repoUserId ? { repoUserId } : {}),
})
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

const LINK: RepoLink = { id: 'l1', name: 'my-project', deviceId: 'dev-1', createdAt: 0, lastUsedAt: 0 }
let canvasId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('repo', 'kevin').id
  vi.mocked(linkFor).mockResolvedValue(LINK)
  vi.mocked(repoToolCall).mockResolvedValue({ ok: true, result: { files: [] } })
})

describe('the repo_* tool set', () => {
  it('offers exactly the three read tools, outside the always-on set', () => {
    expect(REPO_TOOLS.map((t) => t.name).sort()).toEqual(['repo_list', 'repo_read', 'repo_search'])
    for (const name of REPO_TOOLS.map((t) => t.name)) expect(RESIDENT_TOOL_NAMES).not.toContain(name)
  })

  it('refuses the call when the run has no requester link', async () => {
    const result = await execTool(call('repo_list', {}), canvasId, actor(), run())
    expect(result.is_error).toBe(true)
    expect(repoToolCall).not.toHaveBeenCalled()
  })

  it('resolves the link each call and refuses after an unlink', async () => {
    vi.mocked(linkFor).mockResolvedValue(undefined)
    const result = await execTool(call('repo_list', {}), canvasId, actor(), run('u1'))
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('unlinked')
    expect(repoToolCall).not.toHaveBeenCalled()
  })
})

describe('repo_read', () => {
  it('dispatches the requester’s paths to the device and returns its JSON', async () => {
    vi.mocked(repoToolCall).mockResolvedValue({ ok: true, result: { files: [{ path: 'a.ts', text: 'x' }] } })
    const result = await execTool(call('repo_read', { paths: ['a.ts', 'b.ts'] }), canvasId, actor(), run('u1'))
    expect(result.is_error).toBeUndefined()
    expect(repoToolCall).toHaveBeenCalledWith('u1', LINK, 'read', { paths: ['a.ts', 'b.ts'] })
    expect(JSON.parse(String(result.content))).toEqual({ files: [{ path: 'a.ts', text: 'x' }] })
  })

  it('rejects malformed path lists without touching the bridge', async () => {
    for (const input of [{}, { paths: [] }, { paths: [''] }, { paths: 'a.ts' }, { paths: Array(13).fill('x.ts') }]) {
      const result = await execTool(call('repo_read', input), canvasId, actor(), run('u1'))
      expect(result.is_error).toBe(true)
    }
    expect(repoToolCall).not.toHaveBeenCalled()
  })
})

describe('repo_list and repo_search', () => {
  it('clamps depth and forwards a normalized subdir', async () => {
    await execTool(call('repo_list', { subdir: 'src', depth: 99 }), canvasId, actor(), run('u1'))
    expect(repoToolCall).toHaveBeenCalledWith('u1', LINK, 'list', { subdir: 'src', depth: 8 })
    await execTool(call('repo_list', {}), canvasId, actor(), run('u1'))
    expect(repoToolCall).toHaveBeenLastCalledWith('u1', LINK, 'list', {})
  })

  it('requires a query and shapes glob/regex/limit', async () => {
    const bad = await execTool(call('repo_search', { glob: '*.ts' }), canvasId, actor(), run('u1'))
    expect(bad.is_error).toBe(true)
    await execTool(
      call('repo_search', { query: 'TOKEN', glob: '*.tsx', regex: true, limit: 400 }),
      canvasId,
      actor(),
      run('u1'),
    )
    expect(repoToolCall).toHaveBeenCalledWith('u1', LINK, 'search', {
      query: 'TOKEN',
      glob: '*.tsx',
      regex: true,
      limit: 100,
    })
  })
})

describe('device failures', () => {
  it('surfaces the bridge error as an ordinary tool error', async () => {
    vi.mocked(repoToolCall).mockResolvedValue({ ok: false, error: "the doop desktop app holding it isn't online" })
    const result = await execTool(call('repo_list', {}), canvasId, actor(), run('u1'))
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain("isn't online")
  })
})
