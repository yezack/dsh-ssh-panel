// @vitest-environment jsdom
/**
 * TerminalTab right-click context menu: opens only on a live session;
 * 复制 is enabled only when xterm has a selection (writes it to the
 * clipboard); 粘贴 reads the clipboard and sends it into the PTY.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalTab } from '../src/client/panel/TerminalTab.tsx'
import type { SshApi, TerminalConnection } from '../src/client/api.ts'

type MockTerm = {
  selCb?: () => void
  options: Record<string, unknown>
  hasSelection(): boolean
  getSelection(): string
}

const { terminalInstances, selection } = vi.hoisted(() => ({
  terminalInstances: [] as MockTerm[],
  selection: { active: false, text: '' },
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    constructor() { terminalInstances.push(this as MockTerm) }
    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    onData(): { dispose(): void } { return { dispose: () => undefined } }
    onSelectionChange(cb: () => void): { dispose(): void } {
      (this as MockTerm).selCb = cb
      return { dispose: () => undefined }
    }
    hasSelection(): boolean { return selection.active }
    getSelection(): string { return selection.text }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit(): void {} },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.restoreAllMocks()
  terminalInstances.length = 0
  selection.active = false
  selection.text = ''
  document.body.replaceChildren()
})

function makeApi(): { api: SshApi; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const api = {
    listHosts: vi.fn(async () => [{ alias: 'web-1', host: 'web-1.example.com' }]),
    openTerminal: vi.fn(() => ({
      onReady: undefined,
      onOutput: undefined,
      onExit: undefined,
      send,
      resize: () => undefined,
      close: () => undefined,
    }) as TerminalConnection),
  } as unknown as SshApi
  return { api, send }
}

async function renderConnected(): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot>; send: ReturnType<typeof vi.fn> }> {
  const { api, send } = makeApi()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(<TerminalTab api={api} />) })
  await act(async () => { await Promise.resolve() })
  // Pick a host through the custom dropdown first, then connect.
  const picker = container.querySelector('button[class*="pSelectBox"]') as HTMLButtonElement
  await act(async () => { picker.click() })
  const hostOption = [...container.querySelectorAll('button[class*="jumpOption"]')]
    .find(button => (button.textContent ?? '').includes('web-1')) as HTMLButtonElement
  await act(async () => { hostOption.click() })
  const connect = [...container.querySelectorAll('button')].find(button => button.textContent === '连接') as HTMLButtonElement
  await act(async () => { connect.click() })
  return { container, root, send }
}

function rightClick(container: HTMLElement, x = 120, y = 80): void {
  const wrap = container.querySelector('[class*="termWrap"]') as HTMLElement
  act(() => {
    wrap.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }))
  })
}

describe('TerminalTab right-click menu', () => {
  it('opens on a live session with copy disabled and paste sending clipboard', async () => {
    const writeText = vi.fn(async () => undefined)
    const readText = vi.fn(async () => 'pasted-text')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText }, configurable: true })
    const { container, root, send } = await renderConnected()

    rightClick(container)
    const menu = container.querySelector('[class*="termMenu"]') as HTMLElement
    expect(menu).not.toBeNull()
    const copyItem = [...menu.querySelectorAll('button')].find(button => button.textContent === '复制') as HTMLButtonElement
    const pasteItem = [...menu.querySelectorAll('button')].find(button => button.textContent === '粘贴') as HTMLButtonElement
    expect(copyItem.disabled).toBe(true)

    await act(async () => { pasteItem.click() })
    await act(async () => { await Promise.resolve() })
    expect(readText).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('pasted-text')

    await act(async () => { root.unmount() })
  })

  it('enables copy when text is selected and writes the selection', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText: vi.fn(async () => '') }, configurable: true })
    const { container, root } = await renderConnected()

    selection.active = true
    selection.text = 'selected-line'
    const term = terminalInstances[0]
    await act(async () => { term.selCb?.() })

    rightClick(container)
    const menu = container.querySelector('[class*="termMenu"]') as HTMLElement
    const copyItem = [...menu.querySelectorAll('button')].find(button => button.textContent === '复制') as HTMLButtonElement
    expect(copyItem.disabled).toBe(false)

    await act(async () => { copyItem.click() })
    await act(async () => { await Promise.resolve() })
    expect(writeText).toHaveBeenCalledWith('selected-line')

    await act(async () => { root.unmount() })
  })
})