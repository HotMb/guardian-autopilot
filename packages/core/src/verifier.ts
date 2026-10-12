import {execFile as execFileCallback} from 'node:child_process';
import {existsSync} from 'node:fs';
import {delimiter, dirname, isAbsolute, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import type {VerificationResult} from '@cleancode/shared/types';

const execFile = promisify(execFileCallback);

export type VerificationCommand = {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
};

export type VerificationConfig = {
  prepare?: readonly VerificationCommand[];
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
  allowPreparation?: boolean;
};

const DEFAULT_PREPARATION_TIMEOUT_MS = 120_000;
const MAX_PREPARATION_TIMEOUT_MS = 600_000;
const MAX_PREPARATION_COMMANDS = 3;
const MIN_PREPARATION_TIMEOUT_MS = 1_000;

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
    ...(command.timeoutMs === undefined ? {} : {timeout: command.timeoutMs}),
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

  const preparation = configuration.prepare ?? [];
  if (preparation.length > 0) {
    let preparationFailure: string | undefined;
    if (preparation.length > MAX_PREPARATION_COMMANDS) {
      preparationFailure = `Preparation is limited to a maximum of ${MAX_PREPARATION_COMMANDS} commands`;
    } else if (options.allowPreparation !== true) {
      preparationFailure = 'Preparation commands require explicit approval (--allow-preparation)';
    } else {
      let totalTimeout = 0;
      for (const [index, command] of preparation.entries()) {
        const timeoutMs = command.timeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS;
        if (typeof command.command !== 'string' || command.command.trim() === '') {
          preparationFailure = `Preparation command ${index + 1} must have a non-empty executable`;
          break;
        }
        if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string'))) {
          preparationFailure = `Preparation command ${index + 1} arguments must be strings`;
          break;
        }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_PREPARATION_TIMEOUT_MS || timeoutMs > MAX_PREPARATION_TIMEOUT_MS) {
          preparationFailure = `Preparation command ${index + 1} timeout must be between ${MIN_PREPARATION_TIMEOUT_MS} and ${MAX_PREPARATION_TIMEOUT_MS} milliseconds`;
          break;
        }
        totalTimeout += timeoutMs;
      }
      if (preparationFailure === undefined && totalTimeout > MAX_PREPARATION_TIMEOUT_MS) {
        preparationFailure = `Total preparation timeout cannot exceed ${MAX_PREPARATION_TIMEOUT_MS} milliseconds`;
      }
      if (preparationFailure === undefined) {
        for (const [index, command] of preparation.entries()) {
          try {
            await runner({...command, timeoutMs: command.timeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS}, worktreePath);
          } catch (error) {
            preparationFailure = `Preparation command ${index + 1} failed: ${errorMessage(error)}`;
            break;
          }
        }
      }
    }
    if (preparationFailure !== undefined) {
      details.preparation = preparationFailure;
      for (const name of ['build', 'typecheck', 'tests'] as const) {
        result[name] = false;
        details[name] = 'Skipped because dependency preparation did not complete';
      }
      result.acceptance = false;
      details.acceptance = 'Skipped because dependency preparation did not complete';
      return result;
    }
    details.preparation = `${preparation.length} preparation command(s) completed in the isolated worktree`;
  }

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
