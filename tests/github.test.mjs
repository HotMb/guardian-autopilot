import assert from 'node:assert/strict';
import {createHmac, generateKeyPairSync, verify} from 'node:crypto';
import test from 'node:test';
import {createGitHubAppJwt, verifyGitHubWebhookSignature} from '../dist/github.js';

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

test('GitHub App JWTs are short-lived and verifiable with the generated public key', () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const now = 1_700_000_000;
  const token = createGitHubAppJwt(12345, privateKey.export({type: 'pkcs8', format: 'pem'}).toString(), now);
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const decodedHeader = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  const decodedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  assert.deepEqual(decodedHeader, {alg: 'RS256', typ: 'JWT'});
  assert.deepEqual(decodedPayload, {iat: now - 60, exp: now + 540, iss: '12345'});
  assert.equal(verify('RSA-SHA256', Buffer.from(unsigned), publicKey, Buffer.from(encodedSignature, 'base64url')), true);
  assert.throws(() => createGitHubAppJwt('not-an-id', 'key', now), /id must be/);
});
