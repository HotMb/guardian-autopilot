import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {publishCleanup} from '../scripts/github-cleanup-publisher.mjs';

const exec = promisify(execFile);
const git = (dir, ...args) => exec('git', ['-C', dir, ...args], {windowsHide: true});

async function fixture() {
  const target = await mkdtemp(join(tmpdir(), 'guardian-publish-'));
  await mkdir(join(target, 'src'));
  await writeFile(join(target, 'src/unused.js'), 'export const unused = true;\n');
  await writeFile(join(target, 'checks.json'), '{}');
  await git(target, 'init', '-q');
  await git(target, 'config', 'user.name', 'Fixture');
  await git(target, 'config', 'user.email', 'fixture@example.com');
  await git(target, 'add', '.');
  await git(target, 'commit', '-qm', 'fixture');
  const head = (await git(target, 'rev-parse', 'HEAD')).stdout.trim();
  return {target, head, candidate: 'src/unused.js', checks: 'checks.json', repository: 'HotMb/demo', branch: 'main', actor: 'HotMb', runId: '123', runAttempt: '1', token: 'test-token'};
}

function github(head, {staleAt = 0, forbidPull = false} = {}) {
  const requests = [];
  let refReads = 0;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body && JSON.parse(options.body);
    requests.push({path, method: options.method, body});
    let result;
    let status = 200;
    if (path.endsWith('/git/ref/heads/main')) result = {object: {sha: ++refReads === staleAt ? 'f'.repeat(40) : head}};
    else if (path.endsWith(`/git/commits/${head}`)) result = {sha: head, tree: {sha: 'a'.repeat(40)}};
    else if (path === '/users/HotMb') result = {login: 'HotMb', type: 'User', id: 1234};
    else if (path.endsWith('/git/trees')) result = {sha: 'b'.repeat(40)};
    else if (path.endsWith('/git/commits')) result = {sha: 'c'.repeat(40)};
    else if (path.endsWith('/git/refs')) result = {ref: body.ref};
    else if (path.endsWith('/pulls')) { status = forbidPull ? 403 : 201; result = {html_url: 'https://github.com/HotMb/demo/pull/42'}; }
    else throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(result), {status, headers: {'content-type': 'application/json'}});
  };
  return {fetch, requests};
}

test('publishes one deletion as a draft for review without changing the checkout', async () => {
  const input = await fixture();
  const api = github(input.head);
  const result = await publishCleanup({...input, fetch: api.fetch});
  assert.equal(result.url, 'https://github.com/HotMb/demo/pull/42');
  assert.equal(result.branch, 'guardian/cleanup-123-1');
  const tree = api.requests.find((x) => x.path.endsWith('/git/trees')).body;
  assert.deepEqual(tree.tree, [{path: input.candidate, mode: '100644', type: 'blob', sha: null}]);
  const commit = api.requests.find((x) => x.method === 'POST' && x.path.endsWith('/git/commits')).body;
  assert.deepEqual(commit.parents, [input.head]);
  assert.equal(commit.author.email, '1234+HotMb@users.noreply.github.com');
  assert.doesNotMatch(commit.message, /codex|co-authored/i);
  const pull = api.requests.find((x) => x.path.endsWith('/pulls')).body;
  assert.equal(pull.draft, true);
  assert.equal(pull.base, 'main');
  assert.match(pull.body, /external/i);
  assert.equal(await readFile(join(input.target, input.candidate), 'utf8'), 'export const unused = true;\n');
  assert.equal((await git(input.target, 'status', '--porcelain')).stdout.trim(), '');
});

test('refuses protected, unsafe, dirty and stale targets before writing to GitHub', async () => {
  const input = await fixture();
  for (const candidate of ['../secret', '.github/workflows/test.yml', 'checks.json', 'src/*']) {
    const api = github(input.head);
    await assert.rejects(publishCleanup({...input, candidate, fetch: api.fetch}));
    assert.equal(api.requests.filter((x) => x.method === 'POST').length, 0);
  }
  const stale = github(input.head, {staleAt: 1});
  await assert.rejects(publishCleanup({...input, fetch: stale.fetch}), /changed/i);
  assert.equal(stale.requests.filter((x) => x.method === 'POST').length, 0);
  await writeFile(join(input.target, input.candidate), 'modified');
  const dirty = github(input.head);
  await assert.rejects(publishCleanup({...input, fetch: dirty.fetch}), /clean/i);
  assert.equal(dirty.requests.length, 0);
});

test('does not open a pull request when the base changes during publication', async () => {
  const input = await fixture();
  const api = github(input.head, {staleAt: 2});
  await assert.rejects(publishCleanup({...input, fetch: api.fetch}), /changed/i);
  assert.equal(api.requests.some((x) => x.path.endsWith('/pulls')), false);
});

test('honors paths protected by repository configuration', async () => {
  const input = await fixture();
  await mkdir(join(input.target, '.guardian'));
  await writeFile(join(input.target, '.guardian/config.json'), JSON.stringify({version: 1, protectedPaths: ['src']}));
  await git(input.target, 'add', '.guardian/config.json');
  await git(input.target, 'commit', '-qm', 'Protect sources');
  input.head = (await git(input.target, 'rev-parse', 'HEAD')).stdout.trim();
  const api = github(input.head);
  await assert.rejects(publishCleanup({...input, fetch: api.fetch}), /protect/i);
  assert.equal(api.requests.length, 0);
});

test('rejects a base change after creating the review branch and does not open a pull request', async () => {
  const input = await fixture();
  const api = github(input.head, {staleAt: 3});
  await assert.rejects(publishCleanup({...input, fetch: api.fetch}), /guardian\/cleanup-123-1/);
  assert.equal(api.requests.some((x) => x.path.endsWith('/pulls')), false);
});

test('reports a denied pull request without exposing credentials', async () => {
  const input = await fixture();
  const api = github(input.head, {forbidPull: true});
  await assert.rejects(publishCleanup({...input, fetch: api.fetch}), (error) => {
    assert.match(error.message, /guardian\/cleanup-123-1/);
    assert.doesNotMatch(error.message, /test-token/);
    return true;
  });
});
