import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import type {PlanReport} from '@cleancode/core';

const execFile = promisify(execFileCallback);

export type CandidateHumanReview = {
  repositoryHead: string;
  sha256: string;
  allEntrypointsReviewed: boolean;
  noExternalUsageConfirmed: boolean;
};

export type HumanReviewFile = {
  schemaVersion: 1;
  repositoryHead: string;
  candidateReviews: Array<{
    path: string;
    sha256: string;
    allEntrypointsReviewed: boolean;
    noExternalUsageConfirmed: boolean;
  }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    return (await execFile('git', ['-C', root, ...args], {windowsHide: true})).stdout.trim();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Human review requires a Git checkout: ${details}`);
  }
}

async function reviewedContentHash(root: string, path: string, expectedRawHash: string): Promise<string> {
  const absolutePath = resolve(root, path);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const currentPath = await lstat(absolutePath);
    if (!opened.isFile() || currentPath.isSymbolicLink() || !currentPath.isFile()
      || currentPath.dev !== opened.dev || currentPath.ino !== opened.ino) {
      throw new Error(`Candidate changed or is not a regular file: ${path}`);
    }
    const bytes = await handle.readFile();
    const rawHash = createHash('sha256').update(bytes).digest('hex');
    if (rawHash !== expectedRawHash) throw new Error(`Candidate changed after analysis: ${path}`);
    const text = bytes.toString('utf8');
    const canonicalBytes = Buffer.from(text, 'utf8').equals(bytes)
      ? Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8')
      : bytes;
    return createHash('sha256').update(canonicalBytes).digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function createHumanReviewTemplate(plan: PlanReport, paths: readonly string[]): Promise<HumanReviewFile> {
  if (paths.length === 0 || paths.length > 3) throw new Error('Review requires between one and three --path values');
  if (new Set(paths).size !== paths.length) throw new Error('Review paths must be unique');
  const status = await git(plan.root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') throw new Error('Human review template requires a clean Git checkout');
  const repositoryHead = await git(plan.root, ['rev-parse', 'HEAD']);
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.path, candidate]));
  const files = new Map(plan.manifest.files.map((file) => [file.path, file.sha256]));
  const candidateReviews = await Promise.all(paths.map(async (path) => {
    const candidate = candidates.get(path);
    if (candidate === undefined) throw new Error(`Not a current review-only candidate: ${path}`);
    if (candidate.decision.reasons.some((reason) => /candidate path is protected/i.test(reason))) {
      throw new Error(`Protected candidate cannot receive a human review: ${path}`);
    }
    const rawHash = files.get(path);
    if (rawHash === undefined) throw new Error(`Candidate is missing from the current repository manifest: ${path}`);
    const sha256 = await reviewedContentHash(plan.root, path, rawHash);
    return {path, sha256, allEntrypointsReviewed: false, noExternalUsageConfirmed: false};
  }));
  return {schemaVersion: 1, repositoryHead, candidateReviews};
}

export async function loadHumanReviewFile(path: string, plan: PlanReport): Promise<Map<string, CandidateHumanReview>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read human review file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!record(value) || value.schemaVersion !== 1 || typeof value.repositoryHead !== 'string' || !Array.isArray(value.candidateReviews) || value.candidateReviews.length === 0) {
    throw new Error('Human review file must contain schemaVersion 1, repositoryHead, and a non-empty candidateReviews array');
  }
  const repositoryHead = await git(plan.root, ['rev-parse', 'HEAD']);
  if (value.repositoryHead !== repositoryHead) throw new Error('Human review file refers to a different repository commit; generate and complete a fresh review');

  const candidates = new Set(plan.candidates.map((candidate) => candidate.path));
  const files = new Map(plan.manifest.files.map((file) => [file.path, file.sha256]));
  const reviews = new Map<string, CandidateHumanReview>();
  for (const [index, entry] of value.candidateReviews.entries()) {
    if (!record(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || typeof entry.allEntrypointsReviewed !== 'boolean' || typeof entry.noExternalUsageConfirmed !== 'boolean') {
      throw new Error(`Invalid human review at index ${index}; path, sha256, and both boolean confirmations are required`);
    }
    if (reviews.has(entry.path)) throw new Error(`Duplicate human review path: ${entry.path}`);
    if (!candidates.has(entry.path)) throw new Error(`Human review is not for a current review-only candidate: ${entry.path}`);
    const rawHash = files.get(entry.path);
    if (rawHash === undefined || await reviewedContentHash(plan.root, entry.path, rawHash) !== entry.sha256) {
      throw new Error(`Human review file hash is stale for ${entry.path}; generate and complete a fresh review`);
    }
    reviews.set(entry.path, {
      repositoryHead,
      sha256: entry.sha256,
      allEntrypointsReviewed: entry.allEntrypointsReviewed,
      noExternalUsageConfirmed: entry.noExternalUsageConfirmed,
    });
  }
  return reviews;
}
