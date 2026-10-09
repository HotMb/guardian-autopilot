/**
 * States used by the guarded cleanup lifecycle.
 *
 * A candidate can only move forward through this lifecycle, or move to a
 * terminal safety state. Keeping the states in shared makes every adapter
 * (CLI, core, MCP and future backend) speak the same vocabulary.
 */
export const EXECUTION_STATES = [
  'DISCOVERED',
  'ANALYZED',
  'PLANNED',
  'ISOLATED',
  'APPLIED',
  'VERIFIED',
  'COMMITTED',
  'REVERTED',
  'SKIPPED',
] as const;

export type State = (typeof EXECUTION_STATES)[number];

/** Explicitly permitted transitions from the CleanCode specification. */
export const STATE_TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  DISCOVERED: ['ANALYZED', 'SKIPPED'],
  ANALYZED: ['PLANNED', 'SKIPPED'],
  PLANNED: ['ISOLATED', 'SKIPPED'],
  ISOLATED: ['APPLIED', 'REVERTED'],
  APPLIED: ['VERIFIED', 'REVERTED'],
  VERIFIED: ['COMMITTED', 'REVERTED'],
  COMMITTED: [],
  REVERTED: [],
  SKIPPED: [],
};

export function isValidStateTransition(from: State, to: State): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export type EvidenceType =
  | 'no_import_references'
  | 'no_dynamic_references'
  | 'not_in_public_api'
  | 'not_in_package_json_exports'
  | 'no_string_reference_in_repo'
  | 'positive_proof';

export interface Evidence {
  type: EvidenceType;
  confidence: number;
  details?: string;
}

/** The shared, source-agnostic representation passed from analysis to policy. */
export interface Candidate {
  id: string;
  path: string;
  kind: string;
  evidence: readonly Evidence[];
  confidence: number;
}

export interface VerificationResult {
  build: boolean;
  typecheck: boolean;
  tests: boolean;
  acceptance: boolean;
  allPassed: boolean;
  details: Readonly<Record<string, string>>;
}
