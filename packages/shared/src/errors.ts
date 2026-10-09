export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  INVALID_LICENSE: 2,
  POLICY_VIOLATION: 3,
  WORKTREE_ERROR: 4,
  VERIFICATION_FAILED: 5,
  ROLLBACK_EXECUTED: 6,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
export type CleanCodeErrorCode = Exclude<keyof typeof EXIT_CODES, 'SUCCESS'>;

export class CleanCodeError extends Error {
  readonly code: CleanCodeErrorCode;
  readonly exitCode: Exclude<ExitCode, 0>;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: CleanCodeErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'CleanCodeError';
    this.code = code;
    this.exitCode = EXIT_CODES[code] as Exclude<ExitCode, 0>;
    this.details = details;
  }
}

export function isCleanCodeError(error: unknown): error is CleanCodeError {
  return error instanceof CleanCodeError;
}
