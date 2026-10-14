import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
  IncrementalSha256, assertArchiveDestinationOutsideSource, loadQuarantine, purgeQuarantined, quarantineFiles,
  quarantineErrorMessage, reconcileVerifiedQuarantine, restoreQuarantined, isProtectedQuarantineDirectory,
} from '../site/studio-file-ops.js';

class MemoryFileHandle {
  static failWrites = false;
  static failName = '';
  static failManifestAt = 0;
  static manifestWrites = 0;
  constructor(name, blob = null, failWrite = false) { this.name = name; this.kind = 'file'; this.blob = blob; this.failWrite = failWrite; }
  async isSameEntry(other) { return this === other; }
  async getFile() { if (!this.blob) throw Object.assign(new Error('missing'), {name: 'NotFoundError'}); return new File([this.blob], this.name, {lastModified: 10}); }
  async createWritable() {
    const chunks = [];
    return {
      write: async (chunk) => { if (this.failWrite || (MemoryFileHandle.failWrites && this.name.endsWith('.bin')) || this.name === MemoryFileHandle.failName) throw Object.assign(new Error('disk full'), {name: 'QuotaExceededError'}); chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)); },
      close: async () => {
        if (this.name === 'manifest.json') {
          MemoryFileHandle.manifestWrites += 1;
          if (MemoryFileHandle.manifestWrites === MemoryFileHandle.failManifestAt) throw new Error('simulated journal commit failure');
        }
        this.blob = new Blob(chunks);
      },
      abort: async () => { chunks.length = 0; },
    };
  }
}
class MemoryDirectoryHandle {
  constructor(name = 'root') { this.name = name; this.kind = 'directory'; this.children = new Map(); this.permission = 'granted'; }
  async queryPermission() { return this.permission; }
  async requestPermission() { return this.permission; }
  async isSameEntry(other) { return this === other; }
  async getDirectoryHandle(name, {create = false} = {}) {
    let child = this.children.get(name);
    if (!child) { if (!create) throw Object.assign(new Error('missing'), {name: 'NotFoundError'}); child = new MemoryDirectoryHandle(name); this.children.set(name, child); }
    if (!(child instanceof MemoryDirectoryHandle)) throw Object.assign(new Error('not a folder'), {name: 'TypeMismatchError'});
    return child;
  }
  async getFileHandle(name, {create = false} = {}) {
    let child = this.children.get(name);
    if (!child) { if (!create) throw Object.assign(new Error('missing'), {name: 'NotFoundError'}); child = new MemoryFileHandle(name); this.children.set(name, child); }
    if (!(child instanceof MemoryFileHandle)) throw Object.assign(new Error('not a file'), {name: 'TypeMismatchError'});
    return child;
  }
  async removeEntry(name) { if (!this.children.has(name)) throw Object.assign(new Error('missing'), {name: 'NotFoundError'}); this.children.delete(name); }
  async *values() { for (const child of this.children.values()) yield child; }
}
async function putFile(root, path, contents) {
  const parts = path.split('/'); let parent = root;
  for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, {create: true});
  const handle = await parent.getFileHandle(parts.at(-1), {create: true});
  handle.blob = new Blob([contents]);
  return handle;
}
async function hasFile(root, path) {
  try { let parent = root; const parts = path.split('/'); for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part); await parent.getFileHandle(parts.at(-1)); return true; }
  catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
}
function roots() { return {source: new MemoryDirectoryHandle('source'), archive: new MemoryDirectoryHandle('archive')}; }
const idFactory = (() => { let id = 0; return () => `item-${++id}`; })();
const makeRecord = (path, contents, lastModified = 10, handle) => {
  const name = path.split('/').at(-1);
  const file = new File([contents], name, {lastModified});
  return {path, name, bytes: file.size, lastModified, file, ...(handle === undefined ? {} : {handle})};
};

test('incremental SHA-256 matches standard vectors and a multi-chunk synthetic file', () => {
  const empty = new IncrementalSha256().digestHex();
  assert.equal(empty, createHash('sha256').digest('hex'));
  const bytes = new Uint8Array(2 * 1024 * 1024 + 19);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 251;
  const hash = new IncrementalSha256();
  hash.update(bytes.subarray(0, 65)); hash.update(bytes.subarray(65, 1_048_581)); hash.update(bytes.subarray(1_048_581));
  assert.equal(hash.digestHex(), createHash('sha256').update(bytes).digest('hex'));
});

test('quarantines only after streamed copy and byte/hash verification, with durable local journal', async () => {
  const {source, archive} = roots();
  const original = Buffer.from('synthetic image fixture');
  await putFile(source, 'exports/image.png', original);
  const result = await quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('exports/image.png', original)], reason: 'Verified synthetic duplicate', confirmed: true, idFactory});
  assert.equal(await hasFile(source, 'exports/image.png'), false);
  assert.equal(result.sourceBytesRemoved, original.length);
  assert.equal(result.manifest.entries[0].status, 'quarantined');
  assert.equal(result.manifest.entries[0].sha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(await loadQuarantine(archive).then((journal) => journal.entries.length), 1);
  assert.equal(await hasFile(source, '.guardian-quarantine/manifest.json'), false);
});

test('rejects a file handle that does not identify the selected source path', async () => {
  const {source, archive} = roots();
  const selected = await putFile(source, 'same.png', 'current source bytes');
  const otherRoot = new MemoryDirectoryHandle('other');
  const unrelated = await putFile(otherRoot, 'same.png', 'current source bytes');
  await assert.rejects(
    quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('same.png', 'current source bytes', 10, unrelated)], reason: 'test', confirmed: true}),
    {code: 'selection'},
  );
  assert.equal(await selected.getFile().then((file) => file.text()), 'current source bytes');
  assert.equal((await loadQuarantine(archive)).entries.length, 0);
});

test('compares live bytes with the immutable scan snapshot before creating an archive item', async () => {
  const {source, archive} = roots();
  const sourceHandle = await putFile(source, 'changed.png', 'live bytes');
  const scanned = makeRecord('changed.png', 'scan bytes');
  assert.equal(scanned.bytes, await sourceHandle.getFile().then((file) => file.size), 'fixture keeps size and timestamp unchanged');
  await assert.rejects(
    quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [scanned], reason: 'test', confirmed: true}),
    {code: 'verification'},
  );
  assert.equal(await sourceHandle.getFile().then((file) => file.text()), 'live bytes');
  assert.equal((await loadQuarantine(archive)).entries.length, 0);
});

test('archive destination must be outside the source tree and the check fails closed', async () => {
  const source = new MemoryDirectoryHandle('source');
  await putFile(source, 'keep.png', 'source data');
  await assert.rejects(assertArchiveDestinationOutsideSource(source, source), {code: 'archive-scope'});
  await assert.rejects(
    quarantineFiles({sourceRoot: source, destinationRoot: source, records: [makeRecord('keep.png', 'source data')], reason: 'test', confirmed: true}),
    {code: 'archive-scope'},
  );

  const nestedArchive = await source.getDirectoryHandle('nested-archive', {create: true});
  await assert.rejects(assertArchiveDestinationOutsideSource(source, nestedArchive), {code: 'archive-scope'});
  await assert.rejects(
    quarantineFiles({sourceRoot: source, destinationRoot: nestedArchive, records: [makeRecord('keep.png', 'source data')], reason: 'test', confirmed: true}),
    {code: 'archive-scope'},
  );
  assert.equal(nestedArchive.children.size, 0, 'no quarantine directory is created inside the source');
  assert.equal(await hasFile(source, 'keep.png'), true);

  const unsupported = new MemoryDirectoryHandle('unsupported');
  unsupported.values = undefined;
  const {archive} = roots();
  await assert.rejects(assertArchiveDestinationOutsideSource(unsupported, archive), {code: 'archive-scope'});
  await assert.rejects(
    quarantineFiles({sourceRoot: unsupported, destinationRoot: archive, records: [makeRecord('keep.png', 'source data')], reason: 'test', confirmed: true}),
    {code: 'archive-scope'},
  );
  assert.equal(archive.children.size, 0, 'archive remains untouched if source-tree separation cannot be proven');
});

test('a failed archive write leaves the source intact and records an interrupted item', async () => {
  const {source, archive} = roots();
  const original = Buffer.from('never remove this synthetic file');
  await putFile(source, 'image.webp', original);
  MemoryFileHandle.failWrites = true;
  try {
    await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('image.webp', original)], reason: 'test', confirmed: true, idFactory}), (error) => error.code === 'space');
  } finally { MemoryFileHandle.failWrites = false; }
  assert.equal(await hasFile(source, 'image.webp'), true);
  const journal = await loadQuarantine(archive);
  assert.equal(journal.entries[0].status, 'interrupted');
  assert.match(quarantineErrorMessage(Object.assign(new Error('storage full'), {code: 'space'})), /available space/i);
  MemoryFileHandle.failWrites = false;
  const resumed = await quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('image.webp', original)], reason: 'test', confirmed: true, idFactory});
  assert.equal(resumed.manifest.entries[0].status, 'quarantined');
  assert.equal(await hasFile(source, 'image.webp'), false);
});

test('requires explicit review confirmation, a short reason, and a bounded exact selection', async () => {
  const {source, archive} = roots();
  await putFile(source, 'a.png', 'abc');
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('a.png', 'abc')], reason: 'test'}), {code: 'confirmation'});
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('a.png', 'abc')], reason: '', confirmed: true}), {code: 'reason'});
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: Array(21).fill(makeRecord('a.png', 'abc')), reason: 'test', confirmed: true}), {code: 'selection'});
  assert.equal(await hasFile(source, 'a.png'), true);
});

test('write permission denial and path traversal fail closed', async () => {
  const {source, archive} = roots();
  const sourceFile = await putFile(source, 'images/a.png', 'abc');
  source.permission = 'denied';
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('images/a.png', 'abc')], reason: 'test', confirmed: true}), {code: 'permission'});
  source.permission = 'granted';
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('../images/a.png', 'abc')], reason: 'test', confirmed: true}), (error) => error.code === 'selection');
  assert.equal(await sourceFile.getFile().then((file) => file.size), 3);
});

test('restores verified archive bytes without overwriting a conflicting original path', async () => {
  const {source, archive} = roots();
  const original = 'restore this synthetic image';
  await putFile(source, 'folder/a.png', original);
  const archived = await quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('folder/a.png', original)], reason: 'test', confirmed: true, idFactory});
  const id = archived.manifest.entries[0].id;
  MemoryFileHandle.failName = 'a.png';
  try {
    await assert.rejects(restoreQuarantined({sourceRoot: source, destinationRoot: archive, ids: [id], confirmed: true}));
  } finally { MemoryFileHandle.failName = ''; }
  assert.equal(await hasFile(source, 'folder/a.png'), true, 'a failed restore leaves any partial target for explicit inspection');
  assert.equal(await hasFile(archive, `.guardian-quarantine/items/${id}.bin`), true);
  await putFile(source, 'folder/a.png', 'user-created conflict');
  await assert.rejects(restoreQuarantined({sourceRoot: source, destinationRoot: archive, ids: [id], confirmed: true}), {code: 'collision'});
  assert.equal(await (await (await source.getDirectoryHandle('folder')).getFileHandle('a.png')).getFile().then((file) => file.text()), 'user-created conflict');
  await (await source.getDirectoryHandle('folder')).removeEntry('a.png');
  const restored = await restoreQuarantined({sourceRoot: source, destinationRoot: archive, ids: [id], confirmed: true});
  assert.equal(restored.restoredBytes, Buffer.byteLength(original));
  assert.equal(await (await (await source.getDirectoryHandle('folder')).getFileHandle('a.png')).getFile().then((file) => file.text()), original);
  assert.equal(await loadQuarantine(archive).then((journal) => journal.entries[0].status), 'restored');
  assert.equal(await hasFile(archive, `.guardian-quarantine/items/${id}.bin`), true);
});

test('restore requires an explicitly reselected source folder matching the journal', async () => {
  const {source, archive} = roots();
  await putFile(source, 'a.png', 'same-name folder identity check');
  const bytes = Buffer.byteLength('same-name folder identity check');
  const result = await quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('a.png', 'same-name folder identity check')], reason: 'test', confirmed: true, idFactory});
  const other = new MemoryDirectoryHandle('different-source');
  await assert.rejects(restoreQuarantined({sourceRoot: other, destinationRoot: archive, ids: [result.manifest.entries[0].id], confirmed: true}), {code: 'source-root'});
  assert.equal(await hasFile(archive, `.guardian-quarantine/items/${result.manifest.entries[0].id}.bin`), true);
});

test('restore failure retains its quarantine copy and purge requires typed double confirmation', async () => {
  const {source, archive} = roots();
  await putFile(source, 'a.png', 'purge only by explicit request');
  const purgedText = 'purge only by explicit request';
  const result = await quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('a.png', purgedText)], reason: 'test', confirmed: true, idFactory});
  const id = result.manifest.entries[0].id;
  await assert.rejects(purgeQuarantined({destinationRoot: archive, ids: [id], confirmed: true, typedConfirmation: 'purge'}), {code: 'confirmation'});
  assert.equal(await hasFile(archive, `.guardian-quarantine/items/${id}.bin`), true);
  const purged = await purgeQuarantined({destinationRoot: archive, ids: [id], confirmed: true, typedConfirmation: 'PURGE'});
  assert.equal(purged.purgedBytes, Buffer.byteLength(purgedText));
  assert.equal(await hasFile(archive, `.guardian-quarantine/items/${id}.bin`), false);
  assert.equal(purged.manifest.entries[0].status, 'purged');
});

test('cooperative cancellation during copy leaves the original and a resumable journal record', async () => {
  const {source, archive} = roots();
  const content = new Uint8Array(1024 * 1024 + 20).fill(17);
  await putFile(source, 'large.png', content);
  const controller = new AbortController();
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('large.png', content)], reason: 'test', confirmed: true, signal: controller.signal, idFactory, onProgress: ({phase}) => { if (phase === 'copy') controller.abort(); }}), {code: 'cancelled'});
  assert.equal(await hasFile(source, 'large.png'), true);
  assert.equal(await loadQuarantine(archive).then((journal) => journal.entries[0].status), 'interrupted');
});

test('a journal failure after source removal is recovered without falsely attributing missing bytes', async () => {
  const {source, archive} = roots();
  const text = 'verified before this journal fault';
  await putFile(source, 'recover.png', text);
  MemoryFileHandle.manifestWrites = 0;
  MemoryFileHandle.failManifestAt = 5;
  try {
    await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('recover.png', text)], reason: 'test', confirmed: true, idFactory}));
  } finally { MemoryFileHandle.failManifestAt = 0; }
  assert.equal(await hasFile(source, 'recover.png'), false);
  assert.equal(await loadQuarantine(archive).then((journal) => journal.entries[0].status), 'verified');
  const recoveryJournal = await loadQuarantine(archive);
  const recovered = await reconcileVerifiedQuarantine({sourceRoot: source, destinationRoot: archive, ids: [recoveryJournal.entries[0].id], confirmed: true, sourceRootConfirmed: true});
  assert.equal(recovered.manifest.entries[0].status, 'quarantined');
  assert.equal(recovered.sourceBytesRemoved, 0);
  assert.equal(recovered.sourceBytesAlreadyAbsent, Buffer.byteLength(text));
});

test('reconciles a verified archive by rechecking and removing only the unchanged source', async () => {
  const {source, archive} = roots();
  const text = 'same bytes remain after a failed remove attempt';
  const sourceHandle = await putFile(source, 'pending.png', text);
  const removeEntry = source.removeEntry.bind(source);
  source.removeEntry = async (name) => {
    if (name === 'pending.png') throw new Error('simulated interruption before source removal');
    return removeEntry(name);
  };
  try {
    await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('pending.png', text)], reason: 'test', confirmed: true, idFactory}));
  } finally { source.removeEntry = removeEntry; }
  const journal = await loadQuarantine(archive);
  assert.equal(journal.entries[0].status, 'verified');
  assert.equal(await sourceHandle.getFile().then((file) => file.text()), text);
  await assert.rejects(reconcileVerifiedQuarantine({sourceRoot: source, destinationRoot: archive, ids: [journal.entries[0].id], confirmed: true}), {code: 'confirmation'});
  const otherSource = new MemoryDirectoryHandle('different-source');
  const otherHandle = await putFile(otherSource, 'pending.png', text);
  await assert.rejects(
    reconcileVerifiedQuarantine({sourceRoot: otherSource, destinationRoot: archive, ids: [journal.entries[0].id], confirmed: true, sourceRootConfirmed: true}),
    {code: 'source-root'},
  );
  assert.equal(await otherHandle.getFile().then((file) => file.text()), text, 'a mismatched source root is left intact');
  const reconciled = await reconcileVerifiedQuarantine({sourceRoot: source, destinationRoot: archive, ids: [journal.entries[0].id], confirmed: true, sourceRootConfirmed: true});
  assert.equal(reconciled.sourceBytesRemoved, Buffer.byteLength(text));
  assert.equal(reconciled.sourceBytesAlreadyAbsent, 0);
  assert.equal(await hasFile(source, 'pending.png'), false);
  assert.equal(reconciled.manifest.entries[0].status, 'quarantined');
});

test('a pre-existing random archive payload collision is never opened for writing', async () => {
  const {source, archive} = roots();
  await putFile(source, 'seed.png', 'seed');
  await quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('seed.png', 'seed')], reason: 'test', confirmed: true, idFactory: () => 'seed-id'});
  const original = 'source remains safe';
  await putFile(source, 'collision.png', original);
  const items = await (await archive.getDirectoryHandle('.guardian-quarantine', {create: true})).getDirectoryHandle('items', {create: true});
  const collision = await items.getFileHandle('reserved-id.bin', {create: true});
  collision.blob = new Blob(['unrelated existing file']);
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('collision.png', original)], reason: 'test', confirmed: true, idFactory: () => 'reserved-id'}), {code: 'collision'});
  assert.equal(await collision.getFile().then((file) => file.text()), 'unrelated existing file');
  assert.equal(await hasFile(source, 'collision.png'), true);
});

test('quarantine data has a verified marker and refuses an unrecognized data folder', async () => {
  const {source, archive} = roots();
  await putFile(source, 'safe.png', 'keep original');
  const quarantine = await archive.getDirectoryHandle('.guardian-quarantine', {create: true});
  const items = await quarantine.getDirectoryHandle('items', {create: true});
  assert.equal(await isProtectedQuarantineDirectory(items), false);
  await items.getFileHandle('.guardian-quarantine-marker', {create: true}).then((handle) => { handle.blob = new Blob(['not Guardian data']); });
  assert.equal(await isProtectedQuarantineDirectory(items), false);
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('safe.png', 'keep original')], reason: 'test', confirmed: true}), (error) => /marker/i.test(error.cause?.message ?? ''));
  assert.equal(await hasFile(source, 'safe.png'), true);
});

test('does not claim a pre-existing unknown archive data folder as Guardian quarantine', async () => {
  const {source, archive} = roots();
  await putFile(source, 'safe.png', 'keep original');
  const items = await (await archive.getDirectoryHandle('.guardian-quarantine', {create: true})).getDirectoryHandle('items', {create: true});
  await putFile(items, 'customer-data.bin', 'unrelated bytes');
  await assert.rejects(quarantineFiles({sourceRoot: source, destinationRoot: archive, records: [makeRecord('safe.png', 'keep original')], reason: 'test', confirmed: true}), (error) => /unrecognized/i.test(error.cause?.message ?? ''));
  assert.equal(await hasFile(source, 'safe.png'), true);
  assert.equal(await (await items.getFileHandle('customer-data.bin')).getFile().then((file) => file.text()), 'unrelated bytes');
});
