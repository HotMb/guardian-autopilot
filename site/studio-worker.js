import {findExactDuplicateGroups} from './studio-scan.js';
import {findVisualSimilarityGroups} from './studio-similarity.js';

const cancelled = new Set();

if (typeof self !== 'undefined') {
  self.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.token !== 'number') return;
    if (message.type === 'cancel') {
      cancelled.add(message.token);
      return;
    }
    if (message.type === 'scan') void runScan(message);
    if (message.type === 'similarity-scan') void runSimilarityScan(message);
  });
}

async function runScan({token, records, maxHashBytes}) {
  try {
    const result = await findExactDuplicateGroups(records, {
      maxHashBytes,
      shouldCancel: () => cancelled.has(token),
      onProgress: (progress) => self.postMessage({type: 'progress', token, progress}),
    });
    self.postMessage({
      type: 'result',
      token,
      groups: result.groups.map((group) => group.map((record) => record.id)),
      stats: result.stats,
      cancelled: result.cancelled || cancelled.has(token),
    });
  } catch (error) {
    self.postMessage({type: 'error', token, message: error instanceof Error ? error.message : 'Duplicate scan failed'});
  } finally {
    cancelled.delete(token);
  }
}

async function runSimilarityScan({token, records, maxDistance, maxCandidatePairs}) {
  try {
    const result = await findVisualSimilarityGroups(records, {
      maxDistance,
      maxCandidatePairs,
      shouldCancel: () => cancelled.has(token),
      onProgress: (progress) => self.postMessage({type: 'progress', token, progress}),
    });
    self.postMessage({
      type: 'similarity-result',
      token,
      groups: result.groups.map((group) => group.map((record) => record.id)),
      stats: result.stats,
      cancelled: result.cancelled || cancelled.has(token),
    });
  } catch (error) {
    self.postMessage({type: 'error', token, message: error instanceof Error ? error.message : 'Visual similarity scan failed'});
  } finally {
    cancelled.delete(token);
  }
}
