/**
 * Non-blocking in-panel confirm dialog. window.confirm blocks the renderer
 * and looks nothing like the app; this replaces it with the panel's modal
 * styling. Components call `useConfirm()` and await the boolean. Mounted
 * once by SshPanel around the tabs; without a provider (standalone test
 * mounts) it falls back to window.confirm so nothing regresses.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { tt } from './helpers.ts'
import css from './panel.module.css'

/** Confirm dialog options. */
export interface ConfirmOptions {
  /** Heading (defaults to a generic title). */
  title?: string
  /** The question text. */
  text: string
  /** Confirm-button label (defaults to 确定/OK). */
  confirmLabel?: string
  /** Render the confirm button as destructive (red). */
  danger?: boolean
}

interface ConfirmState {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null)

/** Renders the modal and provides `useConfirm()` to descendants. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null)

  const confirm = (options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState({ options, resolve })
    })
  }

  const settle = (value: boolean): void => {
    state?.resolve(value)
    setState(null)
  }

  // Escape cancels, like the other dialogs in the panel.
  useEffect(() => {
    if (state === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') settle(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state !== null && (
        <div className={css.modalBackdrop} onClick={() => { settle(false) }}>
          <div className={css.modal} role="dialog" aria-modal="true" aria-label={state.options.title ?? tt('confirm.title')} onClick={event => { event.stopPropagation() }}>
            <h3 className={css.modalTitle}>{state.options.title ?? tt('confirm.title')}</h3>
            <p className={css.confirmText}>{state.options.text}</p>
            <div className={css.modalFooter}>
              <button type="button" className={css.ghostButton} onClick={() => { settle(false) }}>{tt('form.cancel')}</button>
              <button
                type="button"
                className={state.options.danger === true ? css.dangerButton : css.primaryButton}
                onClick={() => { settle(true) }}
              >
                {state.options.confirmLabel ?? tt('confirm.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

/** Await a user decision; falls back to window.confirm without a provider. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const fromContext = useContext(ConfirmContext)
  return fromContext ?? ((options: ConfirmOptions) => Promise.resolve(window.confirm(options.text)))
}
