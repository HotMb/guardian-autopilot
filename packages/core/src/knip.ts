import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';

const execFile = promisify(execFileCallback);

export type KnipIssue = {
  file: string;
  type: string;
  name?: string;
  line?: number;
  col?: number;
};

export type KnipResult = {
  status: 'available' | 'unavailable' | 'failed';
  issues: KnipIssue[];
  error?: string;
  exitCode?: number;
};

type KnipRunOptions = {executable?: string};

function issueEntries(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
}

export function parseKnipReport(value: unknown): KnipIssue[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Knip JSON report must be an object');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.issues)) throw new Error('Knip JSON report is missing an issues array');
  const issues: KnipIssue[] = [];
  for (const group of issueEntries(raw.issues)) {
    if (typeof group.file !== 'string') continue;
    for (const [type, entries] of Object.entries(group)) {
      if (type === 'file' || type === 'owners') continue;
      for (const entry of issueEntries(entries)) {
        const issue: KnipIssue = {file: group.file, type};
        if (typeof entry.name === 'string') issue.name = entry.name;
        if (typeof entry.line === 'number') issue.line = entry.line;
        if (typeof entry.col === 'number') issue.col = entry.col;
        issues.push(issue);
      }
      if (Array.isArray(entries)) {
        for (const entry of entries) if (typeof entry === 'string') issues.push({file: group.file, type, name: entry});
      }
    }
  }
  return issues.sort((left, right) => `${left.file}\0${left.type}\0${left.name ?? ''}`.localeCompare(`${right.file}\0${right.type}\0${right.name ?? ''}`));
}

function errorDetails(error: unknown): {code?: string | number; message: string; stderr?: string} {
  if (error instanceof Error) {
    const candidate = error as Error & {code?: string | number; stderr?: string};
    return {code: candidate.code, message: candidate.message, stderr: candidate.stderr};
  }
  return {message: String(error)};
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

export async function runKnip(rootDir: string, options: KnipRunOptions = {}): Promise<KnipResult> {
  const root = resolve(rootDir);
  const executable = options.executable ?? (process.platform === 'win32' ? 'knip.cmd' : 'knip');
  const args = ['--reporter', 'json', '--no-progress', '--no-config-hints', '--no-exit-code', '--include', 'dependencies,unlisted,unresolved'];
  const command = process.platform === 'win32' ? 'cmd.exe' : executable;
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', [executable, ...args].map(quoteWindowsArgument).join(' ')]
    : args;
  try {
    const result = await execFile(command, commandArgs, {cwd: root, maxBuffer: 10 * 1024 * 1024, windowsHide: true});
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch (error) {
      return {status: 'failed', issues: [], error: `Knip returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`};
    }
    return {status: 'available', issues: parseKnipReport(parsed)};
  } catch (error) {
    const details = errorDetails(error);
    if (details.code === 'ENOENT' || details.code === 'ENOTFOUND' || /not recognized|n'est pas reconnu|cannot find the file/i.test(details.stderr ?? details.message)) {
      return {status: 'unavailable', issues: [], error: 'Knip is not installed or is not available on PATH'};
    }
    return {status: 'failed', issues: [], error: details.stderr?.trim() || details.message, ...(typeof details.code === 'number' ? {exitCode: details.code} : {})};
  }
}
