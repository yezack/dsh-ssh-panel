/**
 * SFTP transfers: upload (file or recursive tree), single-file download, and
 * remote directory listing. Every channel is opened once per operation and
 * released exactly once so sshd's MaxSessions cap is never exhausted.
 */
import type { RemoteDirEntry, TransferProgress } from '../protocol.ts';
import { type PoolEngine } from './connection-pool.ts';
/** Walk a local directory, collecting relative paths of every file. */
export declare function walkLocalDir(root: string): string[];
/** Upload one local file (or directory tree) to a remote path. */
export declare function upload(engine: PoolEngine, alias: string, localPath: string, remotePath: string, recursive: boolean, onProgress?: (progress: TransferProgress) => void): Promise<{
    bytes: number;
    files: number;
}>;
/**
 * Download one remote path to a local file. A plain file downloads as-is; a
 * directory is streamed into a gzip-compressed tar archive at `localPath`
 * (dependency-free USTAR writer), so the whole tree comes down in one file.
 * @returns byte count, file count, whether the source was a directory, and
 * the suggested download name.
 */
export declare function downloadTree(engine: PoolEngine, alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<{
    bytes: number;
    files: number;
    isDirectory: boolean;
    name: string;
}>;
/** Download one remote file to a local path (directories rejected). */
export declare function download(engine: PoolEngine, alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<{
    bytes: number;
}>;
/** List a remote directory (file browser). */
export declare function ls(engine: PoolEngine, alias: string, path: string): Promise<RemoteDirEntry[]>;
