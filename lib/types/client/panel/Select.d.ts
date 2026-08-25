/** One dropdown option. */
export interface PanelSelectOption {
    value: string;
    label: string;
}
/** PanelSelect props. */
export interface PanelSelectProps {
    /** Current value ('' renders the placeholder styling). */
    value: string;
    options: PanelSelectOption[];
    onChange(value: string): void;
    /** Shown when no option matches the value; also the menu's aria-label. */
    placeholder?: string;
    ariaLabel?: string;
    /** Extra class for layout context (e.g. the controls-row width rule). */
    className?: string;
}
/** The themed custom dropdown used wherever a native <select> used to be. */
export declare function PanelSelect({ value, options, onChange, placeholder, ariaLabel, className }: PanelSelectProps): import("react").JSX.Element;
