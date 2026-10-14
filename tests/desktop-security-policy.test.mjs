import assert from 'node:assert/strict';
import test from 'node:test';
import {isAllowedStudioNavigation} from '../packages/desktop/security-policy.mjs';

test('desktop navigation stays on Guardian Studio origin', () => {
  assert.equal(isAllowedStudioNavigation('guardian://studio/'), true);
  assert.equal(isAllowedStudioNavigation('guardian://studio/studio.js'), true);
});

test('desktop navigation rejects external, forged, and credential-bearing origins', () => {
  for (const url of [
    'https://example.com/',
    'http://127.0.0.1:8765/',
    'guardian://attacker/',
    'guardian://studio.attacker/',
    'guardian://studio:444/',
    'guardian://user@studio/',
    'file:///C:/Users/Public/test.html',
    'not a URL',
  ]) {
    assert.equal(isAllowedStudioNavigation(url), false, url);
  }
});
