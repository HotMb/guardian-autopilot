import {spawn, type ChildProcess} from 'node:child_process';
import {resolve} from 'node:path';

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

type KnipRunOptions = {executable?: string; timeoutMs?: number};

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

function errorDetails(error: unknown): {code?: string | number; message: string; stderr?: string; killed?: boolean} {
  if (error instanceof Error) {
    const candidate = error as Error & {code?: string | number; stderr?: string; killed?: boolean};
    return {code: candidate.code, message: candidate.message, stderr: candidate.stderr, killed: candidate.killed};
  }
  return {message: String(error)};
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
    return;
  }

  await new Promise<void>((resolveKill) => {
    const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.once('error', () => {
      child.kill('SIGKILL');
      resolveKill();
    });
    taskkill.once('close', () => {
      child.kill('SIGKILL');
      resolveKill();
    });
  });
}

function executeKnip(command: string, args: string[], root: string, timeoutMs: number): Promise<{stdout: string; stderr: string}> {
  return new Promise((resolveResult, rejectResult) => {
    const child: ChildProcess = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: 'timeout' | 'max-buffer' | undefined;
    let spawnError: Error | undefined;
    let termination: Promise<void> | undefined;
    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 10 * 1024 * 1024 && failure === undefined) {
        failure = 'max-buffer';
        termination = terminateProcessTree(child);
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.once('error', (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      if (failure !== undefined) return;
      failure = 'timeout';
      termination = terminateProcessTree(child);
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      const complete = (): void => {
        if (failure === 'timeout') {
          rejectResult(Object.assign(new Error(`Knip exceeded its ${timeoutMs} ms timeout`), {code: 'ETIMEDOUT', killed: true, stdout: out, stderr: err}));
        } else if (failure === 'max-buffer') {
          rejectResult(Object.assign(new Error('Knip output exceeded its 10 MB limit'), {code: 'ENOBUFS', stdout: out, stderr: err}));
        } else if (spawnError !== undefined) rejectResult(spawnError);
        else if (code !== 0) {
          rejectResult(Object.assign(new Error(err.trim() || `Knip exited with ${signal ?? `code ${code ?? 'unknown'}`}`), {code: code ?? undefined, stderr: err, stdout: out, killed: signal !== null}));
        } else resolveResult({stdout: out, stderr: err});
      };
      if (termination === undefined) complete();
      else void termination.then(complete, complete);
    });
  });
}

export async function runKnip(rootDir: string, options: KnipRunOptions = {}): Promise<KnipResult> {
  const root = resolve(rootDir);
  const executable = options.executable ?? (process.platform === 'win32' ? 'knip.cmd' : 'knip');
  const args = ['--reporter', 'json', '--no-progress', '--no-config-hints', '--no-exit-code', '--include', 'dependencies,unlisted,unresolved'];
  const command = process.platform === 'win32' ? 'cmd.exe' : executable;
  const commandLine = [executable, ...args].map(quoteWindowsArgument).join(' ');
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', `"${commandLine}"`]
    : args;
  const timeoutMs = options.timeoutMs ?? 10_000;
  try {
    const result = await executeKnip(command, commandArgs, root, timeoutMs);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch (error) {
      return {status: 'failed', issues: [], error: `Knip returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`};
    }
    return {status: 'available', issues: parseKnipReport(parsed)};
  } catch (error) {
    const details = errorDetails(error);
    if (details.code === 'ETIMEDOUT' || details.killed === true) {
      return {status: 'failed', issues: [], error: `Knip exceeded its ${timeoutMs} ms timeout`, ...(typeof details.code === 'number' ? {exitCode: details.code} : {})};
    }
    if (details.code === 'ENOENT' || details.code === 'ENOTFOUND' || /not recognized|n'est pas reconnu|cannot find the file/i.test(details.stderr ?? details.message)) {
      return {status: 'unavailable', issues: [], error: `Knip is not installed or is not available on PATH: ${details.message}`};
    }
    return {status: 'failed', issues: [], error: details.stderr?.trim() || details.message, ...(typeof details.code === 'number' ? {exitCode: details.code} : {})};
  }
}
