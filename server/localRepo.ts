import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from './db/index.ts'
import { repoLinks } from './db/schema.ts'
import {
  REPO_ONLINE_MS,
  REPO_POLL_MS,
  REPO_REQUEST_TTL_MS,
  type RepoLink,
  type RepoOp,
  type RepoRequest,
  type RepoResult,
} from '../shared/localRepo.ts'

/* A canvas's link to a folder on the requester's own computer. The server
 * stores only the link — the absolute path never leaves the desktop app,
 * which answers reads through the poll below. Requests expire unanswered
 * rather than queue: reading needs the app open anyway. */

/* ------------------------------------------------------------------ */
/* link rows                                                           */
/* ------------------------------------------------------------------ */

function toLink(row: typeof repoLinks.$inferSelect): RepoLink {
  return {
    id: row.id,
    name: row.name,
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

/** The requester's link on this canvas, if any — the agent reads theirs. */
export async function linkFor(userId: string, canvasId: string): Promise<RepoLink | undefined> {
  const [row] = await db
    .select()
    .from(repoLinks)
    .where(and(eq(repoLinks.canvasId, canvasId), eq(repoLinks.userId, userId)))
  return row ? toLink(row) : undefined
}

/** One row per (canvas, user): re-linking replaces it. */
export async function putLink(
  userId: string,
  canvasId: string,
  link: { id: string; name: string; deviceId: string },
): Promise<RepoLink> {
  const now = Date.now()
  await db.delete(repoLinks).where(and(eq(repoLinks.canvasId, canvasId), eq(repoLinks.userId, userId)))
  const row = {
    id: link.id,
    canvasId,
    userId,
    name: link.name.slice(0, 200),
    deviceId: link.deviceId,
    createdAt: now,
    lastUsedAt: now,
  }
  await db.insert(repoLinks).values(row)
  return toLink(row)
}

export async function deleteLink(userId: string, canvasId: string): Promise<boolean> {
  const rows = await db
    .delete(repoLinks)
    .where(and(eq(repoLinks.canvasId, canvasId), eq(repoLinks.userId, userId)))
    .returning({ id: repoLinks.id })
  return rows.length > 0
}

async function touchLink(linkId: string): Promise<void> {
  await db.update(repoLinks).set({ lastUsedAt: Date.now() }).where(eq(repoLinks.id, linkId))
}

/* ------------------------------------------------------------------ */
/* device dispatch                                                     */
/* ------------------------------------------------------------------ */

interface Device {
  id: string
  at: number
  /** link ids this device holds grants for — it may only claim those */
  grants: Set<string>
  /** set while a long-poll is waiting for work to arrive */
  waiter?: { resolve: (request: RepoRequest | null) => void }
}

interface Pending {
  id: string
  userId: string
  linkId: string
  op: RepoOp
  args: RepoRequest['args']
  createdAt: number
  /** the device the request was handed to */
  claimedBy?: string
  resolve: (result: RepoResult) => void
}

function job(p: Pending): RepoRequest {
  return { id: p.id, linkId: p.linkId, op: p.op, args: p.args }
}

export class LocalRepo {
  private devices = new Map<string, Device>()
  private pending = new Map<string, Pending>()

  online(userId: string, now = Date.now()): boolean {
    return now - (this.devices.get(userId)?.at ?? 0) < REPO_ONLINE_MS
  }

  /** The install currently polling for this user (the status row's view). */
  deviceFor(userId: string): { id: string; grants: Set<string> } | undefined {
    const device = this.devices.get(userId)
    return device && this.online(userId) ? device : undefined
  }

  /**
   * Register (or confirm) this device and answer a claimable request if one
   * waits, else hold the call open up to REPO_POLL_MS — the long-poll. One
   * device per user answers; a second install stands by like local agent's.
   */
  async poll(userId: string, deviceId: string, grantIds: string[], now = Date.now()): Promise<RepoRequest | null> {
    const current = this.devices.get(userId)
    if (current && current.id !== deviceId && this.online(userId, now)) return null
    const device: Device = { id: deviceId, at: now, grants: new Set(grantIds) }
    this.devices.set(userId, device)
    const ready = [...this.pending.values()].find(
      (p) => p.userId === userId && !p.claimedBy && device.grants.has(p.linkId),
    )
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
      }, REPO_POLL_MS)
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

  /**
   * Hand `op` to the device holding `linkId`'s grant and await its answer.
   * Fails fast when no polling device claims the link — the desktop app is
   * closed or holds another install's grants.
   */
  repoRequest(userId: string, linkId: string, op: RepoOp, args: RepoRequest['args']): Promise<RepoResult> {
    const device = this.devices.get(userId)
    if (!device || !this.online(userId) || !device.grants.has(linkId)) {
      return Promise.resolve({
        ok: false,
        error: "the linked project is unavailable — the doop desktop app holding it isn't online",
      })
    }
    const p: Pending = {
      id: randomUUID(),
      userId,
      linkId,
      op,
      args,
      createdAt: Date.now(),
      resolve: () => {},
    }
    this.pending.set(p.id, p)
    const done = new Promise<RepoResult>((resolve) => {
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
      new Promise<RepoResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              error: 'the linked project did not answer in time — is the desktop app still open?',
            }),
          REPO_REQUEST_TTL_MS,
        ).unref(),
      ),
    ]).then((result) => {
      this.pending.delete(p.id)
      return result
    })
  }

  /** The device posts the answer back; resolves the matching repoRequest. */
  finish(requestId: string, userId: string, deviceId: string, result: RepoResult): boolean {
    const p = this.pending.get(requestId)
    if (!p || p.userId !== userId || p.claimedBy !== deviceId) return false
    this.pending.delete(requestId)
    p.resolve(result)
    return true
  }

  /** Resolve unanswered requests and drop devices that stopped polling. */
  expire(now = Date.now()): void {
    for (const [id, p] of this.pending) {
      if (now - p.createdAt > REPO_REQUEST_TTL_MS) {
        this.pending.delete(id)
        p.resolve({ ok: false, error: 'the linked project did not answer in time' })
      }
    }
    for (const [userId, device] of this.devices) {
      if (now - device.at > REPO_ONLINE_MS + REPO_POLL_MS) {
        if (device.waiter) {
          device.waiter.resolve(null)
          device.waiter = undefined
        }
        this.devices.delete(userId)
      }
    }
  }
}

export const localRepo = new LocalRepo()
const cleanup = setInterval(() => localRepo.expire(), 5_000)
cleanup.unref()

/** Agent-side call: dispatch the read to the device and stamp the link used. */
export async function repoToolCall(
  userId: string,
  link: RepoLink,
  op: RepoOp,
  args: RepoRequest['args'],
): Promise<RepoResult> {
  const result = await localRepo.repoRequest(userId, link.id, op, args)
  if (result.ok) void touchLink(link.id).catch(() => {})
  return result
}

/* ------------------------------------------------------------------ */
/* routes — the device's end of the bridge                             */
/* ------------------------------------------------------------------ */

const pollSchema = z.object({
  deviceId: z.string().uuid(),
  grants: z.array(z.string().max(100)).max(200),
})
const finishSchema = z.object({
  deviceId: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(5_000).optional(),
})

export const localRepoRouter = Router()

localRepoRouter.post('/poll', (req, res, next) => {
  const parsed = pollSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid device' })
    return
  }
  const userId = req.user!.id
  const deviceId = parsed.data.deviceId
  req.on('close', () => localRepo.dropWaiter(userId, deviceId))
  localRepo
    .poll(userId, deviceId, parsed.data.grants)
    .then((request) => {
      if (!res.writableEnded) res.json({ request })
    })
    .catch(next)
})

localRepoRouter.post('/finish/:id', (req, res) => {
  const parsed = finishSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid result' })
    return
  }
  const { deviceId, ...result } = parsed.data
  const ok = localRepo.finish(req.params.id!, req.user!.id, deviceId, result)
  res.status(ok ? 200 : 409).json({ ok })
})
