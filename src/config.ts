import {readFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve} from 'node:path';

export type GuardianConfig = {
  version: 1;
  protectedPaths: string[];
  ignoredPaths: string[];
  maxAssetBytes?: number;
};

const configPath = (root: string): string => join(root, '.guardian', 'config.json');

const defaultConfig: GuardianConfig = {
  version: 1,
  protectedPaths: [],
  ignoredPaths: [],
};

function normalizeConfiguredPath(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field}[${index}] must be a non-empty relative path`);
  }
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const segments = normalized.split('/');
  if (normalized === '.' || normalized.startsWith('/') || isAbsolute(normalized) || segments.includes('..')) {
    throw new Error(`${field}[${index}] must stay inside the scanned root: ${value}`);
  }
  return normalized;
}

function readPathList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of relative paths`);
  return value.map((entry, index) => normalizeConfiguredPath(entry, field, index));
}

function validateConfig(value: unknown): GuardianConfig {
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

export async function loadConfig(rootDir: string): Promise<GuardianConfig> {
  const root = resolve(rootDir);
  try {
    const source = await readFile(configPath(root), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Guardian config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return validateConfig(parsed);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {...defaultConfig};
    throw error;
  }
}

function matchesConfiguredPath(candidate: string, configured: string): boolean {
  return candidate === configured || candidate.startsWith(`${configured}/`);
}

export function isProtectedPath(rootDir: string, candidatePath: string, config: GuardianConfig): boolean {
  const root = resolve(rootDir);
  const candidate = resolve(root, candidatePath);
  const relativePath = relative(root, candidate).replaceAll('\\', '/');
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) return true;

  if (config.protectedPaths.some((path) => matchesConfiguredPath(relativePath, path))) return true;

  const segments = relativePath.split('/');
  const basename = segments.at(-1) ?? '';
  if (segments.some((segment) => segment === '.env' || segment.startsWith('.env.'))) return true;
  return /\.(pem|key|crt|p12|pfx)$/i.test(basename);
}

export function isIgnoredPath(rootDir: string, candidatePath: string, config: GuardianConfig): boolean {
  const root = resolve(rootDir);
  const candidate = resolve(root, candidatePath);
  const relativePath = relative(root, candidate).replaceAll('\\', '/');
  return config.ignoredPaths.some((path) => matchesConfiguredPath(relativePath, path));
}
