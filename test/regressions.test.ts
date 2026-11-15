import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeMp3, Mp3Encoder } from '../src/index.ts';
import type { Mp3EncoderOptions } from '../src/index.ts';
import { makeSignal } from './signals.ts';

function finish(enc: Mp3Encoder, chunks: Uint8Array[]): Uint8Array {
  chunks.push(enc.flush());
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  const tag = enc.getLameTagFrame();
  if (tag) out.set(tag, 0);
  return out;
}

for (const [sampleRate, outSampleRate, channels, seconds] of [
  [8000, 48000, 2, 1],
  [16000, 48000, 1, 1],
  [22050, 44100, 2, 2],
] as const) {
  test(`upsampling ${sampleRate} -> ${outSampleRate} Hz (${channels}ch) is independent of chunk size`, () => {
    const pcm = makeSignal({ sampleRate, channels, seconds, seed: 1 });
    const options: Mp3EncoderOptions = { sampleRate, outSampleRate, channels, bitrate: 320 };
    const expected = encodeMp3(pcm, options);
    for (const blockSize of [sampleRate * seconds, 997]) {
      const enc = new Mp3Encoder(options);
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < pcm.length; offset += blockSize * channels) {
        chunks.push(enc.encodeInterleaved(pcm.subarray(offset, offset + blockSize * channels)));
      }
      assert.deepEqual(finish(enc, chunks), expected, `block size ${blockSize}`);
    }
  });
}

test('retaining encoded chunks does not retain oversized working buffers', (t) => {
  const pcm = makeSignal({ sampleRate: 44100, channels: 2, seconds: 30, seed: 1 });
  const options: Mp3EncoderOptions = { sampleRate: 44100, channels: 2, bitrate: 128 };
  const enc = new Mp3Encoder(options);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += enc.frameSize * 2) {
    chunks.push(enc.encodeInterleaved(pcm.subarray(offset, offset + enc.frameSize * 2)));
  }
  const actual = finish(enc, chunks);
  const buffers = new Set(chunks.map((chunk) => chunk.buffer));
  const retainedBytes = [...buffers].reduce((n, buffer) => n + buffer.byteLength, 0);
  const payloadBytes = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  t.diagnostic(`retained ${retainedBytes} bytes for ${payloadBytes} bytes of MP3 output`);
  assert.ok(
    retainedBytes <= payloadBytes * 2,
    `retained ${retainedBytes} bytes for ${payloadBytes} bytes of MP3 output`,
  );
  // Retain the original returned arrays, so later calls must not overwrite their bytes.
  assert.deepEqual(actual, encodeMp3(pcm, options));
});

for (const method of ['flush', 'flushNoGap'] as const) {
  test(`${method} releases unused output capacity`, () => {
    const enc = new Mp3Encoder({ sampleRate: 44100, channels: 1 });
    enc.encode(makeSignal({ sampleRate: 44100, channels: 1, seconds: 1, seed: 1 }));
    const tail = enc[method]();
    assert.ok(tail.length > 0);
    assert.ok(
      tail.buffer.byteLength <= Math.max(1024, tail.length * 2),
      `retained ${tail.buffer.byteLength} bytes for a ${tail.length}-byte tail`,
    );
  });
}

test('one-shot and streaming reject channels with different PCM scales', () => {
  const left = new Int16Array(4410).fill(16000);
  const right = new Float32Array(4410).fill(0.5);
  const options: Mp3EncoderOptions = { sampleRate: 44100, channels: 2 };
  assert.throws(() => new Mp3Encoder(options).encode(left, right), TypeError);
  assert.throws(() => encodeMp3([left, right], options), TypeError);
});

test('one-shot and streaming reject a short right channel', () => {
  const left = new Int16Array(4410);
  const right = new Int16Array(4409);
  const options: Mp3EncoderOptions = { sampleRate: 44100, channels: 2 };
  assert.throws(() => new Mp3Encoder(options).encode(left, right), RangeError);
  assert.throws(() => encodeMp3([left, right], options), RangeError);
});

test('mono planar input rejects a sample count beyond the buffer', () => {
  const enc = new Mp3Encoder({ sampleRate: 44100, channels: 1 });
  assert.throws(() => enc.encode(new Int16Array(16), null, 17), RangeError);
});

for (const channels of [1, 2] as const) {
  test(`${channels}ch interleaved input rejects a sample count beyond the buffer`, () => {
    const enc = new Mp3Encoder({ sampleRate: 44100, channels });
    assert.throws(() => enc.encodeInterleaved(new Int16Array(16 * channels), 17), RangeError);
  });
}

test('implicit stereo sample counts reject incomplete interleaved frames', () => {
  const options: Mp3EncoderOptions = { sampleRate: 44100, channels: 2 };
  const pcm = new Int16Array(101);
  assert.throws(() => new Mp3Encoder(options).encodeInterleaved(pcm), RangeError);
  assert.throws(() => encodeMp3(pcm, options), RangeError);
});

for (const count of [-1, 0.5, NaN, Infinity]) {
  test(`invalid sample count ${count} is rejected before encoding`, () => {
    const pcm = new Int16Array(16);
    const error = { name: 'RangeError', message: /sample count/ };
    const mono = new Mp3Encoder({ sampleRate: 44100, channels: 1 });
    const stereo = new Mp3Encoder({ sampleRate: 44100, channels: 2 });
    assert.throws(() => mono.encode(pcm, null, count), error);
    assert.throws(() => mono.encodeInterleaved(pcm, count), error);
    assert.throws(() => stereo.encode(pcm, pcm, count), error);
    assert.throws(() => stereo.encodeInterleaved(pcm, count), error);
  });
}

test('rejected input leaves the encoder usable and explicit sample prefixes still work', () => {
  const pcm = makeSignal({ sampleRate: 44100, channels: 1, seconds: 1, seed: 1 });
  const options: Mp3EncoderOptions = { sampleRate: 44100, channels: 1 };
  for (const method of ['encode', 'encodeInterleaved'] as const) {
    const enc = new Mp3Encoder(options);
    const encode = (n: number): Uint8Array =>
      method === 'encode' ? enc.encode(pcm, null, n) : enc.encodeInterleaved(pcm, n);
    assert.throws(() => encode(pcm.length + 1), RangeError);
    assert.equal(encode(0).length, 0);
    const n = 22050;
    assert.deepEqual(finish(enc, [encode(n)]), encodeMp3(pcm.subarray(0, n), options));
  }
});

test('empty input and mixed float precisions remain supported', () => {
  const options: Mp3EncoderOptions = { sampleRate: 44100, channels: 2 };
  const left = new Float32Array(4410).fill(0.5);
  const right = new Float64Array(left);
  const enc = new Mp3Encoder(options);
  assert.equal(enc.encodeInterleaved(new Int16Array(0)).length, 0);
  assert.equal(enc.encode(new Float32Array(0), new Float64Array(0)).length, 0);
  assert.deepEqual(finish(enc, [enc.encode(left, right)]), encodeMp3([left, right], options));
});
