import {execFile as execFileCallback} from 'node:child_process';
import {readFile} from 'node:fs/promises';
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

export async function createHumanReviewTemplate(plan: PlanReport, paths: readonly string[]): Promise<HumanReviewFile> {
  if (paths.length === 0 || paths.length > 3) throw new Error('Review requires between one and three --path values');
  if (new Set(paths).size !== paths.length) throw new Error('Review paths must be unique');
  const status = await git(plan.root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') throw new Error('Human review template requires a clean Git checkout');
  const repositoryHead = await git(plan.root, ['rev-parse', 'HEAD']);
  const candidates = new Set(plan.candidates.map((candidate) => candidate.path));
  const files = new Map(plan.manifest.files.map((file) => [file.path, file.sha256]));
  const candidateReviews = paths.map((path) => {
    if (!candidates.has(path)) throw new Error(`Not a current review-only candidate: ${path}`);
    const sha256 = files.get(path);
    if (sha256 === undefined) throw new Error(`Candidate is missing from the current repository manifest: ${path}`);
    return {path, sha256, allEntrypointsReviewed: false, noExternalUsageConfirmed: false};
  });
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
    if (files.get(entry.path) !== entry.sha256) throw new Error(`Human review file hash is stale for ${entry.path}; generate and complete a fresh review`);
    reviews.set(entry.path, {
      repositoryHead,
      sha256: entry.sha256,
      allEntrypointsReviewed: entry.allEntrypointsReviewed,
      noExternalUsageConfirmed: entry.noExternalUsageConfirmed,
    });
  }
  return reviews;
}
