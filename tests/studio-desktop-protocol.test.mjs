import assert from 'node:assert/strict';
import test from 'node:test';
import {createStudioProtocolHandler} from '../dist/studio.js';

const handler = createStudioProtocolHandler();
const request = (url, method = 'GET') => ({url, method});

test('desktop protocol serves the app with a restrictive policy', async () => {
  const response = await handler(request('guardian://studio/'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await response.text(), /Synthetic demo/);
});

test('desktop protocol serves allowlisted UI assets and blocks arbitrary paths', async () => {
  const script = await handler(request('guardian://studio/studio.js'));
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.ok((await script.arrayBuffer()).byteLength > 0);

  for (const url of [
    'guardian://studio/package.json',
    'guardian://other/studio.js',
    'guardian://studio/studio.js?path=C%3A%5CUsers%5Csecret',
    'guardian://studio/../../package.json',
  ]) {
    assert.equal((await handler(request(url))).status, 404, url);
  }
});

test('desktop protocol is read-only except for local watcher status', async () => {
  assert.equal((await handler(request('guardian://studio/', 'POST'))).status, 405);
  const response = await handler(request('guardian://studio/api/watch/status'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, false);
  assert.deepEqual(body.candidates, []);
});
