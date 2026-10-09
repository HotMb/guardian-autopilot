import type {Evidence} from '@cleancode/shared/types';

export function calculateConfidence(evidence: readonly Evidence[]): number {
  if (evidence.length === 0) return 0.5;
  const minimum = Math.min(...evidence.map((item) => item.confidence));
  const hasPositiveProof = evidence.some((item) => item.type === 'positive_proof');
  return hasPositiveProof ? minimum : Math.min(minimum, 0.5);
}
