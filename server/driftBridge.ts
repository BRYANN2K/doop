import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  DRIFT_FETCH_MAX_BYTES,
  DRIFT_ONLINE_MS,
  DRIFT_POLL_MS,
  DRIFT_REQUEST_TTL_MS,
  type DriftFetchRequest,
  type DriftFetchResult,
} from '../shared/drift.ts'
import type { fetchPinnedPublicUrl } from './publicUrl.ts'

/* Local-URL captures (shared/drift.ts): a localhost/private address can only
 * be reached by a machine that shares it — the owner's desktop app. The app
 * long-polls here; the server hands it one fetch at a time, pinned to the
 * capture's origin, and the headless page's request interception fulfills
 * the browser request from the answer. No grants: the user asked for the
 * capture, and any of their online devices may serve it. Requests expire
 * unanswered rather than queue — fetching needs the app open anyway. */

interface Device {
  id: string
  at: number
  /** set while a long-poll is waiting for work to arrive */
  waiter?: { resolve: (request: DriftFetchRequest | null) => void }
}

interface Pending {
  id: string
  userId: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  createdAt: number
  claimedBy?: string
  resolve: (result: DriftFetchResult) => void
}

function job(p: Pending): DriftFetchRequest {
  return { id: p.id, url: p.url, method: p.method, headers: p.headers, ...(p.body ? { body: p.body } : {}) }
}

export class LocalDrift {
  private devices = new Map<string, Device>()
  private pending = new Map<string, Pending>()

  online(userId: string, now = Date.now()): boolean {
    return now - (this.devices.get(userId)?.at ?? 0) < DRIFT_ONLINE_MS
  }

  /** Register (or confirm) this device and answer a claimable fetch if one
   *  waits, else hold the call open up to DRIFT_POLL_MS — the long-poll. One
   *  device per user answers; a second install stands by. */
  async poll(userId: string, deviceId: string, now = Date.now()): Promise<DriftFetchRequest | null> {
    const current = this.devices.get(userId)
    if (current && current.id !== deviceId && this.online(userId, now)) return null
    const device: Device = { id: deviceId, at: now }
    this.devices.set(userId, device)
    const ready = [...this.pending.values()].find((p) => p.userId === userId && !p.claimedBy)
    if (ready) {
      ready.claimedBy = deviceId
      return job(ready)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (device.waiter) {
          device.waiter = undefined
          resolve(null)
        }
      }, DRIFT_POLL_MS)
      device.waiter = {
        resolve: (request) => {
          clearTimeout(timer)
          if (device.waiter) device.waiter = undefined
          resolve(request)
        },
      }
    })
  }

  /** The client left mid-long-poll: release the waiter so it can't claim. */
  dropWaiter(userId: string, deviceId: string): void {
    const device = this.devices.get(userId)
    if (device?.id === deviceId && device.waiter) {
      device.waiter.resolve(null)
      device.waiter = undefined
    }
  }

  /** Hand the fetch to the user's online device and await its answer. Fails
   *  fast when the desktop app isn't polling — the capture then refuses with
   *  the "open the desktop app" message. */
  fetch(userId: string, request: Omit<DriftFetchRequest, 'id'>): Promise<DriftFetchResult> {
    const device = this.devices.get(userId)
    if (!device || !this.online(userId)) {
      return Promise.resolve({
        ok: false,
        error: "the doop desktop app isn't online — open it to capture a local URL",
      })
    }
    const p: Pending = { id: randomUUID(), userId, ...request, createdAt: Date.now(), resolve: () => {} }
    this.pending.set(p.id, p)
    const done = new Promise<DriftFetchResult>((resolve) => {
      p.resolve = resolve
    })
    if (device.waiter) {
      const waiter = device.waiter
      device.waiter = undefined
      p.claimedBy = device.id
      waiter.resolve(job(p))
    }
    return Promise.race([
      done,
      new Promise<DriftFetchResult>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, error: 'the desktop app did not answer in time — is it still open?' }),
          DRIFT_REQUEST_TTL_MS,
        ).unref(),
      ),
    ]).then((result) => {
      this.pending.delete(p.id)
      return result
    })
  }

  /** The device posts the answer back; resolves the matching fetch. */
  finish(requestId: string, userId: string, deviceId: string, result: DriftFetchResult): boolean {
    const p = this.pending.get(requestId)
    if (!p || p.userId !== userId || p.claimedBy !== deviceId) return false
    this.pending.delete(requestId)
    p.resolve(result)
    return true
  }

  /** Resolve unanswered requests and drop devices that stopped polling. */
  expire(now = Date.now()): void {
    for (const [id, p] of this.pending) {
      if (now - p.createdAt > DRIFT_REQUEST_TTL_MS) {
        this.pending.delete(id)
        p.resolve({ ok: false, error: 'the desktop app did not answer in time' })
      }
    }
    for (const [userId, device] of this.devices) {
      if (now - device.at > DRIFT_ONLINE_MS + DRIFT_POLL_MS) {
        if (device.waiter) {
          device.waiter.resolve(null)
          device.waiter = undefined
        }
        this.devices.delete(userId)
      }
    }
  }
}

export const localDrift = new LocalDrift()
const cleanup = setInterval(() => localDrift.expire(), 5_000)
cleanup.unref()

/** A fetchUrl-shaped function for guardPublicPageRequests that proxies every
 *  request through the owner's desktop, pinned to `origin`: the desktop only
 *  ever talks to the exact address the user asked to capture. `spend`
 *  budgets the requests one capture may issue. */
export function localFetchFor(userId: string, origin: string, spend: () => boolean) {
  return async (raw: string | URL, init: Parameters<typeof fetchPinnedPublicUrl>[1] = {}) => {
    const url = new URL(String(raw))
    if (url.origin !== origin) throw new Error(`off-origin request refused: ${url.origin}`)
    if (!spend()) throw new Error('local capture request budget exceeded')
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(init.headers ?? {})) headers[name] = String(value)
    const result = await localDrift.fetch(userId, {
      url: url.href,
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      ...(typeof init.body === 'string' ? { body: Buffer.from(init.body).toString('base64') } : {}),
    })
    if (!result.ok || result.status === undefined) throw new Error(result.error ?? 'desktop fetch failed')
    const body = result.body ? Buffer.from(result.body, 'base64') : Buffer.alloc(0)
    return new Response(body, { status: result.status, headers: result.headers })
  }
}

/* ------------------------------------------------------------------ */
/* routes — the device's end of the bridge                             */
/* ------------------------------------------------------------------ */

const pollSchema = z.object({
  deviceId: z.string().uuid(),
})
const finishSchema = z.object({
  deviceId: z.string().uuid(),
  ok: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z
    .string()
    .max(Math.ceil(DRIFT_FETCH_MAX_BYTES * (4 / 3)) + 100)
    .optional(),
  error: z.string().max(5_000).optional(),
})

export const localDriftRouter = Router()

localDriftRouter.post('/poll', (req, res, next) => {
  const parsed = pollSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid device' })
    return
  }
  const userId = req.user!.id
  const deviceId = parsed.data.deviceId
  req.on('close', () => localDrift.dropWaiter(userId, deviceId))
  localDrift
    .poll(userId, deviceId)
    .then((request) => {
      if (!res.writableEnded) res.json({ request })
    })
    .catch(next)
})

localDriftRouter.post('/finish/:id', (req, res) => {
  const parsed = finishSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid result' })
    return
  }
  const { deviceId, ...result } = parsed.data
  const ok = localDrift.finish(req.params.id!, req.user!.id, deviceId, result)
  res.status(ok ? 200 : 409).json({ ok })
})
