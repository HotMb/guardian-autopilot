import {createReadStream} from 'node:fs';
import {lstat, mkdir, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {join, resolve} from 'node:path';
import {isIgnoredPath, loadConfig} from './config.js';

export type InventoryEntry = {
  path: string;
  bytes: number;
  mtimeMs: number;
  sha256?: string;
};

export type InventoryIndex = {
  schemaVersion: 1;
  root: string;
  files: Record<string, InventoryEntry>;
  createdAt: string;
};

export type InventoryResult = {
  index: InventoryIndex;
  hashedFiles: number;
  reusedHashes: number;
  removedFiles: number;
};

export type InventoryCoalescer = {
  request(rootDir: string): Promise<InventoryResult>;
};

const indexRelativePath = '.guardian/index.json';
const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.guardian']);
const assetExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'mov', 'webm', 'avif']);

function reportPath(path: string): string {
  return path.replaceAll('\\', '/');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function isAsset(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return assetExtensions.has(extension);
}

function isInventoryIndex(value: unknown, root: string): value is InventoryIndex {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.schemaVersion === 1 && raw.root === root && raw.files !== null && typeof raw.files === 'object';
}

async function loadPreviousIndex(root: string): Promise<InventoryIndex | undefined> {
  try {
    const source = await readFile(join(root, indexRelativePath), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Inventory index is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isInventoryIndex(parsed, root)) throw new Error('Inventory index has an unsupported schema or root');
    return parsed;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function buildInventory(rootDir: string): Promise<InventoryResult> {
  const root = resolve(rootDir);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Inventory root must not be a symbolic link: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Inventory root must be a directory: ${root}`);

  const config = await loadConfig(root);
  const previous = await loadPreviousIndex(root);
  const files: Record<string, InventoryEntry> = {};
  let hashedFiles = 0;
  let reusedHashes = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name) || isIgnoredPath(root, path, config)) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!stat.isFile()) continue;

      const relativePath = reportPath(path.slice(root.length + 1));
      const previousEntry = previous?.files[relativePath];
      const inventoryEntry: InventoryEntry = {path: relativePath, bytes: stat.size, mtimeMs: stat.mtimeMs};
      if (isAsset(relativePath)) {
        if (previousEntry?.bytes === stat.size && previousEntry.mtimeMs === stat.mtimeMs && previousEntry.sha256) {
          inventoryEntry.sha256 = previousEntry.sha256;
          reusedHashes += 1;
        } else {
          inventoryEntry.sha256 = await hashFile(path);
          hashedFiles += 1;
        }
      }
      files[relativePath] = inventoryEntry;
    }
  }

  await walk(root);
  const removedFiles = previous ? Object.keys(previous.files).filter((path) => !(path in files)).length : 0;
  return {
    index: {schemaVersion: 1, root, files, createdAt: new Date().toISOString()},
    hashedFiles,
    reusedHashes,
    removedFiles,
  };
}

export async function writeInventory(rootDir: string, index: InventoryIndex): Promise<string> {
  const root = resolve(rootDir);
  if (index.schemaVersion !== 1 || index.root !== root) throw new Error('Inventory index does not belong to this root');
  const path = join(root, indexRelativePath);
  const directory = join(root, '.guardian');
  const temporaryPath = join(directory, `index.json.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(directory, {recursive: true});
  try {
    await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return path;
}

/**
 * Coalesces bursts of inventory requests for the same root without creating a
 * watcher or a permanent background process. Requests that arrive during the
 * debounce window share one read-only build and one result.
 */
export function createInventoryCoalescer(
  delayMs = 250,
  builder: (rootDir: string) => Promise<InventoryResult> = buildInventory,
): InventoryCoalescer {
  type Waiter = {resolve: (result: InventoryResult) => void; reject: (error: unknown) => void};
  type Pending = {waiters: Waiter[]; timer: ReturnType<typeof setTimeout>};
  const pending = new Map<string, Pending>();

  return {
    request(rootDir: string): Promise<InventoryResult> {
      const root = resolve(rootDir);
      const promise = new Promise<InventoryResult>((resolvePromise, rejectPromise) => {
        const existing = pending.get(root);
        const waiters = existing?.waiters ?? [];
        waiters.push({resolve: resolvePromise, reject: rejectPromise});
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(async () => {
          pending.delete(root);
          try {
            const result = await builder(root);
            for (const waiter of waiters) waiter.resolve(result);
          } catch (error) {
            for (const waiter of waiters) waiter.reject(error);
          }
        }, Math.max(0, delayMs));
        pending.set(root, {waiters, timer});
      });
      return promise;
    },
  };
}
