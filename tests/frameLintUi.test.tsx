// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import type { FrameLint } from '../shared/slopRules'
import { FrameLintBadge } from '../src/components/FrameLintBadge'
import { Inspector } from '../src/components/Inspector'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Checkout',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  html: '<h1>Checkout</h1>',
  createdAt: 1,
  updatedAt: 10,
  updatedBy: 'Designer',
}

const lintWithIssues: FrameLint = {
  score: 66,
  errors: 1,
  warnings: 1,
  checkedAt: 20,
  version: 1,
  engine: 'dom',
  issues: [
    {
      ruleId: 'AS-COL-02',
      severity: 'error',
      message: 'span renders text as a gradient',
      elementId: 't1',
      selector: '[data-doop-id="t1"]',
    },
    { ruleId: 'AS-COPY-03', severity: 'warning', message: 'generic CTA "Learn more"' },
  ],
}

let root: Root
let container: HTMLDivElement

function mount(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>))
}

beforeEach(() => {
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [frame], createdAt: 1, updatedAt: 10 })
  useStore.setState({ selectedElement: null, selectedElements: [], elementPanelOpen: false })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('shows nothing before a first lint', () => {
  mount(<FrameLintBadge frame={frame} />)
  expect(container.textContent).toBe('')
})

it('shows a ✓ chip for a clean lint', () => {
  mount(
    <FrameLintBadge
      frame={{ ...frame, lint: { ...lintWithIssues, score: 100, errors: 0, warnings: 0, issues: [] } }}
    />,
  )
  expect(container.textContent).toBe('✓')
})

it('shows ⚠ with the issue count', () => {
  mount(<FrameLintBadge frame={{ ...frame, lint: lintWithIssues }} />)
  expect(container.textContent).toBe('⚠ 2')
})

it('lists issues in the Inspector quality section', () => {
  mount(<Inspector frame={{ ...frame, lint: lintWithIssues }} />)
  expect(container.textContent).toContain('Quality')
  expect(container.textContent).toContain('AS-COL-02')
  expect(container.textContent).toContain('span renders text as a gradient')
  expect(container.textContent).toContain('AS-COPY-03')
})

it('says the frame is clean when the lint has no issues', () => {
  mount(<Inspector frame={{ ...frame, lint: { ...lintWithIssues, issues: [] } }} />)
  expect(container.textContent).toContain('No lint issues')
})

it('selects the blamed element when an issue is clicked', () => {
  mount(<Inspector frame={{ ...frame, lint: lintWithIssues }} />)
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('span renders text as a gradient'),
  )
  expect(button).toBeDefined()
  act(() => button!.click())
  expect(useStore.getState().selectedElement).toEqual({ frameId: 'f', selector: '[data-doop-id="t1"]' })
})

it('does not react to clicks on issues with no element', () => {
  mount(<Inspector frame={{ ...frame, lint: lintWithIssues }} />)
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('generic CTA'))
  act(() => button!.click())
  expect(useStore.getState().selectedElement).toBeNull()
})
