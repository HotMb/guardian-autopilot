import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

const missingHash = 'MISSING';

export type UndoReceipt = {
  schemaVersion: 1;
  id: string;
  paths: string[];
  beforeHashes: Record<string, string>;
  afterHashes: Record<string, string>;
  finalized: boolean;
  rolledBack: boolean;
};

function hash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function safePath(root: string, value: string): string {
  if (isAbsolute(value) || value.trim() === '') throw new Error(`Receipt path must be relative: ${value}`);
  const absolute = resolve(root, value);
  const relativePath = relative(root, absolute).replaceAll('\\', '/');
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) throw new Error(`Receipt path escapes root: ${value}`);
  return relativePath;
}

export class ReceiptStore {
  private readonly root: string;
  private readonly receipts: string;
  private readonly blobs: string;

  constructor(receiptsDirectory: string, sourceRoot = dirname(resolve(receiptsDirectory))) {
    this.receipts = resolve(receiptsDirectory);
    this.root = resolve(sourceRoot);
    this.blobs = join(this.receipts, 'blobs');
  }

  async begin(paths: readonly string[]): Promise<UndoReceipt> {
    if (paths.length === 0) throw new Error('Receipt requires at least one path');
    const normalized = [...new Set(paths.map((path) => safePath(this.root, path)))].sort();
    const beforeHashes: Record<string, string> = {};
    await mkdir(this.blobs, {recursive: true});
    for (const path of normalized) {
      const absolute = join(this.root, path);
      try {
        const content = await readFile(absolute);
        const digest = hash(content);
        beforeHashes[path] = digest;
        const blob = join(this.blobs, digest);
        try { await stat(blob); } catch { await writeFile(blob, content, {flag: 'wx'}); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') beforeHashes[path] = missingHash;
        else throw error;
      }
    }
    const receipt: UndoReceipt = {
      schemaVersion: 1,
      id: `${Date.now()}-${randomBytes(6).toString('hex')}`,
      paths: normalized,
      beforeHashes,
      afterHashes: {},
      finalized: false,
      rolledBack: false,
    };
    await this.save(receipt);
    return receipt;
  }

  async finalize(id: string): Promise<UndoReceipt> {
    const receipt = await this.load(id);
    if (receipt.finalized) return receipt;
    for (const path of receipt.paths) receipt.afterHashes[path] = await this.currentHash(path);
    receipt.finalized = true;
    await this.save(receipt);
    return receipt;
  }

  async rollback(id: string): Promise<void> {
    const receipt = await this.load(id);
    if (!receipt.finalized) throw new Error('Receipt must be finalized before rollback');
    if (receipt.rolledBack) return;
    for (const path of receipt.paths) {
      const current = await this.currentHash(path);
      if (current !== receipt.afterHashes[path]) throw new Error(`Receipt conflict on ${path}: file was modified`);
    }
    for (const path of receipt.paths) {
      const absolute = join(this.root, path);
      const before = receipt.beforeHashes[path];
      if (before === missingHash) {
        await rm(absolute, {force: true});
      } else {
        await mkdir(dirname(absolute), {recursive: true});
        await writeFile(absolute, await readFile(join(this.blobs, before)));
      }
    }
    receipt.rolledBack = true;
    await this.save(receipt);
  }

  private async currentHash(path: string): Promise<string> {
    try { return hash(await readFile(join(this.root, path))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missingHash;
      throw error;
    }
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('Receipt id is invalid');
    return join(this.receipts, `${id}.json`);
  }

  private async load(id: string): Promise<UndoReceipt> {
    const value = JSON.parse(await readFile(this.file(id), 'utf8')) as UndoReceipt;
    if (value.schemaVersion !== 1 || value.id !== id || !Array.isArray(value.paths)) throw new Error('Receipt is invalid');
    return value;
  }

  private async save(receipt: UndoReceipt): Promise<void> {
    await mkdir(this.receipts, {recursive: true});
    const target = this.file(receipt.id);
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
    await rename(temporary, target);
  }
}
