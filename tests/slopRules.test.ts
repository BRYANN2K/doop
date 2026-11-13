import { describe, expect, it } from 'vitest'
import {
  lintSnapshot,
  lintStaticHtml,
  staticSnapshot,
  SLOP_RULES,
  type SlopElement,
  type SlopSnapshot,
} from '../shared/slopRules'

/* A neutral element: visible block of body text on white. Each test overrides
   the few fields a rule reads. */
function el(over: Partial<SlopElement>): SlopElement {
  return {
    selector: 'body > div',
    tag: 'div',
    ownTextLength: 0,
    rect: { x: 40, y: 40, w: 200, h: 60 },
    color: 'rgb(20, 20, 20)',
    bg: 'rgb(255, 255, 255)',
    bgUncertain: false,
    font: 'Custom Sans, sans-serif',
    fontSizePx: 16,
    fontWeight: 400,
    fontStyle: 'normal',
    letterSpacingPx: 0,
    lineHeightPx: 24,
    textTransform: 'none',
    radiusPx: 0,
    boxShadow: 'none',
    textShadow: 'none',
    backgroundImage: 'none',
    backgroundClip: 'border-box',
    borderWidthsPx: [0, 0, 0, 0],
    borderStyle: 'none none none none',
    borderColors: 'rgb(0, 0, 0) rgb(0, 0, 0) rgb(0, 0, 0) rgb(0, 0, 0)',
    opacity: 1,
    outlineStyle: 'none',
    outlineWidthPx: 0,
    backdropFilter: 'none',
    filter: 'none',
    transitionProperty: 'none',
    transitionDurationMs: 0,
    transitionTiming: 'ease',
    animationName: 'none',
    animationIteration: '',
    interactive: false,
    named: true,
    cardish: false,
    cardAncestor: false,
    ...over,
  }
}

function snap(over: Partial<SlopSnapshot>): SlopSnapshot {
  return { width: 800, height: 600, elements: [], allText: '', styleText: '', ...over }
}

describe('lintSnapshot', () => {
  it('scores a clean document 100 with no issues', () => {
    const lint = lintSnapshot(snap({ elements: [el({ ownTextLength: 30, text: 'A clear headline' })] }))
    expect(lint.score).toBe(100)
    expect(lint.errors).toBe(0)
    expect(lint.issues).toEqual([])
    expect(lint.engine).toBe('dom')
  })

  it('flags low-contrast text as an AS-A11Y-01 error on the element', () => {
    const lint = lintSnapshot(
      snap({ elements: [el({ ownTextLength: 20, color: 'rgb(200, 200, 200)', bg: 'rgb(255, 255, 255)' })] }),
    )
    const issue = lint.issues.find((i) => i.ruleId === 'AS-A11Y-01')
    expect(issue?.severity).toBe('error')
    expect(issue?.selector).toBe('body > div')
    expect(lint.errors).toBeGreaterThan(0)
    expect(lint.score).toBeLessThan(100)
  })

  it('gives large text the 3:1 floor', () => {
    /* ~3.5:1 fails body but passes 24px+ text */
    const lint = lintSnapshot(
      snap({
        elements: [el({ ownTextLength: 10, fontSizePx: 30, color: 'rgb(140, 140, 140)', bg: 'rgb(255, 255, 255)' })],
      }),
    )
    expect(lint.issues.find((i) => i.ruleId === 'AS-A11Y-01')).toBeUndefined()
  })

  it('flags a default purple gradient as AS-COL-01', () => {
    const lint = lintSnapshot(
      snap({
        elements: [el({ backgroundImage: 'linear-gradient(135deg, rgb(99, 102, 241), rgb(168, 85, 247))' })],
      }),
    )
    expect(lint.issues.find((i) => i.ruleId === 'AS-COL-01')?.severity).toBe('error')
  })

  it('flags gradient-clipped text as AS-COL-02', () => {
    const lint = lintSnapshot(
      snap({
        elements: [
          el({ backgroundClip: 'text', backgroundImage: 'linear-gradient(90deg, rgb(255,0,0), rgb(0,0,255))' }),
        ],
      }),
    )
    expect(lint.issues.find((i) => i.ruleId === 'AS-COL-02')?.severity).toBe('error')
  })

  it('flags a card nested in a card as AS-LAY-03', () => {
    const lint = lintSnapshot(snap({ elements: [el({ cardish: true, cardAncestor: true })] }))
    expect(lint.issues.find((i) => i.ruleId === 'AS-LAY-03')?.severity).toBe('error')
  })

  it('flags transition: all as AS-MOT-09', () => {
    const lint = lintSnapshot(snap({ elements: [el({ transitionProperty: 'all', transitionDurationMs: 200 })] }))
    expect(lint.issues.find((i) => i.ruleId === 'AS-MOT-09')?.severity).toBe('error')
  })

  it('flags a generic CTA as a warning, not an error', () => {
    const lint = lintSnapshot(snap({ elements: [el({ interactive: true, text: 'Get started', tag: 'a' })] }))
    const issue = lint.issues.find((i) => i.ruleId === 'AS-COPY-03')
    expect(issue?.severity).toBe('warning')
    expect(lint.errors).toBe(0)
  })

  it('deducts 15 per error and 4 per warning from the score', () => {
    const lint = lintSnapshot(
      snap({
        elements: [
          el({
            ownTextLength: 20,
            color: 'rgb(200, 200, 200)',
            bg: 'rgb(255, 255, 255)',
            interactive: true,
            text: 'Get started',
            tag: 'a',
          }),
        ],
      }),
    )
    expect(lint.errors).toBe(1)
    expect(lint.warnings).toBeGreaterThanOrEqual(1)
    expect(lint.score).toBe(100 - 15 - lint.warnings * 4)
  })

  it('caps issues per rule at three', () => {
    const elements = Array.from({ length: 6 }, (_, i) =>
      el({ selector: `body > p:nth-of-type(${i + 1})`, ownTextLength: 10, fontSizePx: 9 }),
    )
    const lint = lintSnapshot(snap({ elements }))
    expect(lint.issues.filter((i) => i.ruleId === 'AS-TYPE-11')).toHaveLength(3)
  })

  it('carries elementId and selector through to the issue', () => {
    const lint = lintSnapshot(
      snap({
        elements: [el({ selector: '[data-doop-id="abc"]', elementId: 'abc', cardish: true, cardAncestor: true })],
      }),
    )
    const issue = lint.issues.find((i) => i.ruleId === 'AS-LAY-03')
    expect(issue?.elementId).toBe('abc')
    expect(issue?.selector).toBe('[data-doop-id="abc"]')
  })
})

describe('lintStaticHtml', () => {
  it('reports a clean document at 100', () => {
    const lint = lintStaticHtml('<html><body><h1>Shipping today</h1><p>Plain words.</p></body></html>')
    expect(lint.score).toBe(100)
    expect(lint.engine).toBe('static')
  })

  it('catches buzzwords without a DOM', () => {
    const lint = lintStaticHtml('<html><body><p>Seamlessly elevate your workflow</p></body></html>')
    expect(lint.issues.find((i) => i.ruleId === 'AS-COPY-01')?.severity).toBe('error')
  })

  it('catches invented proof numbers', () => {
    const lint = lintStaticHtml('<html><body><p>Trusted by 10K+ teams</p></body></html>')
    expect(lint.issues.find((i) => i.ruleId === 'AS-COPY-06')).toBeDefined()
  })

  it('catches lorem ipsum and fake people', () => {
    const lint = lintStaticHtml('<html><body><p>Lorem ipsum — John Doe, CEO</p></body></html>')
    expect(lint.issues.find((i) => i.ruleId === 'AS-COPY-07')).toBeDefined()
  })

  it('reads transition: all out of the stylesheet', () => {
    const lint = lintStaticHtml(
      '<html><head><style>.x { transition: all 300ms ease }</style></head><body><div class="x">hi</div></body></html>',
    )
    expect(lint.issues.find((i) => i.ruleId === 'AS-MOT-09')).toBeDefined()
  })

  it('asks for reduced-motion when the stylesheet animates', () => {
    const lint = lintStaticHtml(
      '<html><head><style>@keyframes p { to { opacity: 0 } } .x { animation: p 1s infinite }</style></head><body></body></html>',
    )
    expect(lint.issues.find((i) => i.ruleId === 'AS-MOT-11')).toBeDefined()
  })
})

describe('staticSnapshot', () => {
  it('strips tags and scripts, keeps text and styles', () => {
    const s = staticSnapshot(
      '<html><head><style>.a{color:red}</style></head><body><p>Hello</p><script>x()</script></body></html>',
    )
    expect(s.allText).toBe('Hello')
    expect(s.styleText).toContain('.a{color:red}')
  })
})

describe('rule metadata', () => {
  it('keeps AS-* ids and severities honest', () => {
    expect(SLOP_RULES.length).toBeGreaterThan(30)
    for (const rule of SLOP_RULES) {
      expect(rule.id).toMatch(/^(AS-[A-Z0-9]+-\d+|SLOP-[A-Z]+(-\d+)?)$/)
      expect(['error', 'warning']).toContain(rule.severity)
      expect(rule.ref.length).toBeGreaterThan(10)
    }
  })
})
