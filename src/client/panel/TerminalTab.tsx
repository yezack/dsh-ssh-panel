/**
 * Terminal tab: xterm.js PTY sessions over the host's WebSocket terminal route.
 * A host picker plus a session bar: 「连接」opens a NEW session for the picked
 * host, so multiple sessions run side by side. Sessions survive tab switches
 * (SshPanel hides inactive tabs instead of unmounting them). A session that
 * drops with a transport error auto-reconnects with backoff (up to
 * MAX_RECONNECTS attempts); a clean exit just ends the session. Right-click
 * on the live terminal opens a copy / paste / interrupt (Ctrl+C) / clear menu.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SshApi, TerminalConnection } from '../api.ts'
import type { SshHostSummary } from '../../protocol.ts'
import { XTERM_CSS } from './xterm.css.ts'
import { errorMessage, resolveTerminalFontFamily, tt, type TerminalFontSource } from './helpers.ts'
import { PanelSelect } from './Select.tsx'
import { useConfirm } from './confirm.tsx'
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
  /** True when the hosts-list connect action already confirmed a duplicate. */
  duplicateConfirmed?: boolean
  /** Reports live session counts per alias (hosts list badge). */
  onSessionsChange?: (counts: Record<string, number>) => void
}

/** Max auto-reconnect attempts per session (transport errors only). */
const MAX_RECONNECTS = 3
/** Backoff base: reconnect delays are 1s, 2s, 4s. */
const RECONNECT_BASE_MS = 1000

/**
 * The terminal background is painted by CSS (.termContainer uses the theme's
 * --dsw-alias-bg-base, exactly like the idle placeholder), so it always
 * matches the rest of the panel. xterm itself is fully transparent here;
 * set the container background to color-mix(in srgb, var(--dsw-alias-bg-base)
 * 70%, transparent) for a 70% translucent look.
 */

/** The terminal session lifecycle state shown in the status banner. */
type SessionStatus = 'connecting' | 'connected' | 'exited'

/** One live PTY session: its xterm instance plus the WebSocket connection. */
interface TermSession {
  id: number
  alias: string
  term: Terminal
  fit: FitAddon
  conn: TerminalConnection | null
  dataSub: IDisposable | null
  selectionSub: IDisposable | null
  status: SessionStatus
  error?: string
  reconnectAttempts: number
  reconnectTimer?: ReturnType<typeof setTimeout>
  /** Guards the exit handler against double delivery (onclose + onerror). */
  exited: boolean
}

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
export function TerminalTab({ api, presetAlias, requestId, terminalFont, duplicateConfirmed, onSessionsChange }: TerminalTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState(presetAlias ?? '')
  const [sessions, setSessions] = useState<TermSession[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [selectionActive, setSelectionActive] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const nextSessionId = useRef(1)
  const sessionsRef = useRef<TermSession[]>([])
  sessionsRef.current = sessions
  const fontSource = terminalFont ?? NO_FONT_SOURCE
  const fontOverride = useSyncExternalStore(fontSource.subscribe, fontSource.get)

  const activeSession = sessions.find(session => session.id === activeId) ?? null
  const confirm = useConfirm()

  useEffect(() => { ensureXtermCss() }, [])

  // Report live (connecting/connected) session counts per alias so the hosts
  // list can badge how many terminals are open against each host.
  useEffect(() => {
    const counts: Record<string, number> = {}
    for (const session of sessions) {
      if (session.status === 'connecting' || session.status === 'connected') {
        counts[session.alias] = (counts[session.alias] ?? 0) + 1
      }
    }
    onSessionsChange?.(counts)
  }, [sessions, onSessionsChange])

  // Live re-apply a terminal-font change (issue #577) to every session.
  useEffect(() => {
    const next = resolveTerminalFontFamily(fontOverride)
    for (const session of sessionsRef.current) {
      if (session.term.options.fontFamily === next) continue
      session.term.options.fontFamily = next
      session.fit.fit()
      session.conn?.resize(session.term.cols, session.term.rows)
    }
  }, [fontOverride])

  // Fetch the host list on tab activation.
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const list = await api.listHosts()
        if (!disposed) setHosts(list)
      } catch (cause) {
        if (!disposed) setListError(errorMessage(cause))
      }
    })()
    return () => { disposed = true }
  }, [api])

  // A hosts-tab connect action opens a new session for its alias. The
  // panel already confirmed duplicates in that flow (see SshPanel).
  useEffect(() => {
    if (presetAlias === undefined || requestId === undefined) return
    setAlias(presetAlias)
    const timer = setTimeout(() => { connectToRef.current(presetAlias, duplicateConfirmed ?? false) }, 0)
    return () => { clearTimeout(timer) }
  }, [presetAlias, requestId, duplicateConfirmed])

  /** Show one session's xterm element; hide the others (all live in the container). */
  const showSession = (target: TermSession): void => {
    const all = [...sessionsRef.current.filter(session => session.id !== target.id), target]
    for (const session of all) {
      const element = session.term.element
      if (element === undefined) continue
      element.style.display = session.id === target.id ? '' : 'none'
    }
    target.fit.fit()
    target.conn?.resize(target.term.cols, target.term.rows)
  }

  const activateSession = (id: number): void => {
    const session = sessionsRef.current.find(candidate => candidate.id === id)
    if (session === undefined) return
    setActiveId(id)
    setSelectionActive(session.term.hasSelection())
    showSession(session)
  }

  /** Mutate a session and push the array reference so React re-renders. */
  const syncSessions = (): void => {
    setSessions([...sessionsRef.current])
  }

  const openTerminalFor = (session: TermSession, target: string): void => {
    const connection = api.openTerminal(target, session.term.cols, session.term.rows)
    session.conn = connection
    session.exited = false
    session.status = 'connecting'
    session.error = undefined
    session.dataSub?.dispose()
    session.dataSub = session.term.onData(data => { connection.send(data) })
    session.selectionSub?.dispose()
    session.selectionSub = session.term.onSelectionChange(() => {
      setSelectionActive(session.term.hasSelection())
    })
    connection.onReady = () => {
      session.status = 'connected'
      session.reconnectAttempts = 0
      syncSessions()
    }
    connection.onOutput = data => { session.term.write(data) }
    connection.onExit = (code, error) => { handleSessionExit(session, code, error) }
    // No sync here on purpose: createSession appends this session to the
    // state first, and syncing here would clobber the pending append with the
    // (stale) pre-render array. The onReady/onExit handlers sync later.
  }

  const handleSessionExit = (session: TermSession, _code: number | null, error: string | undefined): void => {
    if (session.exited) return
    session.exited = true
    session.conn = null
    if (error !== undefined && session.reconnectAttempts < MAX_RECONNECTS) {
      // Transport error (ws closed unexpectedly): auto-reconnect with backoff.
      session.reconnectAttempts += 1
      session.status = 'connecting'
      session.error = undefined
      syncSessions()
      const delay = RECONNECT_BASE_MS * 2 ** (session.reconnectAttempts - 1)
      session.reconnectTimer = setTimeout(() => {
        const live = sessionsRef.current.find(candidate => candidate.id === session.id)
        if (live === undefined || live.conn !== null) return
        try {
          openTerminalFor(live, live.alias)
        } catch (cause) {
          handleSessionExit(live, null, errorMessage(cause))
        }
      }, delay)
      return
    }
    session.status = 'exited'
    session.error = error
    session.term.options.disableStdin = true
    if (activeId === session.id) setSelectionActive(false)
    syncSessions()
  }

  const teardownSession = (session: TermSession): void => {
    if (session.reconnectTimer !== undefined) clearTimeout(session.reconnectTimer)
    session.reconnectTimer = undefined
    const connection = session.conn
    session.conn = null
    if (connection !== null) {
      connection.onReady = undefined
      connection.onOutput = undefined
      connection.onExit = undefined
      connection.close()
    }
    session.dataSub?.dispose()
    session.dataSub = null
    session.selectionSub?.dispose()
    session.selectionSub = null
    try { session.term.dispose() } catch { /* already gone */ }
  }

  /** Open a brand-new session for the given alias. */
  const createSession = async (target: string, duplicateConfirmedByCaller = false): Promise<void> => {
    const container = containerRef.current
    if (target === '' || container === null) return
    // Opening the same host twice is almost always a mis-click (including
    // the hosts-list connect action); ask first unless the caller already did.
    const live = sessionsRef.current.filter(session =>
      session.alias === target && (session.status === 'connecting' || session.status === 'connected')).length
    if (live > 0 && !duplicateConfirmedByCaller) {
      const ok = await confirm({
        text: tt('terminal.duplicateConfirm', { alias: target, count: live }),
        confirmLabel: tt('terminal.openAnother', { count: live }),
      })
      if (!ok) return
    }
    const id = nextSessionId.current
    nextSessionId.current += 1
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: resolveTerminalFontFamily(fontOverride),
      // The terminal is transparent; .termContainer paints the theme's
      // --dsw-alias-bg-base behind it (identical to the idle placeholder).
      allowTransparency: true,
      theme: { background: 'rgba(0, 0, 0, 0)', foreground: '#d8dee9', cursor: '#a3b8d0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    const session: TermSession = {
      id,
      alias: target,
      term,
      fit,
      conn: null,
      dataSub: null,
      selectionSub: null,
      status: 'connecting',
      reconnectAttempts: 0,
      exited: false,
    }
    setSessions(prev => [...prev, session])
    setActiveId(id)
    setSelectionActive(false)
    showSession(session)
    openTerminalFor(session, target)
  }

  const closeSession = (id: number): void => {
    const session = sessionsRef.current.find(candidate => candidate.id === id)
    if (session === undefined) return
    teardownSession(session)
    const remaining = sessionsRef.current.filter(candidate => candidate.id !== id)
    setSessions(remaining)
    if (activeId === id) {
      const next = remaining.length > 0 ? remaining[remaining.length - 1]! : null
      setActiveId(next === null ? null : next.id)
      setSelectionActive(false)
      if (next !== null) showSession(next)
    }
  }

  const connect = (): void => { void createSession(alias) }

  // The hosts-tab connect action fires from an effect; keep the latest
  // createSession in a ref so the timer never calls a stale closure.
  const connectToRef = useRef<(alias: string, confirmed?: boolean) => void | Promise<void>>(() => undefined)
  connectToRef.current = createSession

  const disconnect = (): void => {
    if (activeSession !== null) closeSession(activeSession.id)
  }

  // Unmount cleanup: tear down every session (never touches state).
  useEffect(() => () => {
    for (const session of sessionsRef.current) teardownSession(session)
  }, [])

  // Keep the active terminal fitted to its container.
  useEffect(() => {
    const sync = (): void => {
      const session = sessionsRef.current.find(candidate => candidate.id === activeId) ?? null
      if (session === null) return
      session.fit.fit()
      const conn = session.conn
      if (conn !== null) conn.resize(session.term.cols, session.term.rows)
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
  }, [activeId])

  const sessionLive = activeSession !== null && activeSession.conn !== null

  /** Right-click on the live terminal: open the copy/paste menu, no browser menu. */
  const handleContextMenu = (event: ReactMouseEvent): void => {
    if (!sessionLive) return
    event.preventDefault()
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 150),
      y: Math.min(event.clientY, window.innerHeight - 110),
    })
  }

  /** Copy the active session's selection into the clipboard. */
  const copySelection = async (): Promise<void> => {
    const term = activeSession?.term
    if (term === undefined || !term.hasSelection()) return
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

  /** Paste the clipboard into the active session's remote PTY. */
  const pasteClipboard = async (): Promise<void> => {
    const connection = activeSession?.conn
    if (connection === null || connection === undefined) return
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (text !== '') connection.send(text)
  }

  /** Send SIGINT (Ctrl+C) to the active session. */
  const sendInterrupt = (): void => {
    activeSession?.conn?.send('\x03')
  }

  /** Clear the active session's screen (xterm buffer). */
  const clearScreen = (): void => {
    activeSession?.term.clear()
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

  const reconnecting = activeSession !== null && activeSession.status === 'connecting' && activeSession.reconnectAttempts > 0

  // Sessions aggregate by target alias: one chip per host, count badge when
  // several sessions share it. Clicking a chip cycles through its sessions.
  const sessionGroups: Array<{ alias: string; sessions: TermSession[] }> = []
  const groupIndex = new Map<string, number>()
  for (const session of sessions) {
    const at = groupIndex.get(session.alias)
    if (at === undefined) {
      groupIndex.set(session.alias, sessionGroups.length)
      sessionGroups.push({ alias: session.alias, sessions: [session] })
    } else {
      sessionGroups[at].sessions.push(session)
    }
  }

  const activateGroup = (group: { alias: string; sessions: TermSession[] }): void => {
    const current = group.sessions.findIndex(session => session.id === activeId)
    const next = group.sessions[(current + 1) % group.sessions.length]
    activateSession(next.id)
  }

  // Secondary (per-session) tabs: when the active host has several sessions,
  // the "终端已连接" banner area becomes a second-level tab bar for them.
  const activeGroup = sessionGroups.find(group => group.sessions.some(session => session.id === activeId)) ?? null
  const secondaryTabs = activeGroup !== null && activeGroup.sessions.length > 1 ? activeGroup.sessions : null

  const closeGroup = async (group: { alias: string; sessions: TermSession[] }): Promise<void> => {
    const ok = await confirm({ text: tt('terminal.closeConfirm', { alias: group.alias, count: group.sessions.length }), danger: true })
    if (!ok) return
    // Tear down and remove every session of the host in ONE state snapshot:
    // looping closeSession would re-read the stale sessions ref between
    // updates and resurrect removed sessions.
    const ids = new Set(group.sessions.map(session => session.id))
    const remaining = sessionsRef.current.filter(session => !ids.has(session.id))
    for (const session of sessionsRef.current) {
      if (ids.has(session.id)) teardownSession(session)
    }
    setSessions(remaining)
    if (activeId !== null && ids.has(activeId)) {
      const next = remaining.length > 0 ? remaining[remaining.length - 1]! : null
      setActiveId(next === null ? null : next.id)
      setSelectionActive(false)
      if (next !== null) showSession(next)
    }
  }

  /** Close ONE session from a secondary tab (asks first). */
  const closeSessionWithConfirm = async (id: number): Promise<void> => {
    const session = sessionsRef.current.find(candidate => candidate.id === id)
    if (session === undefined) return
    const ok = await confirm({ text: tt('terminal.closeConfirm', { alias: session.alias, count: 1 }), danger: true })
    if (!ok) return
    closeSession(id)
  }

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
        <button type="button" className={css.primaryButton} disabled={alias === ''} onClick={connect}>{tt('terminal.connect')}</button>
        <button type="button" className={css.ghostButton} disabled={activeSession === null} onClick={disconnect}>{tt('terminal.disconnect')}</button>
      </div>
      {sessionGroups.length > 0 && (
        <div className={css.sessionBar} role="tablist" aria-label={tt('terminal.sessions')}>
          {sessionGroups.map(group => {
            const activeSessionInGroup = group.sessions.find(session => session.id === activeId) ?? group.sessions[0]
            const active = activeSessionInGroup.id === activeId
            return (
              <div key={group.alias} className={active ? css.sessionChip + ' ' + css.sessionChipActive : css.sessionChip}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={css.sessionChipMain}
                  onClick={() => { activateGroup(group) }}
                >
                  <span className={css.sessionChipDot} data-status={activeSessionInGroup.status} aria-hidden="true" />
                  <span className={css.sessionChipAlias}>{group.alias}</span>
                  {group.sessions.length > 1 && <span className={css.sessionChipCount}>×{group.sessions.length}</span>}
                  {activeSessionInGroup.reconnectAttempts > 0 && <span className={css.sessionChipRetry}>({activeSessionInGroup.reconnectAttempts}/{MAX_RECONNECTS})</span>}
                </button>
                <button
                  type="button"
                  className={css.sessionChipClose}
                  aria-label={tt('terminal.sessionClose', { alias: group.alias })}
                  onClick={() => { closeGroup(group) }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
      {secondaryTabs !== null && (
        <div className={css.sessionSubBar} role="tablist" aria-label={tt('terminal.sessions')}>
          {secondaryTabs.map((session, index) => {
            const active = session.id === activeId
            return (
              <div key={session.id} className={active ? css.sessionSubTab + ' ' + css.sessionSubTabActive : css.sessionSubTab}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={css.sessionSubTabMain}
                  onClick={() => { activateSession(session.id) }}
                >
                  <span className={css.sessionChipDot} data-status={session.status} aria-hidden="true" />
                  <span className={css.sessionSubTabLabel}>{session.alias} #{index + 1}</span>
                  {session.reconnectAttempts > 0 && <span className={css.sessionChipRetry}>({session.reconnectAttempts}/{MAX_RECONNECTS})</span>}
                </button>
                <button
                  type="button"
                  className={css.sessionSubTabClose}
                  aria-label={tt('terminal.sessionClose', { alias: session.alias + ' #' + (index + 1) })}
                  onClick={() => { void closeSessionWithConfirm(session.id) }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
      {activeSession !== null && activeSession.status === 'connecting' && !reconnecting && (
        <div className={css.banner} data-kind="info">{tt('terminal.connecting')}</div>
      )}
      {reconnecting && (
        <div className={css.banner} data-kind="info">{tt('terminal.reconnecting', { attempt: activeSession!.reconnectAttempts, max: MAX_RECONNECTS })}</div>
      )}
      {activeSession !== null && activeSession.status === 'connected' && secondaryTabs === null && (
        <div className={css.banner} data-kind="ok">{tt('terminal.ready', { alias: activeSession.alias })}</div>
      )}
      {activeSession !== null && activeSession.status === 'exited' && (
        <div className={css.banner} data-kind="info">{tt('terminal.exited', { alias: activeSession.alias })}{activeSession.error !== undefined ? ' (' + activeSession.error + ')' : ''}</div>
      )}
      {listError !== null && <div className={css.banner} data-kind="error">{tt('terminal.error', { error: listError })}</div>}
      {sessions.length === 0 && hosts.length === 0 && listError === null && <div className={css.banner} data-kind="info">{tt('hosts.empty')}</div>}
      <div className={css.termWrap} onContextMenu={handleContextMenu}>
        <div ref={containerRef} className={css.termContainer} data-dsh-part="terminal" />
        {sessions.length === 0 && hosts.length > 0 && (
          <div className={css.termPlaceholder}>{tt('terminal.placeholder')}</div>
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
          <button
            type="button"
            role="menuitem"
            className={css.termMenuItem}
            onClick={() => { setContextMenu(null); sendInterrupt() }}
          >
            {tt('terminal.menu.interrupt')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.termMenuItem}
            onClick={() => { setContextMenu(null); clearScreen() }}
          >
            {tt('terminal.menu.clear')}
          </button>
        </div>
      )}
    </div>
  )
}