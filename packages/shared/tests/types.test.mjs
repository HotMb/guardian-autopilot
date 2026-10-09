import test from 'node:test';
import assert from 'node:assert/strict';
import {EXECUTION_STATES, STATE_TRANSITIONS, isValidStateTransition} from '../dist/types.js';

test('exports the complete guarded execution state machine', () => {
  assert.deepEqual(EXECUTION_STATES, [
    'DISCOVERED',
    'ANALYZED',
    'PLANNED',
    'ISOLATED',
    'APPLIED',
    'VERIFIED',
    'COMMITTED',
    'REVERTED',
    'SKIPPED',
  ]);
  assert.deepEqual(STATE_TRANSITIONS.DISCOVERED, ['ANALYZED', 'SKIPPED']);
  assert.deepEqual(STATE_TRANSITIONS.VERIFIED, ['COMMITTED', 'REVERTED']);
  assert.deepEqual(STATE_TRANSITIONS.COMMITTED, []);
});

test('accepts only explicitly declared state transitions', () => {
  assert.equal(isValidStateTransition('DISCOVERED', 'ANALYZED'), true);
  assert.equal(isValidStateTransition('APPLIED', 'REVERTED'), true);
  assert.equal(isValidStateTransition('DISCOVERED', 'COMMITTED'), false);
  assert.equal(isValidStateTransition('COMMITTED', 'REVERTED'), false);
});

