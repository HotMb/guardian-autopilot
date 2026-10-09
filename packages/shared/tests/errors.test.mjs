import test from 'node:test';
import assert from 'node:assert/strict';
import {CleanCodeError, EXIT_CODES, isCleanCodeError} from '../dist/errors.js';

test('errors expose stable codes and CLI exit codes', () => {
  const error = new CleanCodeError('POLICY_VIOLATION', 'Candidate is protected', {path: 'src/secrets.ts'});

  assert.equal(error.name, 'CleanCodeError');
  assert.equal(error.code, 'POLICY_VIOLATION');
  assert.equal(error.exitCode, EXIT_CODES.POLICY_VIOLATION);
  assert.deepEqual(error.details, {path: 'src/secrets.ts'});
  assert.equal(isCleanCodeError(error), true);
});

test('maps every documented failure mode to a non-zero exit code', () => {
  assert.deepEqual(EXIT_CODES, {
    SUCCESS: 0,
    GENERAL_ERROR: 1,
    INVALID_LICENSE: 2,
    POLICY_VIOLATION: 3,
    WORKTREE_ERROR: 4,
    VERIFICATION_FAILED: 5,
    ROLLBACK_EXECUTED: 6,
  });
  assert.equal(isCleanCodeError(new Error('ordinary error')), false);
});

