import type { SshApi } from '../api.ts';
import type { PanelController } from './controller.ts';
import { type TerminalFontSource } from './helpers.ts';
/** The panel's tab identifiers. */
export type SshTab = 'hosts' | 'terminal' | 'transfer' | 'tunnels' | 'cluster';
/** Panel shell props. */
export interface SshPanelProps {
    /** The panel state owner (open/close/toggle). */
    controller: PanelController;
    /** The SSH API client every tab operates through. */
    api: SshApi;
    /** Live terminal-font setting source handed to the terminal tab (issue #577). */
    terminalFont?: TerminalFontSource;
}
/** The tabbed SSH panel (provides the confirm modal to every tab). */
export declare function SshPanel(props: SshPanelProps): import("react").JSX.Element;
