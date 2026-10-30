import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {x as extractTar} from 'tar';
import {planRepository, renderReport} from '@cleancode/core';
import type {GitHubInstallationClient, GitHubCheckOutput} from './github-installation.js';
import type {ClaimedGitHubAuditJob} from './github-audit-queue.js';

const maxCompressedBytes = 30 * 1024 * 1024;
const maxExpandedBytes = 100 * 1024 * 1024;
const maxFiles = 10_000;
const maxFileBytes = 8 * 1024 * 1024;
const maxScannedBytes = 64 * 1024 * 1024;
const maxCheckSummaryChars = 55_000;

export type GitHubAuditJob = {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
  fullName: string;
  ref: string;
  commitSha: string;
};

export type ParsedGitHubAuditEvent = {kind: 'ignored'} | {kind: 'push'; job: GitHubAuditJob};

export type GitHubAuditClientFactory = (job: GitHubAuditJob) => GitHubInstallationClient;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub push payload is invalid');
  return value as Record<string, unknown>;
}

function positiveIdentifier(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validBranchRef(value: string): boolean {
  if (!value.startsWith('refs/heads/')) return false;
  const branch = value.slice('refs/heads/'.length);
  if (branch === '' || branch.startsWith('/') || branch.endsWith('/') || branch.includes('//') || branch.includes('..')) return false;
  if (/[\u0000-\u0020~^:?*[\\\]]/.test(branch)) return false;
  return branch.split('/').every((part) => part !== '' && part !== '.' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Validate the signed GitHub event before placing only bounded metadata on the audit queue. */
export function parseGitHubAuditEvent(event: string, deliveryId: string, payload: unknown): ParsedGitHubAuditEvent {
  if (!/^[A-Za-z0-9-]{1,255}$/.test(deliveryId)) throw new Error('GitHub delivery id is invalid');
  if (event !== 'push') return {kind: 'ignored'};
  const body = record(payload);
  if (body.deleted === true) return {kind: 'ignored'};
  if (typeof body.ref !== 'string' || !validBranchRef(body.ref)) {
    if (typeof body.ref === 'string' && body.ref.startsWith('refs/tags/')) return {kind: 'ignored'};
    throw new Error('GitHub branch ref is invalid');
  }
  if (typeof body.after !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(body.after)) throw new Error('GitHub commit SHA is invalid');
  if (/^0+$/.test(body.after)) return {kind: 'ignored'};

  const installation = record(body.installation);
  const repository = record(body.repository);
  const owner = record(repository.owner);
  if (!positiveIdentifier(installation.id)) throw new Error('GitHub installation id is invalid');
  if (!positiveIdentifier(repository.id)) throw new Error('GitHub repository id is invalid');
  if (typeof owner.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(owner.login)
    || typeof repository.name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(repository.name)
    || repository.name === '.' || repository.name === '..'
    || typeof repository.full_name !== 'string'
    || repository.full_name.toLowerCase() !== `${owner.login}/${repository.name}`.toLowerCase()) {
    throw new Error('GitHub repository identity is invalid');
  }

  return {
    kind: 'push',
    job: {
      deliveryId,
      installationId: installation.id,
      repositoryId: repository.id,
      owner: owner.login,
      repository: repository.name,
      fullName: repository.full_name,
      ref: body.ref,
      commitSha: body.after,
    },
  };
}

class IncompleteSnapshotError extends Error {}

function isDefaultIgnoredPath(path: string): boolean {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage']);
  return path.replaceAll('\\', '/').split('/').some((segment) => ignored.has(segment.toLowerCase()));
}

function isSafeArchivePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (normalized === '' || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false;
  return normalized.split('/').every((segment) => segment !== '..');
}

function limitedStream(maxBytes: number, counter: {bytes: number}, errorCode: string): Transform {
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      counter.bytes += bytes;
      if (counter.bytes > maxBytes) callback(new IncompleteSnapshotError(errorCode));
      else callback(null, chunk);
    },
  });
}

async function extractRepositoryArchive(response: Response, destination: string): Promise<void> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxCompressedBytes)) throw new IncompleteSnapshotError('archive_size_limit');
  if (response.body === null) throw new IncompleteSnapshotError('archive_body_missing');
  const compressed = {bytes: 0};
  const expanded = {bytes: 0};
  const snapshot = {files: 0, bytes: 0, unsupported: false};
  const seen = new Set<string>();
  const unpack = extractTar({
    cwd: destination,
    strip: 1,
    gzip: false,
    strict: true,
    preservePaths: false,
    filter: (archivePath, entry) => {
      if (!isSafeArchivePath(archivePath)) {
        snapshot.unsupported = true;
        return false;
      }
      if (isDefaultIgnoredPath(archivePath)) return false;
      const kind = 'type' in entry ? String(entry.type) : '';
      if (kind === 'Directory') return true;
      if (!['File', 'OldFile', 'ContiguousFile'].includes(kind)) {
        snapshot.unsupported = true;
        return false;
      }
      const fileBytes = 'size' in entry && typeof entry.size === 'number' ? entry.size : 0;
      if (!Number.isSafeInteger(fileBytes) || fileBytes < 0 || fileBytes > maxFileBytes) {
        snapshot.unsupported = true;
        return false;
      }
      snapshot.files += 1;
      snapshot.bytes += fileBytes;
      if (snapshot.files > maxFiles || snapshot.bytes > maxScannedBytes) {
        snapshot.unsupported = true;
        return false;
      }
      const normalized = archivePath.replaceAll('\\', '/');
      if (seen.has(normalized)) {
        snapshot.unsupported = true;
        return false;
      }
      seen.add(normalized);
      return true;
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      limitedStream(maxCompressedBytes, compressed, 'archive_compressed_size_limit'),
      createGunzip(),
      limitedStream(maxExpandedBytes, expanded, 'archive_expanded_size_limit'),
      unpack,
    );
  } catch {
    throw new IncompleteSnapshotError('archive_extract_failed');
  }
  if (snapshot.unsupported) throw new IncompleteSnapshotError('archive_contains_unsupported_entries_or_exceeds_scan_limits');
}

function blockedSummary(code: string): string {
  const descriptions: Record<string, string> = {
    archive_size_limit: 'The repository archive exceeded the compressed-size limit.',
    archive_body_missing: 'GitHub returned an empty repository archive.',
    archive_compressed_size_limit: 'The compressed repository archive exceeded the configured limit.',
    archive_expanded_size_limit: 'The expanded repository archive exceeded the configured limit.',
    archive_extract_failed: 'The repository archive could not be extracted safely.',
    archive_contains_unsupported_entries_or_exceeds_scan_limits: 'The snapshot contains unsupported entries or exceeds the safe scan limits; no candidate is treated as actionable.',
    repository_identity_mismatch: 'The repository returned by GitHub did not match the signed delivery.',
    audit_analysis_failed: 'Static analysis did not complete. No repository code was executed or changed.',
  };
  return descriptions[code] ?? descriptions.audit_analysis_failed!;
}

function safeCheckSummary(job: GitHubAuditJob, reportJson?: string, blockedCode?: string): string {
  const heading = `CleanCode audit for ${job.fullName} at commit ${job.commitSha}`;
  if (blockedCode !== undefined) return `## ${heading}\n\n**Analysis blocked.** ${blockedSummary(blockedCode)}\n\nNo repository files were modified and no project scripts were executed.`;
  if (reportJson === undefined) return `## ${heading}\n\n**Analysis blocked.** ${blockedSummary('audit_analysis_failed')}`;
  let serialized: string;
  try {
    const report = JSON.parse(reportJson) as Record<string, unknown>;
    report.root = `${job.fullName}@${job.commitSha}`;
    serialized = JSON.stringify(report, null, 2);
  } catch {
    return `## ${heading}\n\n**Analysis blocked.** ${blockedSummary('audit_analysis_failed')}`;
  }
  const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const body = `<details><summary>Complete CleanCode report (JSON)</summary>\n\n<pre><code>${escapeHtml(serialized)}</code></pre>\n\n</details>`;
  const summary = `## ${heading}\n\nThis report is **read-only**. The hosted audit did not execute repository scripts or modify repository files. External analyzers and closed-world execution proofs are disabled in hosted mode; deletion readiness remains fail-closed.\n\n${body}`;
  if (summary.length <= maxCheckSummaryChars) return summary;
  const metrics = serialized.slice(0, 12_000);
  return `## ${heading}\n\nThe full report exceeded GitHub's safe Check Run summary budget and has been abbreviated. No candidate is treated as actionable from a truncated report.\n\n<details><summary>Report excerpt (JSON)</summary>\n\n<pre><code>${escapeHtml(metrics)}</code></pre>\n\n</details>`;
}

function checkOutput(job: GitHubAuditJob, reportJson?: string, blockedCode?: string): GitHubCheckOutput {
  const isBlocked = blockedCode !== undefined;
  return {
    conclusion: isBlocked ? 'action_required' : 'neutral',
    title: isBlocked ? 'CleanCode analysis blocked safely' : 'CleanCode report ready for review',
    summary: safeCheckSummary(job, reportJson, blockedCode),
  };
}

/** Fetches one signed commit snapshot, scans it read-only, and publishes the result as a GitHub Check Run. */
export async function processGitHubAuditJob(
  job: ClaimedGitHubAuditJob,
  createClient: GitHubAuditClientFactory,
  saveCheckRunId: (checkRunId: number) => Promise<void>,
): Promise<void> {
  const client = createClient(job);
  let root: string | undefined;
  let reportJson: string | undefined;
  let blockedCode: string | undefined;
  try {
    const repository = await client.getRepository(job.owner, job.repository);
    if (repository.id !== job.repositoryId || repository.fullName.toLowerCase() !== job.fullName.toLowerCase()) {
      blockedCode = 'repository_identity_mismatch';
    } else {
      root = await mkdtemp(join(tmpdir(), 'guardian-cleancode-audit-'));
      const archive = await client.downloadRepositoryArchive(job.owner, job.repository, job.commitSha);
      await extractRepositoryArchive(archive, root);
      const plan = await planRepository(root, {runExternalTools: false});
      reportJson = renderReport(plan, 'json');
      if (plan.discoveryStatus !== 'complete') blockedCode = 'audit_analysis_failed';
    }
  } catch (error) {
    blockedCode = error instanceof IncompleteSnapshotError ? error.message : 'audit_analysis_failed';
  } finally {
    if (root !== undefined) await rm(root, {recursive: true, force: true}).catch(() => undefined);
  }

  const output = checkOutput(job, reportJson, blockedCode);
  const checkRunId = job.checkRunId ?? await client.createCheckRun(job.owner, job.repository, job.commitSha, job.deliveryId);
  if (job.checkRunId === undefined) await saveCheckRunId(checkRunId);
  await client.completeCheckRun(job.owner, job.repository, checkRunId, output);
}
