/**
 * PanelSelect: the plugin's unified dropdown. A native <select> popup is
 * rendered by the browser with the UA palette, so it can never match the app
 * theme (dark mode shows a white panel). This custom dropdown reuses the
 * jump-host combobox menu style (jumpMenu / jumpOption) — the same boxed
 * trigger and the same themed menu in every tab.
 */
import { useEffect, useRef, useState } from 'react'
import css from './panel.module.css'

/** One dropdown option. */
export interface PanelSelectOption {
  value: string
  label: string
}

/** PanelSelect props. */
export interface PanelSelectProps {
  /** Current value ('' renders the placeholder styling). */
  value: string
  options: PanelSelectOption[]
  onChange(value: string): void
  /** Shown when no option matches the value; also the menu's aria-label. */
  placeholder?: string
  ariaLabel?: string
  /** Extra class for layout context (e.g. the controls-row width rule). */
  className?: string
}

/** The themed custom dropdown used wherever a native <select> used to be. */
export function PanelSelect({ value, options, onChange, placeholder, ariaLabel, className }: PanelSelectProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Close on outside mousedown (the trigger and the menu share this wrapper).
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open])

  const current = options.find(option => option.value === value)
  const empty = value === ''

  const mergedClass = className !== undefined ? css.pSelect + ' ' + className : css.pSelect

  return (
    <div ref={wrapRef} className={mergedClass}>
      <button
        type="button"
        className={css.pSelectBox}
        data-open={open || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? placeholder}
        onClick={() => { setOpen(prev => !prev) }}
      >
        <span className={empty ? css.pSelectPlaceholder : css.pSelectValue}>
          {current !== undefined ? current.label : (placeholder ?? '')}
        </span>
        <span className={css.pSelectChevron} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={css.jumpMenu} role="listbox" aria-label={ariaLabel ?? placeholder}>
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={css.jumpOption}
              onMouseDown={event => { event.preventDefault() }}
              onClick={() => { onChange(option.value); setOpen(false) }}
            >
              <span className={css.jumpOptionName}>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
