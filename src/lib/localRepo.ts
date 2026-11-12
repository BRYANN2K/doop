import { create } from 'zustand'
import { api } from './api'
import type { RepoLink, RepoLinkStatus, RepoRequest, RepoResult } from '../../shared/localRepo'

type Bridge = {
  __DOOP_LOCAL_REPO__?: boolean
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
  }
}
const bridge = globalThis as Bridge

/** The desktop shell holds the grants and does the reads (repo.rs); a plain
 *  browser tab can see a link's status but cannot pick or serve folders. */
export const hasLocalRepo = () => bridge.__DOOP_LOCAL_REPO__ === true && !!bridge.__TAURI__?.core

function invokeRepo<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasLocalRepo() || !bridge.__TAURI__) {
    return Promise.reject(new Error('Link a local project from the Doop desktop app.'))
  }
  return bridge.__TAURI__.core.invoke<T>(command, args)
}

/** One stable id per install — the link records it, so a different device
 *  polling for the same account is flagged instead of silently used. */
export function repoDeviceId(): string {
  const KEY = 'doop.repo.device'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}

interface RepoGrant {
  id: string
  name: string
}

/** link status per canvas id, for the Agents panel row */
export const useLocalRepo = create<{ status: Record<string, RepoLinkStatus | undefined> }>(() => ({
  status: {},
}))

export async function refreshLocalRepo(canvasId: string): Promise<RepoLinkStatus> {
  const status = await api.canvasRepo(canvasId)
  useLocalRepo.setState((s) => ({ status: { ...s.status, [canvasId]: status } }))
  return status
}

/** Native picker + consent → grant on this device → link row on the server.
 *  Answers the stored link, or null when the person cancelled. */
export async function linkLocalProject(canvasId: string): Promise<RepoLink | null> {
  const picked = await invokeRepo<{ id: string | null; name?: string }>('repo_choose', { canvasId })
  if (!picked.id || !picked.name) return null
  const { link } = await api.linkCanvasRepo(canvasId, {
    linkId: picked.id,
    name: picked.name,
    deviceId: repoDeviceId(),
  })
  await refreshLocalRepo(canvasId)
  return link
}

/** Drop the server link, and this device's grant too when it holds one. */
export async function unlinkLocalProject(canvasId: string, linkId: string): Promise<void> {
  await api.unlinkCanvasRepo(canvasId)
  if (hasLocalRepo()) await invokeRepo('repo_forget', { linkId }).catch(() => {})
  await refreshLocalRepo(canvasId)
}

/**
 * The device's end of the bridge: advertise the grants this install holds,
 * answer each request the server hands out through repo.rs, and post the
 * result back. Lives above navigation like startLocalAgent — the reads
 * keep working on whichever canvas page is open.
 */
export function startLocalRepo(): () => void {
  if (!hasLocalRepo()) return () => {}
  const deviceId = repoDeviceId()
  let disposed = false

  const serve = async (request: RepoRequest): Promise<RepoResult> => {
    try {
      const result = await invokeRepo<unknown>(`repo_${request.op}`, { linkId: request.linkId, ...request.args })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const loop = async () => {
    while (!disposed) {
      try {
        const grants = await invokeRepo<RepoGrant[]>('repo_grants')
        const { request } = await api.pollLocalRepo(
          deviceId,
          grants.map((g) => g.id),
        )
        if (!request) continue // the long-poll timed out — ask again
        await api.finishLocalRepo(request.id, deviceId, await serve(request))
      } catch {
        if (disposed) return
        await new Promise((r) => setTimeout(r, 3000)) // back off on errors
      }
    }
  }
  void loop()
  return () => {
    disposed = true
  }
}
