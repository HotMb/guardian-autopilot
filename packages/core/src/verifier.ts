import {execFile as execFileCallback} from 'node:child_process';
import {existsSync} from 'node:fs';
import {delimiter, dirname, isAbsolute, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import type {VerificationResult} from '@cleancode/shared/types';

const execFile = promisify(execFileCallback);

export type VerificationCommand = {
  command: string;
  args?: readonly string[];
};

export type VerificationConfig = {
  build?: VerificationCommand;
  typecheck?: VerificationCommand;
  test?: VerificationCommand;
  requireAll?: boolean;
};

export type VerificationRunner = (
  command: VerificationCommand,
  cwd: string,
) => Promise<{stdout: string; stderr: string}>;

export type AcceptanceCheck = () => Promise<{passed: boolean; details?: string}>;

export type VerificationOptions = {
  runner?: VerificationRunner;
  acceptanceCheck?: AcceptanceCheck;
};

function resolveWindowsNpmInvocation(command: VerificationCommand): VerificationCommand {
  if (process.platform !== 'win32' || !/(^|[\\/])npm(?:\.cmd)?$/i.test(command.command)) return command;

  const commandDirectory = isAbsolute(command.command)
    ? dirname(command.command)
    : command.command.includes('/') || command.command.includes('\\')
      ? resolve(dirname(command.command))
      : undefined;
  const searchDirectories = commandDirectory === undefined
    ? [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]
    : [commandDirectory];
  const checked = new Set<string>();
  for (const directory of searchDirectories) {
    if (directory === '' || checked.has(directory.toLowerCase())) continue;
    checked.add(directory.toLowerCase());
    if (!existsSync(join(directory, 'npm.cmd'))) continue;
    const npmCli = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(npmCli)) return {command: process.execPath, args: [npmCli, ...(command.args ?? [])]};
  }
  throw new Error('Could not locate npm-cli.js for npm.cmd; configure a native executable command instead. Verification commands are never run through a shell.');
}

function defaultRunner(command: VerificationCommand, cwd: string): Promise<{stdout: string; stderr: string}> {
  const invocation = resolveWindowsNpmInvocation(command);
  return execFile(invocation.command, [...(invocation.args ?? [])], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const candidate = error as Error & {stderr?: string; stdout?: string};
    return candidate.stderr?.trim() || candidate.stdout?.trim() || candidate.message;
  }
  return String(error);
}

export async function runVerification(
  worktreePath: string,
  configuration: VerificationConfig,
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  const runner = options.runner ?? defaultRunner;
  const requireAll = configuration.requireAll ?? true;
  const details: Record<string, string> = {};
  const result: VerificationResult = {
    build: false,
    typecheck: false,
    tests: false,
    acceptance: false,
    allPassed: false,
    details,
  };

  const checks: Array<{name: 'build' | 'typecheck' | 'tests'; command?: VerificationCommand}> = [
    {name: 'build', command: configuration.build},
    {name: 'typecheck', command: configuration.typecheck},
    {name: 'tests', command: configuration.test},
  ];
  for (const check of checks) {
    if (check.command === undefined) {
      result[check.name] = !requireAll;
      details[check.name] = requireAll ? 'Verification command is not configured' : 'Verification command skipped by policy';
      continue;
    }
    try {
      await runner(check.command, worktreePath);
      result[check.name] = true;
    } catch (error) {
      result[check.name] = false;
      details[check.name] = errorMessage(error);
    }
  }

  if (options.acceptanceCheck === undefined) {
    result.acceptance = true;
  } else {
    try {
      const acceptance = await options.acceptanceCheck();
      result.acceptance = acceptance.passed;
      if (!acceptance.passed && acceptance.details !== undefined) details.acceptance = acceptance.details;
    } catch (error) {
      result.acceptance = false;
      details.acceptance = errorMessage(error);
    }
  }
  result.allPassed = result.build && result.typecheck && result.tests && result.acceptance;
  return result;
}
