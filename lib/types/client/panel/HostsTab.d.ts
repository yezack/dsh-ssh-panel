import type { SshApi } from '../api.ts';
import type { SshHostSummary } from '../../protocol.ts';
/** Hosts tab props. */
export interface HostsTabProps {
    api: SshApi;
    /** Connect the given alias in the terminal tab. */
    onConnect: (alias: string) => void;
    /** Live terminal session counts per alias (badged in each row). */
    sessionCounts?: Record<string, number>;
}
/** Host list grouping modes (#379). */
export type HostGroupBy = 'none' | 'environment' | 'tags';
/** One collapsible group section of the grouped host list. */
export interface HostGroup {
    /** Group key: the environment name, one tag, or '' for the ungrouped bucket. */
    key: string;
    hosts: SshHostSummary[];
}
/**
 * Bucket hosts into collapsible groups (#379). Grouping by tags places a
 * multi-tag host in every one of its tag groups (folder view); hosts without
 * the grouping key land in the '' bucket, which always sorts last. Groups
 * sort alphabetically; host order inside a group follows the API listing.
 */
export declare function groupHosts(hosts: SshHostSummary[], groupBy: HostGroupBy): HostGroup[];
/** Sortable host columns. */
export type HostSortKey = 'alias' | 'host' | 'port' | 'user' | 'auth' | 'jump' | 'environment' | 'tags' | 'description';
/** Every sortable column, in table order (used for the header buttons). */
export declare const HOST_SORT_KEYS: HostSortKey[];
/** Sort a host list by key/direction (ascending by default). */
export declare function sortHosts(hosts: SshHostSummary[], key: HostSortKey, dir: 'asc' | 'desc'): SshHostSummary[];
/** The hosts table plus its toolbar and dialogs. */
export declare function HostsTab({ api, onConnect, sessionCounts }: HostsTabProps): import("react").JSX.Element;
