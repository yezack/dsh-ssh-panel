// @vitest-environment jsdom
/**
 * HostFormDialog jump-host picker: selected aliases render as el-tag style
 * tags INSIDE the input box (self excluded); typing filters the candidate
 * menu, picking appends a tag, × removes one hop, and the chain is saved in
 * selection order.
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
  it('renders tags inside the input box, picks from the menu and removes hops', async () => {
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

    // The prefilled chain renders as a tag INSIDE the input box.
    const box = container.querySelector('[class*="jumpBox"]') as HTMLElement
    const input = box.querySelector('input') as HTMLInputElement
    expect(box.textContent).toContain('bastion')
    expect([...box.querySelectorAll('button[class*="jumpTagRemove"]')]).toHaveLength(1)
    // The edited host itself is not offered by the menu.
    await act(async () => {
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    })
    const menuNames = [...container.querySelectorAll('button[class*="jumpOption"] span:first-child')].map(el => el.textContent)
    expect(menuNames).toContain('db-1')
    expect(menuNames).not.toContain('bastion')
    expect(menuNames).not.toContain('web-1')

    // Type to filter and pick db-1: a second tag appears inside the box and
    // the input is cleared.
    await act(async () => {
      input.value = 'db'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const options = [...container.querySelectorAll('button[class*="jumpOption"]')] as HTMLButtonElement[]
    expect(options).toHaveLength(1)
    expect(options[0]!.textContent).toContain('db-1')
    await act(async () => { options[0]!.click() })
    expect(box.textContent).toContain('db-1')
    expect((box.querySelector('input') as HTMLInputElement).value).toBe('')
    // Every candidate is now selected: the menu closes.
    expect(container.querySelector('[class*="jumpMenu"]')).toBeNull()

    // Remove the first hop: chain becomes db-1 only.
    let removes = [...box.querySelectorAll('button[class*="jumpTagRemove"]')]
    await act(async () => { (removes[0] as HTMLButtonElement).click() })
    const tagNames = [...box.querySelectorAll('span[class*="jumpTagName"]')].map(el => el.textContent)
    expect(tagNames).toEqual(['db-1'])
    removes = [...box.querySelectorAll('button[class*="jumpTagRemove"]')]
    expect(removes).toHaveLength(1)

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
