import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { referenceLibrary } from './db/schema.ts'
import { canvasesFor } from './workspaces.ts'

/**
 * The reference library: the canvases a user marked "the design system lives
 * here" in Settings. The chat run searches only these canvases with
 * find_references, a plan's references must point inside them, and Go design
 * hands the approved frames to the design agent as its base.
 *
 * Per user, like repo_links: a plan is built from the ASKER's library — a
 * collaborator's references never read a library they cannot open, since
 * every stored id is checked against what the user can still reach.
 */

export const LIBRARY_MAX_CANVASES = 8

/** The stored canvas ids, in the order they were picked. No row = no library. */
export async function getLibraryCanvasIds(userId: string): Promise<string[]> {
  const [row] = await db.select().from(referenceLibrary).where(eq(referenceLibrary.userId, userId))
  return row?.canvasIds ?? []
}

export async function setLibraryCanvasIds(userId: string, canvasIds: string[]): Promise<void> {
  const row = { userId, canvasIds, updatedAt: Date.now() }
  await db.insert(referenceLibrary).values(row).onConflictDoUpdate({ target: referenceLibrary.userId, set: row })
}

/** The library as it can be shown or searched right now: stored order,
 *  reduced to the canvases the user can still open — a deleted canvas or a
 *  revoked share simply drops out of the list. */
export async function libraryFor(userId: string): Promise<{ id: string; name: string; frameCount: number }[]> {
  const ids = await getLibraryCanvasIds(userId)
  if (!ids.length) return []
  const reachable = new Map(canvasesFor(userId).map((meta) => [meta.id, meta]))
  return ids.flatMap((id) => {
    const meta = reachable.get(id)
    return meta ? [{ id: meta.id, name: meta.name, frameCount: meta.frameCount }] : []
  })
}
