// Context menus, dialogs and toasts drawn inside the panel: Orca gives html panels no native
// menu or confirm, and browser dialogs would block the host's messages.
import { el, icon, ICONS, moving } from './dom.ts'

// ---- Context menu ----------------------------------------------------------------------------

export type MenuEntry =
  | { label: string; hint?: string; danger?: boolean; disabled?: boolean | string; /** Marked as the current choice. */ checked?: boolean; run: () => void }
  | { heading: string }
  | 'separator'

let closeOpenMenu: (() => void) | null = null

export interface MenuOptions {
  /** Focused again when the menu closes. */
  returnFocus?: HTMLElement
  /** Called once when the menu closes, chosen or dismissed. */
  onClose?: () => void
  /** A dropdown: stays under the point and scrolls in the room left, instead of flipping above. */
  below?: boolean
  /** Adds a field that filters the items by label as the person types; this is its placeholder. */
  filter?: string
}

/** Opens a menu at a point (clamped to the panel) and focuses its first item. */
export function openMenu(entries: MenuEntry[], at: { x: number; y: number }, { returnFocus, onClose, below, filter }: MenuOptions = {}): void {
  closeOpenMenu?.()
  hideTip()
  const menu = el('div', 'menu')
  menu.setAttribute('role', 'menu')
  // With a filter the field stays put and the items scroll under it.
  const search = filter === undefined ? null : el('input', 'input menu-filter')
  const list = search ? el('div', 'menu-list') : menu
  const empty = el('div', 'menu-empty', 'No match')
  if (search) {
    search.type = 'text'
    search.placeholder = filter!
    search.spellcheck = false
    search.autocomplete = 'off'
    search.setAttribute('aria-label', filter!)
    empty.hidden = true
    list.append(empty)
    menu.classList.add('filtered')
    menu.append(search, list)
  }
  const items: HTMLButtonElement[] = []
  /** Headings and separators with the items under them, for the filter. */
  const sections: { head: HTMLElement[]; items: { node: HTMLButtonElement; label: string }[] }[] = [{ head: [], items: [] }]
  let lastWasSeparator = true
  for (const entry of entries) {
    if (entry === 'separator') {
      if (!lastWasSeparator) {
        const line = el('div', 'menu-separator')
        list.append(line)
        sections.push({ head: [line], items: [] })
      }
      lastWasSeparator = true
      continue
    }
    lastWasSeparator = false
    if ('heading' in entry) {
      const heading = el('div', 'menu-heading', entry.heading)
      list.append(heading)
      const section = sections[sections.length - 1]
      if (section.items.length === 0) section.head.push(heading)
      else sections.push({ head: [heading], items: [] })
      continue
    }
    const item = el('button', entry.danger ? 'menu-item danger' : 'menu-item')
    item.type = 'button'
    item.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio')
    if (entry.checked !== undefined) item.setAttribute('aria-checked', String(entry.checked))
    item.append(el('span', 'menu-label', entry.label))
    if (entry.hint) item.append(el('span', 'menu-hint', entry.hint))
    if (entry.checked) item.append(icon(ICONS.check, 'menu-check'))
    sections[sections.length - 1].items.push({ node: item, label: entry.label.toLowerCase() })
    if (entry.disabled) {
      item.disabled = true
      if (typeof entry.disabled === 'string') item.title = entry.disabled
    }
    item.addEventListener('click', () => {
      close()
      entry.run()
    })
    items.push(item)
    list.append(item)
  }
  if (list.lastElementChild?.classList.contains('menu-separator')) list.lastElementChild.remove()

  document.body.append(menu)
  const { innerWidth: w, innerHeight: h } = window
  if (below) menu.style.maxHeight = `${Math.max(120, h - at.y - 6)}px`
  const box = menu.getBoundingClientRect()
  const left = Math.max(4, Math.min(at.x, w - box.width - 4))
  const top = below ? Math.min(at.y, Math.max(4, h - box.height - 6)) : at.y + box.height + 4 > h ? Math.max(4, at.y - box.height) : at.y
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.transformOrigin = `${at.x - left}px ${at.y - top}px`
  // Filtering must not make the menu jump narrower.
  if (search) menu.style.width = `${box.width}px`

  const enabled = () => items.filter((i) => !i.disabled && !i.hidden)
  if (search) search.focus({ preventScroll: true })
  else enabled()[0]?.focus({ preventScroll: true })

  search?.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase()
    let any = false
    for (const section of sections) {
      let shown = false
      for (const { node, label } of section.items) {
        node.hidden = !label.includes(query)
        shown ||= !node.hidden
      }
      for (const node of section.head) node.hidden = !shown
      any ||= shown
    }
    empty.hidden = any
    list.scrollTop = 0
  })

  const onKey = (event: KeyboardEvent) => {
    const list = enabled()
    const inSearch = document.activeElement === search
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : index + step
      // Past either end, back to the filter field.
      if (search && !inSearch && (next < 0 || next >= list.length)) search.focus()
      else list[(next + list.length) % list.length]?.focus()
    } else if (inSearch) {
      if (event.key === 'Enter') {
        event.preventDefault()
        list[0]?.click()
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      list[event.key === 'Home' ? 0 : list.length - 1]?.focus()
    } else if (search && (event.key.length === 1 || event.key === 'Backspace') && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== ' ') {
      // Typing anywhere in the menu goes on filtering.
      search.focus()
    }
  }
  const onPointer = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) close()
  }
  const onAway = () => close()
  // The menu's own list scrolls; anything else scrolling moves what the menu belongs to.
  const onScroll = (event: Event) => {
    if (!menu.contains(event.target as Node)) close()
  }

  function close(): void {
    if (closeOpenMenu !== close) return
    closeOpenMenu = null
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onPointer, true)
    window.removeEventListener('blur', onAway)
    window.removeEventListener('resize', onAway)
    document.removeEventListener('scroll', onScroll, true)
    const done = () => menu.remove()
    if (moving()) menu.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90 }).onfinish = done
    else done()
    returnFocus?.focus({ preventScroll: true })
    onClose?.()
  }
  closeOpenMenu = close
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('blur', onAway)
  window.addEventListener('resize', onAway)
  document.addEventListener('scroll', onScroll, true)
}

// ---- Dialog ----------------------------------------------------------------------------------

export type Field =
  | { kind: 'text'; id: string; label: string; value?: string; placeholder?: string; validate?: (value: string) => string | null }
  | { kind: 'textarea'; id: string; label: string; value?: string; placeholder?: string }
  | { kind: 'check'; id: string; label: string; value?: boolean; hint?: string }
  | { kind: 'choice'; id: string; label: string; value: string; options: { value: string; label: string; hint?: string }[] }

export type Values = Record<string, string | boolean>

export interface DialogSpec {
  title: string
  text?: string
  /** Shown above the fields, each with a warning icon: uncommitted changes, a busy agent. */
  warnings?: string[]
  fields?: Field[]
  /** The git command that will run, recomputed as fields change; null hides it. */
  preview?: (values: Values) => string | null
  confirm: string
  danger?: boolean
}

/** Resolves with the field values on confirm, or null when cancelled. */
export function openDialog(spec: DialogSpec): Promise<Values | null> {
  closeOpenMenu?.()
  hideTip()
  const returnFocus = document.activeElement as HTMLElement | null
  return new Promise((resolve) => {
    const backdrop = el('div', 'dialog-backdrop')
    const dialog = el('div', spec.danger ? 'dialog danger' : 'dialog')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    const title = el('div', 'dialog-title', spec.title)
    title.id = 'dialog-title'
    dialog.setAttribute('aria-labelledby', title.id)
    dialog.append(title)
    if (spec.text) dialog.append(el('p', 'dialog-text', spec.text))
    for (const warning of spec.warnings ?? []) {
      const row = el('div', 'dialog-warning')
      row.append(icon(ICONS.warning), el('span', '', warning))
      dialog.append(row)
    }

    const values: Values = {}
    const errors = new Map<string, HTMLElement>()
    const validators: Array<() => boolean> = []
    const form = el('form', 'dialog-fields')
    for (const field of spec.fields ?? []) form.append(renderField(field, values, errors, validators, update))

    const preview = el('code', 'dialog-preview')
    if (spec.preview) form.append(preview)
    dialog.append(form)

    const buttons = el('div', 'dialog-buttons')
    const cancel = el('button', 'button', 'Cancel')
    cancel.type = 'button'
    const confirm = el('button', spec.danger ? 'button primary danger' : 'button primary', spec.confirm)
    confirm.type = 'submit'
    confirm.setAttribute('form', 'dialog-form')
    form.id = 'dialog-form'
    buttons.append(cancel, confirm)
    dialog.append(buttons)
    backdrop.append(dialog)
    document.body.append(backdrop)

    function update(): void {
      if (spec.preview) {
        const command = spec.preview(values)
        preview.hidden = !command
        preview.textContent = command ? `$ ${command}` : ''
      }
      confirm.disabled = !validators.every((check) => check())
    }
    update()
    ;(form.querySelector<HTMLElement>('input, textarea, select') ?? confirm).focus()

    const finish = (result: Values | null) => {
      document.removeEventListener('keydown', onKey, true)
      const done = () => backdrop.remove()
      if (moving()) backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 }).onfinish = done
      else done()
      returnFocus?.focus?.({ preventScroll: true })
      resolve(result)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      } else if (event.key === 'Tab') {
        // Keep focus inside the dialog.
        const focusable = [...dialog.querySelectorAll<HTMLElement>('input, textarea, select, button:not(:disabled)')]
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', () => finish(null))
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop) finish(null)
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!confirm.disabled) finish({ ...values })
    })
  })
}

function renderField(
  field: Field,
  values: Values,
  errors: Map<string, HTMLElement>,
  validators: Array<() => boolean>,
  update: () => void
): HTMLElement {
  const wrap = el('label', `field field-${field.kind}`)
  switch (field.kind) {
    case 'text':
    case 'textarea': {
      values[field.id] = field.value ?? ''
      const input = field.kind === 'text' ? el('input', 'input') : el('textarea', 'input')
      if (input instanceof HTMLInputElement) {
        input.type = 'text'
        input.spellcheck = false
        input.autocomplete = 'off'
      } else {
        input.rows = 3
      }
      input.value = field.value ?? ''
      if (field.placeholder) input.placeholder = field.placeholder
      const error = el('span', 'field-error')
      errors.set(field.id, error)
      wrap.append(el('span', 'field-label', field.label), input, error)
      if (field.kind === 'text' && field.validate) {
        const validate = field.validate
        let touched = Boolean(field.value)
        validators.push(() => {
          const message = validate(String(values[field.id]))
          error.textContent = touched && message ? message : ''
          input.setAttribute('aria-invalid', String(Boolean(touched && message)))
          return message === null
        })
        input.addEventListener('blur', () => {
          touched = true
          update()
        })
      }
      input.addEventListener('input', () => {
        values[field.id] = input.value
        update()
      })
      if (field.kind === 'text') queueMicrotask(() => input.select())
      return wrap
    }
    case 'check': {
      values[field.id] = field.value ?? false
      const input = el('input', '')
      input.type = 'checkbox'
      input.checked = field.value ?? false
      input.addEventListener('change', () => {
        values[field.id] = input.checked
        update()
      })
      const text = el('span', 'field-label', field.label)
      wrap.append(input, text)
      if (field.hint) wrap.append(el('span', 'field-hint', field.hint))
      return wrap
    }
    case 'choice': {
      values[field.id] = field.value
      const group = el('div', 'choice')
      group.setAttribute('role', 'radiogroup')
      wrap.append(el('span', 'field-label', field.label), group)
      for (const option of field.options) {
        const row = el('label', 'choice-option')
        const input = el('input', '')
        input.type = 'radio'
        input.name = field.id
        input.value = option.value
        input.checked = option.value === field.value
        input.addEventListener('change', () => {
          values[field.id] = option.value
          update()
        })
        const text = el('span', 'choice-text')
        text.append(el('span', 'choice-label', option.label))
        if (option.hint) text.append(el('span', 'field-hint', option.hint))
        row.append(input, text)
        group.append(row)
      }
      return wrap
    }
  }
}

// ---- Toasts ----------------------------------------------------------------------------------

export interface ToastSpec {
  tone: 'busy' | 'success' | 'warning' | 'error' | 'info'
  title: string
  detail?: string
  actions?: { label: string; run: () => void }[]
}

export interface Toast {
  update(spec: ToastSpec): void
  close(): void
}

const MAX_TOASTS = 3
const SUCCESS_MS = 4000

let toastStack: HTMLElement | null = null

/** Shows a toast at the bottom of the panel; success and info fade out on their own. */
export function toast(spec: ToastSpec): Toast {
  if (!toastStack) {
    toastStack = el('div', 'toasts')
    toastStack.setAttribute('role', 'status')
    toastStack.setAttribute('aria-live', 'polite')
    document.body.append(toastStack)
  }
  const stack = toastStack
  while (stack.children.length >= MAX_TOASTS) stack.firstElementChild?.remove()
  const node = el('div', 'toast')
  stack.append(node)
  let timer: ReturnType<typeof setTimeout> | null = null

  const close = () => {
    if (timer) clearTimeout(timer)
    if (!node.isConnected) return
    const done = () => node.remove()
    if (moving()) node.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 140 }).onfinish = done
    else done()
  }

  const update = (next: ToastSpec) => {
    if (timer) clearTimeout(timer)
    node.className = `toast ${next.tone}`
    const head = el('div', 'toast-head')
    const mark = el('span', 'toast-mark')
    head.append(mark, el('span', 'toast-title', next.title))
    if (next.tone !== 'busy') {
      const dismiss = el('button', 'icon toast-close')
      dismiss.type = 'button'
      dismiss.setAttribute('aria-label', 'Dismiss')
      dismiss.append(icon(ICONS.close))
      dismiss.addEventListener('click', close)
      head.append(dismiss)
    }
    const children: Node[] = [head]
    if (next.detail) children.push(el('pre', 'toast-detail', next.detail))
    if (next.actions?.length) {
      const row = el('div', 'toast-actions')
      for (const action of next.actions) {
        const button = el('button', 'button', action.label)
        button.type = 'button'
        button.addEventListener('click', () => {
          close()
          action.run()
        })
        row.append(button)
      }
      children.push(row)
    }
    node.replaceChildren(...children)
    if ((next.tone === 'success' || next.tone === 'info') && !next.actions?.length) timer = setTimeout(close, SUCCESS_MS)
  }

  update(spec)
  return { update, close }
}

// ---- Tooltips --------------------------------------------------------------------------------

export interface TipSpec {
  label: string
  /** The git command the control runs, shown in monospace under the label. */
  command?: string
}

const TIP_DELAY_MS = 350
let tip: HTMLElement | null = null
let tipTimer: ReturnType<typeof setTimeout> | null = null
let tipTarget: HTMLElement | null = null

function hideTip(): void {
  if (tipTimer) clearTimeout(tipTimer)
  tipTimer = null
  tipTarget = null
  tip?.remove()
  tip = null
}

function showTip(target: HTMLElement, spec: TipSpec): void {
  hideTip()
  if (!target.isConnected) return
  tipTarget = target
  tip = el('div', 'tip')
  tip.setAttribute('role', 'tooltip')
  tip.append(el('div', 'tip-label', spec.label))
  if (spec.command) tip.append(el('code', 'tip-command', spec.command))
  document.body.append(tip)
  const anchor = target.getBoundingClientRect()
  const box = tip.getBoundingClientRect()
  const left = Math.max(4, Math.min(anchor.left + anchor.width / 2 - box.width / 2, window.innerWidth - box.width - 4))
  const under = anchor.bottom + 6
  tip.style.left = `${left}px`
  tip.style.top = `${under + box.height + 4 > window.innerHeight ? Math.max(4, anchor.top - box.height - 6) : under}px`
}

/**
 * A tooltip for a control: after a short hover, or at once on keyboard focus. `content` is read
 * each time it opens, so it follows the control's state. Native `title` tooltips are slow and
 * cannot show a command.
 */
export function tooltip(target: HTMLElement, content: () => TipSpec | null): void {
  const open = () => {
    const spec = content()
    if (spec) showTip(target, spec)
  }
  target.addEventListener('pointerenter', () => {
    if (tipTimer) clearTimeout(tipTimer)
    tipTimer = setTimeout(open, TIP_DELAY_MS)
  })
  target.addEventListener('pointerleave', hideTip)
  target.addEventListener('pointerdown', hideTip)
  target.addEventListener('focus', () => {
    if (target.matches(':focus-visible')) open()
  })
  target.addEventListener('blur', () => {
    if (tipTarget === target) hideTip()
  })
  target.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') hideTip()
  })
}
