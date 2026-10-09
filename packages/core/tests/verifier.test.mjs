import test from 'node:test';
import assert from 'node:assert/strict';
import {runVerification} from '../dist/verifier.js';

test('runs build, typecheck and tests without a shell and reports every result', async () => {
  const calls = [];
  const result = await runVerification('C:/worktree', {
    build: {command: 'pnpm', args: ['build']},
    typecheck: {command: 'pnpm', args: ['typecheck']},
    test: {command: 'pnpm', args: ['test']},
  }, {
    runner: async (command, cwd) => {
      calls.push({command, cwd});
      if (command.args?.[0] === 'typecheck') throw new Error('typecheck failed');
      return {stdout: 'ok', stderr: ''};
    },
  });

  assert.equal(result.build, true);
  assert.equal(result.typecheck, false);
  assert.equal(result.tests, true);
  assert.equal(result.acceptance, true);
  assert.equal(result.allPassed, false);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {command: {command: 'pnpm', args: ['build']}, cwd: 'C:/worktree'});
  assert.match(result.details.typecheck, /typecheck failed/);
});

test('fails closed when required verification commands are not configured', async () => {
  const result = await runVerification('C:/worktree', {requireAll: true}, {
    runner: async () => ({stdout: '', stderr: ''}),
  });

  assert.equal(result.build, false);
  assert.equal(result.typecheck, false);
  assert.equal(result.tests, false);
  assert.equal(result.allPassed, false);
  assert.match(result.details.build, /not configured/i);
});

test('supports an explicit acceptance check after technical checks', async () => {
  const result = await runVerification('C:/worktree', {
    build: {command: 'node', args: ['build']},
    typecheck: {command: 'node', args: ['typecheck']},
    test: {command: 'node', args: ['test']},
  }, {
    runner: async () => ({stdout: '', stderr: ''}),
    acceptanceCheck: async () => ({passed: false, details: 'diff modifies a protected config'}),
  });

  assert.equal(result.build, true);
  assert.equal(result.typecheck, true);
  assert.equal(result.tests, true);
  assert.equal(result.acceptance, false);
  assert.equal(result.allPassed, false);
  assert.equal(result.details.acceptance, 'diff modifies a protected config');
});

