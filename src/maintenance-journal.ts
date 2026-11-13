import { lstat, mkdir, rename, readFile, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicJson } from './files.js';
export interface JournalMove {
    from: string;
    to: string;
    identity?: string;
}
interface MoveTransaction {
    phase: 'prepared' | 'committed' | 'rolled-back' | 'recovery-required';
    purpose: 'clear' | 'restore';
    moves: JournalMove[];
}
export type MaintenanceManifest = Record<string, any> & {
    transaction?: MoveTransaction;
};
async function identity(path: string): Promise<string | null> {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink())
            throw Error('恢复路径为符号链接，已停止');
        return `${stat.dev}:${stat.ino}`;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw error;
    }
}
async function persistDirectories(...paths: string[]) {
    for (const path of new Set(paths.map(dirname))) {
        const handle = await open(path, 'r');
        try {
            await handle.sync();
        }
        catch (error) {
            if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))
                throw error;
        }
        finally {
            await handle.close();
        }
    }
}
/** Roll back only exact objects moved by this transaction; never overwrite a regenerated path. */
export async function reconcileMoves(path: string, manifest: MaintenanceManifest, guard: (move: JournalMove) => Promise<void>): Promise<void> {
    const transaction = manifest.transaction;
    if (!transaction || ['committed', 'rolled-back'].includes(transaction.phase))
        return;
    let complete = true;
    for (const move of [...transaction.moves].reverse()) {
        try {
            await guard(move);
            const [from, to] = await Promise.all([identity(move.from), identity(move.to)]);
            if (from === move.identity)
                continue;
            if (from !== null || to !== move.identity) {
                complete = false;
                continue;
            }
            await mkdir(dirname(move.from), { recursive: true });
            await rename(move.to, move.from);
            await persistDirectories(move.to, move.from);
        }
        catch {
            complete = false;
        }
    }
    transaction.phase = complete ? 'rolled-back' : 'recovery-required';
    await atomicJson(path, manifest);
    if (!complete)
        throw Error('部分路径已变化，自动恢复受阻；完整移动计划已保留，请勿清空废纸篓');
}
export async function executeMoves(path: string, manifest: MaintenanceManifest, moves: JournalMove[], guard: (move: JournalMove) => Promise<void>, committedPatch: Record<string, unknown> = {}, persist = atomicJson): Promise<void> {
    const simulated = new Map<string, string | null>();
    for (const move of moves)
        for (const targetPath of [move.from, move.to]) {
            if (!simulated.has(targetPath))
                simulated.set(targetPath, await identity(targetPath));
        }
    for (const move of moves) {
        await guard(move);
        const source = simulated.get(move.from);
        if (!source || simulated.get(move.to) !== null)
            throw Error('维护路径已变化，未开始移动');
        move.identity = source;
        simulated.set(move.from, null);
        simulated.set(move.to, source);
    }
    manifest.transaction = { phase: 'prepared', purpose: committedPatch.restoredAt ? 'restore' : 'clear', moves };
    // Durable write-ahead plan covers crashes after rename but before the next status write.
    await persist(path, manifest);
    try {
        for (const move of moves) {
            await guard(move);
            if (await identity(move.from) !== move.identity || await identity(move.to) !== null)
                throw Error('维护路径正在变化，停止移动');
            await mkdir(dirname(move.to), { recursive: true, mode: 0o700 });
            await rename(move.from, move.to);
            await persistDirectories(move.from, move.to);
        }
        await persist(path, { ...manifest, ...committedPatch, transaction: { ...manifest.transaction, phase: 'committed' } });
    }
    catch (error) {
        try {
            await reconcileMoves(path, manifest, guard);
        }
        catch {
            throw Error('维护未完成，部分恢复待处理；移动计划及数据已保留');
        }
        throw error;
    }
}
export async function readMaintenanceManifest(path: string): Promise<MaintenanceManifest> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
        throw Error('维护事务清单身份不匹配');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as MaintenanceManifest;
    if (manifest.transaction && (!Array.isArray(manifest.transaction.moves) || !['prepared', 'committed', 'rolled-back', 'recovery-required'].includes(manifest.transaction.phase)
        || manifest.transaction.moves.some(move => typeof move.from !== 'string' || typeof move.to !== 'string' || !/^\d+:\d+$/.test(move.identity ?? ''))))
        throw Error('维护事务记录格式无效，原件已保留');
    return manifest;
}
