// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, ChatMessage, ChatPlan } from '../shared/types'

const calls = vi.hoisted(() => ({
  launchChatPlan: vi.fn(() => Promise.resolve({})),
  cancelChatPlan: vi.fn(() => Promise.resolve({})),
  editChatPlan: vi.fn(() => Promise.resolve({})),
  sendChat: vi.fn(() => Promise.resolve({})),
  retryChatAsk: vi.fn(() => Promise.resolve({})),
}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/TeamAllowance', () => ({ isResidentLimit: () => false }))
vi.mock('../src/lib/localRepo', () => ({
  useLocalRepo: (select: (s: { status: Record<string, never> }) => unknown) => select({ status: {} }),
  refreshLocalRepo: vi.fn(() => Promise.resolve({ link: null, online: false, sameDevice: false })),
}))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { ChatPanel } = await import('../src/components/ChatPanel')
const { useStore } = await import('../src/lib/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function canvasWith(role: 'edit' | 'comment' | 'view') {
  return { id: 'c', role, pages: [{ id: 'p', name: 'Page' }], frames: [] } as unknown as Canvas
}

function planMessage(plan: Partial<ChatPlan> = {}): ChatMessage {
  return {
    id: 'm1',
    canvasId: 'c',
    from: 'Doop',
    agent: true,
    text: 'Here is what I would build.',
    at: 2,
    plan: {
      summary: 'A landing page and a pricing sheet.',
      screens: [
        { name: 'Landing', width: 1280, height: 800, outline: 'hero, features, footer' },
        { name: 'Pricing', width: 1280, height: 800, outline: 'three tiers' },
      ],
      openQuestions: ['Which brand font?'],
      status: 'proposed',
      ...plan,
    },
  }
}

function button(text: string) {
  return [...container.querySelectorAll('button')].find((el) => el.textContent === text)
}

it('shows an open plan with its screens and the editor actions', () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [planMessage()] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('A landing page and a pricing sheet.')
  expect(container.textContent).toContain('Landing')
  expect(container.textContent).toContain('1280×800')
  expect(container.textContent).toContain('Which brand font?')
  expect(container.textContent).toContain('proposed')
  expect(button('Go design')).toBeTruthy()
  expect(button('Edit')).toBeTruthy()
  expect(button('Revise')).toBeTruthy()
  expect(button('Cancel')).toBeTruthy()
})

it('Go design launches the plan for the message id', async () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [planMessage()] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  await act(async () => button('Go design')!.click())
  expect(calls.launchChatPlan).toHaveBeenCalledWith('m1')
})

it('a viewer reads the plan but has no editor actions', () => {
  useStore.setState({ canvas: canvasWith('view'), chat: [planMessage()] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('A landing page and a pricing sheet.')
  expect(button('Go design')).toBeUndefined()
  expect(button('Cancel')).toBeUndefined()
  expect(container.querySelector('textarea')).toBeNull()
})

it('a launched plan says who queued the cards and closes the actions', () => {
  useStore.setState({
    canvas: canvasWith('edit'),
    chat: [
      planMessage({
        status: 'launched',
        taskIds: ['t1', 't2'],
        launchedBy: 'Bryan',
        launchedByUserId: 'u1',
        launchedAt: 3,
      }),
    ],
  })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('launched')
  expect(container.textContent).toContain('2 cards queued by Bryan')
  expect(button('Go design')).toBeUndefined()
})
