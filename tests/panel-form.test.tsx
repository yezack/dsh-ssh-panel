// @vitest-environment jsdom
/**
 * HostFormDialog jump-host picker: candidates come from the saved host list,
 * the host being edited is excluded (a host cannot jump through itself), and
 * toggled aliases are saved back in selection order as the proxyJump chain.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostFormDialog } from '../src/client/panel/HostFormDialog.tsx'
import type { SshApi } from '../src/client/api.ts'
import type { SshHostSummary } from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.replaceChildren()
})

function makeHost(alias: string): SshHostSummary {
  return {
    alias,
    host: alias + '.example.com',
    port: 22,
    user: 'root',
    auth: 'key',
    keyReady: true,
    proxyJump: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('HostFormDialog jump-host picker', () => {
  it('offers saved hosts (excluding self) and saves the toggled chain', async () => {
    const updateHost = vi.fn(async (_alias: string, _payload: unknown) => makeHost('web-1'))
    const api = {
      listHosts: vi.fn(async () => [makeHost('bastion'), makeHost('db-1'), makeHost('web-1')]),
      updateHost,
    } as unknown as SshApi
    const editing = { ...makeHost('web-1'), proxyJump: ['bastion'] }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<HostFormDialog api={api} editing={editing} onClose={() => {}} onSaved={() => {}} />)
    })
    await act(async () => { await Promise.resolve() })

    const chips = [...container.querySelectorAll('button[class*="jumpChip"]')] as HTMLButtonElement[]
    const labels = chips.map(chip => chip.textContent ?? '')
    // The edited host itself is not a valid jump candidate.
    expect(labels.some(label => label.includes('web-1'))).toBe(false)
    expect(labels.some(label => label.includes('bastion'))).toBe(true)
    expect(labels.some(label => label.includes('db-1'))).toBe(true)

    // Toggle db-1 on: chain becomes bastion, db-1 (selection order).
    const dbChip = chips.find(chip => chip.textContent?.includes('db-1'))!
    expect(dbChip.getAttribute('aria-pressed')).toBe('false')
    await act(async () => { dbChip.click() })
    expect(dbChip.getAttribute('aria-pressed')).toBe('true')

    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存') as HTMLButtonElement
    await act(async () => { save.click() })
    expect(updateHost).toHaveBeenCalledWith('web-1', expect.objectContaining({ proxyJump: ['bastion', 'db-1'] }))
    await act(async () => { root.unmount() })
  })

  it('shows the empty hint when no other hosts exist', async () => {
    const api = { listHosts: vi.fn(async () => []) } as unknown as SshApi
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<HostFormDialog api={api} editing={null} onClose={() => {}} onSaved={() => {}} />)
    })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('暂无其他主机可选作跳板')
    await act(async () => { root.unmount() })
  })
})
