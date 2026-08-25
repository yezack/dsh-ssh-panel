// @vitest-environment jsdom
/**
 * TerminalTab session manager: sessions for the same host aggregate into one
 * tab (count badge, click cycles), duplicates ask before opening (including
 * the hosts-list connect path), closing a tab asks first, live session
 * counts are reported up, and a transport-error exit auto-reconnects while
 * a clean exit does not.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalTab } from '../src/client/panel/TerminalTab.tsx'
import type { SshApi, TerminalConnection } from '../src/client/api.ts'

const { terminalInstances } = vi.hoisted(() => ({
  terminalInstances: [] as Array<{ hasSelection(): boolean }>,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    constructor() { terminalInstances.push(this as { hasSelection(): boolean }) }
    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    onData(): { dispose(): void } { return { dispose: () => undefined } }
    onSelectionChange(): { dispose(): void } { return { dispose: () => undefined } }
    hasSelection(): boolean { return false }
    getSelection(): string { return '' }
    clear(): void {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit(): void {} },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.restoreAllMocks()
  terminalInstances.length = 0
  document.body.replaceChildren()
})

function makeConnection(): TerminalConnection {
  return {
    onReady: undefined,
    onOutput: undefined,
    onExit: undefined,
    send: () => undefined,
    resize: () => undefined,
    close: () => undefined,
  }
}

function makeApi(): { api: SshApi; connections: TerminalConnection[]; openTerminal: ReturnType<typeof vi.fn> } {
  const connections: TerminalConnection[] = []
  const openTerminal = vi.fn(() => {
    const connection = makeConnection()
    connections.push(connection)
    return connection
  })
  const api = {
    listHosts: vi.fn(async () => [{ alias: 'web-1', host: 'web-1.example.com' }]),
    openTerminal,
  } as unknown as SshApi
  return { api, connections, openTerminal }
}

async function connectOnce(container: HTMLElement): Promise<void> {
  const picker = container.querySelector('button[class*="pSelectBox"]') as HTMLButtonElement
  await act(async () => { picker.click() })
  const hostOption = [...container.querySelectorAll('button[class*="jumpOption"]')]
    .find(button => (button.textContent ?? '').includes('web-1')) as HTMLButtonElement
  await act(async () => { hostOption.click() })
  const connect = [...container.querySelectorAll('button')].find(button => button.textContent === '连接') as HTMLButtonElement
  await act(async () => { connect.click() })
}

describe('TerminalTab sessions', () => {
  it('aggregates same-host sessions into one tab and cycles on click', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { api, connections } = makeApi()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<TerminalTab api={api} />) })
    await act(async () => { await Promise.resolve() })

    await connectOnce(container)
    await connectOnce(container)
    expect(api.openTerminal).toHaveBeenCalledTimes(2)
    expect(connections).toHaveLength(2)

    // One aggregated chip per alias, with a count badge and an active mark.
    const chips = [...container.querySelectorAll('div[class*="sessionChip"]')]
    expect(chips.length).toBe(1)
    expect(chips[0]!.textContent).toContain('×2')
    expect(container.querySelectorAll('div[class*="sessionChipActive"]')).toHaveLength(1)

    // Clicking the chip cycles to the other session (still one active mark).
    const main = chips[0]!.querySelector('button[class*="sessionChipMain"]') as HTMLButtonElement
    await act(async () => { main.click() })
    expect(container.querySelectorAll('div[class*="sessionChipActive"]')).toHaveLength(1)

    // Closing the tab asks first, then removes every session of the host.
    const close = chips[0]!.querySelector('button[class*="sessionChipClose"]') as HTMLButtonElement
    await act(async () => { close.click() })
    expect(window.confirm).toHaveBeenCalled()
    expect(container.querySelectorAll('div[class*="sessionChip"]')).toHaveLength(0)
    expect(api.openTerminal).toHaveBeenCalledTimes(2)

    await act(async () => { root.unmount() })
  })

  it('asks before opening a duplicate live session and respects the answer', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { api } = makeApi()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<TerminalTab api={api} />) })
    await act(async () => { await Promise.resolve() })

    await connectOnce(container)
    expect(api.openTerminal).toHaveBeenCalledTimes(1)

    // Declined: no second session is created.
    await connectOnce(container)
    expect(confirm).toHaveBeenCalled()
    expect(api.openTerminal).toHaveBeenCalledTimes(1)

    // Accepted: the second session opens and the chip aggregates.
    confirm.mockReturnValue(true)
    await connectOnce(container)
    expect(api.openTerminal).toHaveBeenCalledTimes(2)
    expect(container.querySelector('div[class*="sessionChip"]')!.textContent).toContain('×2')

    await act(async () => { root.unmount() })
  })

  it('reports live session counts per alias', async () => {
    const counts: Array<Record<string, number>> = []
    const { api } = makeApi()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<TerminalTab api={api} onSessionsChange={value => { counts.push(value) }} />)
    })
    await act(async () => { await Promise.resolve() })
    await connectOnce(container)
    expect(counts[counts.length - 1]).toEqual({ 'web-1': 1 })

    await act(async () => { root.unmount() })
  })

  it('auto-reconnects after a transport error and not on a clean exit', async () => {
    const { api, connections } = makeApi()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<TerminalTab api={api} />) })
    await act(async () => { await Promise.resolve() })
    await connectOnce(container)
    expect(api.openTerminal).toHaveBeenCalledTimes(1)

    // A clean exit (user typed exit / closed shell): no reconnect, and the
    // host is no longer counted as live, so the next connect needs no confirm.
    await act(async () => { connections[0]!.onExit?.(0, undefined) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(api.openTerminal).toHaveBeenCalledTimes(1)

    // A transport error on the second session: reconnect after the backoff.
    await connectOnce(container)
    await act(async () => { connections[1]!.onExit?.(null, 'connection closed') })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)) })
    expect(api.openTerminal).toHaveBeenCalledTimes(3)

    await act(async () => { root.unmount() })
  })
})
