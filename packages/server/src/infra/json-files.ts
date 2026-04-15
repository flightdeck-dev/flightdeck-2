/**
 * Atomic file writes for JSON and text files.
 * Learned from OpenClaw's json-files.ts — write to tmp, fsync, rename.
 * Prevents corruption from crashes/power loss mid-write.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// ── Async ────────────────────────────────────────────────────────────

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number; trailingNewline?: boolean },
): Promise<void> {
  const mode = options?.mode ?? 0o644;
  const payload =
    options?.trailingNewline && !content.endsWith('\n') ? `${content}\n` : content;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, 'w', mode);
    try {
      await handle.writeFile(payload, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await fs.rename(tmp, filePath);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean },
): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2), options);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Sync (for existing writeFileSync call sites) ─────────────────────

export function writeTextAtomicSync(
  filePath: string,
  content: string,
  options?: { mode?: number },
): void {
  const mode = options?.mode ?? 0o644;
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const fd = fsSync.openSync(tmp, 'w', mode);
    try {
      fsSync.writeSync(fd, content, null, 'utf8');
      fsSync.fsyncSync(fd);
    } finally {
      fsSync.closeSync(fd);
    }
    fsSync.renameSync(tmp, filePath);
  } finally {
    try { fsSync.unlinkSync(tmp); } catch { /* already renamed or doesn't exist */ }
  }
}

export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  writeTextAtomicSync(filePath, JSON.stringify(value, null, 2));
}

// ── Async lock (serialize concurrent writes) ─────────────────────────

export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
