import {readFile} from 'node:fs/promises';
import {dirname, posix, relative, resolve} from 'node:path';

export type PackageEntrypointReport = {
  files: string[];
  invalidManifests: string[];
};

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
}

function packageTargets(value: Record<string, unknown>): string[] {
  const targets: string[] = [];
  for (const field of ['exports', 'bin', 'main', 'module', 'browser', 'types', 'typings']) {
    collectStrings(value[field], targets);
  }
  return targets;
}

function compiledSourceVariants(outputPath: string): string[] {
  const segments = outputPath.split('/');
  const outputDirectory = segments.findIndex((segment) => ['dist', 'build', 'out'].includes(segment));
  if (outputDirectory < 0 || outputDirectory === segments.length - 1) return [];
  let suffix = segments.slice(outputDirectory + 1).join('/');
  suffix = suffix.replace(/\.d\.ts$/i, '.ts').replace(/\.(?:m|c)?js$/i, '.ts');
  const stem = suffix.replace(/\.(?:tsx?|jsx?)$/i, '');
  const variants = new Set<string>();
  for (const prefix of ['', 'src/', 'source/']) {
    for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) variants.add(`${prefix}${stem}${extension}`);
  }
  return [...variants];
}

function addTargetFiles(target: string, root: string, packageRoot: string, knownFiles: readonly string[], found: Set<string>): void {
  if (!target.startsWith('./')) return;
  const pattern = posix.normalize(normalized(target));
  const star = pattern.indexOf('*');
  if (star >= 0) {
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    for (const file of knownFiles) {
      const absolute = resolve(root, file);
      const localPath = normalized(relative(packageRoot, absolute));
      if (localPath === '..' || localPath.startsWith('../') || localPath.startsWith('..\\')) continue;
      if (localPath.startsWith(prefix) && localPath.endsWith(suffix) && localPath.length > prefix.length + suffix.length) found.add(file);
    }
    for (const sourcePattern of compiledSourceVariants(pattern)) {
      const sourceStar = sourcePattern.indexOf('*');
      if (sourceStar < 0) continue;
      const sourcePrefix = sourcePattern.slice(0, sourceStar);
      const sourceSuffix = sourcePattern.slice(sourceStar + 1);
      for (const file of knownFiles) {
        const localPath = normalized(relative(packageRoot, resolve(root, file)));
        if (localPath.startsWith(sourcePrefix) && localPath.endsWith(sourceSuffix) && localPath.length > sourcePrefix.length + sourceSuffix.length) found.add(file);
      }
    }
    return;
  }

  const local = posix.normalize(pattern);
  const candidates = new Set([local]);
  if (!posix.extname(local)) {
    for (const extension of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']) candidates.add(`${local}${extension}`);
    for (const extension of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']) candidates.add(`${local}/index${extension}`);
  }
  for (const candidate of candidates) {
    const absolute = resolve(packageRoot, candidate);
    const relativePath = normalized(relative(root, absolute));
    if (relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\')) continue;
    if (knownFiles.includes(relativePath)) found.add(relativePath);
  }
  if (![...found].some((file) => {
    const localPath = normalized(relative(packageRoot, resolve(root, file)));
    return candidates.has(localPath);
  })) {
    for (const sourceVariant of compiledSourceVariants(local)) {
      const absolute = resolve(packageRoot, sourceVariant);
      const relativePath = normalized(relative(root, absolute));
      if (knownFiles.includes(relativePath)) found.add(relativePath);
    }
  }
}

export async function scanPackageEntrypoints(rootDir: string, knownFiles: readonly string[]): Promise<PackageEntrypointReport> {
  const root = resolve(rootDir);
  const files = new Set<string>();
  const invalidManifests: string[] = [];
  const manifests = knownFiles.filter((path) => path.split('/').at(-1)?.toLowerCase() === 'package.json').sort();
  for (const manifest of manifests) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(resolve(root, manifest), 'utf8')); }
    catch { invalidManifests.push(manifest); continue; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      invalidManifests.push(manifest);
      continue;
    }
    const packageRoot = resolve(root, dirname(manifest));
    for (const target of packageTargets(parsed as Record<string, unknown>)) {
      addTargetFiles(target, root, packageRoot, knownFiles, files);
    }
  }
  return {files: [...files].sort(), invalidManifests};
}

export function belongsToInvalidPackage(file: string, invalidManifests: readonly string[]): boolean {
  const candidate = normalized(file);
  return invalidManifests.some((manifest) => {
    const packageRoot = normalized(posix.dirname(manifest));
    return packageRoot === '.' || candidate.startsWith(`${packageRoot}/`);
  });
}
