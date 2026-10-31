import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('GitHub App contract grants source read and Checks write only, and contains no credentials', async () => {
  const contract = JSON.parse(await readFile(new URL('../integrations/github-app/permissions.json', import.meta.url), 'utf8'));
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.repositoryPermissions, {
    contents: 'read',
    metadata: 'read',
    checks: 'write',
  });
  assert.deepEqual(contract.events, ['installation', 'push']);
  assert.deepEqual(contract.writePermissions, ['checks']);
  assert.equal(contract.webhookSecret, 'configured-at-registration-time');
  assert.equal(Object.keys(contract).some((key) => /secret|privateKey|clientSecret|callback/i.test(key) && key !== 'webhookSecret'), false);
});
