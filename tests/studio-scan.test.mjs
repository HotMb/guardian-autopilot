import assert from 'node:assert/strict';
import test from 'node:test';
import {buildReviewPlan, collectImageInventory, findExactDuplicateGroups, imageTypeFromName} from '../site/studio-scan.js';

const record = (id, bytes) => ({id, bytes: bytes.length, file: new Blob([bytes])});
const quiet = {yieldToBrowser: async () => {}};

test('confirms byte-identical candidates after matching SHA-256 and size', async () => {
  const result = await findExactDuplicateGroups([
    record('copy-a', 'same bytes'), record('copy-b', 'same bytes'), record('different', 'other data'),
  ], quiet);

  assert.deepEqual(result.groups.map((group) => group.map(({id}) => id)), [['copy-a', 'copy-b']]);
  assert.equal(result.stats.hashedFiles, 3);
  assert.equal(result.stats.confirmedGroups, 1);
  assert.equal(result.stats.skippedLargeFiles, 0);
});

test('does not call different same-size files duplicates', async () => {
  const result = await findExactDuplicateGroups([record('first', 'aaaa'), record('second', 'bbbb')], quiet);

  assert.deepEqual(result.groups, []);
  assert.equal(result.stats.hashedFiles, 2);
});

test('byte-compares equal-size records even if the injected digest collides', async () => {
  const result = await findExactDuplicateGroups([
    record('one', 'aaaa'), record('two', 'bbbb'), record('copy', 'aaaa'),
  ], {...quiet, digest: async () => 'forced-collision'});

  assert.deepEqual(result.groups.map((group) => group.map(({id}) => id)), [['one', 'copy']]);
});

test('skips files above the hash limit and exposes their count', async () => {
  const tooLarge = {id: 'large', bytes: 5, file: new Blob(['large'])};
  const result = await findExactDuplicateGroups([tooLarge, record('small-a', 'x'), record('small-b', 'x')], {
    ...quiet, maxHashBytes: 4,
  });

  assert.deepEqual(result.groups.map((group) => group.map(({id}) => id)), [['small-a', 'small-b']]);
  assert.equal(result.stats.skippedLargeFiles, 1);
});

test('stops between file reads when cancellation is requested', async () => {
  let cancel = false;
  const result = await findExactDuplicateGroups([
    record('one', 'same'), record('two', 'same'), record('three', 'same'),
  ], {
    ...quiet,
    shouldCancel: () => cancel,
    onProgress: ({phase, completed}) => { if (phase === 'hash' && completed === 1) cancel = true; },
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.stats.hashedFiles, 1);
  assert.deepEqual(result.groups, []);
});

test('does not treat read failures as matches', async () => {
  const broken = {id: 'broken', bytes: 4, file: {size: 4, arrayBuffer: async () => { throw new Error('read failed'); }}};
  const result = await findExactDuplicateGroups([broken, record('valid', 'same')], quiet);

  assert.deepEqual(result.groups, []);
  assert.equal(result.stats.readFailures, 1);
});

test('indexes a large synthetic listing progressively and retains the largest review set', async () => {
  const total = 12_050;
  const entries = (async function* () {
    yield {kind: 'directory', path: 'ComfyUI/output'};
    for (let index = 0; index < total; index += 1) {
      yield {kind: 'file', path: `ComfyUI/output/render-${index}.png`, file: {name: `render-${index}.png`, size: index + 1}};
    }
    yield {kind: 'file', path: 'ComfyUI/output/workflow.json', file: {name: 'workflow.json', size: 999_999}};
  })();
  let progressEvents = 0;
  let yields = 0;
  const result = await collectImageInventory(entries, {
    maxRecords: 10_000,
    maxEntries: 20_000,
    progressEvery: 500,
    onProgress: ({phase}) => { if (phase === 'inventory') progressEvents += 1; },
    yieldToBrowser: async () => { yields += 1; },
  });

  assert.equal(result.imageCount, total);
  assert.equal(result.imageBytes, total * (total + 1) / 2);
  assert.equal(result.records.length, 10_000);
  assert.equal(result.records[0].name, `render-${total - 1}.png`);
  assert.equal(result.records.at(-1).name, 'render-2050.png');
  assert.equal(result.records[0].folder, 'ComfyUI/output');
  assert.equal(result.entriesScanned, total + 2);
  assert.equal(result.capped, false);
  assert.ok(progressEvents >= 25);
  assert.equal(yields, progressEvents - 1);
});

test('reports inventory limits and cooperative cancellation as incomplete', async () => {
  const makeEntries = (count) => (async function* () {
    for (let index = 0; index < count; index += 1) {
      yield {kind: 'file', path: `image-${index}.webp`, file: {name: `image-${index}.webp`, size: index + 1}};
    }
  })();
  const capped = await collectImageInventory(makeEntries(12), {maxEntries: 10, progressEvery: 2, yieldToBrowser: async () => {}});
  assert.equal(capped.imageCount, 10);
  assert.equal(capped.capped, true);

  let cancel = false;
  const partial = await collectImageInventory(makeEntries(20), {
    maxEntries: 100,
    progressEvery: 2,
    shouldCancel: () => cancel,
    onProgress: ({entriesScanned}) => { if (entriesScanned === 4) cancel = true; },
    yieldToBrowser: async () => {},
  });
  assert.equal(partial.cancelled, true);
  assert.equal(partial.imageCount, 4);
});

test('recognizes the image formats used by local generator archives', () => {
  assert.deepEqual(['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif', 'f.avif', 'g.svg'].map(imageTypeFromName), [
    'PNG', 'JPEG', 'JPEG', 'WEBP', 'GIF', 'AVIF', 'SVG',
  ]);
  assert.equal(imageTypeFromName('workflow.json'), null);
});

test('exports candidate size separately from actual space freed and omits image contents', () => {
  const records = [
    {id: 'large', path: 'ComfyUI/output/large.png', bytes: 50, type: 'PNG'},
    {id: 'duplicate', path: 'Stable-diffusion/output/copy.png', bytes: 30, type: 'PNG', duplicateGroup: 'match-1'},
  ];
  const plan = buildReviewPlan(records, new Set(['large', 'duplicate']), {
    complete: true, totalImageCount: 2, totalImageBytes: 80, retainedForReview: 2,
  }, {createdAt: '2026-10-14T10:00:00.000Z'});

  assert.equal(plan.candidateSizeBytes, 80);
  assert.equal(plan.spaceActuallyFreedBytes, 0);
  assert.deepEqual(plan.candidates.map(({relativePath}) => relativePath), records.map(({path}) => path));
  assert.ok(plan.candidates.every((candidate) => !('bytes' in candidate) && !('hash' in candidate)));
  assert.match(plan.note, /no space has been freed/i);

  const partialPlan = buildReviewPlan(records, new Set(['large']), {
    complete: false, totalImageCount: 12_050, totalImageBytes: 99_000, retainedForReview: 10_000,
  }, {createdAt: '2026-10-14T10:00:00.000Z'});
  assert.equal(partialPlan.scan.complete, false);
  assert.equal(partialPlan.scan.totalImageCount, 12_050);
  assert.equal(partialPlan.scan.retainedForReview, 10_000);
  assert.equal(partialPlan.spaceActuallyFreedBytes, 0);
});
