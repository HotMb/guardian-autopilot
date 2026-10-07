import {lstat, readFile, readdir} from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';
import {isIgnoredPath, loadConfig} from './config.js';

export type ReferenceKind = 'js-ts-literal' | 'css-url' | 'source-literal';
export type AssetReference = {
  source: string;
  target: string;
  kind: ReferenceKind;
  raw: string;
};
export type ReferenceError = {file: string; message: string};
export type ReferenceReport = {references: AssetReference[]; errors: ReferenceError[]};

const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.guardian']);
const sourceExtensions = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'sass', 'less', 'html', 'json', 'md', 'mdx']);
const assetExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'mov', 'webm', 'avif']);
const maxSourceBytes = 2_000_000;

function reportPath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

function isSourceFile(path: string): boolean {
  return sourceExtensions.has(extension(path));
}

function isAssetFile(path: string): boolean {
  return assetExtensions.has(extension(path));
}

function cleanReference(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, '').split(/[?#]/, 1)[0];
}

function looksLikeLocalReference(raw: string): boolean {
  const value = cleanReference(raw);
  if (!value || value.startsWith('data:') || /^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('public/') || isAssetFile(value);
}

function candidatePaths(root: string, sourcePath: string, raw: string): string[] {
  const value = cleanReference(raw);
  if (!value) return [];
  if (value.startsWith('/')) {
    const publicPath = join(root, 'public', value.slice(1));
    const rootPath = join(root, value.slice(1));
    return [publicPath, rootPath];
  }
  if (value.startsWith('public/')) return [join(root, value)];
  if (value.startsWith('./') || value.startsWith('../')) return [resolve(dirname(join(root, sourcePath)), value)];
  return [join(root, value)];
}

async function resolveAsset(root: string, sourcePath: string, raw: string): Promise<string | undefined> {
  for (const candidate of candidatePaths(root, sourcePath, raw)) {
    const candidateRoot = resolve(root);
    const resolvedCandidate = resolve(candidate);
    if (resolvedCandidate !== candidateRoot && !resolvedCandidate.startsWith(`${candidateRoot}\\`) && !resolvedCandidate.startsWith(`${candidateRoot}/`)) continue;
    try {
      const stat = await lstat(resolvedCandidate);
      if (stat.isFile() && !stat.isSymbolicLink() && isAssetFile(resolvedCandidate)) return reportPath(root, resolvedCandidate);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return undefined;
}

function extractRawReferences(sourcePath: string, source: string): Array<{raw: string; kind: ReferenceKind}> {
  const result: Array<{raw: string; kind: ReferenceKind}> = [];
  const kind: ReferenceKind = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(extension(sourcePath)) ? 'js-ts-literal' : 'source-literal';
  const cssUrlPattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\)\s]+))\s*\)/gi;
  const isCss = ['css', 'scss', 'sass', 'less'].includes(extension(sourcePath));
  for (const match of source.matchAll(cssUrlPattern)) result.push({raw: match[1] ?? match[2] ?? match[3], kind: 'css-url'});
  if (isCss) return result;
  const stringPattern = /"([^"\r\n]*)"|'([^'\r\n]*)'/g;
  for (const match of source.matchAll(stringPattern)) {
    result.push({raw: match[1] ?? match[2], kind});
  }
  return result;
}

export async function findAssetReferences(rootDir: string): Promise<ReferenceReport> {
  const root = resolve(rootDir);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Reference root must not be a symbolic link: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Reference root must be a directory: ${root}`);
  const config = await loadConfig(root);
  const references: AssetReference[] = [];
  const errors: ReferenceError[] = [];
  const seen = new Set<string>();

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
      if (!stat.isFile() || !isSourceFile(path)) continue;
      const sourcePath = reportPath(root, path);
      if (stat.size > maxSourceBytes) {
        errors.push({file: sourcePath, message: `Source file exceeds the ${maxSourceBytes}-byte analysis limit`});
        continue;
      }

      let source: string;
      try {
        source = await readFile(path, 'utf8');
      } catch (error) {
        errors.push({file: sourcePath, message: error instanceof Error ? error.message : String(error)});
        continue;
      }

      for (const candidate of extractRawReferences(sourcePath, source)) {
        if (!looksLikeLocalReference(candidate.raw)) continue;
        const target = await resolveAsset(root, sourcePath, candidate.raw);
        if (!target) continue;
        const key = `${sourcePath}\0${target}\0${candidate.kind}\0${candidate.raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({source: sourcePath, target, kind: candidate.kind, raw: candidate.raw});
      }
    }
  }

  await walk(root);
  references.sort((a, b) => `${a.source}\0${a.target}\0${a.kind}\0${a.raw}`.localeCompare(`${b.source}\0${b.target}\0${b.kind}\0${b.raw}`));
  return {references, errors};
}
