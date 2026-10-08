import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import test from 'node:test';
import {verifyGitHubWebhookSignature} from '../dist/github.js';

const secret = "It's a Secret to Everybody";
const payload = 'Hello, World!';
const digest = createHmac('sha256', secret).update(payload).digest('hex');

test('GitHub webhook signature fixture follows the documented SHA-256 format', () => {
  assert.equal(digest, '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17');
  verifyGitHubWebhookSignature(payload, `sha256=${digest}`, secret);
  verifyGitHubWebhookSignature(Buffer.from(payload, 'utf8'), `sha256=${digest.toUpperCase()}`, secret);
  assert.throws(() => verifyGitHubWebhookSignature(`${payload}!`, `sha256=${digest}`, secret), /verification failed/);
  assert.throws(() => verifyGitHubWebhookSignature(payload, `sha1=${digest}`, secret), /header is invalid/);
  assert.throws(() => verifyGitHubWebhookSignature(payload, `sha256=${digest}`, 'wrong secret'), /verification failed/);
});
