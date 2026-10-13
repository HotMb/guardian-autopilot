const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const GENERATION_KEYS = new Set([
  'parameters', 'prompt', 'workflow', 'software', 'source', 'seed',
  'negative_prompt', 'negative prompt', 'model', 'sampler', 'steps', 'cfg_scale',
]);
const PRODUCERS = new Map([
  ['parameters', 'Stable Diffusion WebUI'],
  ['prompt', 'ComfyUI'],
  ['workflow', 'ComfyUI'],
]);

function findNull(bytes, start, end) {
  for (let index = start; index < end; index += 1) if (bytes[index] === 0) return index;
  return -1;
}

function decode(bytes, encoding) {
  return new TextDecoder(encoding, {fatal: false}).decode(bytes);
}

function normalizedKey(bytes) {
  return decode(bytes, 'latin1').trim().toLowerCase();
}

function extractTextChunk(type, data) {
  const separator = findNull(data, 0, data.length);
  if (separator <= 0 || separator > 79) return null;
  const key = normalizedKey(data.subarray(0, separator));
  if (!GENERATION_KEYS.has(key)) return null;

  if (type === 'tEXt') {
    return {key, value: decode(data.subarray(separator + 1), 'latin1'), encoding: 'Latin-1'};
  }

  if (type === 'zTXt') return {key, compressed: true};

  const fields = data.subarray(separator + 1);
  if (fields.length < 3) return {key, malformed: true};
  const compressionFlag = fields[0];
  const compressionMethod = fields[1];
  const languageEnd = findNull(fields, 2, fields.length);
  if (languageEnd < 0) return {key, malformed: true};
  const translatedEnd = findNull(fields, languageEnd + 1, fields.length);
  if (translatedEnd < 0) return {key, malformed: true};
  if (compressionFlag !== 0 || compressionMethod !== 0) return {key, compressed: true};
  return {key, value: decode(fields.subarray(translatedEnd + 1), 'utf-8'), encoding: 'UTF-8'};
}

function boundedField(field, maxFieldCharacters) {
  const truncated = field.value.length > maxFieldCharacters;
  return {
    key: field.key,
    producer: PRODUCERS.get(field.key) ?? 'PNG metadata',
    encoding: field.encoding,
    value: truncated ? field.value.slice(0, maxFieldCharacters) : field.value,
    truncated,
  };
}

/** Read only the recognized, uncompressed PNG text fields used by image generators. */
export function parsePngGenerationMetadata(input, {maxFieldCharacters = 256_000} = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return {status: 'invalid', fields: [], unsupportedKeys: []};
  }

  const fields = [];
  const unsupportedKeys = new Set();
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const chunkLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    const type = decode(bytes.subarray(offset + 4, offset + 8), 'ascii');
    const dataStart = offset + 8;
    const chunkEnd = dataStart + chunkLength + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      return {status: 'incomplete', fields, unsupportedKeys: [...unsupportedKeys]};
    }

    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const extracted = extractTextChunk(type, bytes.subarray(dataStart, dataStart + chunkLength));
      if (extracted?.compressed) unsupportedKeys.add(extracted.key);
      else if (extracted?.malformed) return {status: 'incomplete', fields, unsupportedKeys: [...unsupportedKeys]};
      else if (extracted?.value !== undefined) fields.push(boundedField(extracted, maxFieldCharacters));
    }

    offset = chunkEnd;
    if (type === 'IEND') {
      return {
        status: unsupportedKeys.size > 0 && fields.length === 0 ? 'unsupported' : 'complete',
        fields,
        unsupportedKeys: [...unsupportedKeys],
      };
    }
  }
  return {status: 'incomplete', fields, unsupportedKeys: [...unsupportedKeys]};
}
