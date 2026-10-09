import test from 'node:test';
import assert from 'node:assert/strict';
import {findExactDuplicates} from '../dist/duplicates.js';

test('groups exact SHA-256 duplicates and keeps paths deterministic', () => {
  const groups = findExactDuplicates({
    schemaVersion: 1,
    root: '/repo',
    files: [
      {path: 'src/z.ts', bytes: 4, sha256: 'same'},
      {path: 'src/a.ts', bytes: 4, sha256: 'same'},
      {path: 'src/unique.ts', bytes: 6, sha256: 'unique'},
      {path: 'src/b.ts', bytes: 4, sha256: 'same'},
    ],
  });

  assert.deepEqual(groups, [{
    sha256: 'same',
    bytes: 4,
    canonical: 'src/a.ts',
    duplicates: ['src/b.ts', 'src/z.ts'],
  }]);
});

test('does not report a hash group with only one file', () => {
  assert.deepEqual(findExactDuplicates({schemaVersion: 1, root: '/repo', files: [
    {path: 'only.ts', bytes: 1, sha256: 'one'},
  ]}), []);
});

