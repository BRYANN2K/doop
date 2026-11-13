/**
 * The DOM side of the slop lint: turn a rendered frame document into the
 * SlopSnapshot shared/slopRules.ts scores.
 *
 * The collector ships as a SOURCE STRING, not a callable — the same body
 * runs in two places that cannot import modules:
 *   - inside the frame iframe (frameRuntime.ts interpolates it into the
 *     bootstrap and answers `doop:slop-snapshot` with it)
 *   - inside the server's headless page (server/lint.ts hands it to
 *     page.evaluate, which evaluates the expression)
 *
 * Keep it self-contained ES5: no imports, no helpers at module scope, no
 * template literals, no arrow functions — it is embedded inside a larger
 * template literal.
 */
import type { SlopSnapshot } from './slopRules.ts'

/** `function collectSlopSnapshot() { … }` as source. */
export const SLOP_COLLECTOR_SOURCE = `function collectSlopSnapshot() {
  var MAX_ELEMENTS = 600
  var MAX_TEXT = 300
  function selectorFor(el) {
    var doopId = el.getAttribute('data-doop-id')
    if (doopId) return '[data-doop-id="' + doopId + '"]'
    if (el.id && el.id.length < 80) return '#' + el.id
    var parts = []
    var node = el
    while (node && node !== document.body && parts.length < 7) {
      var tag = node.tagName.toLowerCase()
      var parent = node.parentElement
      if (!parent) { parts.unshift(tag); break }
      var same = []
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) same.push(parent.children[i])
      }
      parts.unshift(tag + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : ''))
      node = parent
    }
    return 'body > ' + parts.join(' > ')
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d || 0) }
  function visible(el, st, rect) {
    return st.display !== 'none' && st.visibility !== 'hidden' && num(st.opacity, 1) > 0 && rect.width > 1 && rect.height > 1
  }
  function hasAlpha(color) {
    var m = /rgba\\([^)]*,\\s*([\\d.]+)%?\\s*\\)/.exec(color || '')
    return m ? parseFloat(m[1]) > 0 : false
  }
  /* the first painted backdrop under this element: its own background, then
     each ancestor's, then body/html — plus whether a gradient or image sits
     anywhere in that chain (a solid guess is not honest there) */
  function backdropOf(el) {
    var uncertain = false
    var node = el
    var hops = 0
    while (node && hops < 12) {
      var st = getComputedStyle(node)
      var img = st.backgroundImage || 'none'
      if (img !== 'none') uncertain = true
      var bg = st.backgroundColor || ''
      if (bg && bg !== 'transparent' && hasAlpha(bg)) return { color: bg, uncertain: uncertain }
      node = node.parentElement
      hops++
    }
    return { color: 'rgb(255, 255, 255)', uncertain: uncertain }
  }
  function ownTextLength(el) {
    var n = 0
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i]
      if (c.nodeType === 3) n += (c.nodeValue || '').replace(/\\s+/g, '').length
    }
    return n
  }
  function named(el, text) {
    if (text) return true
    if (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('aria-labelledby')) return true
    var img = el.tagName === 'IMG' ? el : el.querySelector && el.querySelector('img[alt]')
    if (img && img.getAttribute('alt')) return true
    return false
  }
  function cardish(st, rect) {
    var radius = num(st.borderTopLeftRadius) || num(st.borderRadius)
    var bordered = false
    var bw = [st.borderTopWidth, st.borderRightWidth, st.borderBottomWidth, st.borderLeftWidth]
    var bs = [st.borderTopStyle, st.borderRightStyle, st.borderBottomStyle, st.borderLeftStyle]
    for (var i = 0; i < 4; i++) if (num(bw[i]) > 0 && bs[i] !== 'none' && bs[i] !== 'hidden') bordered = true
    var shadowed = st.boxShadow && st.boxShadow !== 'none'
    return radius >= 6 && rect.width > 40 && rect.height > 30 && (bordered || shadowed)
  }
  function cardAncestor(el) {
    var node = el.parentElement
    var hops = 0
    while (node && node !== document.body && hops < 10) {
      if (cardish(getComputedStyle(node), node.getBoundingClientRect())) return true
      node = node.parentElement
      hops++
    }
    return false
  }
  var out = []
  var els = []
  var truncated = false
  var all = document.body ? document.body.querySelectorAll('*') : []
  for (var i = 0; i < all.length; i++) {
    var el = all[i]
    if (out.length >= MAX_ELEMENTS) { truncated = true; break }
    var st = getComputedStyle(el)
    var rect = el.getBoundingClientRect()
    if (!visible(el, st, rect)) continue
    var tag = el.tagName.toLowerCase()
    var role = el.getAttribute('role') || undefined
    var text = (el.innerText || '').replace(/\\s+/g, ' ').trim()
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1) + '…'
    var back = backdropOf(el)
    var interactive =
      /^(button|a|input|select|textarea|summary|option)$/.test(tag) ||
      /^(button|link|menuitem|tab|checkbox|radio|switch|option)$/.test(role || '') ||
      el.hasAttribute('onclick') ||
      (el.hasAttribute('tabindex') && num(el.getAttribute('tabindex'), -1) >= 0)
    var heading = /^h([1-6])$/.exec(tag)
    var duration = Math.max.apply(null, (st.transitionDuration || '0s').split(',').map(function (v) {
      v = v.trim()
      return v.indexOf('ms') > -1 ? num(v) : num(v) * 1000
    }).concat([0]))
    out.push({
      selector: selectorFor(el),
      elementId: el.getAttribute('data-doop-id') || undefined,
      parentSelector: el.parentElement ? selectorFor(el.parentElement) : undefined,
      tag: tag,
      role: role,
      text: text || undefined,
      ownTextLength: ownTextLength(el),
      rect: { x: rect.left + (window.scrollX || 0), y: rect.top + (window.scrollY || 0), w: rect.width, h: rect.height },
      color: st.color,
      bg: back.color,
      bgUncertain: back.uncertain,
      font: st.fontFamily,
      fontSizePx: num(st.fontSize),
      fontWeight: num(st.fontWeight, 400),
      fontStyle: st.fontStyle,
      letterSpacingPx: st.letterSpacing === 'normal' ? 0 : num(st.letterSpacing),
      lineHeightPx: st.lineHeight === 'normal' ? num(st.fontSize) * 1.2 : num(st.lineHeight),
      textTransform: st.textTransform,
      radiusPx: Math.max(num(st.borderTopLeftRadius), num(st.borderTopRightRadius), num(st.borderBottomLeftRadius), num(st.borderBottomRightRadius)),
      boxShadow: st.boxShadow || 'none',
      textShadow: st.textShadow || 'none',
      backgroundImage: st.backgroundImage || 'none',
      backgroundClip: st.backgroundClip || st.webkitBackgroundClip || 'border-box',
      borderWidthsPx: [num(st.borderTopWidth), num(st.borderRightWidth), num(st.borderBottomWidth), num(st.borderLeftWidth)],
      borderStyle: [st.borderTopStyle, st.borderRightStyle, st.borderBottomStyle, st.borderLeftStyle].join(' '),
      borderColors: [st.borderTopColor, st.borderRightColor, st.borderBottomColor, st.borderLeftColor].join(' '),
      opacity: num(st.opacity, 1),
      outlineStyle: st.outlineStyle,
      outlineWidthPx: num(st.outlineWidth),
      backdropFilter: st.backdropFilter || st.webkitBackdropFilter || 'none',
      filter: st.filter || 'none',
      transitionProperty: st.transitionProperty || 'none',
      transitionDurationMs: Math.round(duration),
      transitionTiming: st.transitionTimingFunction || '',
      animationName: st.animationName || 'none',
      animationIteration: st.animationIterationCount || '',
      interactive: !!interactive,
      named: named(el, text),
      cardish: cardish(st, rect),
      cardAncestor: false,
      headingLevel: heading ? parseInt(heading[1], 10) : undefined,
      imgSrc: tag === 'img' ? (el.getAttribute('src') || '') : undefined,
      imgBroken: tag === 'img' ? (el.complete === true && el.naturalWidth === 0) : undefined,
    })
    els.push(el)
  }
  /* card ancestry needs the collected rows' own judgement, so a second pass
     climbs each element's real ancestors once */
  for (var j = 0; j < out.length; j++) out[j].cardAncestor = cardAncestor(els[j])
  var styles = []
  var styleEls = document.querySelectorAll('style')
  for (var s = 0; s < styleEls.length; s++) styles.push(styleEls[s].textContent || '')
  var htmlEl = document.documentElement
  return {
    width: htmlEl.clientWidth || (document.body && document.body.clientWidth) || 0,
    height: htmlEl.clientHeight || (document.body && document.body.clientHeight) || 0,
    elements: out,
    allText: ((document.body && document.body.innerText) || '').slice(0, 100000),
    styleText: styles.join('\\n').slice(0, 200000),
    truncated: truncated,
  }
}`

/** Evaluate the collector against `document` — for tests and for hosts that
 *  have a real DOM at hand (jsdom). The string is the source of truth. */
export function collectSlopSnapshot(): SlopSnapshot {
  const fn = new Function(`${SLOP_COLLECTOR_SOURCE}; return collectSlopSnapshot()`)
  return fn() as SlopSnapshot
}
