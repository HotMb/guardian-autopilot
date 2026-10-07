import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { isIgnoredPath, loadConfig } from './config.js';

export type Finding = { kind: 'exact-duplicate'; file: string; sameAs: string; bytes: number; action: 'review-only' };
export type ScanError = { file: string; code?: string; message: string };
export type ScanReport = {
  schemaVersion: 1;
  root: string;
  scannedFiles: number;
  totalBytes: number;
  findings: Finding[];
  errors: ScanError[];
  createdAt: string;
  mode: 'read-only';
};

const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.guardian']);
const assetExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'mov', 'webm', 'avif']);

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function errorDetails(error: unknown): { code?: string; message: string } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: string };
    return {code: candidate.code, message: candidate.message};
  }
  return {message: String(error)};
}

function reportPath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

export async function scan(rootDir: string): Promise<ScanReport> {
  const root = resolve(rootDir);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    const details = errorDetails(error);
    throw new Error(`Scan root cannot be read: ${root} (${details.message})`);
  }
  if (rootStat.isSymbolicLink()) throw new Error(`Scan root must not be a symbolic link: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Scan root must be a directory: ${root}`);
  const config = await loadConfig(root);

  const seen = new Map<string, string>();
  const findings: Finding[] = [];
  const errors: ScanError[] = [];
  let scannedFiles = 0, totalBytes = 0;

  function recordError(path: string, error: unknown): void {
    const details = errorDetails(error);
    errors.push({file: reportPath(root, path), ...details});
  }

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch (error) {
      if (dir === root) throw error;
      recordError(dir, error);
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || ignored.has(entry.name) || isIgnoredPath(root, path, config)) continue;
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        recordError(path, error);
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { await walk(path); continue; }
      if (!stat.isFile()) continue;

      scannedFiles += 1;
      totalBytes += stat.size;
      const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
      if (!assetExtensions.has(ext)) continue;
      if (config.maxAssetBytes !== undefined && stat.size > config.maxAssetBytes) {
        errors.push({
          file: reportPath(root, path),
          code: 'GUARDIAN_MAX_ASSET_BYTES',
          message: `Asset exceeds configured maxAssetBytes (${config.maxAssetBytes})`,
        });
        continue;
      }

      let hash: string;
      try {
        hash = await hashFile(path);
      } catch (error) {
        recordError(path, error);
        continue;
      }

      const key = `${stat.size}:${hash}`;
      const file = reportPath(root, path);
      const sameAs = seen.get(key);
      if (sameAs) findings.push({kind: 'exact-duplicate', file, sameAs, bytes: stat.size, action: 'review-only'});
      else seen.set(key, file);
    }
  }

  await walk(root);
  return {schemaVersion: 1, root, scannedFiles, totalBytes, findings, errors, createdAt: new Date().toISOString(), mode: 'read-only'};
}
