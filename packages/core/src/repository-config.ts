import {lstat, readFile, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, win32} from 'node:path';

export type RepositoryConfig = {
  version: 1;
  protectedPaths: string[];
  ignoredPaths: string[];
  maxAssetBytes?: number;
};

const defaultConfig: RepositoryConfig = {version: 1, protectedPaths: [], ignoredPaths: []};

function normalizeConfiguredPath(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field}[${index}] must be a non-empty relative path`);
  }
  const normalized = value.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  const containsGlob = ['*', '?', '[', ']'].some((character) => normalized.includes(character));
  if (segments.length === 0 || normalized.startsWith('/') || isAbsolute(normalized) || win32.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || segments.includes('..') || containsGlob) {
    throw new Error(`${field}[${index}] must stay inside the scanned root: ${value}`);
  }
  return segments.join('/');
}

function readPathList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of relative paths`);
  return value.map((entry, index) => normalizeConfiguredPath(entry, field, index));
}

function validateConfig(value: unknown): RepositoryConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Guardian config must be a JSON object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error('Guardian config version must be 1');
  const maxAssetBytes = raw.maxAssetBytes;
  if (maxAssetBytes !== undefined &&
      (typeof maxAssetBytes !== 'number' || !Number.isSafeInteger(maxAssetBytes) || maxAssetBytes <= 0)) {
    throw new Error('maxAssetBytes must be a positive safe integer');
  }
  return {
    version: 1,
    protectedPaths: readPathList(raw.protectedPaths, 'protectedPaths'),
    ignoredPaths: readPathList(raw.ignoredPaths, 'ignoredPaths'),
    ...(maxAssetBytes === undefined ? {} : {maxAssetBytes}),
  };
}

export async function loadRepositoryConfig(rootDir: string): Promise<RepositoryConfig> {
  const root = resolve(rootDir);
  const file = join(root, '.guardian', 'config.json');
  let fileInfo;
  try {
    fileInfo = await lstat(file);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {...defaultConfig};
    throw error;
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('Guardian config must be a regular, non-symbolic-link file');

  const realRoot = await realpath(root);
  const realFile = await realpath(file);
  const relativeFile = relative(realRoot, realFile);
  const normalizedRelativeFile = relativeFile.replaceAll('\\', '/');
  if (normalizedRelativeFile === '..' || normalizedRelativeFile.startsWith('../') || isAbsolute(relativeFile)) {
    throw new Error('Guardian config must resolve inside the scanned root');
  }

  const source = await readFile(realFile, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Guardian config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateConfig(parsed);
}

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

export function matchesConfiguredRepositoryPath(candidatePath: string, configuredPaths: readonly string[]): boolean {
  const candidate = normalized(candidatePath);
  return configuredPaths.some((configuredPath) => {
    const configured = normalized(configuredPath);
    return candidate === configured || candidate.startsWith(`${configured}/`);
  });
}
