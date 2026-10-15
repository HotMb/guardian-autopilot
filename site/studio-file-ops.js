export const QUARANTINE_DIRECTORY = '.guardian-quarantine';
export const TRASH_DIRECTORY = 'Corbeille';
export const MAX_QUARANTINE_BATCH = 20;
const MANIFEST_NAME = 'manifest.json';
const DATA_DIRECTORY = 'items';
export const QUARANTINE_MARKER = '.guardian-quarantine-marker';
const QUARANTINE_MARKER_CONTENT = 'Guardian Studio quarantine data directory v1';
const TRASH_MARKER = '.guardian-studio-trash-marker';
const TRASH_MARKER_CONTENT = 'Guardian Studio Corbeille v1';
const CHUNK_BYTES = 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 5000;

const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

function rotateRight(value, shift) { return (value >>> shift) | (value << (32 - shift)); }

/** Incremental SHA-256; memory use is bounded by one 1 MiB stream chunk. */
export class IncrementalSha256 {
  constructor() {
    this.state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buffer = new Uint8Array(64);
    this.buffered = 0;
    this.bytes = 0;
    this.finished = false;
  }
  update(input) {
    if (this.finished) throw new Error('Hash already finalized');
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.bytes += data.byteLength;
    let offset = 0;
    if (this.buffered) {
      const take = Math.min(64 - this.buffered, data.length);
      this.buffer.set(data.subarray(0, take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === 64) { this.#block(this.buffer); this.buffered = 0; }
    }
    while (offset + 64 <= data.length) { this.#block(data.subarray(offset, offset + 64)); offset += 64; }
    if (offset < data.length) { this.buffer.set(data.subarray(offset), 0); this.buffered = data.length - offset; }
    return this;
  }
  #block(block) {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const x = words[i - 15], y = words[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let i = 0; i < 64; i += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choice + SHA256_K[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const next = [a,b,c,d,e,f,g,h];
    for (let i = 0; i < 8; i += 1) this.state[i] = (this.state[i] + next[i]) >>> 0;
  }
  digestHex() {
    if (this.finished) throw new Error('Hash already finalized');
    this.finished = true;
    const bitLength = BigInt(this.bytes) * 8n;
    this.buffer[this.buffered++] = 0x80;
    if (this.buffered > 56) {
      this.buffer.fill(0, this.buffered);
      this.#block(this.buffer);
      this.buffered = 0;
    }
    this.buffer.fill(0, this.buffered, 56);
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Number((bitLength >> 32n) & 0xffffffffn), false);
    view.setUint32(60, Number(bitLength & 0xffffffffn), false);
    this.#block(this.buffer);
    return [...this.state].map((word) => word.toString(16).padStart(8, '0')).join('');
  }
}

function notFound(error) { return error?.name === 'NotFoundError'; }
function cancelled(signal) { return Boolean(signal?.aborted); }
function throwIfCancelled(signal) { if (cancelled(signal)) throw new DOMException('Operation cancelled', 'AbortError'); }
function validatePath(path) {
  const raw = String(path ?? '');
  const parts = raw.split('/');
  if (!raw || raw.includes('\\') || raw.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0') || /[<>:"|?*]/.test(part) || part.toLowerCase() === QUARANTINE_DIRECTORY.toLowerCase()) || parts[0]?.toLowerCase() === TRASH_DIRECTORY.toLowerCase()) {
    throw new Error('Unsafe or protected path');
  }
  return parts;
}
async function childFile(directory, name, create = false) { return directory.getFileHandle(name, {create}); }
async function resolveFile(root, path, create = false) {
  const parts = validatePath(path);
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, {create});
  return childFile(directory, parts.at(-1), create);
}

function archiveScopeError(message, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.code = 'archive-scope';
  return error;
}

/** True only for a Corbeille created or initialized by Guardian Studio. */
export async function isGuardianTrashDirectory(directoryHandle) {
  if (directoryHandle?.kind !== 'directory' || directoryHandle.name?.toLowerCase() !== TRASH_DIRECTORY.toLowerCase()) return false;
  try {
    const marker = await childFile(directoryHandle, TRASH_MARKER);
    return (await (await marker.getFile()).text()) === TRASH_MARKER_CONTENT;
  } catch (error) { if (notFound(error)) return false; throw error; }
}

/** Create Corbeille only when absent or empty; never claim a user folder containing data. */
export async function ensureGuardianTrashDirectory(sourceRoot) {
  if (sourceRoot?.kind !== 'directory' || typeof sourceRoot.getDirectoryHandle !== 'function') {
    throw archiveScopeError('Choose a readable source folder before creating Corbeille.');
  }
  await assertWritePermission(sourceRoot).catch((error) => fail(safeErrorCode(error), 'Grant write access to the selected folder before creating Corbeille.', error));
  let trash;
  try { trash = await sourceRoot.getDirectoryHandle(TRASH_DIRECTORY, {create: true}); }
  catch (error) { fail('archive-scope', 'Guardian could not create Corbeille in the selected folder. No image was changed.', error); }
  if (!await isGuardianTrashDirectory(trash)) {
    let occupied = false;
    try {
      if (typeof trash.values !== 'function') throw new Error('Folder contents cannot be checked');
      for await (const _entry of trash.values()) { occupied = true; break; }
    } catch (error) { fail('archive-scope', 'Guardian could not verify that Corbeille is empty. No image was changed.', error); }
    if (occupied) fail('archive-scope', 'A folder named Corbeille already contains files and is not managed by Guardian. Rename it before using the archive.');
    try {
      const marker = await childFile(trash, TRASH_MARKER, true);
      await writeText(marker, TRASH_MARKER_CONTENT);
    } catch (error) { fail('archive-scope', 'Guardian could not mark Corbeille safely. No image was changed.', error); }
  }
  if (!await isGuardianTrashDirectory(trash)) fail('archive-scope', 'Corbeille does not have a valid Guardian marker. No image was changed.');
  return trash;
}

/** Prove that destinationRoot is the Guardian-managed Corbeille directly inside sourceRoot. */
export async function assertGuardianTrashDestination(sourceRoot, destinationRoot) {
  if (sourceRoot?.kind !== 'directory' || destinationRoot?.kind !== 'directory' || destinationRoot.name?.toLowerCase() !== TRASH_DIRECTORY.toLowerCase()) {
    throw archiveScopeError('Archive must use Guardian’s Corbeille inside the selected source folder.');
  }
  if (typeof sourceRoot.getDirectoryHandle !== 'function' || typeof destinationRoot.isSameEntry !== 'function') {
    throw archiveScopeError('This browser cannot verify Guardian’s Corbeille identity; nothing was changed.');
  }
  let expected;
  try { expected = await sourceRoot.getDirectoryHandle(TRASH_DIRECTORY); }
  catch (error) { throw archiveScopeError('Corbeille is missing from the selected source folder. Reselect the original folder; nothing was changed.', error); }
  let same;
  try { same = await expected.isSameEntry(destinationRoot); }
  catch (error) { throw archiveScopeError('Could not verify Corbeille identity; nothing was changed.', error); }
  if (same !== true || !await isGuardianTrashDirectory(expected)) {
    throw archiveScopeError('The selected Corbeille does not match the Guardian-managed folder in this source. Nothing was changed.');
  }
}

async function readManifest(destinationRoot, create = false) {
  const quarantine = await destinationRoot.getDirectoryHandle(QUARANTINE_DIRECTORY, {create});
  const data = await quarantine.getDirectoryHandle(DATA_DIRECTORY, {create});
  let marker;
  try { marker = await childFile(data, QUARANTINE_MARKER); }
  catch (error) {
    if (!notFound(error) || !create) throw new Error('Quarantine data marker is missing or unreadable; nothing was changed.', {cause: error});
    let existingManifest = false;
    try { await childFile(quarantine, MANIFEST_NAME); existingManifest = true; }
    catch (manifestError) { if (!notFound(manifestError)) throw manifestError; }
    let existingData = false;
    for await (const _entry of data.values()) { existingData = true; break; }
    if (existingManifest || existingData) throw new Error('Unrecognized quarantine data folder; existing files were left untouched. Choose a different archive folder.');
    marker = await childFile(data, QUARANTINE_MARKER, true);
    await writeText(marker, QUARANTINE_MARKER_CONTENT);
  }
  if (await (await marker.getFile()).text() !== QUARANTINE_MARKER_CONTENT) throw new Error('Quarantine data marker does not match Guardian; nothing was changed.');
  let manifestHandle;
  try { manifestHandle = await childFile(quarantine, MANIFEST_NAME); }
  catch (error) {
    if (!notFound(error) || !create) throw error;
    manifestHandle = await childFile(quarantine, MANIFEST_NAME, true);
    const initial = {schemaVersion: 1, entries: []};
    await writeJson(manifestHandle, initial);
    return {quarantine, data, manifestHandle, manifest: initial};
  }
  const file = await manifestHandle.getFile();
  if (file.size > 2_000_000) throw new Error('Quarantine journal exceeds the safe read limit');
  let manifest;
  try { manifest = JSON.parse(await file.text()); } catch { throw new Error('Quarantine journal is unreadable; nothing was changed'); }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_MANIFEST_ENTRIES) {
    throw new Error('Quarantine journal is not a supported Guardian journal; nothing was changed');
  }
  return {quarantine, data, manifestHandle, manifest};
}
async function writeJson(handle, value) {
  const writer = await handle.createWritable({keepExistingData: false, mode: 'exclusive'});
  try { await writer.write(JSON.stringify(value)); await writer.close(); }
  catch (error) { try { await writer.abort?.(); } catch {} throw error; }
}
async function writeText(handle, value) {
  const writer = await handle.createWritable({keepExistingData: false, mode: 'exclusive'});
  try { await writer.write(value); await writer.close(); }
  catch (error) { try { await writer.abort?.(); } catch {} throw error; }
}
async function saveManifest(storage) {
  if (storage.manifest.entries.length > MAX_MANIFEST_ENTRIES) throw new Error('Quarantine journal reached its safety limit');
  await writeJson(storage.manifestHandle, storage.manifest);
}
function entryById(manifest, id) { return manifest.entries.find((entry) => entry.id === id); }
function getStreamReader(file) {
  if (typeof file.stream !== 'function') throw new Error('This browser cannot stream file operations safely');
  return file.stream().getReader();
}
async function writeStreamFile(handle, sourceFile, {signal, onProgress = () => {}, completed = 0, total = sourceFile.size} = {}) {
  const reader = getStreamReader(sourceFile);
  const writer = await handle.createWritable({keepExistingData: false, mode: 'exclusive'});
  let written = 0;
  try {
    while (true) {
      throwIfCancelled(signal);
      const {done, value} = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
        throwIfCancelled(signal);
        const chunk = value.subarray(offset, Math.min(value.byteLength, offset + CHUNK_BYTES));
        await writer.write(chunk);
        written += chunk.byteLength;
        onProgress({phase: 'copy', completed: completed + written, total, fileBytes: written});
      }
    }
    await writer.close();
    if (written !== sourceFile.size) throw new Error('Copy size did not match the source');
    return written;
  } catch (error) {
    try { await reader.cancel(); } catch {}
    try { await writer.abort?.(); } catch {}
    throw error;
  }
}
async function verifyFiles(source, archived, {signal, onProgress = () => {}, completed = 0, total = source.size} = {}) {
  if (source.size !== archived.size) throw new Error('Verification failed: file size changed');
  const hash = new IncrementalSha256();
  for (let offset = 0; offset < source.size; offset += CHUNK_BYTES) {
    throwIfCancelled(signal);
    const end = Math.min(source.size, offset + CHUNK_BYTES);
    const [sourceChunk, archiveChunk] = await Promise.all([
      source.slice(offset, end).arrayBuffer(), archived.slice(offset, end).arrayBuffer(),
    ]);
    const left = new Uint8Array(sourceChunk), right = new Uint8Array(archiveChunk);
    if (left.length !== right.length) throw new Error('Verification failed: byte count changed');
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) throw new Error('Verification failed: file bytes differ');
    hash.update(left);
    onProgress({phase: 'verify', completed: completed + end, total, fileBytes: end});
  }
  return {sha256: hash.digestHex(), sizeBytes: source.size};
}
async function hashFile(file, {signal, onProgress = () => {}} = {}) {
  const reader = getStreamReader(file);
  const hash = new IncrementalSha256();
  let read = 0;
  try {
    while (true) {
      throwIfCancelled(signal);
      const {done, value} = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
        const chunk = value.subarray(offset, Math.min(value.byteLength, offset + CHUNK_BYTES));
        hash.update(chunk); read += chunk.byteLength;
        onProgress({phase: 'verify', completed: read, total: file.size, fileBytes: read});
      }
    }
    return {sha256: hash.digestHex(), sizeBytes: read};
  } finally { try { reader.releaseLock(); } catch {} }
}
function assertWritePermission(handle, mode = 'readwrite') {
  if (typeof handle?.queryPermission !== 'function') return Promise.resolve(true);
  return handle.queryPermission({mode}).then((permission) => {
    if (permission !== 'granted') throw new DOMException('Write access is not currently granted', 'NotAllowedError');
    return true;
  });
}
function safeErrorCode(error) {
  if (error?.name === 'AbortError') return 'cancelled';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'permission';
  if (error?.name === 'QuotaExceededError') return 'space';
  if (error?.name === 'NoModificationAllowedError') return 'write';
  if (/collision|already exists/i.test(error?.message ?? '')) return 'collision';
  if (/verif|byte count|size changed/i.test(error?.message ?? '')) return 'verification';
  return 'write';
}
function fail(code, message, cause) { const error = new Error(message, {cause}); error.code = code; throw error; }

export async function loadQuarantine(destinationRoot) {
  try { return (await readManifest(destinationRoot, false)).manifest; }
  catch (error) { if (notFound(error)) return {schemaVersion: 1, entries: []}; throw error; }
}

export async function isProtectedQuarantineDirectory(directoryHandle) {
  try {
    const marker = await childFile(directoryHandle, QUARANTINE_MARKER);
    return (await (await marker.getFile()).text()) === QUARANTINE_MARKER_CONTENT;
  } catch (error) { if (notFound(error)) return false; throw error; }
}

/** Copy, verify, persist the verified hash, then and only then remove the source. */
export async function quarantineFiles({sourceRoot, destinationRoot, records, reason = 'Manually reviewed in Guardian Studio', confirmed = false, signal, onProgress = () => {}, onResult = () => {}, idFactory = () => crypto.randomUUID(), now = () => new Date().toISOString()}) {
  if (!confirmed) fail('confirmation', 'Review and confirm the exact file list before archiving.');
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_QUARANTINE_BATCH) fail('selection', `Select between 1 and ${MAX_QUARANTINE_BATCH} files per operation.`);
  if (!String(reason ?? '').trim() || String(reason).length > 300) fail('reason', 'The archive note is not valid.');
  await assertGuardianTrashDestination(sourceRoot, destinationRoot);
  await Promise.all([assertWritePermission(sourceRoot), assertWritePermission(destinationRoot)]).catch((error) => fail(safeErrorCode(error), 'Write permission is missing or expired. Re-authorize both selected folders; no source file was removed.', error));
  let paths;
  try { paths = records.map(({path}) => validatePath(path).join('/')); }
  catch (error) { fail('selection', 'The selection includes an unsafe or protected quarantine path. Nothing was changed.', error); }
  if (new Set(paths).size !== paths.length) fail('selection', 'The selection contains the same path more than once.');
  let storage;
  try { storage = await readManifest(destinationRoot, true); }
  catch (error) {
    const message = /marker/i.test(error?.message ?? '')
      ? 'The archive folder has a missing or invalid Guardian marker. Choose a different archive folder; no source file was removed.'
      : /unrecognized quarantine data folder/i.test(error?.message ?? '')
        ? error.message
        : 'The quarantine journal could not be opened safely. No source file was removed.';
    fail(safeErrorCode(error), message, error);
  }
  let sourceBytesRemoved = 0;
  let sourceBytesAlreadyAbsent = 0;
  const outcomes = [];
  for (let index = 0; index < records.length; index += 1) {
    throwIfCancelled(signal);
    await Promise.all([assertWritePermission(sourceRoot), assertWritePermission(destinationRoot)]).catch((error) => fail(safeErrorCode(error), 'A folder write permission expired. The current source file was not removed.', error));
    const record = records[index];
    const path = paths[index];
    let entry = storage.manifest.entries.find((item) => item.sourcePath === path && ['interrupted', 'copying', 'verified'].includes(item.status));
    let sourceHandle;
    try { sourceHandle = await resolveFile(sourceRoot, path); }
    catch (error) {
      if (notFound(error) && entry?.status === 'verified') {
        try {
          const archivedFile = await (await childFile(storage.data, `${entry.id}.bin`)).getFile();
          const archivedHash = await hashFile(archivedFile, {signal, onProgress});
          if (archivedHash.sizeBytes !== entry.sizeBytes || archivedHash.sha256 !== entry.sha256) throw new Error('Stored bytes do not match the verified journal');
          entry.status = 'quarantined'; entry.updatedAt = now(); await saveManifest(storage);
          sourceBytesAlreadyAbsent += entry.sizeBytes;
          outcomes.push({id: entry.id, sourcePath: path, sizeBytes: entry.sizeBytes, status: 'quarantined'});
          onResult({entry, status: 'quarantined'});
          continue;
        } catch (recoveryError) { fail(safeErrorCode(recoveryError), `Recovery check for ${path} failed. The verified archive was not removed.`, recoveryError); }
      }
      fail(safeErrorCode(error), `Could not reopen ${path}. No source file was removed.`, error);
    }
    if (record.handle?.kind === 'file') {
      let sameHandle = false;
      try { sameHandle = typeof sourceHandle.isSameEntry === 'function' && await sourceHandle.isSameEntry(record.handle); }
      catch { /* fail closed below */ }
      if (!sameHandle) fail('selection', `The selected file handle does not match ${path}. Scan the source folder again.`);
    }
    let sourceFile;
    try { sourceFile = await sourceHandle.getFile(); } catch (error) { fail(safeErrorCode(error), `Could not read ${path}. No source file was removed.`, error); }
    if (sourceFile.size !== record.bytes || (record.lastModified && sourceFile.lastModified !== record.lastModified)) {
      fail('verification', `${path} changed since the scan. Scan it again before archiving.`, new Error('Source snapshot changed'));
    }
    if (!record.file || typeof record.file.slice !== 'function' || !Number.isSafeInteger(record.file.size)) {
      fail('verification', `${path} has no readable scan snapshot. Scan it again before archiving.`);
    }
    try {
      await verifyFiles(record.file, sourceFile, {signal, onProgress, total: sourceFile.size});
    } catch (error) {
      fail(safeErrorCode(error), `${path} no longer matches the bytes shown during the scan. Scan it again before archiving.`, error);
    }
    if (!entry) {
      if (storage.manifest.entries.length >= MAX_MANIFEST_ENTRIES) fail('journal-limit', 'The quarantine journal is full; export or purge old entries first.');
      let id;
      for (let attempts = 0; attempts < 10; attempts += 1) {
        id = idFactory();
        if (storage.manifest.entries.some((item) => item.id === id)) { id = null; continue; }
        try { await childFile(storage.data, `${id}.bin`); id = null; }
        catch (error) { if (notFound(error)) break; fail(safeErrorCode(error), 'Could not check a unique archive filename. No source file was removed.', error); }
        id = null;
      }
      if (!id) fail('collision', 'Could not reserve a unique quarantine file name. Nothing was changed.');
      entry = {id, sourcePath: path, sourceRootName: sourceRoot.name ?? '', fileName: record.name, sizeBytes: sourceFile.size, reason: String(reason).trim(), sha256: null, status: 'copying', createdAt: now(), updatedAt: now()};
      storage.manifest.entries.push(entry);
    } else if (entry.sizeBytes !== sourceFile.size) {
      fail('verification', `${path} no longer matches its interrupted archive record. Nothing was changed.`, new Error('Source size changed'));
    }
    const dataName = `${entry.id}.bin`;
    try {
      if (entry.status === 'verified') {
        const archivedHandle = await childFile(storage.data, dataName);
        const result = await verifyFiles(sourceFile, await archivedHandle.getFile(), {signal, onProgress, completed: index * sourceFile.size, total: records.reduce((sum, item) => sum + item.bytes, 0)});
        if (result.sha256 !== entry.sha256) throw new Error('Verification hash did not match the journal');
      } else {
        await saveManifest(storage);
        if (entry.status === 'copying' || entry.status === 'interrupted') {
          try { await storage.data.removeEntry(dataName); } catch (error) { if (!notFound(error)) throw error; }
        }
        const archivedHandle = await childFile(storage.data, dataName, true);
        entry.status = 'copying'; entry.updatedAt = now();
        await saveManifest(storage);
        await writeStreamFile(archivedHandle, sourceFile, {signal, onProgress, completed: index * sourceFile.size, total: records.reduce((sum, item) => sum + item.bytes, 0)});
        const sourceAgain = await sourceHandle.getFile();
        const archivedAgain = await archivedHandle.getFile();
        const result = await verifyFiles(sourceAgain, archivedAgain, {signal, onProgress, completed: index * sourceFile.size, total: records.reduce((sum, item) => sum + item.bytes, 0)});
        entry.sha256 = result.sha256;
        entry.sizeBytes = result.sizeBytes;
        entry.status = 'verified'; entry.updatedAt = now();
        await saveManifest(storage);
      }
      throwIfCancelled(signal);
      // Re-read immediately before deletion; this narrows, but cannot make atomic, external-editor races.
      const latestSource = await sourceHandle.getFile();
      const latestArchive = await (await childFile(storage.data, dataName)).getFile();
      const finalCheck = await verifyFiles(latestSource, latestArchive, {signal, onProgress, completed: index * sourceFile.size, total: records.reduce((sum, item) => sum + item.bytes, 0)});
      if (finalCheck.sha256 !== entry.sha256) throw new Error('Final verification did not match the journal');
      throwIfCancelled(signal);
      await sourceHandle.remove?.();
      if (typeof sourceHandle.remove !== 'function') {
        const parentParts = path.split('/');
        let parent = sourceRoot;
        for (const part of parentParts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
        await parent.removeEntry(parentParts.at(-1));
      }
      sourceBytesRemoved += entry.sizeBytes;
      entry.status = 'quarantined'; entry.updatedAt = now();
      await saveManifest(storage);
      outcomes.push({id: entry.id, sourcePath: path, sizeBytes: entry.sizeBytes, status: 'quarantined'});
      onResult({entry, status: 'quarantined'});
    } catch (error) {
      if (entry.status === 'copying') { entry.status = 'interrupted'; entry.updatedAt = now(); try { await saveManifest(storage); } catch {} }
      fail(safeErrorCode(error), error?.name === 'AbortError'
        ? `Archive paused at ${path}. Check the source and archive journal before resuming; a verified entry may need reconciliation.`
        : `Could not finish archiving ${path}. Check the source and archive journal before retrying; a verified entry may need reconciliation.`, error);
    }
  }
  return {outcomes, sourceBytesRemoved, sourceBytesAlreadyAbsent, manifest: storage.manifest};
}

/** Restore only after a no-conflict preflight; keep the verified archive copy until explicit purge. */
export async function restoreQuarantined({sourceRoot, destinationRoot, ids, confirmed = false, signal, onProgress = () => {}, now = () => new Date().toISOString()}) {
  if (!confirmed) fail('confirmation', 'Review and confirm the exact restore list.');
  await assertGuardianTrashDestination(sourceRoot, destinationRoot);
  const storage = await readManifest(destinationRoot, false);
  await Promise.all([assertWritePermission(sourceRoot), assertWritePermission(destinationRoot)]).catch((error) => fail(safeErrorCode(error), 'Write permission is missing or expired. The archive was not removed.', error));
  const entries = ids.map((id) => entryById(storage.manifest, id));
  if (!entries.length || entries.some((entry) => !entry || entry.status !== 'quarantined')) fail('selection', 'Only currently quarantined items can be restored.');
  if (entries.some((entry) => entry.sourceRootName && entry.sourceRootName !== sourceRoot.name)) fail('source-root', 'The selected source folder name does not match the archive journal. Choose the original source folder before restoring.');
  let restoredBytes = 0;
  for (const entry of entries) {
    throwIfCancelled(signal);
    await Promise.all([assertWritePermission(sourceRoot), assertWritePermission(destinationRoot)]).catch((error) => fail(safeErrorCode(error), 'A folder write permission expired. The quarantine copy was retained.', error));
    const archivedHandle = await childFile(storage.data, `${entry.id}.bin`);
    const archivedFile = await archivedHandle.getFile();
    if (archivedFile.size !== entry.sizeBytes) fail('verification', `Archive verification failed for ${entry.sourcePath}; the archive was kept.`);
    let target;
    try { target = await resolveFile(sourceRoot, entry.sourcePath); }
    catch (error) { if (!notFound(error)) fail(safeErrorCode(error), `Could not check restore path ${entry.sourcePath}; archive retained.`, error); }
    if (target) fail('collision', `Restore stopped: ${entry.sourcePath} already exists. It was not overwritten.`);
    const targetHandle = await resolveFile(sourceRoot, entry.sourcePath, true);
    try {
      await writeStreamFile(targetHandle, archivedFile, {signal, onProgress, total: entry.sizeBytes});
      const restoredFile = await targetHandle.getFile();
      const verified = await verifyFiles(archivedFile, restoredFile, {signal, onProgress, total: entry.sizeBytes});
      if (verified.sha256 !== entry.sha256) throw new Error('Restore hash did not match the journal');
      // Keep the verified archive copy; a separate explicit purge is required to reclaim archive storage.
      entry.status = 'restored'; entry.updatedAt = now();
      await saveManifest(storage);
      restoredBytes += entry.sizeBytes;
    } catch (error) {
      fail(safeErrorCode(error), `Could not complete restore of ${entry.sourcePath}. The quarantine copy was retained. Inspect the target path before retrying; a partial target may remain.`, error);
    }
  }
  return {restoredBytes, manifest: storage.manifest};
}

/** Recover a crash after the verified-journal commit; explicit confirmation is still required. */
export async function reconcileVerifiedQuarantine({sourceRoot, destinationRoot, ids, confirmed = false, sourceRootConfirmed = false, signal, onProgress = () => {}, now = () => new Date().toISOString()}) {
  if (!confirmed) fail('confirmation', 'Review and confirm the exact interrupted archive entries.');
  if (!sourceRootConfirmed) fail('confirmation', 'Explicitly confirm that the selected source folder is the original folder for these archive entries.');
  await assertGuardianTrashDestination(sourceRoot, destinationRoot);
  const storage = await readManifest(destinationRoot, false);
  await Promise.all([assertWritePermission(sourceRoot), assertWritePermission(destinationRoot)]).catch((error) => fail(safeErrorCode(error), 'Write permission is missing or expired. Nothing was finalized.', error));
  const entries = ids.map((id) => entryById(storage.manifest, id));
  if (!entries.length || entries.some((entry) => !entry || entry.status !== 'verified')) fail('selection', 'Only verified, interrupted archive entries can be reconciled.');
  if (typeof sourceRoot?.name !== 'string' || sourceRoot.name === ''
    || entries.some((entry) => typeof entry.sourceRootName !== 'string' || entry.sourceRootName === '' || entry.sourceRootName !== sourceRoot.name)) {
    fail('source-root', 'The selected source folder name does not match the original folder recorded in the archive journal. Choose the original source folder.');
  }
  let sourceBytesRemoved = 0;
  let sourceBytesAlreadyAbsent = 0;
  for (const entry of entries) {
    throwIfCancelled(signal);
    await Promise.all([assertWritePermission(sourceRoot), assertWritePermission(destinationRoot)]).catch((error) => fail(safeErrorCode(error), 'A folder write permission expired. No further source entries were removed.', error));
    const archiveFile = await (await childFile(storage.data, `${entry.id}.bin`)).getFile();
    const archiveHash = await hashFile(archiveFile, {signal, onProgress});
    if (archiveHash.sizeBytes !== entry.sizeBytes || archiveHash.sha256 !== entry.sha256) fail('verification', `Archive integrity check failed for ${entry.sourcePath}. The archive was kept.`);
    let sourceHandle;
    try { sourceHandle = await resolveFile(sourceRoot, entry.sourcePath); }
    catch (error) {
      if (!notFound(error)) fail(safeErrorCode(error), `Could not check ${entry.sourcePath}; journal state was not changed.`, error);
      entry.status = 'quarantined'; entry.updatedAt = now(); await saveManifest(storage);
      sourceBytesAlreadyAbsent += entry.sizeBytes;
      continue;
    }
    const sourceFile = await sourceHandle.getFile();
    const comparison = await verifyFiles(sourceFile, archiveFile, {signal, onProgress});
    if (comparison.sha256 !== entry.sha256) fail('verification', `${entry.sourcePath} no longer matches the verified archive. Source and archive were kept.`);
    throwIfCancelled(signal);
    const parts = entry.sourcePath.split('/'); let parent = sourceRoot;
    for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
    await parent.removeEntry(parts.at(-1));
    entry.status = 'quarantined'; entry.updatedAt = now(); await saveManifest(storage);
    sourceBytesRemoved += entry.sizeBytes;
  }
  return {sourceBytesRemoved, sourceBytesAlreadyAbsent, manifest: storage.manifest};
}

/** Irreversible purge; the page must require a separate, explicit user confirmation. */
export async function purgeQuarantined({destinationRoot, ids, confirmed = false, signal, onProgress = () => {}, now = () => new Date().toISOString()}) {
  if (!confirmed) fail('confirmation', 'Confirm permanent deletion after reviewing the listed Corbeille files.');
  if (destinationRoot?.name?.toLowerCase() !== TRASH_DIRECTORY.toLowerCase() || !await isGuardianTrashDirectory(destinationRoot)) {
    fail('archive-scope', 'Permanent deletion is limited to Guardian-managed Corbeille data.');
  }
  const storage = await readManifest(destinationRoot, false);
  await assertWritePermission(destinationRoot).catch((error) => fail(safeErrorCode(error), 'Write permission is missing or expired. No quarantine file was purged.', error));
  const entries = ids.map((id) => entryById(storage.manifest, id));
  if (!entries.length || entries.some((entry) => !entry || !['quarantined', 'restored', 'purging'].includes(entry.status))) fail('selection', 'Only archived or restored archive copies can be purged.');
  const selectedBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  let removedBytes = 0;
  for (const [index, entry] of entries.entries()) {
    throwIfCancelled(signal);
    await assertWritePermission(destinationRoot).catch((error) => fail(safeErrorCode(error), 'Archive write permission expired. No further archive data was purged.', error));
    try {
      const fileName = `${entry.id}.bin`;
      let archiveFile;
      try { archiveFile = await (await childFile(storage.data, fileName)).getFile(); }
      catch (error) {
        if (notFound(error) && entry.status === 'purging') {
          entry.status = 'purged'; entry.updatedAt = now(); await saveManifest(storage); removedBytes += entry.sizeBytes; continue;
        }
        throw error;
      }
      const integrity = await hashFile(archiveFile, {signal, onProgress});
      if (integrity.sizeBytes !== entry.sizeBytes || integrity.sha256 !== entry.sha256) throw new Error(`Verification failed before purge: ${entry.sourcePath}`);
      entry.status = 'purging'; entry.updatedAt = now(); await saveManifest(storage);
      throwIfCancelled(signal);
      await storage.data.removeEntry(fileName);
      entry.status = 'purged'; entry.updatedAt = now();
      await saveManifest(storage);
      removedBytes += entry.sizeBytes;
      onProgress({phase: 'purge', completed: removedBytes, total: selectedBytes, item: index + 1, itemCount: entries.length});
    } catch (error) { fail(safeErrorCode(error), `Could not purge ${entry.sourcePath}. ${removedBytes} bytes were removed from quarantine in this operation; check the journal before retrying.`, error); }
  }
  return {purgedBytes: removedBytes, manifest: storage.manifest};
}

export function quarantineErrorMessage(error) {
  const prefix = error?.code === 'permission' ? 'Permission needed'
    : error?.code === 'collision' ? 'Path conflict'
      : error?.code === 'space' ? 'Not enough available space'
      : error?.code === 'verification' || /verification failed/i.test(error?.message ?? '') ? 'Verification stopped'
          : error?.code === 'cancelled' ? 'Operation paused'
            : error?.code === 'confirmation' ? 'Confirm the operation'
              : error?.code === 'selection' ? 'Review the selection'
                : 'Operation stopped safely';
  return `${prefix}. ${error?.message ?? 'No further detail is available.'}`;
}
