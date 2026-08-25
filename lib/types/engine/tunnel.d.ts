/**
 * Local port-forward tunnels: one loopback-only listener per tunnel, pinned
 * to a pooled connection so an idle sweep never closes it, with per-tunnel
 * socket tracking and stop (single / alias-scoped / all).
 */
import { type Server as NetServer, type Socket } from 'node:net';
import type { TunnelInfo } from '../protocol.ts';
import { type PoolEngine, type PoolRecord } from './connection-pool.ts';
/** One active tunnel record (server + pinned connection + live sockets). */
export interface TunnelRecord {
    info: TunnelInfo;
    server: NetServer;
    alias: string;
    /** The pooled connection this tunnel pins; siblings on one alias may share it. */
    record: PoolRecord;
    sockets: Set<Socket>;
}
/** The engine slice the tunnel module needs (adds the tunnel registry). */
export interface TunnelEngine extends PoolEngine {
    readonly tunnels: Map<string, TunnelRecord>;
    nextTunnelId: number;
    /** Optional persistence file: active tunnels are re-started after a restart. */
    readonly tunnelSpecPath?: string;
}
/** One persisted tunnel spec (everything needed to re-start the tunnel). */
export interface TunnelSpec {
    alias: string;
    remoteHost: string;
    remotePort: number;
    localPort: number;
}
/** Read persisted tunnel specs (missing/corrupt file = empty list). */
export declare function readTunnelSpecs(path: string): TunnelSpec[];
/** Atomically write the live tunnel list (best-effort, 0600). */
export declare function persistTunnelSpecs(engine: TunnelEngine): void;
/** Start a local port-forward tunnel (listens on 127.0.0.1 only). */
export declare function startTunnel(engine: TunnelEngine, alias: string, options: {
    remotePort: number;
    remoteHost?: string;
    localPort?: number;
}): Promise<TunnelInfo>;
/** All active tunnels. */
export declare function listTunnels(engine: TunnelEngine): TunnelInfo[];
/** Stop one tunnel (closes the listener, live sockets, and the pinned connection). */
export declare function stopTunnel(engine: TunnelEngine, id: string): boolean;
/** Stop all tunnels (optionally for one alias). */
export declare function stopAllTunnels(engine: TunnelEngine, alias?: string): number;
