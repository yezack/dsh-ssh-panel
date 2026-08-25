/**
 * Sidebar entry injection — package-specific wiring over the shared core.
 *
 * The DOM injection / self-healing / idempotency logic lives exactly once in
 * shared/client/sidebar-entry-core.ts (synced copy); this wrapper supplies the
 * ssh icon, copy, CSS module, and the panel toggle. The row is plain DOM (no
 * React tree) so it can never disturb the shell's reconciliation; the panel
 * view it toggles is a separate React root mounted in the center column
 * (see mount.tsx).
 */
import type { PanelController } from './panel/controller.ts';
/** Stable data attribute identifying the injected entry row. */
export declare const ENTRY_SELECTOR = "[data-dsh-ssh-entry]";
/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param controller - the panel controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export declare function mountSidebarEntry(controller: PanelController): () => void;
