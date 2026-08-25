/**
 * Terminal tab: an xterm.js PTY view over the host's WebSocket terminal route.
 * A host <select> plus connect/disconnect controls; the terminal container is
 * sized by FitAddon (default 80x24 before first fit). On remote exit the last
 * output stays visible and input is disabled. xterm's stylesheet is injected
 * once per page load (module-level guard).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SshApi, TerminalConnection } from '../api.ts'
import type { SshHostSummary } from '../../protocol.ts'
import { XTERM_CSS } from './xterm.css.ts'
import { errorMessage, resolveTerminalFontFamily, tt, type TerminalFontSource } from './helpers.ts'
import { PanelSelect } from './Select.tsx'
import css from './panel.module.css'

/** Terminal tab props. */
export interface TerminalTabProps {
  api: SshApi
  /** Alias preselected by a "connect" action from the hosts tab. */
  presetAlias?: string
  /** Monotonic id of the connect request (re-applies presetAlias). */
  requestId?: number
  /**
   * Live terminal-font setting source (issue #577). Absent in tests and
   * legacy mounts: the font then comes from the CSS custom-property chain.
   */
  terminalFont?: TerminalFontSource
}

/** The terminal session lifecycle state shown in the status banner. */
type TerminalStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; alias: string }
  | { kind: 'exited'; alias: string; detail?: string }
  | { kind: 'error'; detail: string }

/** Injected-once guard for the xterm stylesheet (one tag per page load). */
let xtermCssInjected = false

function ensureXtermCss(): void {
  if (xtermCssInjected || typeof document === 'undefined') return
  xtermCssInjected = true
  if (document.querySelector('style[data-dsh-ssh-xterm]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshSshXterm = ''
  style.textContent = XTERM_CSS
  document.head.appendChild(style)
}

/** No-op source stand-in so the hook order stays stable without the prop. */
const NO_FONT_SOURCE: TerminalFontSource = {
  get: () => undefined,
  subscribe: () => () => undefined,
}

/** The xterm terminal view. */
export function TerminalTab({ api, presetAlias, requestId, terminalFont }: TerminalTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState(presetAlias ?? '')
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'idle' })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const connRef = useRef<TerminalConnection | null>(null)
  const dataSubRef = useRef<IDisposable | null>(null)
  const selectionSubRef = useRef<IDisposable | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Right-click menu on the live terminal: copy (enabled only when xterm has
  // a selection) and paste (writes the clipboard into the PTY).
  const [selectionActive, setSelectionActive] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const fontSource = terminalFont ?? NO_FONT_SOURCE
  const fontOverride = useSyncExternalStore(fontSource.subscribe, fontSource.get)

  useEffect(() => { ensureXtermCss() }, [])

  // Live re-apply a terminal-font change (issue #577): xterm re-measures
  // and repaints on the options write; a refit keeps cols/rows aligned with
  // the new metrics and the remote PTY learns the new size.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const next = resolveTerminalFontFamily(fontOverride)
    if (term.options.fontFamily === next) return
    term.options.fontFamily = next
    fitRef.current?.fit()
    connRef.current?.resize(term.cols, term.rows)
  }, [fontOverride])

  // Fetch the host list on tab activation.
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const list = await api.listHosts()
        if (!disposed) setHosts(list)
      } catch (cause) {
        if (!disposed) setStatus({ kind: 'error', detail: errorMessage(cause) })
      }
    })()
    return () => { disposed = true }
  }, [api])

  // A hosts-tab connect action preselects its alias here and connects
  // immediately — one click in the host list must reach a live shell without
  // a second "Connect" press. The timeout defers past the commit so the
  // terminal container is guaranteed to exist.
  useEffect(() => {
    if (presetAlias === undefined || requestId === undefined) return
    setAlias(presetAlias)
    const timer = setTimeout(() => { connectToRef.current(presetAlias) }, 0)
    return () => { clearTimeout(timer) }
  }, [presetAlias, requestId])

  const teardown = (): void => {
    const connection = connRef.current
    connRef.current = null
    if (connection !== null) {
      connection.onReady = undefined
      connection.onOutput = undefined
      connection.onExit = undefined
      connection.close()
    }
    // Release the xterm subscriptions explicitly and dispose the terminal
    // so no listener (or the terminal Renderer) survives a disconnect or
    // the tab unmounting.
    dataSubRef.current?.dispose()
    dataSubRef.current = null
    selectionSubRef.current?.dispose()
    selectionSubRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
    setSelectionActive(false)
    setContextMenu(null)
  }

  // Unmount cleanup (never touches state on an unmounting component).
  useEffect(() => () => { teardown() }, [])

  // Keep the terminal fitted to its container. A window resize is only one
  // trigger: the status banner appearing after connect, panel resizes, and
  // sidebar toggles all change the container without a window resize, so the
  // container itself is observed (otherwise the viewport keeps the pre-banner
  // height and the last line is clipped below the fold). ResizeObserver may
  // be absent (jsdom tests); the window listener then remains the only path.
  useEffect(() => {
    let lastCols = -1
    let lastRows = -1
    const sync = (): void => {
      const term = termRef.current
      const fit = fitRef.current
      if (term === null || fit === null) return
      fit.fit()
      const conn = connRef.current
      if (conn !== null && (term.cols !== lastCols || term.rows !== lastRows)) {
        lastCols = term.cols
        lastRows = term.rows
        conn.resize(term.cols, term.rows)
      }
    }
    window.addEventListener('resize', sync)
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') {
      return () => { window.removeEventListener('resize', sync) }
    }
    const observer = new ResizeObserver(() => { sync() })
    observer.observe(container)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])

  /** Open the PTY for an explicit alias (used by the connect button and the
   *  hosts-tab auto-connect path). */
  const connectTo = (target: string): void => {
    const container = containerRef.current
    if (target === '' || container === null) return
    if (status.kind === 'connecting' || status.kind === 'connected') return
    teardown()
    setStatus({ kind: 'connecting' })
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: resolveTerminalFontFamily(fontOverride),
      theme: { background: '#0b0e14', foreground: '#d8dee9', cursor: '#a3b8d0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    const connection = api.openTerminal(target, term.cols, term.rows)
    termRef.current = term
    fitRef.current = fit
    connRef.current = connection
    let settled = false
    dataSubRef.current = term.onData(data => { connection.send(data) })
    // Track xterm's selection so the context menu's copy item can enable
    // itself only when text is actually selected.
    selectionSubRef.current = term.onSelectionChange(() => { setSelectionActive(term.hasSelection()) })
    connection.onReady = () => { setStatus({ kind: 'connected', alias: target }) }
    connection.onOutput = data => { term.write(data) }
    connection.onExit = (_code, error) => {
      if (settled) return
      settled = true
      dataSubRef.current?.dispose()
      dataSubRef.current = null
      term.options.disableStdin = true
      connRef.current = null
      // Keep the last output visible; input is now disabled.
      setStatus({ kind: 'exited', alias: target, detail: error })
    }
  }

  const connect = (): void => { connectTo(alias) }

  // The hosts-tab connect action fires the auto-connect from an effect; keep
  // the latest connectTo in a ref so the timer never calls a stale closure.
  const connectToRef = useRef<(alias: string) => void>(() => undefined)
  connectToRef.current = connectTo

  const disconnect = (): void => {
    teardown()
    setStatus({ kind: 'idle' })
  }

  const active = status.kind === 'connecting' || status.kind === 'connected'
  // A live session only: the menu is pointless while the shell is gone.
  const sessionLive = connRef.current !== null && termRef.current !== null

  /** Right-click on the live terminal: open the copy/paste menu, no browser menu. */
  const handleContextMenu = (event: ReactMouseEvent): void => {
    if (!sessionLive) return
    event.preventDefault()
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 150),
      y: Math.min(event.clientY, window.innerHeight - 90),
    })
  }

  /** Copy the xterm selection into the clipboard. */
  const copySelection = async (): Promise<void> => {
    const term = termRef.current
    if (term === null || !term.hasSelection()) return
    const text = term.getSelection()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      fallbackCopy(text)
    }
  }

  /** execCommand fallback for environments without the async clipboard API. */
  const fallbackCopy = (text: string): void => {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try { document.execCommand('copy') } catch { /* clipboard unavailable */ }
    textarea.remove()
  }

  /** Paste the clipboard into the remote PTY. */
  const pasteClipboard = async (): Promise<void> => {
    const connection = connRef.current
    if (connection === null) return
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (text !== '') connection.send(text)
  }

  // Close the context menu on outside mousedown or Escape.
  useEffect(() => {
    if (contextMenu === null) return
    const onDown = (event: MouseEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) setContextMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  return (
    <div className={css.termBody}>
      <div className={css.controls}>
        <PanelSelect
          ariaLabel={tt('terminal.selectHost')}
          value={alias}
          onChange={setAlias}
          options={[
            { value: '', label: tt('terminal.selectHost') },
            ...hosts.map(host => ({ value: host.alias, label: host.alias + ' (' + host.host + ')' })),
          ]}
        />
        <button type="button" className={css.primaryButton} disabled={alias === '' || active} onClick={connect}>{tt('terminal.connect')}</button>
        <button type="button" className={css.ghostButton} disabled={!active} onClick={disconnect}>{tt('terminal.disconnect')}</button>
      </div>
      {status.kind === 'connecting' && <div className={css.banner} data-kind="info">{tt('terminal.connecting')}</div>}
      {status.kind === 'connected' && <div className={css.banner} data-kind="ok">{tt('terminal.ready', { alias: status.alias })}</div>}
      {status.kind === 'exited' && (
        <div className={css.banner} data-kind="info">{tt('terminal.exited', { alias: status.alias })}{status.detail !== undefined ? ' (' + status.detail + ')' : ''}</div>
      )}
      {status.kind === 'error' && <div className={css.banner} data-kind="error">{tt('terminal.error', { error: status.detail })}</div>}
      <div className={css.termWrap} onContextMenu={handleContextMenu}>
        <div ref={containerRef} className={css.termContainer} data-dsh-part="terminal" />
        {status.kind === 'idle' && (
          <div className={css.termPlaceholder}>{hosts.length === 0 ? tt('hosts.empty') : tt('terminal.placeholder')}</div>
        )}
      </div>
      {contextMenu !== null && sessionLive && (
        <div
          ref={menuRef}
          className={css.termMenu}
          role="menu"
          aria-label={tt('terminal.menu.label')}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={event => { event.preventDefault() }}
        >
          <button
            type="button"
            role="menuitem"
            className={css.termMenuItem}
            disabled={!selectionActive}
            onClick={() => { setContextMenu(null); void copySelection() }}
          >
            {tt('terminal.menu.copy')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.termMenuItem}
            onClick={() => { setContextMenu(null); void pasteClipboard() }}
          >
            {tt('terminal.menu.paste')}
          </button>
        </div>
      )}
    </div>
  )
}
