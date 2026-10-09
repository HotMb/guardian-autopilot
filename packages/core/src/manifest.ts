import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, readdir, stat} from 'node:fs/promises';
import {relative, resolve} from 'node:path';

export type SymlinkMode = 'skip' | 'follow' | 'error';

export type DiscoveryOptions = {
  ignore?: readonly string[];
  symlinks?: SymlinkMode;
};

export type DiscoveryError = {
  path: string;
  message: string;
};

export type DiscoveryResult = {
  root: string;
  files: string[];
  errors: DiscoveryError[];
};

export type ManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type RepositoryManifest = {
  schemaVersion: 1;
  root: string;
  files: ManifestFile[];
};

const defaultIgnoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage']);

function reportPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function ignored(relativePath: string, patterns: readonly string[]): boolean {
  const normalized = reportPath(relativePath);
  const segments = normalized.split('/');
  return patterns.some((pattern) => {
    const clean = reportPath(pattern).replace(/^\.\//, '');
    const marker = clean.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    return marker !== '' && (segments.includes(marker) || normalized === marker || normalized.startsWith(`${marker}/`));
  });
}

function discoveryOptions(options: DiscoveryOptions): Required<DiscoveryOptions> {
  return {
    ignore: options.ignore ?? ['**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/coverage/**', '**/.git/**'],
    symlinks: options.symlinks ?? 'skip',
  };
}

export async function discoverRepository(rootDir: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const root = resolve(rootDir);
  const configuration = discoveryOptions(options);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) throw new Error('Repository root must be a directory');
  const files: string[] = [];
  const errors: DiscoveryError[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch (error) {
      errors.push({path: reportPath(relative(root, directory)), message: error instanceof Error ? error.message : String(error)});
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const relativePath = reportPath(relative(root, absolute));
      if (ignored(relativePath, configuration.ignore)) continue;
      if (entry.isSymbolicLink()) {
        if (configuration.symlinks === 'error') throw new Error(`Symlink encountered: ${relativePath}`);
        if (configuration.symlinks === 'follow') {
          const followed = await stat(absolute);
          if (followed.isDirectory()) await walk(absolute);
          else if (followed.isFile()) files.push(relativePath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!defaultIgnoredDirectories.has(entry.name)) await walk(absolute);
        continue;
      }
      if (entry.isFile()) files.push(relativePath);
    }
  }

  await walk(root);
  files.sort();
  return {root, files, errors};
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export async function buildManifest(rootDir: string, options: DiscoveryOptions = {}): Promise<RepositoryManifest> {
  const discovery = await discoverRepository(rootDir, options);
  const files: ManifestFile[] = [];
  for (const path of discovery.files) {
    const absolute = resolve(discovery.root, path);
    const details = await stat(absolute);
    files.push({path, bytes: details.size, sha256: await hashFile(absolute)});
  }
  return {schemaVersion: 1, root: discovery.root, files};
}
