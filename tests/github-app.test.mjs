import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('GitHub App contract is read-only and contains no credentials', async () => {
  const contract = JSON.parse(await readFile(new URL('../integrations/github-app/permissions.json', import.meta.url), 'utf8'));
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.repositoryPermissions, {
    contents: 'read',
    metadata: 'read',
    pull_requests: 'read',
    checks: 'read',
  });
  assert.deepEqual(contract.events, ['installation', 'push', 'pull_request']);
  assert.equal(contract.writeAccess, false);
  assert.equal(contract.webhookSecret, 'configured-at-registration-time');
  assert.equal(Object.keys(contract).some((key) => /secret|privateKey|clientSecret|callback/i.test(key) && key !== 'webhookSecret'), false);
});
