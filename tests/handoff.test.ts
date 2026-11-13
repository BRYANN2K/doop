import { describe, expect, it, vi } from 'vitest'

/* The pack builder reads the in-memory store; persistence is mocked away
   like the other store-level tests. The frame renderer is injected — no
   Chromium needed to check the pack's shape. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
}))

const { store } = await import('../server/store.ts')
const { buildHandoffPack, HandoffError } = await import('../server/handoff.ts')
const { HANDOFF_CHANGE_ID, HANDOFF_MAX_FRAMES, base64ByteLength, handoffFilesProblem, newHandoffChangeId } =
  await import('../shared/handoff.ts')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const renderPng = async () => PNG

function seedCanvas(name = 'Checkout') {
  const canvas = store.createCanvas(name, 'bryan')
  const home = store.createFrame(
    canvas.id,
    { name: 'Home', html: '<h1>Welcome</h1>', width: 1440, height: 900 },
    'bryan',
  )!
  const cart = store.createFrame(canvas.id, { name: 'Cart', html: '<p>3 items</p>', width: 390, height: 844 }, 'bryan')!
  return { canvas, home, cart }
}

describe('shared/handoff', () => {
  it('mints slug change ids', () => {
    const id = newHandoffChangeId('Écran Panier — v2!', () => 'a1b2')
    expect(id).toBe('ecran-panier-v2-a1b2')
    expect(HANDOFF_CHANGE_ID.test(id)).toBe(true)
    expect(newHandoffChangeId('!!!', () => 'dead')).toBe('change-dead')
  })

  it('refuses files outside the change folder, duplicates and bad shapes', () => {
    const id = 'my-change-1'
    const spec = { path: `.workflow/changes/${id}/spec.md`, text: '# S' }
    expect(handoffFilesProblem(id, [spec])).toBeNull()
    expect(handoffFilesProblem('Bad_ID', [spec])).toMatch(/slug/)
    expect(handoffFilesProblem(id, [])).toMatch(/no files/)
    expect(handoffFilesProblem(id, [{ path: 'spec.md', text: 'x' }])).toMatch(/start with/)
    expect(handoffFilesProblem(id, [{ path: `.workflow/changes/${id}/../evil.md`, text: 'x' }])).toBeTruthy()
    expect(handoffFilesProblem(id, [spec, spec])).toMatch(/duplicate/)
    expect(handoffFilesProblem(id, [{ path: `.workflow/changes/${id}/a.md` }])).toMatch(/exactly one/)
    expect(handoffFilesProblem(id, [{ path: `.workflow/changes/${id}/a.md`, text: 'x', base64: 'eA==' }])).toMatch(
      /exactly one/,
    )
    expect(handoffFilesProblem(id, [{ path: `.workflow/changes/${id}/a.png`, base64: 'not b64!!' }])).toMatch(/base64/)
  })

  it('measures base64 payloads', () => {
    expect(base64ByteLength('eA==')).toBe(1)
    expect(base64ByteLength(PNG.toString('base64'))).toBe(PNG.length)
    expect(base64ByteLength('not b64!!')).toBeNull()
    expect(base64ByteLength('abc')).toBeNull() /* not a multiple of 4 */
  })
})

describe('buildHandoffPack', () => {
  it('builds a Stip-shaped pack from named frames', async () => {
    const { canvas, home } = seedCanvas()
    const pack = await buildHandoffPack(canvas.id, { frameIds: [home.id], renderPng })
    expect(pack.changeId).toMatch(HANDOFF_CHANGE_ID)
    expect(pack.dir).toBe(`.workflow/changes/${pack.changeId}`)
    expect(handoffFilesProblem(pack.changeId, pack.files)).toBeNull()
    const paths = pack.files.map((f) => f.path.replace(`${pack.dir}/`, '')).sort()
    expect(paths).toContain('proposal.md')
    expect(paths).toContain('spec.md')
    expect(paths).toContain('tasks.md')
    expect(paths).toContain('state.json')
    expect(paths).toContain('evidence.md')
    expect(paths).toContain('assets/01-home.png')
    /* spec carries AC-n criteria and the frame's deep link */
    expect(pack.spec).toMatch(/- AC-1: /)
    expect(pack.spec).toContain(`/c/${canvas.id}?frame=${home.id}`)
    expect(pack.proposal).toContain(`/c/${canvas.id}?frame=${home.id}`)
    /* state.json mirrors Stip's explore output */
    const state = JSON.parse(pack.files.find((f) => f.path.endsWith('state.json'))!.text!)
    expect(state).toMatchObject({ schema_version: 1, id: pack.changeId, phase: 'exploring', target_before: null })
    /* the PNG lands as base64 */
    const png = pack.files.find((f) => f.path.endsWith('.png'))!
    expect(Buffer.from(png.base64!, 'base64')).toEqual(PNG)
    expect(pack.draftedBy).toBe('template')
  })

  it('falls back to every non-demo frame, capped, with a warning', async () => {
    const { canvas } = seedCanvas()
    for (let i = 0; i < 8; i++) store.createFrame(canvas.id, { name: `Screen ${i}` }, 'bryan')
    store.createFrame(canvas.id, { name: 'Demo', demo: true }, 'bryan')
    const pack = await buildHandoffPack(canvas.id, { renderPng })
    expect(pack.files.filter((f) => f.path.endsWith('.png'))).toHaveLength(HANDOFF_MAX_FRAMES)
    expect(pack.warnings.some((w) => w.includes(`${HANDOFF_MAX_FRAMES}`))).toBe(true)
    expect(pack.files.some((f) => f.path.includes('demo'))).toBe(false)
  })

  it('drafts from a plan, matching its screens to frames by name', async () => {
    const { canvas, home } = seedCanvas()
    const pack = await buildHandoffPack(canvas.id, {
      renderPng,
      plan: {
        status: 'launched',
        summary: 'Rebuild the storefront',
        screens: [{ name: 'Home', width: 1440, height: 900, outline: 'hero + grid' }],
        openQuestions: ['Which checkout provider?'],
      } as never,
    })
    expect(pack.proposal).toContain('Rebuild the storefront')
    expect(pack.proposal).toContain('Which checkout provider?')
    expect(pack.files.some((f) => f.path.endsWith('assets/01-home.png'))).toBe(true)
    expect(pack.spec).toContain(`/c/${canvas.id}?frame=${home.id}`)
    expect(pack.spec).toContain('open questions')
  })

  it('lets the caller write the contract (the MCP path)', async () => {
    const { canvas } = seedCanvas()
    const pack = await buildHandoffPack(canvas.id, {
      renderPng,
      docs: { spec: '# Mine\n\n- AC-1: custom criterion\n' },
    })
    expect(pack.spec).toBe('# Mine\n\n- AC-1: custom criterion\n')
    expect(pack.files.find((f) => f.path.endsWith('/spec.md'))!.text).toBe(pack.spec)
    /* the untouched docs still get drafted */
    expect(pack.proposal).toContain('## Problem')
  })

  it('honours a caller-picked change id', async () => {
    const { canvas } = seedCanvas()
    const pack = await buildHandoffPack(canvas.id, { renderPng, changeId: 'billing-screen-01' })
    expect(pack.changeId).toBe('billing-screen-01')
    await expect(buildHandoffPack(canvas.id, { renderPng, changeId: 'Nope' })).rejects.toThrow(HandoffError)
  })

  it('warns rather than fails when a render blows up', async () => {
    const { canvas } = seedCanvas()
    const pack = await buildHandoffPack(canvas.id, {
      renderPng: (f) => (f.name === 'Home' ? Promise.reject(new Error('no browser')) : renderPng()),
    })
    expect(pack.warnings.some((w) => w.includes('no browser'))).toBe(true)
    /* Home kept its criterion from the frame link instead of the export */
    expect(pack.spec).toContain('Home')
    expect(pack.files.filter((f) => f.path.endsWith('.png'))).toHaveLength(1)
  })

  it('reads an existing target spec for state.json target_before', async () => {
    const { canvas } = seedCanvas()
    const pack = await buildHandoffPack(canvas.id, {
      renderPng,
      changeId: 'existing-change',
      readRepo: async (paths) => ({
        files: paths.map((p) => ({ path: p, text: '# old spec' })),
        truncated: false,
      }),
    })
    const state = JSON.parse(pack.files.find((f) => f.path.endsWith('state.json'))!.text!)
    expect(state.target_before).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fails empty-handed: no canvas, nothing to hand off', async () => {
    await expect(buildHandoffPack('nope', {})).rejects.toMatchObject({ status: 404 })
    const empty = store.createCanvas('empty', 'bryan')
    await expect(buildHandoffPack(empty.id, { frameIds: ['ghost'] })).rejects.toThrow(/nothing to hand off/)
  })
})
