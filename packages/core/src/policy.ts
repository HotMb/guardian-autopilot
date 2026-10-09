import type {Candidate} from '@cleancode/shared/types';
import {calculateConfidence} from './confidence.js';
import {canDelete, isProtectedPath} from './safeguards.js';

export type PolicyConfig = {
  minConfidence?: number;
};

export type PolicyDecision = {
  allowed: boolean;
  reasons: string[];
  confidence: number;
};

export function evaluateCandidate(candidate: Candidate, config: PolicyConfig = {}): PolicyDecision {
  const minConfidence = config.minConfidence ?? 0.95;
  const calculatedConfidence = Math.min(candidate.confidence, calculateConfidence(candidate.evidence));
  const reasons: string[] = [];
  if (isProtectedPath(candidate.path)) reasons.push('Candidate path is protected');
  if (calculatedConfidence < minConfidence) reasons.push(`Candidate confidence ${calculatedConfidence} is below ${minConfidence}`);
  if (!canDelete(candidate, minConfidence)) reasons.push('Candidate lacks positive proof at the required confidence');
  return {allowed: reasons.length === 0, reasons, confidence: calculatedConfidence};
}
