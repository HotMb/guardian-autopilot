import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findAssetReferences} from '../dist/references.js';

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'guardian-references-test-'));
}

test('resolves JS/TS, CSS and public URL asset references', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'src'), {recursive: true});
    await mkdir(join(root, 'assets'), {recursive: true});
    await mkdir(join(root, 'public', 'images'), {recursive: true});
    await writeFile(join(root, 'assets', 'logo.png'), 'logo');
    await writeFile(join(root, 'public', 'images', 'hero.webp'), 'hero');
    await writeFile(join(root, 'src', 'Card.tsx'), "import logo from '../assets/logo.png';\nexport const image = '/images/hero.webp';\nconst external = 'https://cdn.example.com/remote.png';");
    await writeFile(join(root, 'src', 'theme.css'), ".hero { background-image: url('../assets/logo.png'); } .banner { background: url('/images/hero.webp'); }");

    const result = await findAssetReferences(root);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.references, [
      {source: 'src/Card.tsx', target: 'assets/logo.png', kind: 'js-ts-literal', raw: '../assets/logo.png'},
      {source: 'src/Card.tsx', target: 'public/images/hero.webp', kind: 'js-ts-literal', raw: '/images/hero.webp'},
      {source: 'src/theme.css', target: 'assets/logo.png', kind: 'css-url', raw: '../assets/logo.png'},
      {source: 'src/theme.css', target: 'public/images/hero.webp', kind: 'css-url', raw: '/images/hero.webp'},
    ]);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('does not resolve paths outside the root or dynamic remote values', async () => {
  const root = await makeRoot();
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'page.ts'), "const dynamic = `../secret.png`;\nconst remote = 'https://example.com/photo.png';\nconst outside = '../../outside.png';");

    const result = await findAssetReferences(root);

    assert.deepEqual(result.references, []);
  } finally { await rm(root, {recursive: true, force: true}); }
});
