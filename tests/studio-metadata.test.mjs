import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePngGenerationMetadata} from '../site/studio-metadata.js';

const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type, data) {
  const value = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const chunk = new Uint8Array(12 + value.length);
  new DataView(chunk.buffer).setUint32(0, value.length, false);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(value, 8);
  // The parser reads text metadata only; a zero CRC is sufficient for these
  // isolated parser fixtures because it deliberately does not validate image integrity.
  new DataView(chunk.buffer).setUint32(8 + value.length, 0, false);
  return chunk;
}

function joinBytes(...parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function textChunk(keyword, value) {
  return pngChunk('tEXt', joinBytes(new TextEncoder().encode(keyword), Uint8Array.of(0), new TextEncoder().encode(value)));
}

function internationalTextChunk(keyword, value) {
  return pngChunk('iTXt', joinBytes(
    new TextEncoder().encode(keyword), Uint8Array.of(0, 0, 0, 0, 0),
    // keyword separator, compression flag/method, empty language and translated keyword
    new TextEncoder().encode(value),
  ));
}

function png(...chunks) {
  return joinBytes(signature, ...chunks, pngChunk('IEND', new Uint8Array()));
}

test('parses Stable Diffusion WebUI parameters without losing the original text', () => {
  const parameters = 'a cinematic forest, warm light\nNegative prompt: blurry, low quality\nSteps: 28, Sampler: DPM++ 2M, Seed: 42';
  const result = parsePngGenerationMetadata(png(textChunk('parameters', parameters)));

  assert.equal(result.status, 'complete');
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].key, 'parameters');
  assert.equal(result.fields[0].value, parameters);
  assert.equal(result.fields[0].producer, 'Stable Diffusion WebUI');
});

test('parses ComfyUI prompt and workflow text from uncompressed iTXt chunks', () => {
  const prompt = JSON.stringify({ '4': { class_type: 'KSampler', inputs: { seed: 42 } } });
  const workflow = JSON.stringify({ nodes: [{ id: 1, type: 'CLIPTextEncode' }, { id: 2, type: 'KSampler' }] });
  const result = parsePngGenerationMetadata(png(
    internationalTextChunk('prompt', prompt),
    internationalTextChunk('workflow', workflow),
  ));

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.fields.map(({key, producer}) => [key, producer]), [
    ['prompt', 'ComfyUI'], ['workflow', 'ComfyUI'],
  ]);
  assert.equal(result.fields[0].value, prompt);
  assert.equal(result.fields[1].value, workflow);
});

test('does not claim metadata is absent when the PNG is truncated before IEND', () => {
  const bytes = joinBytes(signature, textChunk('parameters', 'safe prompt'), pngChunk('IDAT', new Uint8Array(32)));
  const result = parsePngGenerationMetadata(bytes);

  assert.equal(result.status, 'incomplete');
  assert.equal(result.fields[0].value, 'safe prompt');
});

test('reports a malformed chunk length as incomplete instead of throwing', () => {
  const malformed = joinBytes(signature, Uint8Array.from([0, 0, 1, 0, 116, 69, 88, 116, 0]));

  assert.equal(parsePngGenerationMetadata(malformed).status, 'incomplete');
});

test('rejects non-PNG input and never invents generation fields', () => {
  assert.deepEqual(parsePngGenerationMetadata(new TextEncoder().encode('not a png')), {
    status: 'invalid', fields: [], unsupportedKeys: [],
  });
  assert.deepEqual(parsePngGenerationMetadata(png(textChunk('Comment', 'ordinary note'))), {
    status: 'complete', fields: [], unsupportedKeys: [],
  });
});

test('marks compressed generation metadata unsupported rather than reporting it absent', () => {
  const value = joinBytes(new TextEncoder().encode('workflow'), Uint8Array.of(0, 0));
  const result = parsePngGenerationMetadata(png(pngChunk('zTXt', value)));

  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.unsupportedKeys, ['workflow']);
  assert.deepEqual(result.fields, []);
});

test('bounds a metadata value and marks it as truncated', () => {
  const value = 'x'.repeat(128);
  const result = parsePngGenerationMetadata(png(textChunk('parameters', value)), {maxFieldCharacters: 32});

  assert.equal(result.fields[0].value, 'x'.repeat(32));
  assert.equal(result.fields[0].truncated, true);
});
