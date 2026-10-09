import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCandidate} from '../dist/policy.js';

const candidate = {
  id: 'candidate-1',
  path: 'src/legacy.ts',
  kind: 'unused-export',
  confidence: 0.98,
  evidence: [
    {type: 'positive_proof', confidence: 0.98},
    {type: 'no_import_references', confidence: 0.99},
  ],
};

test('allows only candidates that satisfy every deletion rule', () => {
  const decision = evaluateCandidate(candidate);
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasons, []);
});

test('rejects protected paths and weak evidence', () => {
  const protectedDecision = evaluateCandidate({...candidate, path: '.env.local'});
  assert.equal(protectedDecision.allowed, false);
  assert.match(protectedDecision.reasons.join(' '), /protected/i);

  const weakDecision = evaluateCandidate({
    ...candidate,
    confidence: 0.6,
    evidence: [{type: 'no_import_references', confidence: 1}],
  });
  assert.equal(weakDecision.allowed, false);
  assert.match(weakDecision.reasons.join(' '), /positive proof|confidence/i);
});

test('honours stricter configured confidence thresholds', () => {
  const decision = evaluateCandidate(candidate, {minConfidence: 0.99});
  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join(' '), /confidence/i);
});

