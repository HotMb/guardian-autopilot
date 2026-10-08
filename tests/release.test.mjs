import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('npm publication is manual, tag-only, and OIDC-gated', async () => {
  const workflow = await readFile(new URL('.github/workflows/publish.yml', root), 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirm_publish:/);
  assert.match(workflow, /if: inputs\.confirm_publish == true && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /name: npm-release/);
  assert.match(workflow, /npm publish --access public/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
});
