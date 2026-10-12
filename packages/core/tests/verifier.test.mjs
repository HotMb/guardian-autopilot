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

test('runs the npm executable on Windows without invoking a command shell', async () => {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await runVerification(process.cwd(), {
    build: {command, args: ['--version']},
    requireAll: false,
  });

  assert.equal(result.build, true, result.details.build);
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

test('runs explicitly approved preparation commands before build, typecheck and tests', async () => {
  const calls = [];
  const result = await runVerification('C:/worktree', {
    prepare: [{command: 'npm', args: ['ci'], timeoutMs: 30000}],
    build: {command: 'npm', args: ['run', 'build']},
    typecheck: {command: 'npm', args: ['run', 'typecheck']},
    test: {command: 'npm', args: ['test']},
  }, {
    allowPreparation: true,
    runner: async (command, cwd) => {
      calls.push({command, cwd});
      return {stdout: '', stderr: ''};
    },
  });

  assert.equal(result.allPassed, true);
  assert.deepEqual(calls.map(({command}) => command.args?.[0]), ['ci', 'run', 'run', 'test']);
  assert.deepEqual(calls.map(({cwd}) => cwd), Array(4).fill('C:/worktree'));
  assert.equal(calls[0].command.timeoutMs, 30000);
});

test('never runs preparation without explicit approval and skips dependent checks', async () => {
  const calls = [];
  const result = await runVerification('C:/worktree', {
    prepare: [{command: 'npm', args: ['ci']}],
    build: {command: 'npm', args: ['run', 'build']},
    typecheck: {command: 'npm', args: ['run', 'typecheck']},
    test: {command: 'npm', args: ['test']},
  }, {runner: async (command) => {
    calls.push(command);
    return {stdout: '', stderr: ''};
  }});

  assert.equal(calls.length, 0);
  assert.equal(result.allPassed, false);
  assert.match(result.details.preparation, /explicit.*approval/i);
  assert.match(result.details.build, /skipped/i);
});

test('stops before verification when an approved preparation command fails', async () => {
  const calls = [];
  const result = await runVerification('C:/worktree', {
    prepare: [
      {command: 'npm', args: ['ci']},
      {command: 'node', args: ['setup-check.js']},
    ],
    build: {command: 'npm', args: ['run', 'build']},
    typecheck: {command: 'npm', args: ['run', 'typecheck']},
    test: {command: 'npm', args: ['test']},
  }, {
    allowPreparation: true,
    runner: async (command) => {
      calls.push(command.args?.[0]);
      if (command.args?.[0] === 'ci') throw new Error('install failed');
      return {stdout: '', stderr: ''};
    },
  });

  assert.deepEqual(calls, ['ci']);
  assert.equal(result.allPassed, false);
  assert.match(result.details.preparation, /install failed/i);
  assert.match(result.details.tests, /skipped/i);
});

test('bounds preparation command count and per-command timeout', async () => {
  const tooMany = await runVerification('C:/worktree', {
    prepare: Array.from({length: 4}, () => ({command: 'node', args: ['setup.js']})),
  }, {allowPreparation: true, runner: async () => ({stdout: '', stderr: ''})});
  const tooLong = await runVerification('C:/worktree', {
    prepare: [{command: 'node', args: ['setup.js'], timeoutMs: 600001}],
  }, {allowPreparation: true, runner: async () => ({stdout: '', stderr: ''})});

  assert.equal(tooMany.allPassed, false);
  assert.match(tooMany.details.preparation, /maximum of 3/i);
  assert.equal(tooLong.allPassed, false);
  assert.match(tooLong.details.preparation, /timeout/i);
});

test('enforces preparation command timeout in the real process runner', async () => {
  const result = await runVerification(process.cwd(), {
    prepare: [{command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 1000}],
  }, {allowPreparation: true});

  assert.equal(result.allPassed, false);
  assert.match(result.details.preparation, /failed/i);
  assert.match(result.details.build, /skipped/i);
});

