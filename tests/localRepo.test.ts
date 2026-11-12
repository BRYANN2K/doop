import { expect, it } from 'vitest'
import { LocalRepo } from '../server/localRepo.ts'
import { REPO_ONLINE_MS, REPO_REQUEST_TTL_MS } from '../shared/localRepo.ts'

/** The local-repo bridge's dispatcher — pure in-memory, no db: a device
 *  polls with the grant ids it holds, requests are handed only to a device
 *  claiming that link, and answers come back through finish. */

const LINK = 'link-1'

it('hands a pending request to the polling grant holder', async () => {
  const repo = new LocalRepo()
  const polling = repo.poll('u1', 'dev-1', [LINK])
  const asked = repo.repoRequest('u1', LINK, 'list', { subdir: 'src' })
  const request = await polling
  expect(request).toMatchObject({ linkId: LINK, op: 'list', args: { subdir: 'src' } })
  expect(repo.finish(request!.id, 'u1', 'dev-1', { ok: true, result: { entries: [] } })).toBe(true)
  await expect(asked).resolves.toEqual({ ok: true, result: { entries: [] } })
})

it('fails fast when no device holds the grant', async () => {
  const repo = new LocalRepo()
  // device online but holding another link's grant
  void repo.poll('u1', 'dev-1', ['other-link'])
  const result = await repo.repoRequest('u1', LINK, 'read', { paths: ['a.ts'] })
  expect(result.ok).toBe(false)
  expect(result.error).toMatch(/isn't online/)
})

it('answers immediately to no device at all', async () => {
  const repo = new LocalRepo()
  const result = await repo.repoRequest('u1', LINK, 'search', { query: 'x' })
  expect(result.ok).toBe(false)
})

it('claims an unclaimed pending on the next poll', async () => {
  const repo = new LocalRepo()
  const polling = repo.poll('u1', 'dev-1', [LINK])
  repo.dropWaiter('u1', 'dev-1') // the app left before work arrived
  await expect(polling).resolves.toBeNull()
  const asked = repo.repoRequest('u1', LINK, 'list', {})
  const request = await repo.poll('u1', 'dev-1', [LINK])
  expect(request?.op).toBe('list')
  repo.finish(request!.id, 'u1', 'dev-1', { ok: true, result: {} })
  await expect(asked).resolves.toEqual({ ok: true, result: {} })
})

it('only hands a pending to a device advertising its grant', async () => {
  const repo = new LocalRepo()
  const polling = repo.poll('u1', 'dev-1', [LINK])
  repo.dropWaiter('u1', 'dev-1')
  await polling
  const asked = repo.repoRequest('u1', LINK, 'list', {})
  // the same install, now not advertising the grant: the pending stays
  const none = repo.poll('u1', 'dev-1', [])
  repo.dropWaiter('u1', 'dev-1')
  await expect(none).resolves.toBeNull()
  // polling again with the grant picks it up
  const request = await repo.poll('u1', 'dev-1', [LINK])
  expect(request?.linkId).toBe(LINK)
  repo.finish(request!.id, 'u1', 'dev-1', { ok: true, result: 1 })
  await expect(asked).resolves.toEqual({ ok: true, result: 1 })
})

it('refuses finish from the wrong device or user', async () => {
  const repo = new LocalRepo()
  const polling = repo.poll('u1', 'dev-1', [LINK])
  const asked = repo.repoRequest('u1', LINK, 'list', {})
  const request = (await polling)!
  expect(repo.finish(request.id, 'u1', 'dev-2', { ok: true })).toBe(false)
  expect(repo.finish(request.id, 'u2', 'dev-1', { ok: true })).toBe(false)
  expect(repo.finish('nope', 'u1', 'dev-1', { ok: true })).toBe(false)
  // the real answer still lands
  expect(repo.finish(request.id, 'u1', 'dev-1', { ok: true, result: 'late' })).toBe(true)
  await expect(asked).resolves.toEqual({ ok: true, result: 'late' })
})

it('keeps one active device per user; a second install stands by', async () => {
  const repo = new LocalRepo()
  const first = repo.poll('u1', 'dev-1', [LINK])
  const second = repo.poll('u1', 'dev-2', [LINK])
  // dev-2 can't register while dev-1 is fresh — it answers empty at once
  await expect(second).resolves.toBeNull()
  repo.dropWaiter('u1', 'dev-1')
  await first
  // once dev-1 goes quiet, dev-2 takes over
  repo.expire(Date.now() + REPO_ONLINE_MS + 30_000)
  const polling = repo.poll('u1', 'dev-2', [LINK])
  repo.dropWaiter('u1', 'dev-2')
  await expect(polling).resolves.toBeNull()
  expect(repo.deviceFor('u1')?.id).toBe('dev-2')
})

it('reports online status and resolves expired requests', async () => {
  const repo = new LocalRepo()
  expect(repo.online('u1')).toBe(false)
  const polling = repo.poll('u1', 'dev-1', [LINK])
  repo.dropWaiter('u1', 'dev-1')
  await polling
  expect(repo.online('u1')).toBe(true)
  expect(repo.deviceFor('u1')?.grants.has(LINK)).toBe(true)
  // an unanswered request outlives its TTL through the sweep, not the poll
  const asked = repo.repoRequest('u1', LINK, 'read', { paths: ['a'] })
  repo.expire(Date.now() + REPO_REQUEST_TTL_MS + 1)
  const result = await asked
  expect(result.ok).toBe(false)
  expect(result.error).toMatch(/did not answer/)
  // and the device is forgotten once it stops polling
  repo.expire(Date.now() + REPO_ONLINE_MS + 60_000)
  expect(repo.online('u1')).toBe(false)
})
