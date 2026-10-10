import assert from 'node:assert/strict';
import test from 'node:test';
import {GitHubInstallationClient} from '../dist/github-installation.js';

test('installation access is scoped to one repository and read permissions', async () => {
  const calls = [];
  const client = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'test-jwt', fetch: async (url, options) => {
    calls.push({url, options});
    return Response.json(calls.length === 1 ? {token: 'test-token', permissions: {contents: 'read', metadata: 'read', checks: 'read', pull_requests: 'read'}, repositories: [{id: 17}]} : {id: 17, full_name: 'HotMb/guardian-autopilot', default_branch: 'main', private: false});
  }});
  assert.deepEqual(await client.getRepository('HotMb', 'guardian-autopilot'), {id: 17, fullName: 'HotMb/guardian-autopilot', defaultBranch: 'main', private: false});
  assert.deepEqual(JSON.parse(calls[0].options.body), {repository_ids: [17], permissions: {contents: 'read', metadata: 'read', pull_requests: 'read', checks: 'read'}});
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
});

test('installation client rejects elevated token permissions and hides remote errors', async () => {
  const elevated = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async () => Response.json({token: 'secret-token', permissions: {contents: 'write'}, repositories: [{id: 17}]})});
  await assert.rejects(elevated.getRepository('HotMb', 'guardian-autopilot'), /read-only/);
  const denied = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async () => new Response('secret-token', {status: 403})});
  await assert.rejects(denied.getRepository('HotMb', 'guardian-autopilot'), /^Error: GitHub request failed \(403\)$/);
});

test('installation client rejects repository mismatches and unsafe names', async () => {
  let requests = 0;
  const client = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async () => {
    requests++;
    return Response.json(requests === 1 ? {token: 'token', permissions: {contents: 'read', metadata: 'read'}, repositories: [{id: 17}]} : {id: 18, full_name: 'HotMb/other', default_branch: 'main', private: true});
  }});
  await assert.rejects(client.getRepository('../escape', 'repo'), /name/);
  assert.equal(requests, 0);
  await assert.rejects(client.getRepository('HotMb', 'other'), /repository/);
  assert.throws(() => new GitHubInstallationClient({installationId: 0, repositoryId: 17, createJwt: () => 'jwt'}), /positive/);
});
