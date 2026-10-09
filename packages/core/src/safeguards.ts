import {realpathSync} from 'node:fs';
import {relative, resolve} from 'node:path';
import type {Candidate, Evidence} from '@cleancode/shared/types';

export const DEFAULT_CHANGE_LIMITS = {
  maxFiles: 50,
  maxLines: 500,
  maxBytes: 100_000,
} as const;

const protectedPatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /\.(?:key|pem)$/i,
  /(^|\/)(?:migrations?|secrets?|db)(?:\/|$)/i,
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
  /\.lock$/i,
];

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isProtectedPath(path: string, patterns: readonly RegExp[] = protectedPatterns): boolean {
  const normalized = normalizedPath(path);
  return patterns.some((pattern) => pattern.test(normalized));
}

export function isSafePath(path: string, root: string): boolean {
  try {
    const realRoot = realpathSync(resolve(root));
    const realPath = realpathSync(resolve(path));
    const relativePath = relative(realRoot, realPath);
    return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${'\\'}`) && !relativePath.startsWith('../'));
  } catch {
    return false;
  }
}

export function canDelete(candidate: Pick<Candidate, 'evidence'>, minConfidence = 0.95): boolean {
  const evidence: readonly Evidence[] = candidate.evidence;
  return evidence.length > 0
    && evidence.every((item) => Number.isFinite(item.confidence) && item.confidence >= minConfidence)
    && evidence.some((item) => item.type === 'positive_proof');
}

export type ChangeCounts = {
  files: number;
  lines: number;
  bytes: number;
};

export function enforceChangeLimits(counts: ChangeCounts, limits = DEFAULT_CHANGE_LIMITS): void {
  if (!Number.isSafeInteger(counts.files) || counts.files < 0 || counts.files > limits.maxFiles) {
    throw new Error(`Change exceeds file limit: ${counts.files} > ${limits.maxFiles}`);
  }
  if (!Number.isSafeInteger(counts.lines) || counts.lines < 0 || counts.lines > limits.maxLines) {
    throw new Error(`Change exceeds line limit: ${counts.lines} > ${limits.maxLines}`);
  }
  if (!Number.isSafeInteger(counts.bytes) || counts.bytes < 0 || counts.bytes > limits.maxBytes) {
    throw new Error(`Change exceeds byte limit: ${counts.bytes} > ${limits.maxBytes}`);
  }
}
