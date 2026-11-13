import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatPlan, ChatPlanReference, Frame } from '../shared/types.ts'

/* The reference library contract: find_references never leaves the asker's
   designated canvases, a plan's references must point inside them, removing
   one is a human edit, and Go design carries the survivors onto the cards. */

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveChatMessage: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

/* a posted ask would wake the real sweep; the run itself is not under test */
vi.mock('../server/resident.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/resident.ts')>()
  return { ...mod, onFeedback: () => {} }
})

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { execChatTool, execTool, chatTools } = await import('../server/resident.ts')
const { cleanChatPlan, chatPlanCardTitle } = await import('../shared/chat.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const actor = () => actions.resolveActor({ name: AGENT, kind: 'agent' })
const run = (extra: Record<string, unknown> = {}) => ({
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
  chatDone: false,
  ...extra,
})
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

let canvasId: string
let libraryId: string
let otpFrame: Frame

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('chat', 'owner').id
  /* the asker's library: alice's "Design Library" canvas with an OTP sheet
     the plans will reference */
  libraryId = store.createCanvas('Design Library', 'alice').id
  otpFrame = actions.createFrame(
    libraryId,
    {
      name: 'OTP input sheet',
      width: 400,
      height: 600,
      html: '<main><h1>cp.vui-otp-input</h1><div class="otp-input">Enter the 6 digits</div></main>',
    },
    actor(),
    { reveal: false },
  )!
})

const library = () => [{ id: libraryId, name: 'Design Library' }]

const libraryRef = (over: Partial<ChatPlanReference> = {}): ChatPlanReference => ({
  libraryId: `${libraryId}:${otpFrame.id}`,
  canvasId: libraryId,
  frameId: otpFrame.id,
  label: 'OTP input sheet',
  why: 'the otp step builds on it',
  ...over,
})

const planInput = (references: ChatPlanReference[] | undefined = [libraryRef()]) => ({
  summary: 'Login flow',
  screens: [
    { name: 'Login — OTP', width: 390, height: 844, outline: 'enter the code', ...(references ? { references } : {}) },
  ],
})

const ask = (text: string, fromUserId = 'alice') =>
  actions.postChatMessage(canvasId, { from: fromUserId, fromUserId, text: `@Doop ${text}` })!

const proposePlan = async (input: unknown, runState: ReturnType<typeof run>) =>
  execChatTool(call('propose_plan', input), canvasId, actor(), runState)

const postedPlan = () => actions.getChat(canvasId).find((m) => m.plan)

describe('the tool list', () => {
  it('find_references is offered only when the asker designated a library', () => {
    expect(chatTools(false).map((t) => t.name)).not.toContain('find_references')
    expect(chatTools(true).map((t) => t.name)).not.toContain('find_references')
    expect(chatTools(false, true).map((t) => t.name)).toContain('find_references')
  })
})

describe('find_references stays inside the library', () => {
  it('finds library frames and reports the ids a plan needs', async () => {
    const result = await execChatTool(
      call('find_references', { query: 'otp' }),
      canvasId,
      actor(),
      run({ libraryCanvases: library() }),
    )
    expect(result.is_error).toBeUndefined()
    const found = JSON.parse(String(result.content))
    expect(found.hits).toContainEqual(
      expect.objectContaining({ canvas_id: libraryId, frame_id: otpFrame.id, frame_name: 'OTP input sheet' }),
    )
    expect(found.hits[0].thumbnail).toBe(`/i/${otpFrame.id}.jpg?preview`)
    expect(found.hits[0].url).toBe(`/c/${libraryId}?frame=${otpFrame.id}`)
  })

  it('never searches a canvas outside the library', async () => {
    const otherId = store.createCanvas('Other', 'alice').id
    actions.createFrame(otherId, { name: 'OTP elsewhere', html: '<main>otp</main>' }, actor(), { reveal: false })
    const result = await execChatTool(
      call('find_references', { query: 'otp' }),
      canvasId,
      actor(),
      run({ libraryCanvases: library() }),
    )
    const found = JSON.parse(String(result.content))
    expect(found.hits.some((h: { canvas_id: string }) => h.canvas_id === otherId)).toBe(false)
    expect(found.hits.some((h: { canvas_id: string }) => h.canvas_id === canvasId)).toBe(false)
  })

  it('refuses to run when the asker has no library', async () => {
    const result = await execChatTool(call('find_references', { query: 'otp' }), canvasId, actor(), run())
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('reference library')
  })
})

describe('propose_plan validates references against the library', () => {
  it('posts a plan whose references live inside the library', async () => {
    const message = ask('design the login')
    actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')
    const result = await proposePlan(planInput(), run({ chatAsks: [message], libraryCanvases: library() }))
    expect(result.is_error).toBeUndefined()
    const refs = postedPlan()?.plan?.screens[0]?.references
    expect(refs).toHaveLength(1)
    expect(refs?.[0]).toMatchObject({ canvasId: libraryId, frameId: otpFrame.id, label: 'OTP input sheet' })
  })

  it('rejects a reference to a canvas outside the library', async () => {
    const message = ask('design the login')
    actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')
    /* the chat canvas itself is not library — pointing at it must fail */
    const ref = libraryRef({ canvasId, libraryId: `${canvasId}:${otpFrame.id}` })
    const result = await proposePlan(planInput([ref]), run({ chatAsks: [message], libraryCanvases: library() }))
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('not in the asker')
    expect(postedPlan()).toBeUndefined()
  })

  it('rejects a reference to a frame the library canvas does not have', async () => {
    const message = ask('design the login')
    actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')
    const ref = libraryRef({ frameId: 'nosuchframe', libraryId: `${libraryId}:nosuchframe` })
    const result = await proposePlan(planInput([ref]), run({ chatAsks: [message], libraryCanvases: library() }))
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('does not exist')
    expect(postedPlan()).toBeUndefined()
  })

  it('rejects references when the asker has no library at all', async () => {
    const message = ask('design the login')
    actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')
    const result = await proposePlan(planInput(), run({ chatAsks: [message] }))
    expect(result.is_error).toBe(true)
    expect(postedPlan()).toBeUndefined()
  })
})

describe('removing a reference', () => {
  const postPlanWithRefs = (refs: ChatPlanReference[]): ChatMessage =>
    actions.postChatMessage(canvasId, {
      from: AGENT,
      agent: true,
      text: 'Login flow',
      plan: { ...planInput(refs), status: 'proposed' } as ChatPlan,
    })!

  it('drops just that reference and marks the plan approved', () => {
    const second = { ...libraryRef({ frameId: otpFrame.id }), libraryId: `${libraryId}:other`, label: 'Second' }
    const message = postPlanWithRefs([libraryRef(), second])
    const updated = actions.removeChatPlanReference(message.id, 0, libraryRef().libraryId)!
    expect(updated.plan?.status).toBe('approved')
    expect(updated.plan?.screens[0]?.references).toEqual([second])
  })

  it('removes the field when the last reference goes', () => {
    const message = postPlanWithRefs([libraryRef()])
    const updated = actions.removeChatPlanReference(message.id, 0, libraryRef().libraryId)!
    expect(updated.plan?.screens[0]?.references).toBeUndefined()
  })

  it('ignores an unknown reference, a bad screen, and a closed plan', () => {
    const message = postPlanWithRefs([libraryRef()])
    expect(actions.removeChatPlanReference(message.id, 0, 'nope')).toBeUndefined()
    expect(actions.removeChatPlanReference(message.id, 5, libraryRef().libraryId)).toBeUndefined()
    actions.cancelChatPlan(message.id)
    expect(actions.removeChatPlanReference(message.id, 0, libraryRef().libraryId)).toBeUndefined()
  })

  it('a dropped reference never reaches the screen’s card', () => {
    const kept = { ...libraryRef(), libraryId: `${libraryId}:kept`, label: 'Kept' }
    const message = postPlanWithRefs([libraryRef(), kept])
    actions.removeChatPlanReference(message.id, 0, libraryRef().libraryId)
    const cards = actions.launchChatPlan(actions.findChatMessage(message.id)!, { name: 'Maya', userId: 'maya' })!
    expect(cards).toHaveLength(1)
    expect(cards[0]!.references).toEqual([kept])
    expect(cards[0]!.status).not.toContain('OTP input sheet')
  })
})

describe('Go design carries the approved references', () => {
  it('queues a card per screen with its references, in the title and the field', () => {
    const message = actions.postChatMessage(canvasId, {
      from: AGENT,
      agent: true,
      text: 'Login flow',
      plan: { ...planInput(), status: 'proposed' } as ChatPlan,
    })!
    const cards = actions.launchChatPlan(message, { name: 'Maya', userId: 'maya' })!
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.references).toEqual([libraryRef()])
    expect(card.status).toContain(`canvas_id=${libraryId}`)
    expect(card.status).toContain(`frame_id=${otpFrame.id}`)
    expect(card.status).toContain('get_frame_html')
  })
})

describe('find_in_canvas on a design run', () => {
  it('searches this canvas with no canvas_id', async () => {
    const local = actions.createFrame(canvasId, { name: 'Pricing page', html: '<main>pricing tiers</main>' }, actor(), {
      reveal: false,
    })!
    const result = await execTool(call('find_in_canvas', { query: 'pricing' }), canvasId, actor(), run())
    expect(result.is_error).toBeUndefined()
    const found = JSON.parse(String(result.content))
    expect(found.hits).toContainEqual(expect.objectContaining({ frame_id: local.id, frame_name: 'Pricing page' }))
  })

  it('searches a library canvas the requester can read, and refuses one they cannot', async () => {
    const allowed = await execTool(
      call('find_in_canvas', { query: 'otp', canvas_id: libraryId }),
      canvasId,
      actor(),
      run({ payerId: 'alice' }),
    )
    expect(allowed.is_error).toBeUndefined()
    expect(JSON.parse(String(allowed.content)).hits[0]).toMatchObject({ frame_id: otpFrame.id })
    const denied = await execTool(
      call('find_in_canvas', { query: 'otp', canvas_id: libraryId }),
      canvasId,
      actor(),
      run({ payerId: 'bob' }),
    )
    expect(denied.is_error).toBe(true)
    expect(String(denied.content)).toContain('is not one the requester can read')
  })
})

describe('the design run reads library frames across canvases', () => {
  it('opens a frame on another canvas the requester can read', async () => {
    const result = await execTool(
      call('get_frame_html', { frame_id: otpFrame.id, canvas_id: libraryId }),
      canvasId,
      actor(),
      run({ payerId: 'alice' }),
    )
    expect(result.is_error).toBeUndefined()
    expect(String(result.content)).toContain('cp.vui-otp-input')
  })

  it('refuses a canvas the requester cannot read — and refuses with no payer', async () => {
    for (const runState of [run({ payerId: 'bob' }), run()]) {
      const result = await execTool(
        call('get_frame_html', { frame_id: otpFrame.id, canvas_id: libraryId }),
        canvasId,
        actor(),
        runState,
      )
      expect(result.is_error).toBe(true)
      expect(String(result.content)).toContain('is not one the requester can read')
    }
  })

  it('still serves this canvas’s frames with no canvas_id', async () => {
    const local = actions.createFrame(canvasId, { name: 'Local', html: '<main>local</main>' }, actor(), {
      reveal: false,
    })!
    const result = await execTool(call('get_frame_html', { frame_id: local.id }), canvasId, actor(), run())
    expect(result.is_error).toBeUndefined()
    expect(String(result.content)).toContain('local')
  })

  it('reports a frame the named canvas does not hold', async () => {
    const result = await execTool(
      call('get_frame_html', { frame_id: 'nosuchframe', canvas_id: libraryId }),
      canvasId,
      actor(),
      run({ payerId: 'alice' }),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('not found')
  })
})

describe('plan cleaning and the card brief', () => {
  it('keeps well-formed references and mints a libraryId', () => {
    const plan = cleanChatPlan({
      summary: 's',
      screens: [
        {
          name: 'n',
          width: 390,
          height: 844,
          outline: 'o',
          references: [{ canvas_id: 'lib', frame_id: 'f1', label: 'Sheet', why: 'base' }],
        },
      ],
    })!
    expect(plan.screens[0]?.references?.[0]).toEqual({
      libraryId: 'lib:f1',
      canvasId: 'lib',
      frameId: 'f1',
      label: 'Sheet',
      why: 'base',
    })
  })

  it('drops malformed references but keeps the screen', () => {
    const plan = cleanChatPlan({
      summary: 's',
      screens: [
        {
          name: 'n',
          width: 390,
          height: 844,
          outline: 'o',
          references: [{ frame_id: 'f1' }, 'junk', { canvas_id: 'lib', frame_id: 'f1', label: 'L', why: 'w' }],
        },
      ],
    })!
    expect(plan.screens[0]?.references).toHaveLength(1)
  })

  it('the card brief names every approved reference and how to open it', () => {
    const plan = { ...planInput(), status: 'proposed' } as ChatPlan
    const title = chatPlanCardTitle(plan, plan.screens[0]!)
    expect(title).toContain('"OTP input sheet"')
    expect(title).toContain(`canvas_id=${libraryId}`)
    expect(title).toContain(`frame_id=${otpFrame.id}`)
    expect(title).toContain('the otp step builds on it')
    expect(title).toContain('get_frame_html')
  })
})
