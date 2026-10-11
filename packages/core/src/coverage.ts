import {readFile} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';

export type CoverageReport = {
  status: 'available' | 'unavailable' | 'invalid';
  reportPath: 'coverage/lcov.info';
  executedFiles: string[];
  zeroCoverageFiles: string[];
  zeroCoverageIsProof: false;
};

function normalized(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function pathKey(value: string): string {
  const path = normalized(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function repositoryPath(root: string, source: string): string | undefined {
  if (source.trim() === '' || source.startsWith('file:')) return undefined;
  const absolute = isAbsolute(source) ? resolve(source) : resolve(root, source);
  const path = normalized(relative(root, absolute));
  if (path === '' || path === '..' || path.startsWith('../') || path.startsWith('..\\')) return undefined;
  return path;
}

export async function scanCoverage(rootDir: string, knownFiles: readonly string[]): Promise<CoverageReport> {
  const root = resolve(rootDir);
  const reportPath = 'coverage/lcov.info' as const;
  let content: string;
  try {
    content = await readFile(resolve(root, reportPath), 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {status: missing ? 'unavailable' : 'invalid', reportPath, executedFiles: [], zeroCoverageFiles: [], zeroCoverageIsProof: false};
  }

  const canonicalFiles = new Map(knownFiles.map((path) => [pathKey(path), normalized(path)]));
  const observed = new Map<string, {measured: boolean; executed: boolean}>();
  let source: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      source = repositoryPath(root, line.slice(3));
      continue;
    }
    if (source === undefined) continue;
    const path = canonicalFiles.get(pathKey(source));
    if (path === undefined) continue;
    let countField: string | undefined;
    if (line.startsWith('DA:')) countField = line.slice(3).split(',')[1];
    else if (line.startsWith('FNDA:')) countField = line.slice(5).split(',')[0];
    if (countField === undefined || !/^\d+$/.test(countField)) continue;
    const count = Number(countField);
    if (!Number.isSafeInteger(count)) continue;
    const current = observed.get(path) ?? {measured: false, executed: false};
    current.measured = true;
    current.executed ||= count > 0;
    observed.set(path, current);
  }

  const executedFiles = [...observed].filter(([, value]) => value.executed).map(([path]) => path).sort();
  const zeroCoverageFiles = [...observed].filter(([, value]) => value.measured && !value.executed).map(([path]) => path).sort();
  return {status: 'available', reportPath, executedFiles, zeroCoverageFiles, zeroCoverageIsProof: false};
}
