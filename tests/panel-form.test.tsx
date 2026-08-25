// @vitest-environment jsdom
/**
 * HostFormDialog jump-host picker: candidates come from the saved host list
 * (dropdown, self excluded), the selected chain renders as removable tags
 * (× removes one hop), and the chain is saved in selection order.
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
  it('picks from the dropdown into removable tags and saves the chain order', async () => {
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

    // Dropdown offers the remaining saved hosts: already-selected aliases
    // (bastion, prefilled) and the edited host itself (web-1) are excluded.
    const select = container.querySelector('select[aria-label="选择跳板机…"]') as HTMLSelectElement
    const options = [...select.querySelectorAll('option')].map(option => option.value)
    expect(options).not.toContain('bastion')
    expect(options).toContain('db-1')
    expect(options).not.toContain('web-1')

    // The prefilled chain renders as a removable tag.
    const removeButtons = [...container.querySelectorAll('button[class*="jumpTagRemove"]')] as HTMLButtonElement[]
    expect(removeButtons).toHaveLength(1)
    expect(container.textContent).toContain('bastion')

    // Pick db-1 from the dropdown: chain becomes bastion, db-1, and with
    // every candidate selected the dropdown disappears.
    await act(async () => {
      select.value = 'db-1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    let tagsAfterPick = [...container.querySelectorAll('button[class*="jumpTagRemove"]')]
    expect(tagsAfterPick).toHaveLength(2)
    expect(container.querySelector('select')).toBeNull()

    // Remove the first hop: chain becomes db-1 only, dropdown returns with
    // the freed candidate.
    await act(async () => { (tagsAfterPick[0] as HTMLButtonElement).click() })
    const tagNames = [...container.querySelectorAll('span[class*="jumpTagName"]')].map(el => el.textContent)
    expect(tagNames).toEqual(['db-1'])
    tagsAfterPick = [...container.querySelectorAll('button[class*="jumpTagRemove"]')]
    expect(tagsAfterPick).toHaveLength(1)
    const selectAgain = container.querySelector('select') as HTMLSelectElement
    expect([...selectAgain.querySelectorAll('option')].map(option => option.value)).toContain('bastion')

    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存') as HTMLButtonElement
    await act(async () => { save.click() })
    expect(updateHost).toHaveBeenCalledWith('web-1', expect.objectContaining({ proxyJump: ['db-1'] }))
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
