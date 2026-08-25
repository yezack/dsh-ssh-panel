// @vitest-environment jsdom
/**
 * The in-panel ConfirmProvider: confirm() renders the themed modal instead of
 * the blocking window.confirm, resolves true on 确定 and false on 取消 /
 * backdrop / Escape.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfirmProvider, useConfirm } from '../src/client/panel/confirm.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.replaceChildren()
})

function Harness() {
  const confirm = useConfirm()
  return (
    <div>
      <button
        id="ask"
        onClick={() => {
          void confirm({ text: '真的要删除吗？', danger: true }).then(result => {
            document.body.dataset.result = String(result)
          })
        }}
      >
        询问
      </button>
    </div>
  )
}

describe('ConfirmProvider', () => {
  it('renders the modal and resolves true on confirm', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<ConfirmProvider><Harness /></ConfirmProvider>) })

    const ask = container.querySelector('#ask') as HTMLButtonElement
    await act(async () => { ask.click() })
    const dialog = container.querySelector('[class*="modal"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('真的要删除吗？')

    const confirmButton = [...dialog.querySelectorAll('button')].find(button => button.textContent === '确定') as HTMLButtonElement
    await act(async () => { confirmButton.click() })
    expect(document.body.dataset.result).toBe('true')
    expect(container.querySelector('[class*="modal"]')).toBeNull()

    await act(async () => { root.unmount() })
  })

  it('resolves false on cancel and closes on Escape', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<ConfirmProvider><Harness /></ConfirmProvider>) })

    const ask = container.querySelector('#ask') as HTMLButtonElement
    await act(async () => { ask.click() })
    const dialog = container.querySelector('[class*="modal"]') as HTMLElement
    const cancelButton = [...dialog.querySelectorAll('button')].find(button => button.textContent === '取消') as HTMLButtonElement
    await act(async () => { cancelButton.click() })
    expect(document.body.dataset.result).toBe('false')

    await act(async () => { ask.click() })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.body.dataset.result).toBe('false')

    await act(async () => { root.unmount() })
  })
})
