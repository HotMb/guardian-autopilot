import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionStateMachine} from '../dist/state-machine.js';

test('walks through the guarded lifecycle and records history', () => {
  const machine = new ExecutionStateMachine();

  assert.equal(machine.current, 'DISCOVERED');
  machine.transitionTo('ANALYZED');
  machine.transitionTo('PLANNED');
  machine.transitionTo('ISOLATED');
  machine.transitionTo('APPLIED');
  machine.transitionTo('VERIFIED');
  machine.transitionTo('COMMITTED');

  assert.equal(machine.current, 'COMMITTED');
  assert.deepEqual(machine.history, [
    'DISCOVERED',
    'ANALYZED',
    'PLANNED',
    'ISOLATED',
    'APPLIED',
    'VERIFIED',
    'COMMITTED',
  ]);
});

test('rejects invalid transitions without changing state', () => {
  const machine = new ExecutionStateMachine();

  assert.throws(
    () => machine.transitionTo('COMMITTED'),
    (error) => error.code === 'POLICY_VIOLATION' && error.details.from === 'DISCOVERED' && error.details.to === 'COMMITTED',
  );
  assert.equal(machine.current, 'DISCOVERED');
  assert.deepEqual(machine.history, ['DISCOVERED']);
});

test('allows safe terminal transitions and prevents leaving terminal states', () => {
  const machine = new ExecutionStateMachine('PLANNED');

  machine.transitionTo('SKIPPED');
  assert.equal(machine.current, 'SKIPPED');
  assert.throws(() => machine.transitionTo('ISOLATED'), /Invalid state transition/);
});

