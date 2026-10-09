import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {issueLicense, verifyLicense} from '../dist/index.js';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({format: 'pem', type: 'pkcs8'}),
    publicKey: pair.publicKey.export({format: 'pem', type: 'spki'}),
  };
}

const input = {
  plan: 'pro',
  seats: 5,
  org: 'acme',
  features: ['policy-packs', 'ci', 'reports'],
  kid: '2025-01',
};

test('issues and verifies an Ed25519 license offline', () => {
  const keyPair = keys();
  const license = issueLicense(keyPair.privateKey, input, 1_730_000_000);
  const payload = verifyLicense(license, keyPair.publicKey, 1_730_000_001);

  assert.match(license, /^ccl_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(payload, {
    v: 1,
    ...input,
    iat: 1_730_000_000,
    exp: 1_730_000_000 + 365 * 86_400,
  });
});

test('rejects expired licenses and payload tampering', () => {
  const keyPair = keys();
  const license = issueLicense(keyPair.privateKey, {...input, durationSeconds: 60}, 1_000);

  assert.equal(verifyLicense(license, keyPair.publicKey, 1_061), null);
  const [prefix, encoded] = license.split('ccl_');
  void prefix;
  const [payload, signature] = encoded.split('.');
  const tampered = `ccl_${Buffer.from(JSON.stringify({...input, plan: 'enterprise'})).toString('base64url')}.${signature}`;
  assert.equal(verifyLicense(tampered, keyPair.publicKey, 1_001), null);
  assert.equal(verifyLicense(`ccl_${payload}.${signature.slice(0, -1)}x`, keyPair.publicKey, 1_001), null);
});

test('rejects malformed payloads and invalid license fields', () => {
  const keyPair = keys();
  assert.equal(verifyLicense('not-a-license', keyPair.publicKey), null);
  assert.throws(() => issueLicense(keyPair.privateKey, {...input, seats: 0}, 1_000), /seats/i);
  assert.throws(() => issueLicense(keyPair.privateKey, {...input, plan: 'free'}, 1_000), /plan/i);
});
