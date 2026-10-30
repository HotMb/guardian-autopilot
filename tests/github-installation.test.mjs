import assert from 'node:assert/strict';
import test from 'node:test';
import {GitHubInstallationClient} from '../dist/github-installation.js';

test('installation access is scoped to one repository and minimal audit permissions', async () => {
  const calls = [];
  const client = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'test-jwt', fetch: async (url, options) => {
    calls.push({url, options});
    return Response.json(calls.length === 1 ? {token: 'test-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {contents: 'read', metadata: 'read', checks: 'write'}, repositories: [{id: 17}]} : {id: 17, full_name: 'HotMb/guardian-autopilot', default_branch: 'main', private: false});
  }});
  assert.deepEqual(await client.getRepository('HotMb', 'guardian-autopilot'), {id: 17, fullName: 'HotMb/guardian-autopilot', defaultBranch: 'main', private: false});
  assert.deepEqual(JSON.parse(calls[0].options.body), {repository_ids: [17], permissions: {contents: 'read', metadata: 'read', checks: 'write'}});
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
});

test('installation client rejects elevated token permissions and hides remote errors', async () => {
  const elevated = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async () => Response.json({token: 'secret-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {contents: 'write', metadata: 'read', checks: 'write'}, repositories: [{id: 17}]})});
  await assert.rejects(elevated.getRepository('HotMb', 'guardian-autopilot'), /read access to contents/i);
  const denied = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async () => new Response('secret-token', {status: 403})});
  await assert.rejects(denied.getRepository('HotMb', 'guardian-autopilot'), /^Error: GitHub request failed \(403\)$/);
});

test('installation client rejects repository mismatches and unsafe names', async () => {
  let requests = 0;
  const client = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async () => {
    requests++;
    return Response.json(requests === 1 ? {token: 'token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {contents: 'read', metadata: 'read', checks: 'write'}, repositories: [{id: 17}]} : {id: 18, full_name: 'HotMb/other', default_branch: 'main', private: true});
  }});
  await assert.rejects(client.getRepository('../escape', 'repo'), /name/);
  assert.equal(requests, 0);
  await assert.rejects(client.getRepository('HotMb', 'other'), /repository/);
  assert.throws(() => new GitHubInstallationClient({installationId: 0, repositoryId: 17, createJwt: () => 'jwt'}), /positive/);
});

test('installation client starts and completes a check run using only the configured repository grant', async () => {
  const calls = [];
  const client = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async (url, options) => {
    calls.push({url, options});
    if (calls.length === 1) return Response.json({token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {contents: 'read', metadata: 'read', checks: 'write'}, repositories: [{id: 17}]});
    if (calls.length === 2) return Response.json({check_runs: []});
    if (calls.length === 3) return Response.json({id: 991});
    return Response.json({id: 991, status: 'completed'});
  }});
  const checkRunId = await client.createCheckRun('HotMb', 'guardian-autopilot', 'a'.repeat(40), 'delivery-123');
  assert.equal(checkRunId, 991);
  await client.completeCheckRun('HotMb', 'guardian-autopilot', checkRunId, {conclusion: 'neutral', title: 'CleanCode report ready', summary: 'One report'});
  assert.equal(calls[0].options.headers.Authorization, 'Bearer jwt');
  assert.equal(JSON.parse(calls[0].options.body).permissions.checks, 'write');
  assert.equal(calls[1].options.method, 'GET');
  assert.match(calls[1].url, /check_name=CleanCode%20audit/);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(JSON.parse(calls[2].options.body).head_sha, 'a'.repeat(40));
  assert.equal(JSON.parse(calls[2].options.body).external_id, 'delivery-123');
  assert.equal(calls[3].options.method, 'PATCH');
  assert.equal(JSON.parse(calls[3].options.body).conclusion, 'neutral');
  assert.equal(JSON.parse(calls[3].options.body).output.summary, 'One report');
});

test('installation client reuses a Check Run after a retry with the same GitHub delivery id', async () => {
  const calls = [];
  const client = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async (url, options) => {
    calls.push({url, options});
    if (calls.length === 1) return Response.json({token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {contents: 'read', metadata: 'read', checks: 'write'}, repositories: [{id: 17}]});
    if (calls.length === 2) return Response.json({check_runs: []});
    if (calls.length === 3) return Response.json({id: 992});
    return Response.json({check_runs: [{id: 992, name: 'CleanCode audit', head_sha: 'b'.repeat(40), external_id: 'delivery-retry'}]});
  }});
  assert.equal(await client.createCheckRun('HotMb', 'guardian-autopilot', 'b'.repeat(40), 'delivery-retry'), 992);
  assert.equal(await client.createCheckRun('HotMb', 'guardian-autopilot', 'b'.repeat(40), 'delivery-retry'), 992);
  assert.equal(calls.filter(({url, options}) => options.method === 'POST' && url.endsWith('/check-runs')).length, 1);
});

test('installation client downloads an archive through the expected codeload host without forwarding credentials', async () => {
  const calls = [];
  const client = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async (url, options) => {
    calls.push({url: String(url), options});
    if (calls.length === 1) return Response.json({token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {contents: 'read', metadata: 'read', checks: 'write'}, repositories: [{id: 17}]});
    if (calls.length === 2) return new Response(null, {status: 302, headers: {location: 'https://codeload.github.com/HotMb/guardian-autopilot/legacy.tar.gz/' + 'a'.repeat(40)}});
    return new Response('archive-bytes', {status: 200, headers: {'content-type': 'application/x-gzip'}});
  }});
  const response = await client.downloadRepositoryArchive('HotMb', 'guardian-autopilot', 'a'.repeat(40));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'archive-bytes');
  assert.match(calls[1].url, /^https:\/\/api\.github\.com\/repos\/HotMb\/guardian-autopilot\/tarball\//);
  assert.equal(calls[2].options.headers.Authorization, undefined);
  assert.equal(calls[2].options.redirect, 'error');
});

test('installation client rejects archive redirects outside GitHub codeload', async () => {
  let calls = 0;
  const client = new GitHubInstallationClient({installationId: 42, repositoryId: 17, createJwt: () => 'jwt', fetch: async () => {
    calls += 1;
    if (calls === 1) return Response.json({token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {contents: 'read', metadata: 'read', checks: 'write'}, repositories: [{id: 17}]});
    return new Response(null, {status: 302, headers: {location: 'https://evil.example/archive.tar.gz'}});
  }});
  await assert.rejects(client.downloadRepositoryArchive('HotMb', 'guardian-autopilot', 'a'.repeat(40)), /archive redirect/i);
  assert.equal(calls, 2);
});
