import {findAssetReferences, AssetReference, ReferenceError} from './references.js';
import {scan, ScanError} from './scanner.js';
import {KnipResult, runKnip} from './knip.js';

export type CandidateConfidence = 'high' | 'medium' | 'low';
export type CleanupCandidate = {
  kind: 'exact-duplicate';
  file: string;
  sameAs: string;
  bytes: number;
  confidence: CandidateConfidence;
  action: 'review-only';
  evidence: {
    exactDuplicate: true;
    fileReferences: AssetReference[];
    canonicalReferences: AssetReference[];
    reasons: string[];
  };
};
export type CandidateReport = {
  schemaVersion: 1;
  root: string;
  candidates: CleanupCandidate[];
  scanErrors: ScanError[];
  referenceErrors: ReferenceError[];
  knip: KnipResult;
  mode: 'read-only';
};

function referencesByTarget(references: AssetReference[]): Map<string, AssetReference[]> {
  const result = new Map<string, AssetReference[]>();
  for (const reference of references) {
    const existing = result.get(reference.target) ?? [];
    existing.push(reference);
    result.set(reference.target, existing);
  }
  return result;
}

function confidenceFor(fileReferences: AssetReference[], canonicalReferences: AssetReference[], hasReferenceErrors: boolean): CandidateConfidence {
  if (fileReferences.length > 0) return 'low';
  if (hasReferenceErrors) return 'medium';
  if (canonicalReferences.length > 0) return 'high';
  return 'medium';
}

function reasonsFor(fileReferences: AssetReference[], canonicalReferences: AssetReference[], hasReferenceErrors: boolean): string[] {
  const reasons = ['Files have identical size and SHA-256 content'];
  if (fileReferences.length === 0) reasons.push('No supported static reference points to the duplicate file');
  else reasons.push('The duplicate file is still referenced by supported static code');
  if (canonicalReferences.length > 0) reasons.push('The canonical file is referenced by supported static code');
  else reasons.push('No supported static reference points to the canonical file');
  if (hasReferenceErrors) reasons.push('Reference analysis reported unreadable or oversized source files');
  reasons.push('Static analysis cannot prove that dynamic runtime paths are unused');
  return reasons;
}

export async function planCandidates(rootDir: string): Promise<CandidateReport> {
  const scanReport = await scan(rootDir);
  const referenceReport = await findAssetReferences(rootDir);
  const knip = await runKnip(rootDir);
  const byTarget = referencesByTarget(referenceReport.references);
  const hasReferenceErrors = referenceReport.errors.length > 0;

  const candidates = scanReport.findings.map((finding) => {
    const fileReferences = byTarget.get(finding.file) ?? [];
    const canonicalReferences = byTarget.get(finding.sameAs) ?? [];
    return {
      kind: 'exact-duplicate' as const,
      file: finding.file,
      sameAs: finding.sameAs,
      bytes: finding.bytes,
      confidence: confidenceFor(fileReferences, canonicalReferences, hasReferenceErrors),
      action: 'review-only' as const,
      evidence: {
        exactDuplicate: true as const,
        fileReferences,
        canonicalReferences,
        reasons: reasonsFor(fileReferences, canonicalReferences, hasReferenceErrors),
      },
    };
  });

  return {
    schemaVersion: 1,
    root: scanReport.root,
    candidates,
    scanErrors: scanReport.errors,
    referenceErrors: referenceReport.errors,
    knip,
    mode: 'read-only',
  };
}
