/**
 * Local port-forward tunnels: one loopback-only listener per tunnel, pinned
 * to a pooled connection so an idle sweep never closes it, with per-tunnel
 * socket tracking and stop (single / alias-scoped / all).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { TunnelInfo } from '../protocol.ts'
import { acquire, disposeRecord, endRecordChain, type PoolEngine, type PoolRecord } from './connection-pool.ts'

/** One active tunnel record (server + pinned connection + live sockets). */
export interface TunnelRecord {
  info: TunnelInfo
  server: NetServer
  alias: string
  /** The pooled connection this tunnel pins; siblings on one alias may share it. */
  record: PoolRecord
  sockets: Set<Socket>
}

/** The engine slice the tunnel module needs (adds the tunnel registry). */
export interface TunnelEngine extends PoolEngine {
  readonly tunnels: Map<string, TunnelRecord>
  nextTunnelId: number
  /** Optional persistence file: active tunnels are re-started after a restart. */
  readonly tunnelSpecPath?: string
}

/** One persisted tunnel spec (everything needed to re-start the tunnel). */
export interface TunnelSpec {
  alias: string
  remoteHost: string
  remotePort: number
  localPort: number
}

/** Read persisted tunnel specs (missing/corrupt file = empty list). */
export function readTunnelSpecs(path: string): TunnelSpec[] {
  try {
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tunnels?: unknown }
    if (!Array.isArray(parsed.tunnels)) return []
    return parsed.tunnels.filter((item): item is TunnelSpec => {
      const value = item as Record<string, unknown>
      return typeof value?.alias === 'string'
        && typeof value.remoteHost === 'string'
        && typeof value.remotePort === 'number'
        && typeof value.localPort === 'number'
    })
  } catch {
    return []
  }
}

/** Atomically write the live tunnel list (best-effort, 0600). */
export function persistTunnelSpecs(engine: TunnelEngine): void {
  if (engine.tunnelSpecPath === undefined) return
  const specs: TunnelSpec[] = [...engine.tunnels.values()].map(tunnel => ({
    alias: tunnel.alias,
    remoteHost: tunnel.info.remoteHost,
    remotePort: tunnel.info.remotePort,
    localPort: tunnel.info.localPort,
  }))
  try {
    mkdirSync(dirname(engine.tunnelSpecPath), { recursive: true, mode: 0o700 })
    const tmp = engine.tunnelSpecPath + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: 1, tunnels: specs }, null, 2), { mode: 0o600 })
    renameSync(tmp, engine.tunnelSpecPath)
  } catch {
    // Persistence is best-effort; a failed write never breaks the tunnel.
  }
}

/** Start a local port-forward tunnel (listens on 127.0.0.1 only). */
export async function startTunnel(
  engine: TunnelEngine,
  alias: string,
  options: { remotePort: number; remoteHost?: string; localPort?: number },
): Promise<TunnelInfo> {
  if (!Number.isInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65535) {
    throw new Error('remotePort must be an integer in 1..65535')
  }
  if (options.localPort !== undefined && (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535)) {
    throw new Error('localPort must be an integer in 1..65535')
  }
  const entry = engine.store.find(alias)
  if (entry === undefined) throw new Error('alias \'' + alias + '\' not found — add it first')
  const remoteHost = options.remoteHost ?? '127.0.0.1'
  const id = 'tun-' + engine.nextTunnelId
  engine.nextTunnelId += 1
  const info: TunnelInfo = {
    id,
    alias,
    localPort: 0,
    remoteHost,
    remotePort: options.remotePort,
    state: 'connecting',
    startedAt: Date.now(),
  }
  // Reuse the live pooled connection when one exists so sibling tunnels on
  // one alias multiplex over it (and no orphaned connection leaks); recycle
  // a broken one first.
  const existing = engine.pool.get(alias)
  if (existing !== undefined && existing.broken) disposeRecord(engine, alias, existing)
  const record = engine.pool.get(alias) ?? (await acquire(engine, alias))
  const client = record.client
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    client.forwardOut('127.0.0.1', 0, remoteHost, options.remotePort, (error, stream) => {
      if (error !== undefined) {
        socket.destroy()
        return
      }
      // Both ends of the pipe can die independently; destroy the pair so an
      // unhandled 'error' event can never crash the host process.
      const destroy = (): void => {
        try { socket.destroy() } catch { /* gone */ }
        try { stream.close() } catch { /* gone */ }
      }
      stream.on('error', destroy)
      socket.on('error', destroy)
      stream.on('close', destroy)
      socket.on('close', destroy)
      stream.pipe(socket).pipe(stream)
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.localPort ?? 0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    // Roll back: never leave an unpinned orphan connection behind.
    if (!record.pinned && record.inFlight === 0) disposeRecord(engine, alias, record)
    throw error
  }
  record.pinned = true
  const address = server.address()
  info.localPort = typeof address === 'object' && address !== null ? address.port : 0
  info.state = 'forwarding'
  engine.tunnels.set(id, { info, server, alias, record, sockets })
  persistTunnelSpecs(engine)
  return info
}

/** All active tunnels. */
export function listTunnels(engine: TunnelEngine): TunnelInfo[] {
  return [...engine.tunnels.values()].map(tunnel => ({ ...tunnel.info }))
}

/** Stop one tunnel (closes the listener, live sockets, and the pinned connection). */
export function stopTunnel(engine: TunnelEngine, id: string): boolean {
  const tunnel = engine.tunnels.get(id)
  if (tunnel === undefined) return false
  engine.tunnels.delete(id)
  try { tunnel.server.close() } catch { /* already closed */ }
  for (const socket of tunnel.sockets) {
    try { socket.destroy() } catch { /* already closed */ }
  }
  tunnel.sockets.clear()
  // Sibling tunnels on the same alias share the pinned connection: release it
  // only once the last tunnel using it is gone. A record the pool has since
  // replaced (e.g. after a broken-connection recycle) is ended directly.
  const shared = [...engine.tunnels.values()].some(candidate => candidate.record === tunnel.record)
  if (!shared) {
    if (engine.pool.get(tunnel.alias) === tunnel.record) disposeRecord(engine, tunnel.alias, tunnel.record)
    else endRecordChain(tunnel.record)
  }
  persistTunnelSpecs(engine)
  return true
}

/** Stop all tunnels (optionally for one alias). */
export function stopAllTunnels(engine: TunnelEngine, alias?: string): number {
  let count = 0
  for (const [id, tunnel] of [...engine.tunnels]) {
    if (alias === undefined || tunnel.alias === alias) {
      stopTunnel(engine, id)
      count += 1
    }
  }
  if (count > 0) persistTunnelSpecs(engine)
  return count
}