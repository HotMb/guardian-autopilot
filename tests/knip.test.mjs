import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {parseKnipReport, runKnip} from '../dist/knip.js';

test('normalizes Knip grouped JSON issues', () => {
  const issues = parseKnipReport({
    issues: [
      {file: 'package.json', dependencies: [{name: 'unused-lib'}], unlisted: [{name: 'missing-lib'}]},
      {file: 'src/index.ts', unresolved: [{name: './missing', line: 4, col: 12}]},
    ],
  });

  assert.deepEqual(issues, [
    {file: 'package.json', type: 'dependencies', name: 'unused-lib'},
    {file: 'package.json', type: 'unlisted', name: 'missing-lib'},
    {file: 'src/index.ts', type: 'unresolved', name: './missing', line: 4, col: 12},
  ]);
});

test('reports an unavailable optional Knip executable without failing the analysis', async () => {
  const root = await mkdtemp(joinPath(tmpdir(), 'guardian-knip-test-'));
  try {
    const result = await runKnip(root, {executable: 'guardian-command-that-does-not-exist'});
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.issues, []);
  } finally { await rm(root, {recursive: true, force: true}); }
});

function joinPath(directory, name) {
  return `${directory}/${name}`;
}
