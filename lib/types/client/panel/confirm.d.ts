/**
 * Non-blocking in-panel confirm dialog. window.confirm blocks the renderer
 * and looks nothing like the app; this replaces it with the panel's modal
 * styling. Components call `useConfirm()` and await the boolean. Mounted
 * once by SshPanel around the tabs; without a provider (standalone test
 * mounts) it falls back to window.confirm so nothing regresses.
 */
import { type ReactNode } from 'react';
/** Confirm dialog options. */
export interface ConfirmOptions {
    /** Heading (defaults to a generic title). */
    title?: string;
    /** The question text. */
    text: string;
    /** Confirm-button label (defaults to 确定/OK). */
    confirmLabel?: string;
    /** Render the confirm button as destructive (red). */
    danger?: boolean;
}
/** Renders the modal and provides `useConfirm()` to descendants. */
export declare function ConfirmProvider({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
/** Await a user decision; falls back to window.confirm without a provider. */
export declare function useConfirm(): (options: ConfirmOptions) => Promise<boolean>;
