import {execFile} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import type {UnresolvedReference} from '@cleancode/core';

const execFileAsync = promisify(execFile) as (file: string, args: string[], options: {
  shell: false;
  windowsHide: true;
  timeout: number;
  maxBuffer: number;
}) => Promise<unknown>;

export type GitHubCommandRunner = (file: string, args: string[], options: {
  shell: false;
  windowsHide: true;
  timeout: number;
  maxBuffer: number;
}) => Promise<unknown>;

export function summarizeUnresolvedReferences(references: readonly UnresolvedReference[]): {
  unresolvedReferences: number;
  unresolvedTestReferences: number;
  unresolvedGeneratedOutputReferences: number;
} {
  const testReferences = references.filter(({from}) => /(^|\/)(?:tests?|__tests__)\//i.test(from));
  const generatedOutputReferences = testReferences.filter(({specifier}) => /(^|\/)(?:dist|build|out)\//i.test(specifier.replaceAll('\\', '/')));
  return {
    unresolvedReferences: references.length - testReferences.length,
    unresolvedTestReferences: testReferences.length,
    unresolvedGeneratedOutputReferences: generatedOutputReferences.length,
  };
}

function validRepositorySlug(repository: string): boolean {
  const [owner, name, extra] = repository.split('/');
  return extra === undefined
    && owner !== undefined
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    && name !== undefined
    && name.length <= 100
    && /^[A-Za-z0-9._-]+$/.test(name)
    && name !== '.'
    && name !== '..';
}

export async function cloneGitHubRepository(
  repository: string,
  destination: string,
  run: GitHubCommandRunner = execFileAsync,
): Promise<string> {
  if (!validRepositorySlug(repository)) throw new Error('Repository must use the owner/repository format.');
  if (destination.trim() === '') throw new Error('An explicit destination path is required.');

  const localPath = resolve(destination);
  try {
    await lstat(localPath);
    throw new Error('The destination already exists; choose a new, empty path so no local files are overwritten.');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // A new destination is required; gh creates it during clone.
    } else {
      throw error;
    }
  }

  const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
  try {
    await run(executable, ['repo', 'clone', repository, localPath], {
      shell: false,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error('Could not clone the repository. Install GitHub CLI, sign in with `gh auth login`, and check access with `gh auth status`.');
  }
  return localPath;
}
