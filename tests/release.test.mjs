import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
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
  assert.match(workflow, /verify-release-tag\.mjs/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
});

test('release tag must match package version exactly', async () => {
  const script = fileURLToPath(new URL('../scripts/verify-release-tag.mjs', import.meta.url));
  const matching = spawnSync(process.execPath, [script, 'v0.1.0'], {encoding: 'utf8', windowsHide: true});
  assert.equal(matching.status, 0);

  const mismatched = spawnSync(process.execPath, [script, 'v0.1.1'], {encoding: 'utf8', windowsHide: true});
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /must match package version exactly/);
});

test('GitHub workflows use Node 24-compatible action majors', async () => {
  for (const workflow of ['ci.yml', 'release.yml', 'publish.yml']) {
    const source = await readFile(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /actions\/(?:checkout|setup-node)@v4/);
    assert.match(source, /actions\/checkout@v5/);
    assert.match(source, /actions\/setup-node@v5/);
  }
});
