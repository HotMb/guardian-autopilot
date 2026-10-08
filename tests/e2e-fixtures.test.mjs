import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {planCandidates} from '../dist/candidates.js';
import {findAssetReferences} from '../dist/references.js';
import {scan} from '../dist/scanner.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/next-app/', import.meta.url));

test('Next.js fixture scans public assets and ignores build output', async () => {
  const result = await scan(fixtureRoot);

  assert.equal(result.errors.length, 0);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    kind: 'exact-duplicate',
    file: 'public/images/card.png',
    sameAs: 'public/images/card-copy.png',
    bytes: Buffer.byteLength('next-fixture-card') + 1,
    action: 'review-only',
  });
  assert.ok(!result.findings.some(({file}) => file.startsWith('.next/')));
});

test('Next.js fixture resolves public URL conventions without trusting dynamic or remote URLs', async () => {
  const result = await findAssetReferences(fixtureRoot);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.references, [
    {source: 'app/metadata.json', target: 'public/images/card-copy.png', kind: 'source-literal', raw: '/images/card-copy.png'},
    {source: 'app/page.module.css', target: 'public/images/card.png', kind: 'css-url', raw: '/images/card.png'},
    {source: 'app/page.tsx', target: 'public/hero.webp', kind: 'js-ts-literal', raw: '/hero.webp'},
    {source: 'app/page.tsx', target: 'public/images/card.png', kind: 'js-ts-literal', raw: '/images/card.png?width=1200'},
  ]);
});

test('Next.js fixture produces explainable review-only evidence', async () => {
  const result = await planCandidates(fixtureRoot);

  assert.equal(result.mode, 'read-only');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].confidence, 'low');
  assert.equal(result.candidates[0].action, 'review-only');
  assert.match(result.candidates[0].evidence.reasons.join(' '), /still referenced/i);
  assert.equal(result.knip.status, 'unavailable');
});
