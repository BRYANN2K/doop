import { api } from './api'
import { repoDeviceId } from './localRepo'
import type { DriftFetchRequest, DriftFetchResult } from '../../shared/drift'

type Bridge = {
  __DOOP_LOCAL_DRIFT__?: boolean
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
  }
}
const bridge = globalThis as Bridge

/** The desktop shell serves local-URL captures (desktop/src-tauri/src/drift.rs);
 *  a plain browser tab can't — it has no way to reach the user's machine. */
export const hasLocalDrift = () => bridge.__DOOP_LOCAL_DRIFT__ === true && !!bridge.__TAURI__?.core

/**
 * The device's end of the drift bridge: long-poll for fetches the server
 * needs for a local-URL compare, answer each through drift.rs, and post the
 * result back. Lives above navigation like startLocalRepo — a capture keeps
 * working on whichever canvas page is open.
 */
export function startLocalDrift(): () => void {
  if (!hasLocalDrift()) return () => {}
  const deviceId = repoDeviceId()
  let disposed = false

  const serve = async (request: DriftFetchRequest): Promise<DriftFetchResult> => {
    try {
      return await bridge.__TAURI__!.core.invoke<DriftFetchResult>('drift_fetch', {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const loop = async () => {
    while (!disposed) {
      try {
        const { request } = await api.pollLocalDrift(deviceId)
        if (!request) continue // the long-poll timed out — ask again
        await api.finishLocalDrift(request.id, deviceId, await serve(request))
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
