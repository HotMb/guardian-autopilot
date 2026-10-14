import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {relative, resolve} from 'node:path';

export type SymlinkMode = 'skip' | 'error';

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

export const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/coverage/**',
  '**/.git/**',
] as const;

const defaultIgnoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage']);

function reportPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function ignored(relativePath: string, patterns: readonly string[]): boolean {
  const normalized = reportPath(relativePath);
  // Git worktrees store a file named `.git` that points to metadata outside the
  // checkout. Treat it like the `.git/` directory in the primary checkout.
  if (normalized.split('/').includes('.git')) return true;
  return patterns.some((pattern) => {
    const clean = reportPath(pattern).replace(/^\.\//, '');
    if (clean.includes('*')) {
      const insensitivePath = normalized.toLowerCase();
      const insensitivePattern = clean.toLowerCase();
      const segments = insensitivePath.split('/');
      const marker = insensitivePattern.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
      return marker !== '' && (segments.includes(marker) || insensitivePath === marker || insensitivePath.startsWith(`${marker}/`));
    }
    const comparedPath = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const comparedPattern = process.platform === 'win32' ? clean.toLowerCase() : clean;
    return comparedPath === comparedPattern || comparedPath.startsWith(`${comparedPattern}/`);
  });
}

function discoveryOptions(options: DiscoveryOptions): Required<DiscoveryOptions> {
  return {
    ignore: options.ignore ?? DEFAULT_IGNORE_PATTERNS,
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
  return (async () => {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      const currentPath = await lstat(path);
      if (!opened.isFile() || currentPath.isSymbolicLink() || !currentPath.isFile()
        || currentPath.dev !== opened.dev || currentPath.ino !== opened.ino) {
        throw new Error(`Manifest entry changed or is not a regular file: ${path}`);
      }
      return await new Promise<string>((resolveHash, reject) => {
        const hash = createHash('sha256');
        const stream = handle.createReadStream({autoClose: true});
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolveHash(hash.digest('hex')));
      });
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  })();
}

export async function buildManifest(rootDir: string, options: DiscoveryOptions = {}): Promise<RepositoryManifest> {
  const discovery = await discoverRepository(rootDir, options);
  const files: ManifestFile[] = [];
  for (const path of discovery.files) {
    const absolute = resolve(discovery.root, path);
    const details = await lstat(absolute);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Manifest entry is not a regular file: ${path}`);
    files.push({path, bytes: details.size, sha256: await hashFile(absolute)});
  }
  return {schemaVersion: 1, root: discovery.root, files};
}
