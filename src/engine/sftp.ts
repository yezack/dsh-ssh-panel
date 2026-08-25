/**
 * SFTP transfers: upload (file or recursive tree), single-file download, and
 * remote directory listing. Every channel is opened once per operation and
 * released exactly once so sshd's MaxSessions cap is never exhausted.
 */

import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path'
import { createGzip } from 'node:zlib'
import { Client, type SFTPWrapper } from 'ssh2'
import type { RemoteDirEntry, TransferProgress } from '../protocol.ts'
import { withClient, type PoolEngine } from './connection-pool.ts'

/** Walk a local directory, collecting relative paths of every file. */
export function walkLocalDir(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      // lstat, not stat: a symlink must never be followed — a link cycle
      // (ln -s . self) recurses forever under stat, and a link to a file
      // would silently upload the target's bytes.
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) files.push(relative(root, full))
    }
  }
  visit(root)
  return files
}

/** Upload one local file (or directory tree) to a remote path. */
export async function upload(
  engine: PoolEngine,
  alias: string,
  localPath: string,
  remotePath: string,
  recursive: boolean,
  onProgress?: (progress: TransferProgress) => void,
): Promise<{ bytes: number; files: number }> {
  // Remote paths must be absolute: the mkdir chain and fastPut must agree
  // on one resolution (relative paths previously created dirs at the root).
  if (!remotePath.startsWith('/')) {
    throw new Error('remotePath must be an absolute path (got \'' + remotePath + '\')')
  }
  const local = resolvePath(localPath)
  if (!existsSync(local)) throw new Error('local path not found: \'' + localPath + '\'')
  return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
    const stat = statSync(local)
    let files: string[]
    if (stat.isDirectory()) {
      if (!recursive) throw new Error('\'' + localPath + '\' is a directory — enable recursive upload')
      files = walkLocalDir(local)
      await ensureRemoteDir(sftp, remotePath)
    } else {
      files = ['']
      await ensureRemoteDir(sftp, dirname(remotePath))
    }
    let bytes = 0
    for (const rel of files) {
      const src = rel === '' ? local : join(local, rel)
      // Remote paths always use forward slashes; normalize any OS separators.
      const remoteRel = rel.split(/[\\/]/).join('/')
      const dst = rel === '' ? remotePath : remotePath.replace(/\/$/, '') + '/' + remoteRel
      await fastPut(sftp, src, dst, engine.opts.sftpConcurrency, onProgress)
      bytes += statSync(src).size
    }
    return { bytes, files: files.length }
  }))
}

/**
 * Download one remote path to a local file. A plain file downloads as-is; a
 * directory is streamed into a gzip-compressed tar archive at `localPath`
 * (dependency-free USTAR writer), so the whole tree comes down in one file.
 * @returns byte count, file count, whether the source was a directory, and
 * the suggested download name.
 */
export async function downloadTree(
  engine: PoolEngine,
  alias: string,
  remotePath: string,
  localPath: string,
  onProgress?: (progress: TransferProgress) => void,
): Promise<{ bytes: number; files: number; isDirectory: boolean; name: string }> {
  return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
    const stat = await new Promise<{ isDirectory: () => boolean; size: number; mtime: number; mode: number }>((resolve, reject) => {
      sftp.stat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
    })
    const local = resolvePath(localPath)
    if (!existsSync(dirname(local))) mkdirSync(dirname(local), { recursive: true })
    if (!stat.isDirectory()) {
      await fastGet(sftp, remotePath, local, engine.opts.sftpConcurrency, onProgress)
      return { bytes: statSync(local).size, files: 1, isDirectory: false, name: basename(remotePath) }
    }
    const root = remotePath.replace(/\/+$/, '') || '/'
    const files = await walkRemoteTree(sftp, root)
    const baseName = basename(root) || 'download'
    const out = createWriteStream(local, { mode: 0o600 })
    const gzip = createGzip()
    gzip.pipe(out)
    let transferred = 0
    const writeAll = async (chunk: Buffer): Promise<void> => {
      if (!gzip.write(chunk)) {
        await new Promise<void>(resolve => { gzip.once('drain', () => resolve()) })
      }
    }
    try {
      for (const rel of files) {
        const remote = root + '/' + rel
        const fstat = await new Promise<{ size: number; mtime: number; mode: number }>((resolve, reject) => {
          sftp.stat(remote, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
        })
        onProgress?.({ phase: 'transferring', file: remote, transferred, total: 0, percent: 0 })
        await writeAll(tarHeader(rel, fstat.size, fstat.mode, Math.floor(fstat.mtime)))
        await new Promise<void>((resolve, reject) => {
          const rs = sftp.createReadStream(remote)
          rs.on('data', (chunk: Buffer) => {
            if (!gzip.write(chunk)) {
              rs.pause()
              gzip.once('drain', () => { try { rs.resume() } catch { /* closed */ } })
            }
            transferred += chunk.length
          })
          rs.on('error', reject)
          rs.on('end', resolve)
        })
        const pad = fstat.size % 512
        if (pad > 0) await writeAll(Buffer.alloc(512 - pad))
      }
      await writeAll(Buffer.alloc(1024)) // two zero blocks end the archive
      gzip.end()
      await new Promise<void>((resolve, reject) => {
        out.once('finish', resolve)
        out.once('error', reject)
      })
    } catch (error) {
      try { gzip.destroy() } catch { /* closed */ }
      throw error
    }
    return { bytes: statSync(local).size, files: files.length, isDirectory: true, name: baseName + '.tar.gz' }
  }))
}


/** Download one remote file to a local path (directories rejected). */
export async function download(
  engine: PoolEngine,
  alias: string,
  remotePath: string,
  localPath: string,
  onProgress?: (progress: TransferProgress) => void,
): Promise<{ bytes: number }> {
  return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
    const stat = await new Promise<{ isDirectory: () => boolean }>((resolve, reject) => {
      sftp.stat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
    })
    if (stat.isDirectory()) {
      throw new Error('\'' + remotePath + '\' is a directory — use the web panel for recursive downloads')
    }
    const local = resolvePath(localPath)
    if (!existsSync(dirname(local))) mkdirSync(dirname(local), { recursive: true })
    await fastGet(sftp, remotePath, local, engine.opts.sftpConcurrency, onProgress)
    return { bytes: statSync(local).size }
  }))
}

/** Walk a remote directory tree via SFTP, collecting every relative file path. */
async function walkRemoteTree(sftp: SFTPWrapper, root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    const list = await new Promise<{ filename: string; attrs: { isDirectory(): boolean; isFile(): boolean } }[]>((resolve, reject) => {
      sftp.readdir(dir, (error, items) => error !== undefined ? reject(error) : resolve(items))
    })
    for (const item of list) {
      const full = dir.replace(/\/+$/, '') + '/' + item.filename
      if (item.attrs.isDirectory()) {
        await visit(full)
      } else if (item.attrs.isFile()) {
        files.push(full.slice(root.length + 1))
      }
    }
  }
  await visit(root)
  return files
}

/** One USTAR header block for a regular file (long names via prefix split). */
function tarHeader(name: string, size: number, mode: number, mtimeSec: number): Buffer {
  const buf = Buffer.alloc(512)
  const encoded = Buffer.from(name, 'utf8')
  if (encoded.length <= 100) {
    encoded.copy(buf, 0)
  } else {
    let split = name.lastIndexOf('/', 155)
    if (split <= 0) split = 100
    const prefix = name.slice(0, split)
    const base = name.slice(split + 1)
    Buffer.from(prefix, 'utf8').copy(buf, 345)
    Buffer.from(base, 'utf8').copy(buf, 0)
  }
  buf.write('0000644\0', 100, 8)
  buf.write('0000000\0', 108, 8)
  buf.write('0000000\0', 116, 8)
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  buf.write(mtimeSec.toString(8).padStart(11, '0') + '\0', 136, 12)
  buf.write('        ', 148, 8) // checksum placeholder
  buf.write('0', 156, 1) // regular file
  buf.write('ustar\0', 257, 6)
  buf.write('00', 263, 2)
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += buf[i]
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return buf
}

/** List a remote directory (file browser). */
export async function ls(engine: PoolEngine, alias: string, path: string): Promise<RemoteDirEntry[]> {
  return withClient(engine, alias, (client) => withSftp(client, async (sftp) => {
    return await new Promise((resolve, reject) => {
      sftp.readdir(path, (error, list) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        const entries: RemoteDirEntry[] = list.map(item => ({
          name: item.filename,
          type: item.attrs.isDirectory() ? 'dir' : item.attrs.isFile() ? 'file' : 'other',
          size: item.attrs.size,
          mtimeMs: item.attrs.mtime * 1000,
          mode: item.attrs.mode,
        }))
        resolve(entries)
      })
    })
  }))
}

/**
 * Open one SFTP channel, run the operation, and release the channel exactly
 * once when the operation settles (success or error). ssh2 keeps each
 * subsystem channel open until end(); without this, every transfer leaks a
 * channel until sshd's MaxSessions cap makes all later opens fail.
 */
async function withSftp<T>(client: Client, run: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const sftp = await sftpChannel(client)
  let ended = false
  const endOnce = (): void => {
    if (ended) return
    ended = true
    try { sftp.end() } catch { /* channel already closed */ }
  }
  // The channel can also close underneath us (peer reset, timeout); the
  // guard makes the finally below a no-op instead of ending it twice.
  sftp.once('close', endOnce)
  try {
    return await run(sftp)
  } finally {
    endOnce()
  }
}

function sftpChannel(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => error !== undefined ? reject(error) : resolve(sftp))
  })
}

/** Create a remote directory chain (stat-then-mkdir per segment). */
function ensureRemoteDir(sftp: SFTPWrapper, remote: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const segments = remote.replace(/^\/+/, '').split('/').filter(segment => segment !== '')
    const walk = (index: number): void => {
      if (index >= segments.length) {
        resolve()
        return
      }
      const current = '/' + segments.slice(0, index + 1).join('/')
      sftp.stat(current, (statError) => {
        if (statError === undefined) {
          walk(index + 1)
          return
        }
        // Statting a missing path fails; mkdir it (idempotent because the
        // stat check runs first — some sftp servers throw on EEXIST).
        sftp.mkdir(current, (mkdirError) => {
          if (mkdirError !== undefined) {
            reject(mkdirError)
            return
          }
          walk(index + 1)
        })
      })
    }
    walk(0)
  })
}

/** One fastPut/fastGet transfer with throttled progress (the two directions share everything but the verb). */
function fastTransfer(sftp: SFTPWrapper, kind: 'put' | 'get', src: string, dst: string, concurrency: number, onProgress?: (progress: TransferProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // Progress frames name the destination on upload, the source on download;
    // the final size comes from the local side of the transfer.
    const file = kind === 'put' ? dst : src
    const finalSize = (): number => statSync(kind === 'put' ? src : dst).size
    let last = 0
    let lastEmit = 0
    const started = Date.now()
    if (kind === 'put') {
      onProgress?.({ phase: 'transferring', file, transferred: 0, total: statSync(src).size, percent: 0 })
    }
    const step = (transferred: number, _chunk: number, total: number): void => {
      const now = Date.now()
      // Throttle: high-speed links fire one callback per chunk; the UI only
      // needs ~10 frames per second.
      if (now - lastEmit < 100 && transferred < total) return
      lastEmit = now
      const elapsed = (now - started) / 1000
      onProgress?.({
        phase: 'transferring',
        file,
        transferred,
        total,
        percent: total > 0 ? Math.round((transferred / total) * 1000) / 10 : 0,
        speedBps: elapsed > 0 ? Math.round((transferred - last) / elapsed) : undefined,
      })
      last = transferred
    }
    const done = (error: unknown): void => {
      if (error !== undefined) {
        onProgress?.({ phase: 'error', file, transferred: 0, total: 0, percent: 0, error: String(error) })
        reject(error)
      } else {
        onProgress?.({ phase: 'done', file, transferred: finalSize(), total: finalSize(), percent: 100 })
        resolve()
      }
    }
    if (kind === 'put') sftp.fastPut(src, dst, { concurrency, step }, done)
    else sftp.fastGet(src, dst, { concurrency, step }, done)
  })
}

function fastPut(sftp: SFTPWrapper, src: string, dst: string, concurrency: number, onProgress?: (progress: TransferProgress) => void): Promise<void> {
  return fastTransfer(sftp, 'put', src, dst, concurrency, onProgress)
}

function fastGet(sftp: SFTPWrapper, src: string, dst: string, concurrency: number, onProgress?: (progress: TransferProgress) => void): Promise<void> {
  return fastTransfer(sftp, 'get', src, dst, concurrency, onProgress)
}