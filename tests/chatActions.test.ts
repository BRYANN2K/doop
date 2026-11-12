import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatPlan } from '../shared/types.ts'

/* The chat queue and plan lifecycle against the real actions module: the
   ask claims only its payer on the default connection, the plan card goes
   proposed → approved → launched (one board card per screen, stamped with
   the editor who pressed Go design), and the plan-only tool executor never
   lets a chat run touch the canvas. */

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
const { execChatTool, chatTools, CHAT_READ_TOOL_NAMES, REPO_TOOLS } = await import('../server/resident.ts')
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

const PLAN: ChatPlan = {
  status: 'proposed',
  summary: 'A settings flow',
  screens: [
    { name: 'Settings — Profile', width: 1440, height: 900, outline: 'profile form' },
    { name: 'Settings — Billing', width: 1440, height: 900, outline: 'plan and invoices' },
  ],
  openQuestions: ['Light only, or dark too?'],
}

let canvasId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('chat', 'owner').id
})

const ask = (text: string, fromUserId = 'alice', agent = true) =>
  actions.postChatMessage(canvasId, { from: fromUserId, fromUserId, text: agent ? `@Doop ${text}` : text })!

describe('the ask joins the resident queue', () => {
  it('an @mention line is claimable work routed to the named agent', () => {
    const message = ask('design the onboarding')
    expect(message.forAgent).toBe(true)
    expect(message.targetAgent).toBe(AGENT)
    expect(actions.pendingWorkAgents(canvasId)).toEqual([AGENT])
    const work = actions.nextWork(canvasId, AGENT)
    expect(work).toMatchObject({ payer: 'alice', chat: true })
  })

  it('a plain human line is just chat — nothing to run', () => {
    ask('what do you think of this?', 'alice', false)
    expect(actions.pendingWorkAgents(canvasId)).toEqual([])
    expect(actions.nextWork(canvasId, AGENT)).toBeUndefined()
  })

  it('the oldest ask wins across work kinds', () => {
    const old = actions.postChatMessage(canvasId, {
      from: 'alice',
      fromUserId: 'alice',
      text: '@Doop first ask',
    })!
    /* backdate it behind a card queued later */
    old.at = 1000
    actions.addQueuedCard(canvasId, 'make a frame', 'bob', undefined, undefined, 'bob')
    const work = actions.nextWork(canvasId, AGENT)
    expect(work).toMatchObject({ payer: 'alice', chat: true })
  })
})

describe('the Chat tab talks to Doop', () => {
  it('an editor line with no @mention still asks the default agent', () => {
    const m = actions.postChatMessage(canvasId, { from: 'alice', fromUserId: 'alice', text: 'Test', askAgent: true })!
    expect(m.forAgent).toBe(true)
    expect(m.targetAgent).toBe(AGENT)
  })

  it('without askAgent a plain line stays with the room', () => {
    const m = actions.postChatMessage(canvasId, { from: 'carol', fromUserId: 'carol', text: 'hello' })!
    expect(m.forAgent).toBeUndefined()
  })
})

describe('claiming', () => {
  it('claims only this payer’s asks, oldest first', () => {
    const a1 = ask('one', 'alice')
    const b1 = ask('two', 'bob')
    const a2 = ask('three', 'alice')
    const claimed = actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')
    expect(claimed.map((m) => m.id)).toEqual([a1.id, a2.id])
    for (const m of claimed) expect(m.claimedBy).toBe(AGENT)
    expect(actions.findChatMessage(b1.id)?.claimedBy).toBeUndefined()
  })

  it('an ask with no pick rides the Settings default, never a named runner', () => {
    ask('one')
    expect(actions.takeChatAsksFor(canvasId, AGENT, 'alice', 'claude-local|model|')).toEqual([])
    expect(actions.nextWork(canvasId, AGENT)).toMatchObject({ chat: true })
  })

  it('an ask sent with the picker runs on that connection, and so does its plan', () => {
    const runner = { provider: 'chatgpt' as const, model: 'gpt-6-astra', effort: 'medium' }
    const picked = actions.postChatMessage(canvasId, {
      from: 'alice',
      fromUserId: 'alice',
      text: '@Doop plan the pricing page',
      runner,
    })!
    expect(picked.runner).toEqual(runner)
    expect(actions.nextWork(canvasId, AGENT)).toMatchObject({ chat: true, runner })
    /* the default run passes it over; the picked connection claims it */
    expect(actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')).toEqual([])
    const claimed = actions.takeChatAsksFor(canvasId, AGENT, 'alice', 'chatgpt|gpt-6-astra|medium')
    expect(claimed.map((m) => m.id)).toEqual([picked.id])
    /* Go design queues the screens on the same connection */
    const plan = actions.postChatMessage(canvasId, {
      from: AGENT,
      agent: true,
      threadId: picked.id,
      text: 'plan',
      runner,
      plan: {
        summary: 'Pricing',
        screens: [{ name: 'Pricing', width: 1440, height: 900, outline: 'tiers' }],
        openQuestions: [],
        status: 'proposed',
      } as unknown as ChatPlan,
    })!
    const cards = actions.launchChatPlan(plan, { name: 'alice', userId: 'alice' })
    expect(cards?.[0]?.runner).toEqual(runner)
  })

  it('answer and fail settle the ask; retry reopens a failed one', () => {
    const a = ask('one')
    const b = ask('two')
    actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')
    actions.answerChatAsk(a.id)
    expect(actions.findChatMessage(a.id)?.answeredAt).toBeTypeOf('number')
    actions.failChatAsk(b.id, 'boom')
    expect(actions.findChatMessage(b.id)?.failureReason).toBe('boom')
    expect(actions.nextWork(canvasId, AGENT)).toBeUndefined()
    const retried = actions.retryChatAsk(b.id)
    expect(retried?.failedAt).toBeUndefined()
    expect(retried?.claimedBy).toBeUndefined()
    expect(actions.nextWork(canvasId, AGENT)).toMatchObject({ chat: true })
    /* an answered ask cannot be retried */
    expect(actions.retryChatAsk(a.id)).toBeUndefined()
  })
})

describe('the plan card lifecycle', () => {
  const postPlan = (threadId?: string): ChatMessage =>
    actions.postChatMessage(canvasId, {
      from: AGENT,
      agent: true,
      text: PLAN.summary,
      plan: PLAN,
      ...(threadId ? { threadId } : {}),
    })!

  it('an edit approves the plan and keeps it launchable', () => {
    const message = postPlan()
    const edited = actions.editChatPlan(message.id, {
      summary: 'Tighter scope',
      screens: [PLAN.screens[0]!],
    })
    expect(edited?.plan?.status).toBe('approved')
    expect(edited?.plan?.summary).toBe('Tighter scope')
    expect(edited?.plan?.screens).toHaveLength(1)
  })

  it('Go design queues one board card per screen, stamped with the launcher', () => {
    const message = postPlan()
    const cards = actions.launchChatPlan(message, { name: 'Maya', userId: 'maya-id' })!
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(card.queuedBy).toBe('Maya')
      expect(card.queuedByUserId).toBe('maya-id')
      expect(card.status).toContain('From the design plan: A settings flow')
    }
    expect(cards[0]!.status).toContain('Settings — Profile')
    expect(cards[1]!.status).toContain('Settings — Billing')
    const launched = actions.findChatMessage(message.id)!.plan!
    expect(launched.status).toBe('launched')
    expect(launched.launchedBy).toBe('Maya')
    expect(launched.launchedByUserId).toBe('maya-id')
    expect(launched.taskIds).toEqual(cards.map((c) => c.id))
    /* a launched plan is closed: it never queues twice */
    expect(actions.launchChatPlan(actions.findChatMessage(message.id)!, { name: 'X', userId: 'x' })).toBeUndefined()
  })

  it('a cancel closes the plan without queueing anything', () => {
    const message = postPlan()
    const canceled = actions.cancelChatPlan(message.id)
    expect(canceled?.plan?.status).toBe('canceled')
    expect(actions.cancelChatPlan(message.id)).toBeUndefined()
    expect(actions.launchChatPlan(actions.findChatMessage(message.id)!, { name: 'X', userId: 'x' })).toBeUndefined()
    expect(actions.getTasks(canvasId)).toEqual([])
  })

  it('a new plan supersedes the thread’s still-open plans', () => {
    const first = postPlan()
    const second = postPlan(first.id)
    actions.reviseChatPlans(canvasId, first.id, second.id)
    expect(actions.findChatMessage(first.id)?.plan?.status).toBe('revised')
    expect(actions.findChatMessage(second.id)?.plan?.status).toBe('proposed')
  })
})

describe('the plan-only tool contract', () => {
  it('offers read tools and the two plan tools, never a write tool', () => {
    const names = chatTools(false).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['propose_plan', 'ask_in_chat', ...CHAT_READ_TOOL_NAMES]))
    for (const write of ['create_frame', 'set_tokens', 'set_guidelines', 'save_decision', 'update_frame']) {
      expect(names).not.toContain(write)
    }
    /* repo_* only when the asker linked a project */
    expect(names).not.toContain('repo_list')
    const linked = chatTools(true).map((t) => t.name)
    for (const tool of REPO_TOOLS) expect(linked).toContain(tool.name)
  })

  it('refuses a canvas write tool even if the model calls it anyway', async () => {
    const result = await execChatTool(
      call('create_frame', { name: 'X', width: 100, height: 100 }),
      canvasId,
      actor(),
      run(),
    )
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('Go design')
    expect(store.getCanvas(canvasId)?.frames).toEqual([])
  })

  it('propose_plan posts the card in the ask’s thread and ends the turn', async () => {
    const message = ask('design the onboarding')
    actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')
    const runState = run({ chatAsks: [message] })
    const result = await execChatTool(
      call('propose_plan', { summary: PLAN.summary, screens: PLAN.screens, open_questions: PLAN.openQuestions }),
      canvasId,
      actor(),
      runState,
    )
    expect(result.is_error).toBeUndefined()
    expect(runState.chatDone).toBe(true)
    const plan = actions.getChat(canvasId).find((m) => m.plan)
    expect(plan?.agent).toBe(true)
    expect(plan?.plan?.status).toBe('proposed')
    expect(plan?.threadId).toBe(message.id)
    /* one plan per run */
    const second = await execChatTool(
      call('propose_plan', { summary: 'again', screens: PLAN.screens }),
      canvasId,
      actor(),
      runState,
    )
    expect(second.is_error).toBe(true)
  })

  it('a malformed plan is a tool error, not a chat message', async () => {
    const result = await execChatTool(call('propose_plan', { summary: 'no screens' }), canvasId, actor(), run())
    expect(result.is_error).toBe(true)
    expect(actions.getChat(canvasId)).toEqual([])
  })

  it('ask_in_chat posts the question and ends the turn', async () => {
    const message = ask('redo the dashboard')
    actions.takeChatAsksFor(canvasId, AGENT, 'alice', '')
    const runState = run({ chatAsks: [message] })
    const result = await execChatTool(
      call('ask_in_chat', { question: 'Mobile or desktop first?' }),
      canvasId,
      actor(),
      runState,
    )
    expect(result.is_error).toBeUndefined()
    expect(runState.chatDone).toBe(true)
    const question = actions.getChat(canvasId).find((m) => m.agent)
    expect(question?.text).toBe('Mobile or desktop first?')
    expect(question?.threadId).toBe(message.id)
  })
})
