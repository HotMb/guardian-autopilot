import type {Evidence} from '@cleancode/shared/types';

const engineVerifiedProofs = new WeakSet<Evidence>();

/** Internal evidence constructor for verified engine analyzers; intentionally not exported from the package root. */
export function createVerifiedPositiveProofEvidence(details: string, confidence: number): Evidence {
  if (details.trim() === '' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError('Verified proof evidence requires details and confidence between zero and one');
  }
  const evidence: Evidence = {type: 'positive_proof', confidence, details};
  engineVerifiedProofs.add(evidence);
  return evidence;
}

export function isEngineVerifiedPositiveProof(evidence: Evidence): boolean {
  return evidence.type === 'positive_proof' && engineVerifiedProofs.has(evidence);
}
