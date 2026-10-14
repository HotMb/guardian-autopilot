import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import test from 'node:test';
import {createStudioServer} from '../dist/studio.js';

async function withStudio(run) {
  const server = createStudioServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run({server, baseUrl: `http://127.0.0.1:${address.port}`});
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('Studio serves its local app with restrictive security headers', async () => {
  await withStudio(async ({baseUrl}) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(response.headers.get('content-security-policy') ?? '', /worker-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(await response.text(), /Synthetic demo/);
  });
});

test('Studio serves only allowlisted CSS, JavaScript, and synthetic preview images', async () => {
  await withStudio(async ({baseUrl}) => {
    for (const [path, type] of [
      ['/studio.css', /text\/css/],
      ['/studio.js', /javascript/],
      ['/studio-metadata.js', /javascript/],
      ['/studio-scan.js', /javascript/],
      ['/studio-worker.js', /javascript/],
      ['/studio-file-ops.js', /javascript/],
      ['/studio-demo/demo-cabin.png', /image\/png/],
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') ?? '', type, path);
      assert.ok(Number(response.headers.get('content-length')) > 0, path);
    }
  });
});

test('Studio labels creator metadata as local, bounded, and opt-in without browser persistence or requests', async () => {
  const html = await readFile(new URL('../site/studio.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../site/studio.js', import.meta.url), 'utf8');
  const metadata = await readFile(new URL('../site/studio-metadata.js', import.meta.url), 'utf8');
  const scan = await readFile(new URL('../site/studio-scan.js', import.meta.url), 'utf8');
  const fileOps = await readFile(new URL('../site/studio-file-ops.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../site/studio-worker.js', import.meta.url), 'utf8');

  assert.match(html, /Prompts and workflows are revealed on request; they are not uploaded or saved/);
  assert.match(html, /id="previous-page"/);
  assert.match(html, /id="next-page"/);
  assert.match(html, /id="space-freed"/);
  assert.match(html, /id="enable-source-write"/);
  assert.match(html, /id="choose-quarantine"/);
  assert.match(html, /id="archive-dialog"/);
  assert.match(html, /id="purge-dialog"/);
  assert.match(html, /Type <code>PURGE<\/code>/);
  assert.match(html, /compatibility picker stays read-only/i);
  assert.match(fileOps, /MAX_QUARANTINE_BATCH = 20/);
  assert.match(fileOps, /await writer\.close\(\)/);
  assert.match(fileOps, /await sourceHandle\.remove/);
  assert.match(fileOps, /typedConfirmation !== 'PURGE'/);
  assert.match(fileOps, /Unsafe or protected path/);
  assert.match(html, /id="create-plan"[^>]*>Export review plan/);
  for (const source of [app, metadata, scan, fileOps, worker]) {
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest)\s*\(/);
    assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB)\b/);
  }
});

test('Studio rejects methods other than GET', async () => {
  await withStudio(async ({baseUrl}) => {
    const response = await fetch(`${baseUrl}/`, {method: 'POST', body: 'do not accept'});
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  });
});

test('Studio rejects arbitrary filesystem and API routes', async () => {
  await withStudio(async ({baseUrl}) => {
    for (const path of ['/api/file?path=C%3A%5CUsers%5Csecret.txt', '/../../package.json', '/site/index.html']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
    }
  });
});

test('Studio rejects a mismatched Host header', async () => {
  await withStudio(async ({baseUrl}) => {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(baseUrl, {headers: {host: 'localhost:12345'}}, resolve);
      request.on('error', reject);
      request.end();
    });
    response.resume();
    assert.equal(response.statusCode, 421);
  });
});

test('Studio rejects cross-origin and cross-site requests', async () => {
  await withStudio(async ({baseUrl}) => {
    const originResponse = await fetch(`${baseUrl}/`, {headers: {origin: 'https://attacker.example'}});
    assert.equal(originResponse.status, 403);
    const fetchMetadataResponse = await fetch(`${baseUrl}/`, {headers: {'sec-fetch-site': 'cross-site'}});
    assert.equal(fetchMetadataResponse.status, 403);
  });
});
