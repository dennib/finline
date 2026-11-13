// DOM helpers: the panel builds every node with createElement, never innerHTML.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

/** A 16×16 stroked icon from one path. */
export function icon(d: string, cls = ''): SVGSVGElement {
  const node = svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' })
  if (cls) node.setAttribute('class', cls)
  node.append(svg('path', { d }))
  return node
}

export const ICONS = {
  close: 'M4 4l8 8M12 4l-8 8',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  fetch: 'M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10',
  pull: 'M8 2.5v9M4.5 8L8 11.5 11.5 8',
  push: 'M8 13.5v-9M4.5 8L8 4.5 11.5 8',
  warning: 'M8 2.5l6 11H2zM8 7v3M8 12h.01',
  check: 'M3.5 8.5l3 3 6-7',
  switch: 'M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13'
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
/** False when the system asks for reduced motion. */
export const moving = () => !reducedMotion.matches
