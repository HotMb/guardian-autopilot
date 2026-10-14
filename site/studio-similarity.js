const SAMPLE_SIDE = 32;
const LOW_FREQUENCIES = 8;
const HASH_MASK = (1n << 64n) - 1n;
const VISUAL_IMAGE_TYPES = new Set(['PNG', 'JPEG', 'WEBP', 'AVIF']);
const DEFAULT_MAX_DISTANCE = 5;
const DEFAULT_MAX_CANDIDATE_PAIRS = 50_000;

const dctBasis = Array.from({length: LOW_FREQUENCIES}, (_, frequency) =>
  Float64Array.from({length: SAMPLE_SIDE}, (_, sample) => {
    const scale = frequency === 0 ? Math.sqrt(1 / SAMPLE_SIDE) : Math.sqrt(2 / SAMPLE_SIDE);
    return scale * Math.cos((Math.PI * (2 * sample + 1) * frequency) / (2 * SAMPLE_SIDE));
  }));

/** Build a compact perceptual hash from an already bounded RGBA thumbnail. */
export function perceptualHashFromRgba(rgba, width = SAMPLE_SIDE, height = SAMPLE_SIDE) {
  if (width !== SAMPLE_SIDE || height !== SAMPLE_SIDE || rgba?.length !== SAMPLE_SIDE * SAMPLE_SIDE * 4) {
    throw new TypeError('Perceptual hashing requires a 32 by 32 RGBA sample');
  }

  const grayscale = new Float64Array(SAMPLE_SIDE * SAMPLE_SIDE);
  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    const offset = pixel * 4;
    const alpha = rgba[offset + 3] / 255;
    const luminance = rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114;
    grayscale[pixel] = luminance * alpha + 255 * (1 - alpha);
  }

  const horizontal = new Float64Array(SAMPLE_SIDE * LOW_FREQUENCIES);
  for (let y = 0; y < SAMPLE_SIDE; y += 1) {
    for (let u = 0; u < LOW_FREQUENCIES; u += 1) {
      let sum = 0;
      for (let x = 0; x < SAMPLE_SIDE; x += 1) sum += grayscale[y * SAMPLE_SIDE + x] * dctBasis[u][x];
      horizontal[y * LOW_FREQUENCIES + u] = sum;
    }
  }

  const coefficients = [];
  for (let v = 0; v < LOW_FREQUENCIES; v += 1) {
    for (let u = 0; u < LOW_FREQUENCIES; u += 1) {
      let sum = 0;
      for (let y = 0; y < SAMPLE_SIDE; y += 1) sum += horizontal[y * LOW_FREQUENCIES + u] * dctBasis[v][y];
      if (v !== 0 || u !== 0) coefficients.push(sum);
    }
  }
  const sorted = [...coefficients].sort((first, second) => first - second);
  const median = sorted[Math.floor(sorted.length / 2)];
  let hash = 0n;
  for (let index = 0; index < coefficients.length; index += 1) {
    if (coefficients[index] > median) hash |= 1n << BigInt(index);
  }
  return hash & HASH_MASK;
}

/** Decode and downsample a local raster image entirely in the current browser context. */
export async function perceptualHashFile(file) {
  if (typeof globalThis.createImageBitmap !== 'function') throw new Error('This browser cannot decode local image thumbnails');
  const bitmap = await globalThis.createImageBitmap(file, {
    resizeWidth: SAMPLE_SIDE,
    resizeHeight: SAMPLE_SIDE,
    resizeQuality: 'low',
    imageOrientation: 'from-image',
  });
  try {
    const canvas = typeof globalThis.OffscreenCanvas === 'function'
      ? new globalThis.OffscreenCanvas(SAMPLE_SIDE, SAMPLE_SIDE)
      : globalThis.document?.createElement('canvas');
    if (!canvas) throw new Error('This browser cannot prepare local image thumbnails');
    canvas.width = SAMPLE_SIDE;
    canvas.height = SAMPLE_SIDE;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) throw new Error('This browser cannot read local image thumbnails');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, SAMPLE_SIDE, SAMPLE_SIDE);
    context.drawImage(bitmap, 0, 0, SAMPLE_SIDE, SAMPLE_SIDE);
    return perceptualHashFromRgba(context.getImageData(0, 0, SAMPLE_SIDE, SAMPLE_SIDE).data);
  } finally {
    bitmap.close?.();
  }
}

export function hammingDistance(first, second) {
  let value = (BigInt(first) ^ BigInt(second)) & HASH_MASK;
  let distance = 0;
  while (value !== 0n) {
    value &= value - 1n;
    distance += 1;
  }
  return distance;
}

function bandKey(hash, band) {
  const start = Math.floor(band * 64 / 6);
  const end = Math.floor((band + 1) * 64 / 6);
  const width = end - start;
  return (hash >> BigInt(start)) & ((1n << BigInt(width)) - 1n);
}

/** Group only compact-hash candidates; this is a review hint, never an equivalence proof. */
export async function groupPerceptualHashes(entries, {
  maxDistance = DEFAULT_MAX_DISTANCE,
  maxCandidatePairs = DEFAULT_MAX_CANDIDATE_PAIRS,
  shouldCancel = () => false,
  onProgress = () => {},
  yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  if (!Number.isInteger(maxDistance) || maxDistance < 0 || maxDistance > 5) {
    throw new RangeError('Perceptual candidate distance must be between 0 and 5 bits');
  }
  if (!Number.isSafeInteger(maxCandidatePairs) || maxCandidatePairs < 0) {
    throw new RangeError('The candidate-pair limit must be a non-negative safe integer');
  }

  const hashGroups = new Map();
  for (const entry of entries) {
    const hash = BigInt(entry.hash);
    if (hash < 0n || hash > HASH_MASK) continue;
    const group = hashGroups.get(hash) ?? [];
    group.push(entry.record);
    hashGroups.set(hash, group);
  }
  const nodes = [...hashGroups.entries()]
    .map(([hash, records]) => ({hash, records: records.sort((a, b) => String(a.path ?? a.id).localeCompare(String(b.path ?? b.id)))}))
    .sort((first, second) => first.hash < second.hash ? -1 : first.hash > second.hash ? 1 : 0);

  const bands = Array.from({length: 6}, () => new Map());
  for (let index = 0; index < nodes.length; index += 1) {
    for (let band = 0; band < bands.length; band += 1) {
      const key = bandKey(nodes[index].hash, band);
      const bucket = bands[band].get(key) ?? [];
      bucket.push(index);
      bands[band].set(key, bucket);
    }
  }

  const groups = [];
  const assigned = new Set();
  const stats = {hashedFiles: entries.length, uniqueHashes: nodes.length, candidatePairs: 0, candidatePairsCapped: false, candidateGroups: 0};
  let cancelled = false;
  let comparisonsSinceYield = 0;
  let stop = false;
  for (let index = 0; index < nodes.length && !stop; index += 1) {
    if (shouldCancel()) { cancelled = true; break; }
    if (assigned.has(index)) continue;
    const cluster = [index];
    assigned.add(index);
    const candidates = new Set();
    for (let band = 0; band < bands.length; band += 1) {
      const bucket = bands[band].get(bandKey(nodes[index].hash, band)) ?? [];
      for (const candidate of bucket) if (candidate > index && !assigned.has(candidate)) candidates.add(candidate);
    }

    for (const candidate of [...candidates].sort((first, second) => first - second)) {
      if (shouldCancel()) { cancelled = true; stop = true; break; }
      if (assigned.has(candidate)) continue;
      if (stats.candidatePairs >= maxCandidatePairs) {
        stats.candidatePairsCapped = true;
        stop = true;
        break;
      }
      stats.candidatePairs += 1;
      comparisonsSinceYield += 1;
      if (hammingDistance(nodes[index].hash, nodes[candidate].hash) > maxDistance) continue;
      let fits = true;
      for (const member of cluster.slice(1)) {
        if (stats.candidatePairs >= maxCandidatePairs) {
          stats.candidatePairsCapped = true;
          stop = true;
          fits = false;
          break;
        }
        stats.candidatePairs += 1;
        comparisonsSinceYield += 1;
        if (hammingDistance(nodes[member].hash, nodes[candidate].hash) > maxDistance) { fits = false; break; }
      }
      if (fits) { cluster.push(candidate); assigned.add(candidate); }
      if (comparisonsSinceYield >= 500) {
        onProgress({phase: 'visual-group', completed: index + 1, total: nodes.length, candidatePairs: stats.candidatePairs});
        await yieldToBrowser();
        comparisonsSinceYield = 0;
      }
      if (stop) break;
    }
    if (cluster.length > 1 || nodes[index].records.length > 1) {
      groups.push(cluster.flatMap((member) => nodes[member].records));
    }
    onProgress({phase: 'visual-group', completed: index + 1, total: nodes.length, candidatePairs: stats.candidatePairs});
    if (index % 40 === 39) await yieldToBrowser();
  }
  stats.candidateGroups = groups.length;
  return {groups, stats, cancelled: cancelled || shouldCancel()};
}

/** Decode supported raster images and create deterministic, bounded candidate groups locally. */
export async function findVisualSimilarityGroups(records, {
  hashFile = perceptualHashFile,
  maxDistance = DEFAULT_MAX_DISTANCE,
  maxCandidatePairs = DEFAULT_MAX_CANDIDATE_PAIRS,
  shouldCancel = () => false,
  onProgress = () => {},
  yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  const eligible = [];
  let skippedFormats = 0;
  for (const record of records) {
    const type = String(record.type ?? '').toUpperCase();
    if (VISUAL_IMAGE_TYPES.has(type)) eligible.push(record);
    else skippedFormats += 1;
  }
  const stats = {eligibleFiles: eligible.length, hashedFiles: 0, skippedFormats, readFailures: 0, candidatePairs: 0, candidatePairsCapped: false, candidateGroups: 0};
  const hashes = [];
  let cancelled = false;

  for (let index = 0; index < eligible.length; index += 1) {
    if (shouldCancel()) { cancelled = true; break; }
    try {
      hashes.push({record: eligible[index], hash: await hashFile(eligible[index].file)});
      stats.hashedFiles += 1;
    } catch {
      stats.readFailures += 1;
    }
    onProgress({phase: 'visual-hash', completed: index + 1, total: eligible.length, hashedFiles: stats.hashedFiles, readFailures: stats.readFailures});
    await yieldToBrowser();
  }
  if (shouldCancel()) cancelled = true;
  if (cancelled) return {groups: [], stats, cancelled: true};

  const grouped = await groupPerceptualHashes(hashes, {
    maxDistance,
    maxCandidatePairs,
    shouldCancel,
    onProgress,
    yieldToBrowser,
  });
  Object.assign(stats, grouped.stats);
  stats.eligibleFiles = eligible.length;
  stats.skippedFormats = skippedFormats;
  stats.readFailures += Math.max(0, eligible.length - stats.hashedFiles - stats.readFailures);
  return {groups: grouped.groups, stats, cancelled: grouped.cancelled};
}
