import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {cloneGitHubRepository} from '../dist/github.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('GitHub clone uses gh with argument-safe repo and explicit destination', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cleancode-github-'));
  const destination = join(parent, 'private-project');
  const calls = [];
  await cloneGitHubRepository('owner/private-project', destination, async (...args) => { calls.push(args); });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.platform === 'win32' ? 'gh.exe' : 'gh');
  assert.deepEqual(calls[0][1], ['repo', 'clone', 'owner/private-project', resolve(destination)]);
  assert.equal(calls[0][2].shell, false);
});

test('GitHub clone rejects invalid repository slugs before launching gh', async () => {
  let called = false;
  await assert.rejects(
    () => cloneGitHubRepository('../owner/repo', 'target', async () => { called = true; }),
    /owner\/repository/,
  );
  assert.equal(called, false);
});

test('GitHub clone refuses to use an existing destination', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cleancode-github-'));
  const destination = join(parent, 'existing');
  await mkdir(destination);
  let called = false;
  await assert.rejects(
    () => cloneGitHubRepository('owner/repo', destination, async () => { called = true; }),
    /already exists/,
  );
  assert.equal(called, false);
});

test('GitHub clone reports authentication setup without leaking command output', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cleancode-github-'));
  await assert.rejects(
    () => cloneGitHubRepository('owner/repo', join(parent, 'target'), async () => { throw new Error('private token detail'); }),
    (error) => {
      assert.match(error.message, /GitHub CLI.*gh auth login/);
      assert.doesNotMatch(error.message, /private token detail/);
      return true;
    },
  );
});

test('GitHub analyze requires an explicit destination before starting', async () => {
  await assert.rejects(
    () => exec(process.execPath, [cli, 'github', 'analyze', 'owner/repo']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /explicit --destination path is required/);
      return true;
    },
  );
});
