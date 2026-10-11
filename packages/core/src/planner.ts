import {relative} from 'node:path';
import type {Candidate, Evidence} from '@cleancode/shared/types';
import {buildManifest, type RepositoryManifest} from './manifest.js';
import {buildReferenceGraph, type ReferenceGraph} from './reference-graph.js';
import {findExactDuplicates, type ExactDuplicateGroup} from './duplicates.js';
import {evaluateCandidate, type PolicyConfig, type PolicyDecision} from './policy.js';
import {runKnip, type KnipResult} from './knip.js';
import {scanDynamicHints, type DynamicHint} from './dynamic-hints.js';
import {scanCoverage, type CoverageReport} from './coverage.js';
import {belongsToInvalidPackage, scanPackageEntrypoints, type PackageEntrypointReport} from './package-exports.js';
import {scanStringReferences, type StringReferenceReport} from './string-references.js';

export type PlannedCandidate = Candidate & {
  action: 'review-only';
  sameAs?: string;
  evidence: readonly Evidence[];
  decision: PolicyDecision;
};

export type PlanOptions = PolicyConfig & {
  entryFiles?: readonly string[];
  knipExecutable?: string;
};

export type PlanReport = {
  schemaVersion: 1;
  root: string;
  candidates: PlannedCandidate[];
  manifest: RepositoryManifest;
  graph: ReferenceGraph;
  duplicates: ExactDuplicateGroup[];
  knip: KnipResult;
  dynamicHints: DynamicHint[];
  coverage: CoverageReport;
  packageEntrypoints: PackageEntrypointReport;
  stringReferences: StringReferenceReport;
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

function incomingFiles(graph: ReferenceGraph): Set<string> {
  return new Set(graph.edges.map((edge) => edge.to));
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
  const manifest = await buildManifest(rootDir);
  const graph = await buildReferenceGraph(manifest.root);
  const duplicates = findExactDuplicates(manifest);
  const knip = await runKnip(manifest.root, options.knipExecutable === undefined ? {} : {executable: options.knipExecutable});
  const dynamicHints = await scanDynamicHints(manifest.root);
  const coverage = await scanCoverage(manifest.root, manifest.files.map((file) => file.path));
  const packageEntrypoints = await scanPackageEntrypoints(manifest.root, manifest.files.map((file) => file.path));
  const stringReferences = await scanStringReferences(manifest.root, manifest.files.map((file) => file.path));
  const incoming = incomingFiles(graph);
  const observedAtRuntime = new Set(coverage.executedFiles);
  const publicFiles = new Set(packageEntrypoints.files);
  const stringReferenced = new Set(stringReferences.references.map((reference) => reference.target));
  const entryFiles = new Set(options.entryFiles ?? manifest.files.filter((file) => /(^|\/)index\.[cm]?[jt]sx?$/.test(file.path)).map((file) => file.path));
  const candidates: PlannedCandidate[] = [];

  for (const file of manifest.files) {
    if (stringReferences.unreadableFiles.length > 0 || !sourceFile(file.path) || entryFiles.has(file.path) || incoming.has(file.path) || observedAtRuntime.has(file.path) || publicFiles.has(file.path) || stringReferenced.has(file.path) || belongsToInvalidPackage(file.path, packageEntrypoints.invalidManifests)) continue;
    candidates.push(makeCandidate('unreferenced-file', file.path, [
      {type: 'no_import_references', confidence: 0.99, details: 'No local static import or export targets this file'},
    ], options));
  }

  for (const group of duplicates) {
    for (const path of group.duplicates) {
      if (stringReferences.unreadableFiles.length > 0 || observedAtRuntime.has(path)) continue;
      if (publicFiles.has(path) || stringReferenced.has(path) || belongsToInvalidPackage(path, packageEntrypoints.invalidManifests)) continue;
      const evidence: Evidence[] = [
        {type: 'no_import_references', confidence: incoming.has(path) ? 0.2 : 0.99},
        {type: 'no_dynamic_references', confidence: 0.5, details: 'Exact hashing cannot prove runtime usage'},
      ];
      candidates.push(makeCandidate('exact-duplicate', path, evidence, options, {sameAs: group.canonical}));
    }
  }

  candidates.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return {schemaVersion: 1, root: manifest.root, candidates, manifest, graph, duplicates, knip, dynamicHints, coverage, packageEntrypoints, stringReferences, mode: 'read-only'};
}
