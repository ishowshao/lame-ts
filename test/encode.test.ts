import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeMp3, LAME_VERSION, Mp3Encoder, parseWav } from '../src/index.ts';
import type { Mp3EncoderOptions } from '../src/index.ts';
import { CASES, caseName } from './cases.ts';
import type { Case } from './cases.ts';
import { makeSignal, makeWav } from './signals.ts';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as Record<
  string,
  { bytes: number; sha256: string }
>;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/* the `lame` command line program runs the ReplayGain analysis by default */
function optionsOf(c: Case): Mp3EncoderOptions {
  return { replayGain: true, ...c.options, sampleRate: c.signal.sampleRate, channels: c.signal.channels };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const signals = new Map<object, Int16Array>();
function signalOf(c: Case): Int16Array {
  let s = signals.get(c.signal);
  if (!s) signals.set(c.signal, (s = makeSignal(c.signal)));
  return s;
}

test('version', () => {
  assert.equal(LAME_VERSION, '3.100');
});

for (const c of CASES) {
  const name = caseName(c);
  test(`bit-exact with libmp3lame: ${name}`, () => {
    const want = FIXTURES[name];
    assert.ok(want, 'missing fixture - run scripts/gen-fixtures.ts');
    const mp3 = encodeMp3(signalOf(c), optionsOf(c));
    assert.equal(mp3.length, want.bytes);
    assert.equal(sha256(mp3), want.sha256);
  });
}

test('streaming with odd chunk sizes and planar float input gives the same bytes', () => {
  for (const c of [CASES[1], CASES[16], CASES[29], CASES[41]]) {
    const pcm = signalOf(c);
    const ch = c.signal.channels;
    const n = pcm.length / ch;
    /* 16-bit samples as floats: x / 32768 * 32767 would not be exact, so use the raw entry */
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = pcm[ch * i];
      r[i] = pcm[ch * i + ch - 1];
    }
    const enc = new Mp3Encoder(optionsOf(c));
    const chunks: Uint8Array[] = [];
    let seed = 12345;
    for (let p = 0; p < n; ) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const len = Math.min(n - p, 1 + (seed % 5000));
      chunks.push(enc.encodeRaw(l, p, ch === 2 ? r : null, p, len, 1, 1.0).slice());
      p += len;
    }
    chunks.push(enc.flush().slice());
    const mp3 = concat(chunks);
    const tag = enc.getLameTagFrame();
    if (tag) mp3.set(tag, 0);
    assert.equal(sha256(mp3), FIXTURES[caseName(c)].sha256, caseName(c));
  }
});

test('sample types are equivalent', () => {
  const c = CASES[1];
  const pcm = signalOf(c);
  const want = FIXTURES[caseName(c)].sha256;
  const i32 = Int32Array.from(pcm, (v) => v << 16);
  assert.equal(sha256(encodeMp3(i32, optionsOf(c))), want);
  const n = pcm.length / 2;
  const l = new Int16Array(n);
  const r = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = pcm[2 * i];
    r[i] = pcm[2 * i + 1];
  }
  assert.equal(sha256(encodeMp3([l, r], optionsOf(c))), want);
});

test('encoder instances do not share state', () => {
  const a = CASES[1];
  const b = CASES[29];
  const ea = new Mp3Encoder(optionsOf(a));
  const eb = new Mp3Encoder(optionsOf(b));
  const pa = signalOf(a);
  const pb = signalOf(b);
  const oa: Uint8Array[] = [];
  const ob: Uint8Array[] = [];
  const step = 3000;
  for (let p = 0; p < pa.length || p < pb.length; p += step) {
    if (p < pa.length) oa.push(ea.encodeInterleaved(pa.subarray(p, p + step)).slice());
    if (p < pb.length) ob.push(eb.encodeInterleaved(pb.subarray(p, p + step)).slice());
  }
  oa.push(ea.flush().slice());
  ob.push(eb.flush().slice());
  const ma = concat(oa);
  const mb = concat(ob);
  ma.set(ea.getLameTagFrame()!, 0);
  mb.set(eb.getLameTagFrame()!, 0);
  assert.equal(sha256(ma), FIXTURES[caseName(a)].sha256);
  assert.equal(sha256(mb), FIXTURES[caseName(b)].sha256);
});

test('stream layout', () => {
  const c = CASES[1];
  const enc = new Mp3Encoder(optionsOf(c));
  assert.equal(enc.frameSize, 1152);
  assert.equal(enc.outSampleRate, 44100);
  assert.equal(enc.encoderDelay, 576);
  const mp3 = encodeMp3(signalOf(c), optionsOf(c));
  /* MPEG-1 layer III sync word, then the Info tag of a CBR stream */
  assert.equal(mp3[0], 0xff);
  assert.equal(mp3[1] & 0xfe, 0xfa);
  assert.ok(Buffer.from(mp3.subarray(0, 200)).includes('Info'));
  assert.ok(Buffer.from(mp3.subarray(0, 200)).includes('LAME3.100'));
  /* 128 kbps: 417 or 418 byte frames */
  assert.ok(Math.abs(mp3.length - Math.ceil((signalOf(c).length / 2 + 576 + 1152) / 1152) * 417.96) < 1300);
});

test('argument checking', () => {
  assert.throws(() => new Mp3Encoder({ sampleRate: 44100, channels: 3 as 2 }), RangeError);
  assert.throws(() => new Mp3Encoder({ sampleRate: 44100, mode: 'x' as 'mono' }), RangeError);
  const enc = new Mp3Encoder({ sampleRate: 44100 });
  assert.throws(() => enc.encode(new Int16Array(10)), TypeError);
  assert.throws(() => enc.encode(new Int16Array(10), new Float32Array(10)), TypeError);
  enc.flush();
  assert.throws(() => enc.encode(new Int16Array(10), new Int16Array(10)), Error);
});

test('parseWav + command line', () => {
  const c = CASES[29];
  const wavBytes = makeWav(signalOf(c), c.signal.sampleRate, c.signal.channels);
  const wav = parseWav(wavBytes);
  assert.equal(wav.sampleRate, 44100);
  assert.equal(wav.channels, 2);
  assert.equal(wav.numSamples, signalOf(c).length / 2);

  const dir = mkdtempSync(join(tmpdir(), 'lame-ts-test-'));
  try {
    const inPath = join(dir, 'in.wav');
    const outPath = join(dir, 'out.mp3');
    writeFileSync(inPath, wavBytes);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    execFileSync(process.execPath, [cli, ...c.args.split(' '), inPath, outPath], { stdio: 'ignore' });
    assert.equal(sha256(readFileSync(outPath)), FIXTURES[caseName(c)].sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
