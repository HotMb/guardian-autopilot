import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateConfidence} from '../dist/confidence.js';

test('requires positive proof and returns the weakest evidence confidence', () => {
  assert.equal(calculateConfidence([
    {type: 'positive_proof', confidence: 0.99},
    {type: 'no_import_references', confidence: 0.97},
  ]), 0.97);
});

test('caps confidence at 0.5 when positive proof is absent', () => {
  assert.equal(calculateConfidence([
    {type: 'no_import_references', confidence: 1},
    {type: 'not_in_public_api', confidence: 0.98},
  ]), 0.5);
});

test('handles empty evidence conservatively', () => {
  assert.equal(calculateConfidence([]), 0.5);
});

