/**
 * The SSH operations panel shell: a header with a close control, a five-tab
 * bar, and the active tab's content. Tab state lives here (browser session
 * state); inactive tabs unmount, so each tab fetches its own data on
 * activation. The hosts tab's connect action switches here to the terminal
 * tab with the chosen alias preselected.
 */
import { useState } from 'react'
import type { SshApi } from '../api.ts'
import type { PanelController } from './controller.ts'
import { tt, type TerminalFontSource } from './helpers.ts'
import { ClusterTab } from './ClusterTab.tsx'
import { HostsTab } from './HostsTab.tsx'
import { TerminalTab } from './TerminalTab.tsx'
import { TransferTab } from './TransferTab.tsx'
import { TunnelsTab } from './TunnelsTab.tsx'
import css from './panel.module.css'

/** The panel's tab identifiers. */
export type SshTab = 'hosts' | 'terminal' | 'transfer' | 'tunnels' | 'cluster'

/** Panel shell props. */
export interface SshPanelProps {
  /** The panel state owner (open/close/toggle). */
  controller: PanelController
  /** The SSH API client every tab operates through. */
  api: SshApi
  /** Live terminal-font setting source handed to the terminal tab (issue #577). */
  terminalFont?: TerminalFontSource
}

/** The tab bar definition (labels resolved at render time). */
const TABS: ReadonlyArray<{ id: SshTab; label: () => string }> = [
  { id: 'hosts', label: () => tt('tab.hosts') },
  { id: 'terminal', label: () => tt('tab.terminal') },
  { id: 'transfer', label: () => tt('tab.transfer') },
  { id: 'tunnels', label: () => tt('tab.tunnels') },
  { id: 'cluster', label: () => tt('tab.cluster') },
]

/** A pending "connect this host" request handed to the terminal tab. */
interface ConnectRequest {
  alias: string
  nonce: number
}

/** The tabbed SSH panel. */
export function SshPanel({ controller, api, terminalFont }: SshPanelProps) {
  const [activeTab, setActiveTab] = useState<SshTab>('hosts')
  const [connectRequest, setConnectRequest] = useState<ConnectRequest | null>(null)

  const handleConnect = (alias: string): void => {
    setActiveTab('terminal')
    setConnectRequest(prev => ({ alias, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  return (
    <div className={css.panel} data-dsh-plugin="ssh">
      <div className={css.panelHeader}>
        {/* Shared hook: dsh-web-all offsets center-view back controls beside the collapsed mobile sidebar. */}
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          aria-label={tt('panel.backToConversation')}
          data-dsh-center-view-back=""
          onClick={() => { controller.close() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{tt('panel.backToConversation')}</span>
        </button>
        <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
      </div>
      <div className={css.tabBar} role="tablist" data-dsh-part="tab-bar">
        {TABS.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} data-active={activeTab === tab.id ? '' : undefined} data-dsh-part="tab" className={css.tab} onClick={() => { setActiveTab(tab.id) }}>
            {tab.label()}
          </button>
        ))}
      </div>
      <div className={css.panelContent}>
        {/* Tabs stay mounted; inactive ones are hidden with CSS so live
            terminal sessions and in-flight state survive tab switches. */}
        <div className={activeTab === 'hosts' ? css.panelTab : css.panelTabHidden}><HostsTab api={api} onConnect={handleConnect} /></div>
        <div className={activeTab === 'terminal' ? css.panelTab : css.panelTabHidden}><TerminalTab api={api} presetAlias={connectRequest?.alias} requestId={connectRequest?.nonce} terminalFont={terminalFont} /></div>
        <div className={activeTab === 'transfer' ? css.panelTab : css.panelTabHidden}><TransferTab api={api} /></div>
        <div className={activeTab === 'tunnels' ? css.panelTab : css.panelTabHidden}><TunnelsTab api={api} /></div>
        <div className={activeTab === 'cluster' ? css.panelTab : css.panelTabHidden}><ClusterTab api={api} /></div>
      </div>
    </div>
  )
}
