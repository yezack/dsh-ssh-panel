// @vitest-environment jsdom
/**
 * Hosts-tab "Connect" one-click flow: the terminal tab auto-connects to the
 * preset alias — no second Connect press inside the terminal tab. The
 * auto-connect is a real openTerminal call driven by presetAlias + requestId;
 * a bare presetAlias (no request) only preselects, preserving legacy callers.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { terminalInstances } = vi.hoisted(() => ({
  terminalInstances: [] as unknown[],
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    constructor() { terminalInstances.push(this) }
    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    onData(): { dispose(): void } { return { dispose: () => undefined } }
    onSelectionChange(): { dispose(): void } { return { dispose: () => undefined } }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit(): void {} },
}))

import { TerminalTab } from '../src/client/panel/TerminalTab.tsx'
import type { SshApi, TerminalConnection } from '../src/client/api.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.restoreAllMocks()
  terminalInstances.length = 0
  document.body.replaceChildren()
})

function fakeApi(): { api: SshApi; openTerminal: ReturnType<typeof vi.fn> } {
  const openTerminal = vi.fn(() => ({
    onReady: undefined,
    onOutput: undefined,
    onExit: undefined,
    send: () => undefined,
    resize: () => undefined,
    close: () => undefined,
  }) as TerminalConnection)
  return {
    api: {
      listHosts: vi.fn(async () => [{ alias: 'web-1', host: 'web-1.example.com' }]),
      openTerminal,
    } as unknown as SshApi,
    openTerminal,
  }
}

describe('TerminalTab hosts-tab auto-connect', () => {
  it('connects to the preset alias without a manual Connect click', async () => {
    const { api, openTerminal } = fakeApi()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<TerminalTab api={api} presetAlias="web-1" requestId={1} />)
    })
    // Flush the hosts load and the deferred auto-connect timer.
    await act(async () => { await Promise.resolve() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(openTerminal).toHaveBeenCalledWith('web-1', expect.any(Number), expect.any(Number))
    expect(terminalInstances).toHaveLength(1)
    await act(async () => { root.unmount() })
  })

  it('preselects but does not auto-connect without a connect request', async () => {
    const { api, openTerminal } = fakeApi()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<TerminalTab api={api} presetAlias="web-1" />)
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(openTerminal).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })
})
