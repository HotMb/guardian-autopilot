import type {Evidence} from '@cleancode/shared/types';

const engineVerifiedProofs = new WeakSet<Evidence>();
const positiveProofBindings = new WeakMap<Evidence, PositiveProofBinding>();

export type PositiveProofBinding = Readonly<{
  analyzer: string;
  analyzerVersion: number;
  candidatePath: string;
  candidateSha256: string;
  repositoryHead: string;
  configSha256: string;
  manifestSha256: string;
  roots: readonly string[];
  bindingDigest: string;
}>;

/** Internal evidence constructor for verified engine analyzers; intentionally not exported from the package root. */
export function createVerifiedPositiveProofEvidence(details: string, confidence: number, binding?: PositiveProofBinding): Evidence {
  if (details.trim() === '' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError('Verified proof evidence requires details and confidence between zero and one');
  }
  const evidence: Evidence = {type: 'positive_proof', confidence, details};
  engineVerifiedProofs.add(evidence);
  if (binding !== undefined) positiveProofBindings.set(evidence, Object.freeze({...binding, roots: Object.freeze([...binding.roots])}));
  return evidence;
}

export function isEngineVerifiedPositiveProof(evidence: Evidence): boolean {
  return evidence.type === 'positive_proof' && engineVerifiedProofs.has(evidence);
}

export function getPositiveProofBinding(evidence: Evidence): PositiveProofBinding | undefined {
  return positiveProofBindings.get(evidence);
}
