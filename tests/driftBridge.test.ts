import { expect, it } from 'vitest'
import { LocalDrift, localFetchFor } from '../server/driftBridge.ts'
import type { DriftFetchResult } from '../shared/drift.ts'

/** The local-drift bridge's dispatcher — pure in-memory, no db. No grants:
 *  any online device of the user may serve a fetch, but it is pinned to the
 *  capture's origin by localFetchFor. */

const ok = (body: string): DriftFetchResult => ({ ok: true, status: 200, body: Buffer.from(body).toString('base64') })

it('hands a pending fetch to the user’s online device', async () => {
  const bridge = new LocalDrift()
  const polling = bridge.poll('u1', 'dev-1')
  const asked = bridge.fetch('u1', { url: 'http://localhost:3000/app.js', method: 'GET', headers: {} })
  const request = await polling
  expect(request?.url).toBe('http://localhost:3000/app.js')
  expect(bridge.finish(request!.id, 'u1', 'dev-1', ok('js'))).toBe(true)
  await expect(asked).resolves.toMatchObject({ ok: true, status: 200 })
})

it('fails fast when no device is online', async () => {
  const bridge = new LocalDrift()
  const result = await bridge.fetch('u1', { url: 'http://localhost:3000', method: 'GET', headers: {} })
  expect(result.ok).toBe(false)
  expect(result.error).toMatch(/isn't online/)
})

it('keeps one active device per user; a second install stands by', async () => {
  const bridge = new LocalDrift()
  const first = bridge.poll('u1', 'dev-1')
  const second = bridge.poll('u1', 'dev-2')
  const asked = bridge.fetch('u1', { url: 'http://localhost:3000', method: 'GET', headers: {} })
  const request = (await first)!
  bridge.dropWaiter('u1', 'dev-2')
  await expect(second).resolves.toBeNull()
  bridge.finish(request.id, 'u1', 'dev-1', ok('x'))
  await expect(asked).resolves.toMatchObject({ ok: true })
})

it('refuses finish from the wrong device or user', async () => {
  const bridge = new LocalDrift()
  const polling = bridge.poll('u1', 'dev-1')
  const asked = bridge.fetch('u1', { url: 'http://localhost:3000', method: 'GET', headers: {} })
  const request = (await polling)!
  expect(bridge.finish(request.id, 'u1', 'dev-2', ok('x'))).toBe(false)
  expect(bridge.finish(request.id, 'u2', 'dev-1', ok('x'))).toBe(false)
  expect(bridge.finish('nope', 'u1', 'dev-1', ok('x'))).toBe(false)
  expect(bridge.finish(request.id, 'u1', 'dev-1', ok('late'))).toBe(true)
  await expect(asked).resolves.toMatchObject({ ok: true })
})

it('localFetchFor pins every request to the capture origin', async () => {
  /* localFetchFor proxies through the module-level singleton */
  const { localDrift } = await import('../server/driftBridge.ts')
  const polling = localDrift.poll('u1', 'dev-1')
  const fetch = localFetchFor('u1', 'http://localhost:3000', () => true)
  await expect(fetch('https://evil.example/x')).rejects.toThrow(/off-origin/)
  const response = fetch('http://localhost:3000/app.js')
  const request = await polling
  expect(request?.url).toBe('http://localhost:3000/app.js')
  localDrift.finish(request!.id, 'u1', 'dev-1', ok('hello'))
  expect(await (await response).text()).toBe('hello')
})

it('localFetchFor refuses once the per-capture budget is spent', async () => {
  const fetch = localFetchFor('u1', 'http://localhost:3000', () => false)
  await expect(fetch('http://localhost:3000/app.js')).rejects.toThrow(/budget/)
})
