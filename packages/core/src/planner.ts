import {extname, relative, resolve} from 'node:path';
import type {Candidate, Evidence} from '@cleancode/shared/types';
import {buildManifest, DEFAULT_IGNORE_PATTERNS, type DirectoryReader, type DiscoveryError, type RepositoryManifest} from './manifest.js';
import {buildReferenceGraph, type ReferenceGraph} from './reference-graph.js';
import {findExactDuplicates, type ExactDuplicateGroup} from './duplicates.js';
import {evaluateCandidate, type PolicyConfig, type PolicyDecision} from './policy.js';
import {runKnip, type KnipResult} from './knip.js';
import {scanDynamicHints, type DynamicHint} from './dynamic-hints.js';
import {scanCoverage, type CoverageReport} from './coverage.js';
import {belongsToInvalidPackage, scanPackageEntrypoints, type PackageEntrypointReport} from './package-exports.js';
import {scanStringReferences, type StringReferenceReport} from './string-references.js';
import {loadRepositoryConfig} from './repository-config.js';
import {analyzeClosedWorld, CLOSED_WORLD_ANALYZER, CLOSED_WORLD_ANALYZER_VERSION, type ClosedWorldBlocker} from './closed-world.js';
import {getPositiveProofBinding, isEngineVerifiedPositiveProof} from './proof-evidence.js';

export type PlannedCandidate = Candidate & {
  action: 'review-only';
  sameAs?: string;
  evidence: readonly Evidence[];
  decision: PolicyDecision;
};

export type PlanProgressEvent = {
  phase: string;
  state: 'started' | 'progress' | 'completed' | 'failed';
  elapsedMs: number;
  phaseElapsedMs?: number;
  completed?: number;
  total?: number;
};

export type PlanOptions = PolicyConfig & {
  entryFiles?: readonly string[];
  knipExecutable?: string;
  knipTimeoutMs?: number;
  runExternalTools?: boolean;
  discoveryReader?: DirectoryReader;
  onProgress?: (event: PlanProgressEvent) => void;
};

export type PlanReport = {
  schemaVersion: 1;
  root: string;
  discoveryStatus: 'complete' | 'partial';
  discoveryErrors: DiscoveryError[];
  ignoredPaths: string[];
  candidates: PlannedCandidate[];
  manifest: RepositoryManifest;
  graph: ReferenceGraph;
  duplicates: ExactDuplicateGroup[];
  knip: KnipResult;
  dynamicHints: DynamicHint[];
  coverage: CoverageReport;
  packageEntrypoints: PackageEntrypointReport;
  stringReferences: StringReferenceReport;
  closedWorld: {
    analyzer: string;
    analyzerVersion: number;
    complete: boolean;
    roots: string[];
    reachable: string[];
    unreachable: string[];
    blockers: ClosedWorldBlocker[];
  };
  mode: 'read-only';
};

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

function candidateId(kind: string, path: string): string {
  return `${kind}:${path}`;
}

function sourceFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && sourceExtensions.has(path.slice(dot).toLowerCase());
}

function testFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return /(^|\/)(?:__tests__|tests?)(\/|$)/i.test(normalized)
    || /(?:^|\.)(?:test|spec)\.[^/]+$/i.test(normalized);
}

function frameworkEntrypoint(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (/^(?:src\/)?pages\/.+\.[cm]?[jt]sx?$/i.test(normalized)) return true;
  return /^(?:src\/)?app\/.+\/(?:page|layout|route|template|default|loading|error|global-error|not-found|forbidden|unauthorized)\.[cm]?[jt]sx?$/i.test(normalized)
    || /^(?:src\/)?app\/(?:page|layout|route|template|default|loading|error|global-error|not-found|forbidden|unauthorized)\.[cm]?[jt]sx?$/i.test(normalized);
}

function incomingFiles(graph: ReferenceGraph): Set<string> {
  return new Set(graph.edges.map((edge) => edge.to));
}

export function hasMatchingClosedWorldProof(
  candidate: Pick<PlannedCandidate, 'kind' | 'path' | 'evidence'>,
  repositoryHead: string,
  candidateSha256: string,
): boolean {
  if (candidate.kind !== 'closed-world-unreachable' || candidate.evidence.length !== 1) return false;
  const evidence = candidate.evidence[0];
  if (evidence === undefined || !isEngineVerifiedPositiveProof(evidence)) return false;
  const binding = getPositiveProofBinding(evidence);
  return binding?.analyzer === CLOSED_WORLD_ANALYZER
    && binding.analyzerVersion === CLOSED_WORLD_ANALYZER_VERSION
    && binding.candidatePath === candidate.path
    && binding.candidateSha256 === candidateSha256
    && binding.repositoryHead === repositoryHead;
}

function makeCandidate(
  kind: string,
  path: string,
  evidence: readonly Evidence[],
  policy: PolicyConfig,
  extras: {sameAs?: string} = {},
): PlannedCandidate {
  const candidate: Candidate = {
    id: candidateId(kind, path),
    path,
    kind,
    evidence,
    confidence: Math.min(...evidence.map((item) => item.confidence)),
  };
  return {
    ...candidate,
    action: 'review-only',
    ...extras,
    decision: evaluateCandidate(candidate, policy),
  };
}

export async function planRepository(rootDir: string, options: PlanOptions = {}): Promise<PlanReport> {
  const planStartedAt = Date.now();
  const emit = (phase: string, state: PlanProgressEvent['state'], extra: Partial<PlanProgressEvent> = {}): void => {
    options.onProgress?.({phase, state, elapsedMs: Date.now() - planStartedAt, ...extra});
  };
  const measure = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
    const phaseStartedAt = Date.now();
    emit(phase, 'started');
    try {
      const result = await operation();
      emit(phase, 'completed', {phaseElapsedMs: Date.now() - phaseStartedAt});
      return result;
    } catch (error) {
      emit(phase, 'failed', {phaseElapsedMs: Date.now() - phaseStartedAt});
      throw error;
    }
  };

  const repositoryConfig = await measure('repository-config', () => loadRepositoryConfig(rootDir));
  const ignoredPaths = [...new Set([...DEFAULT_IGNORE_PATTERNS, ...repositoryConfig.ignoredPaths])].sort((left, right) => left.localeCompare(right));
  const manifest = await measure('manifest', () => buildManifest(rootDir, {
    ignore: ignoredPaths,
  }, options.discoveryReader, (completed, total) => emit('manifest', 'progress', {completed, total})));
  const sourceTextCache = new Map<string, string>();
  const graph = await measure('reference-graph', () => buildReferenceGraph(manifest.root, manifest, sourceTextCache));
  const discoveryErrors = [...new Map(
    [...(manifest.errors ?? []), ...graph.errors].map((error) => [`${error.path}\0${error.message}`, error]),
  ).values()].sort((left, right) => left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
  const discoveryStatus = discoveryErrors.length === 0 ? 'complete' : 'partial';
  const closedWorldAnalysis = await measure('closed-world-analysis', async () => discoveryStatus === 'partial'
    ? {
      analyzer: CLOSED_WORLD_ANALYZER,
      analyzerVersion: CLOSED_WORLD_ANALYZER_VERSION,
      root: manifest.root,
      complete: false,
      roots: [],
      reachable: [],
      unreachable: [],
      blockers: discoveryErrors.map((error): ClosedWorldBlocker => ({
        code: 'repository-discovery-failed', message: error.message, ...(error.path === '' ? {} : {path: error.path}),
      })),
      proofs: new Map(),
    }
    : options.runExternalTools === false
      ? {
        analyzer: CLOSED_WORLD_ANALYZER,
        analyzerVersion: CLOSED_WORLD_ANALYZER_VERSION,
        root: manifest.root,
        complete: false,
        roots: [],
        reachable: [],
        unreachable: [],
        blockers: [{code: 'external-execution-disabled', message: 'Closed-world analysis was skipped because external execution is disabled.'}],
        proofs: new Map(),
      }
      : await analyzeClosedWorld(rootDir));
  const policy = {
    ...options,
    protectedPaths: [...repositoryConfig.protectedPaths, ...(options.protectedPaths ?? [])],
  };
  const duplicates = await measure('duplicate-analysis', async () => findExactDuplicates(manifest));
  const knip = await measure('knip-analysis', async () => discoveryStatus === 'partial' || options.runExternalTools === false
    ? {status: 'unavailable' as const, issues: [], error: discoveryStatus === 'partial'
      ? 'Knip was skipped because repository discovery was incomplete.'
      : 'Knip was skipped because external execution is disabled.'}
    : await runKnip(manifest.root, {
      ...(options.knipExecutable === undefined ? {} : {executable: options.knipExecutable}),
      ...(options.knipTimeoutMs === undefined ? {} : {timeoutMs: options.knipTimeoutMs}),
    }));
  const dynamicHints = await measure('dynamic-hints', () => discoveryStatus === 'partial'
    ? Promise.resolve([])
    : scanDynamicHints(manifest.root, manifest, sourceTextCache));
  const [coverage, packageEntrypoints] = await measure('metadata-scans', () => Promise.all([
    scanCoverage(manifest.root, manifest.files.map((file) => file.path)),
    scanPackageEntrypoints(manifest.root, manifest.files.map((file) => file.path)),
  ]));
  const phpDuplicateTargets = duplicates.flatMap((group) => group.duplicates)
    .filter((path) => ['.php', '.phtml'].includes(extname(path).toLowerCase()));
  const stringReferences = await measure('string-reference-scan', () => scanStringReferences(
    manifest.root,
    manifest.files.map((file) => file.path),
    phpDuplicateTargets,
    (completed, total) => emit('string-reference-scan', 'progress', {completed, total}),
    sourceTextCache,
  ));
  const incoming = incomingFiles(graph);
  const observedAtRuntime = new Set(coverage.executedFiles);
  const publicFiles = new Set(packageEntrypoints.files);
  const stringReferenced = new Set(stringReferences.references.map((reference) => reference.target));
  const entryFiles = new Set(options.entryFiles ?? manifest.files.filter((file) => /(^|\/)index\.[cm]?[jt]sx?$/.test(file.path)).map((file) => file.path));
  const candidates: PlannedCandidate[] = [];

  for (const file of manifest.files) {
    const positiveProof = closedWorldAnalysis.proofs.get(file.path);
    if (positiveProof !== undefined && sourceFile(file.path) && !testFile(file.path) && !frameworkEntrypoint(file.path)) {
      candidates.push(makeCandidate('closed-world-unreachable', file.path, [positiveProof], policy));
      continue;
    }
    if (stringReferences.unreadableFiles.length > 0 || !sourceFile(file.path) || testFile(file.path) || frameworkEntrypoint(file.path) || entryFiles.has(file.path) || incoming.has(file.path) || observedAtRuntime.has(file.path) || publicFiles.has(file.path) || stringReferenced.has(file.path) || belongsToInvalidPackage(file.path, packageEntrypoints.invalidManifests)) continue;
    candidates.push(makeCandidate('unreferenced-file', file.path, [
      {type: 'no_import_references', confidence: 0.99, details: 'No local static import or export targets this file'},
    ], policy));
  }

  for (const group of duplicates) {
    for (const path of group.duplicates) {
      if (stringReferences.unreadableFiles.length > 0 || testFile(path) || frameworkEntrypoint(path) || observedAtRuntime.has(path)) continue;
      if (publicFiles.has(path) || stringReferenced.has(path) || belongsToInvalidPackage(path, packageEntrypoints.invalidManifests)) continue;
      const evidence: Evidence[] = [
        {type: 'no_import_references', confidence: incoming.has(path) ? 0.2 : 0.99},
        {type: 'no_dynamic_references', confidence: 0.5, details: 'Exact hashing cannot prove runtime usage'},
      ];
      candidates.push(makeCandidate('exact-duplicate', path, evidence, policy, {sameAs: group.canonical}));
    }
  }

  candidates.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return {
    schemaVersion: 1,
    root: manifest.root,
    discoveryStatus,
    discoveryErrors,
    ignoredPaths,
    candidates: discoveryStatus === 'partial' ? [] : candidates,
    manifest,
    graph,
    duplicates,
    knip,
    dynamicHints,
    coverage,
    packageEntrypoints,
    stringReferences,
    closedWorld: {
      analyzer: closedWorldAnalysis.analyzer,
      analyzerVersion: closedWorldAnalysis.analyzerVersion,
      complete: closedWorldAnalysis.complete,
      roots: closedWorldAnalysis.roots,
      reachable: closedWorldAnalysis.reachable,
      unreachable: closedWorldAnalysis.unreachable,
      blockers: closedWorldAnalysis.blockers,
    },
    mode: 'read-only',
  };
}
