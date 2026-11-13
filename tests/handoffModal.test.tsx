// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HandoffPack } from '../shared/handoff'

const calls = vi.hoisted(() => ({
  buildHandoff: vi.fn(),
  writeHandoff: vi.fn(),
}))

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { HandoffModal } = await import('../src/components/HandoffModal')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const PACK: HandoffPack = {
  changeId: 'billing-screen-a1b2',
  dir: '.workflow/changes/billing-screen-a1b2',
  title: 'Billing screen',
  proposal: '# Billing\n\n## Problem\n\nShip it.\n',
  spec: '# Billing\n\n- AC-1: the total is visible\n- AC-2: taxes are itemized\n',
  tasks: '# Tasks\n\n- [ ] build it\n',
  files: [
    { path: '.workflow/changes/billing-screen-a1b2/proposal.md', text: 'p' },
    { path: '.workflow/changes/billing-screen-a1b2/spec.md', text: 's' },
    { path: '.workflow/changes/billing-screen-a1b2/tasks.md', text: 't' },
    { path: '.workflow/changes/billing-screen-a1b2/state.json', text: '{}' },
    { path: '.workflow/changes/billing-screen-a1b2/assets/01-billing.png', base64: 'aGk=' },
  ],
  draftedBy: 'template',
  warnings: [],
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
  calls.buildHandoff.mockResolvedValue({ pack: PACK, link: { name: 'my-project' }, writable: true })
  calls.writeHandoff.mockResolvedValue({
    ok: true,
    result: { dir: PACK.dir, written: ['a.md', 'b.png'], repo: 'my-project' },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function open() {
  await act(async () => {
    root.render(<HandoffModal canvasId="c1" input={{ frameIds: ['f1'] }} onClose={() => {}} />)
  })
  await act(async () => Promise.resolve())
}

it('builds the pack on open and shows the editable spec', async () => {
  await open()
  expect(calls.buildHandoff).toHaveBeenCalledWith('c1', { frameIds: ['f1'] })
  expect(document.body.textContent).toContain('.workflow/changes/billing-screen-a1b2')
  const spec = document.body.querySelector('textarea')!
  expect(spec.value).toContain('- AC-1: the total is visible')
  /* the file list shows the pack contents, paths inside the folder */
  expect(document.body.textContent).toContain('assets/01-billing.png')
})

it('writes the pack through the server — with the edited spec', async () => {
  await open()
  const spec = document.body.querySelector('textarea')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(spec, spec.value + '- AC-3: reviewed\n')
    spec.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const write = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Write to repo'))!
  await act(async () => write.click())
  expect(calls.writeHandoff).toHaveBeenCalledOnce()
  const [canvasId, changeId, files] = calls.writeHandoff.mock.calls[0]!
  expect(canvasId).toBe('c1')
  expect(changeId).toBe('billing-screen-a1b2')
  const specFile = files.find((f: { path: string }) => f.path.endsWith('/spec.md'))!
  expect(specFile.text).toContain('- AC-3: reviewed')
  /* the binary asset went through untouched */
  expect(files.find((f: { path: string }) => f.path.endsWith('.png'))!.base64).toBe('aGk=')
  /* and the modal confirms where it landed */
  expect(document.body.textContent).toContain('my-project')
})

it('disables the write while the desktop app is not serving the link', async () => {
  calls.buildHandoff.mockResolvedValue({ pack: PACK, link: { name: 'my-project' }, writable: false })
  await open()
  const write = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Write to repo'))!
  expect(write.disabled).toBe(true)
  expect(document.body.textContent).toContain('desktop app')
})

it('requires at least one AC criterion before writing', async () => {
  calls.buildHandoff.mockResolvedValue({
    pack: { ...PACK, spec: '# Billing\n\nNo criteria yet.\n' },
    link: null,
    writable: true,
  })
  await open()
  const write = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Write to repo'))!
  expect(write.disabled).toBe(true)
  expect(document.body.textContent).toContain('AC-n')
})
