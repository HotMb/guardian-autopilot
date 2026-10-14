const DEFAULT_MAX_HASH_BYTES = 64 * 1024 * 1024;
const COMPARE_CHUNK_BYTES = 1024 * 1024;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']);

export function imageTypeFromName(name) {
  const extension = String(name).split('.').pop()?.toLowerCase() ?? '';
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return null;
  return extension === 'jpg' ? 'JPEG' : extension.toUpperCase();
}

function folderFromPath(path) {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'Root';
}

function compareBySize(first, second) {
  return first.bytes - second.bytes || first.path.localeCompare(second.path);
}

function pushLargest(heap, record, limit) {
  if (heap.length < limit) {
    heap.push(record);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareBySize(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }
  if (compareBySize(record, heap[0]) <= 0) return;
  heap[0] = record;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && compareBySize(heap[left], heap[smallest]) < 0) smallest = left;
    if (right < heap.length && compareBySize(heap[right], heap[smallest]) < 0) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

/** Read a potentially large recursive file listing without retaining every File handle. */
export async function collectImageInventory(entries, {
  maxRecords = 10_000,
  maxEntries = 250_000,
  shouldCancel = () => false,
  onProgress = () => {},
  yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0)),
  progressEvery = 250,
} = {}) {
  const largest = [];
  let entriesScanned = 0;
  let imageCount = 0;
  let imageBytes = 0;
  let unreadableFiles = 0;
  let capped = false;
  let cancelled = false;

  for await (const entry of entries) {
    if (shouldCancel()) { cancelled = true; break; }
    entriesScanned += 1;
    if (entriesScanned > maxEntries) { capped = true; entriesScanned = maxEntries; break; }
    if (entry?.kind === 'error') unreadableFiles += 1;
    if (entry?.kind === 'file' && entry.file) {
      const type = imageTypeFromName(entry.file.name);
      if (type) {
        imageCount += 1;
        imageBytes += entry.file.size;
        let path = entry.path || entry.file.webkitRelativePath || entry.file.name;
        if (!entry.path && entry.file.webkitRelativePath) path = path.replace(/^[^/]+\//, '');
        path = String(path).replace(/\\/g, '/');
        const record = {
          file: entry.file,
          handle: entry.handle ?? null,
          name: entry.file.name,
          path,
          folder: folderFromPath(path),
          bytes: entry.file.size,
          lastModified: entry.file.lastModified ?? 0,
          type,
          src: null,
          duplicateGroup: null,
          isDemo: false,
        };
        pushLargest(largest, record, maxRecords);
      }
    }
    if (entriesScanned % progressEvery === 0) {
      onProgress({phase: 'inventory', entriesScanned, imageCount, imageBytes, unreadableFiles});
      await yieldToBrowser();
    }
  }
  if (shouldCancel()) cancelled = true;
  onProgress({phase: 'inventory', entriesScanned, imageCount, imageBytes, unreadableFiles, capped, cancelled});
  const records = largest.sort((first, second) => second.bytes - first.bytes || first.path.localeCompare(second.path));
  return {records, entriesScanned, imageCount, imageBytes, unreadableFiles, capped, cancelled};
}

export function buildReviewPlan(records, selectedIds, inventory, {createdAt = new Date().toISOString()} = {}) {
  const selected = records.filter((record) => selectedIds.has(record.id));
  const candidateSizeBytes = selected.reduce((sum, record) => sum + record.bytes, 0);
  return {
    schemaVersion: 1,
    product: 'Guardian Studio',
    createdAt,
    scan: {
      complete: Boolean(inventory.complete),
      totalImageCount: inventory.totalImageCount,
      totalImageBytes: inventory.totalImageBytes,
      retainedForReview: inventory.retainedForReview,
    },
    candidateSizeBytes,
    spaceActuallyFreedBytes: 0,
    candidates: selected.map(({path, bytes, type, duplicateGroup, similarGroup}) => ({
      relativePath: path,
      sizeBytes: bytes,
      type,
      confirmedExactDuplicate: Boolean(duplicateGroup),
      visuallySimilarCandidate: Boolean(similarGroup),
    })),
    note: 'Human review only. This export does not delete, move, or change files; no space has been freed.',
  };
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function defaultDigest(file) {
  const data = await file.arrayBuffer();
  return bytesToHex(await globalThis.crypto.subtle.digest('SHA-256', data));
}

async function filesEqualInChunks(first, second, shouldCancel) {
  if (first.size !== second.size) return false;
  for (let offset = 0; offset < first.size; offset += COMPARE_CHUNK_BYTES) {
    if (shouldCancel()) return null;
    const end = Math.min(first.size, offset + COMPARE_CHUNK_BYTES);
    const [left, right] = await Promise.all([
      first.slice(offset, end).arrayBuffer(),
      second.slice(offset, end).arrayBuffer(),
    ]);
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  }
  return !shouldCancel();
}

/** Hash same-size candidates, then compare bytes in bounded chunks before confirming duplicates. */
export async function findExactDuplicateGroups(records, {
  maxHashBytes = DEFAULT_MAX_HASH_BYTES,
  digest = defaultDigest,
  shouldCancel = () => false,
  onProgress = () => {},
  yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  const sizeGroups = new Map();
  let skippedLargeFiles = 0;
  for (const record of records) {
    const size = record.file?.size;
    if (!Number.isSafeInteger(size) || size < 0) continue;
    if (size > maxHashBytes) { skippedLargeFiles += 1; continue; }
    if (size === 0) continue;
    const group = sizeGroups.get(size) ?? [];
    group.push(record);
    sizeGroups.set(size, group);
  }

  const candidates = [...sizeGroups.values()].filter((group) => group.length > 1).flat();
  const stats = {candidateFiles: candidates.length, hashedFiles: 0, skippedLargeFiles, readFailures: 0, confirmedGroups: 0};
  const hashes = new Map();
  let cancelled = false;

  for (const record of candidates) {
    if (shouldCancel()) { cancelled = true; break; }
    try {
      const hash = await digest(record.file);
      stats.hashedFiles += 1;
      const group = hashes.get(hash) ?? [];
      group.push(record);
      hashes.set(hash, group);
    } catch {
      stats.readFailures += 1;
    }
    onProgress({phase: 'hash', completed: stats.hashedFiles + stats.readFailures, hashedFiles: stats.hashedFiles, total: candidates.length});
    if ((stats.hashedFiles + stats.readFailures) % 3 === 0) await yieldToBrowser();
  }
  if (shouldCancel()) cancelled = true;

  const groups = [];
  let comparisons = 0;
  if (!cancelled) {
    outer: for (const hashed of hashes.values()) {
      if (hashed.length < 2) continue;
      const partitions = [];
      for (const record of hashed) {
        if (shouldCancel()) { cancelled = true; break outer; }
        let matched = false;
        for (const partition of partitions) {
          comparisons += 1;
          let equal;
          try {
            equal = await filesEqualInChunks(partition[0].file, record.file, shouldCancel);
          } catch {
            stats.readFailures += 1;
            continue;
          }
          if (equal === null) { cancelled = true; break outer; }
          if (equal) { partition.push(record); matched = true; break; }
        }
        if (!matched) partitions.push([record]);
        onProgress({phase: 'verify', completed: comparisons, total: comparisons});
      }
      groups.push(...partitions.filter((partition) => partition.length > 1));
    }
  }

  stats.confirmedGroups = groups.length;
  return {groups, stats, cancelled};
}
