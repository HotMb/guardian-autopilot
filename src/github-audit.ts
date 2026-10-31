import {mkdtemp, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
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
const maxCommitsPerPush = 20;

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

export type ParsedGitHubAuditEvent = {kind: 'ignored'} | {kind: 'push'; jobs: GitHubAuditJob[]};

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

  const commits = body.commits;
  if (commits !== undefined && !Array.isArray(commits)) throw new Error('GitHub push commits are invalid');
  if (Array.isArray(commits) && commits.length > maxCommitsPerPush) {
    throw new Error(`GitHub push exceeds the configured commit limit (${maxCommitsPerPush})`);
  }
  const commitShas: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(commits) ? commits : []) {
    const commit = record(item);
    if (typeof commit.id !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit.id) || /^0+$/.test(commit.id)) {
      throw new Error('GitHub commit SHA is invalid');
    }
    const sha = commit.id.toLowerCase();
    if (!seen.has(sha)) {
      seen.add(sha);
      commitShas.push(sha);
    }
  }
  const headSha = body.after.toLowerCase();
  if (!seen.has(headSha)) {
    if (commitShas.length >= maxCommitsPerPush) throw new Error(`GitHub push exceeds the configured commit limit (${maxCommitsPerPush})`);
    commitShas.push(headSha);
  }

  return {
    kind: 'push',
    jobs: commitShas.map((commitSha) => ({
      // Stable per repository and commit so retries and repeated deliveries deduplicate.
      deliveryId: `${repository.id}:${commitSha}`,
      installationId: installation.id as number,
      repositoryId: repository.id as number,
      owner: owner.login as string,
      repository: repository.name as string,
      fullName: repository.full_name as string,
      ref: body.ref as string,
      commitSha,
    })),
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

type ArchiveEvidence = {sha256: string; files: number; compressedBytes: number};

async function extractRepositoryArchive(response: Response, destination: string): Promise<ArchiveEvidence> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxCompressedBytes)) throw new IncompleteSnapshotError('archive_size_limit');
  if (response.body === null) throw new IncompleteSnapshotError('archive_body_missing');
  const compressed = {bytes: 0};
  const archiveHash = createHash('sha256');
  const hashStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveHash.update(chunk);
      callback(null, chunk);
    },
  });
  const expanded = {bytes: 0};
  const snapshot = {files: 0, bytes: 0, unsupported: false};
  const seen = new Set<string>();
  let archiveRoot: string | undefined;
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
      const kind = 'type' in entry ? String(entry.type) : '';
      const parts = archivePath.replaceAll('\\', '/').split('/').filter((part) => part !== '');
      if (parts.length === 0 || parts.some((part) => part === '.') || (parts.length === 1 && kind !== 'Directory')) {
        snapshot.unsupported = true;
        return false;
      }
      if (archiveRoot === undefined) archiveRoot = parts[0];
      else if (archiveRoot !== parts[0]) {
        snapshot.unsupported = true;
        return false;
      }
      if (isDefaultIgnoredPath(parts.slice(1).join('/'))) return false;
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
      hashStream,
      createGunzip(),
      limitedStream(maxExpandedBytes, expanded, 'archive_expanded_size_limit'),
      unpack,
    );
  } catch {
    throw new IncompleteSnapshotError('archive_extract_failed');
  }
  if (snapshot.unsupported || snapshot.files === 0) throw new IncompleteSnapshotError('archive_contains_unsupported_entries_or_exceeds_scan_limits');
  return {sha256: archiveHash.digest('hex'), files: snapshot.files, compressedBytes: compressed.bytes};
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

function safeCheckSummary(job: GitHubAuditJob, reportMarkdown?: string, blockedCode?: string, archiveEvidence?: ArchiveEvidence): string {
  const heading = `CleanCode audit for ${job.fullName} at commit ${job.commitSha}`;
  if (blockedCode !== undefined) return `## ${heading}\n\n**Analysis blocked.** ${blockedSummary(blockedCode)}\n\nNo repository files were modified and no project scripts were executed.`;
  if (reportMarkdown === undefined) return `## ${heading}\n\n**Analysis blocked.** ${blockedSummary('audit_analysis_failed')}`;
  const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const body = `<details><summary>Complete CleanCode report (Markdown)</summary>\n\n${escapeHtml(reportMarkdown)}\n\n</details>`;
  const provenance = archiveEvidence === undefined ? '' : `Archive SHA-256: \`${archiveEvidence.sha256}\`\n\nArchive files: ${archiveEvidence.files}; compressed bytes: ${archiveEvidence.compressedBytes}. The digest identifies the downloaded archive; it is not proof that deletion is safe.\n\n`;
  const summary = `## ${heading}\n\n${provenance}This report is **read-only**. The hosted audit did not execute repository scripts or modify repository files. External analyzers and closed-world execution proofs are disabled in hosted mode; deletion readiness remains fail-closed.\n\n${body}`;
  if (summary.length <= maxCheckSummaryChars) return summary;
  return `## ${heading}\n\n${provenance}**Report too large for GitHub Checks.** The complete report was not shortened or partially published. No candidate is actionable from this result.\n\nThe read-only analysis finished; no repository files were modified and no project scripts were executed.`;
}

function checkOutput(job: GitHubAuditJob, reportJson?: string, blockedCode?: string, archiveEvidence?: ArchiveEvidence): GitHubCheckOutput {
  const isBlocked = blockedCode !== undefined;
  return {
    conclusion: isBlocked ? 'action_required' : 'neutral',
    title: isBlocked ? 'CleanCode analysis blocked safely' : 'CleanCode report ready for review',
    summary: safeCheckSummary(job, reportJson, blockedCode, archiveEvidence),
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
  let reportMarkdown: string | undefined;
  let blockedCode: string | undefined;
  let archiveEvidence: ArchiveEvidence | undefined;
  try {
    const repository = await client.getRepository(job.owner, job.repository);
    if (repository.id !== job.repositoryId || repository.fullName.toLowerCase() !== job.fullName.toLowerCase()) {
      blockedCode = 'repository_identity_mismatch';
    } else {
      root = await mkdtemp(join(tmpdir(), 'guardian-cleancode-audit-'));
      const archive = await client.downloadRepositoryArchive(job.owner, job.repository, job.commitSha);
      archiveEvidence = await extractRepositoryArchive(archive, root);
      const plan = await planRepository(root, {runExternalTools: false});
      reportMarkdown = renderReport(plan, 'markdown');
      if (plan.discoveryStatus !== 'complete') blockedCode = 'audit_analysis_failed';
    }
  } catch (error) {
    blockedCode = error instanceof IncompleteSnapshotError ? error.message : 'audit_analysis_failed';
  } finally {
    if (root !== undefined) await rm(root, {recursive: true, force: true}).catch(() => undefined);
  }

  const output = checkOutput(job, reportMarkdown, blockedCode, archiveEvidence);
  const checkRunId = job.checkRunId ?? await client.createCheckRun(job.owner, job.repository, job.commitSha, job.deliveryId);
  if (job.checkRunId === undefined) await saveCheckRunId(checkRunId);
  await client.completeCheckRun(job.owner, job.repository, checkRunId, output);
}
