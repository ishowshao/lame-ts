#!/usr/bin/env node
// A small command line encoder that mirrors the option handling of the `lame` frontend for
// the supported subset of options, so its output can be compared byte for byte with it.

import { readFileSync, writeFileSync } from 'node:fs';
import { JOINT_STEREO, vbr_off } from './constants.ts';
import { LAME_VERSION, Mp3Encoder, parseWav } from './index.ts';
import type { ChannelMode, Mp3EncoderOptions } from './index.ts';

const USAGE = `lame-ts - TypeScript port of the LAME ${LAME_VERSION} MP3 encoder

usage: lame-ts [options] <input.wav> [output.mp3]

  -b <kbps>          constant bitrate (default 128), or minimum bitrate with -V/--abr
  -B <kbps>          maximum bitrate for -V/--abr
  -V <0..9.999>      VBR quality (0 = best)
  --vbr-new          use the default VBR algorithm (implies VBR)
  --vbr-old          use the old VBR algorithm (implies VBR)
  --abr <kbps>       average bitrate
  --cbr              enforce constant bitrate
  -q <0..9>          algorithm quality (0 = best/slowest, default 3)
  -h / -f            same as -q 2 / -q 7
  -m <s|j|f|d|m>     stereo, joint, forced mid/side, dual channel, mono
  --resample <kHz>   output sample rate
  --lowpass <kHz>    lowpass frequency (-1 to disable)
  --highpass <kHz>   highpass frequency (-1 to disable)
  --scale <n>        scale input by n
  -F                 strictly enforce the -b minimum bitrate
  -p                 add CRC error protection
  -c / -o            mark as copyright / as non-original
  --nores            disable the bit reservoir
  -t                 do not write the Xing/Info tag frame
  --noreplaygain     do not run the ReplayGain analysis
  --version / --help
`;

function fail(msg: string): never {
  process.stderr.write(`lame-ts: ${msg}\n`);
  process.exit(1);
}

/** frequencies below 1000 are taken as kHz, like the lame frontend does */
function freq(v: number): number {
  if (v < 0) return -1;
  return Math.trunc(v * (v < 1000 ? 1e3 : 1) + 0.5);
}

function main(argv: string[]): void {
  const opts: Partial<Mp3EncoderOptions> = { replayGain: true };
  const files: string[] = [];
  let brate: number | undefined;
  let vbr: 'off' | 'new' | 'old' | 'abr' | undefined;
  let vbrq: number | undefined;
  let cbr = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (): number => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) fail(`option ${a} needs a numeric argument`);
      return v;
    };
    if (!a.startsWith('-') || a === '-') {
      files.push(a);
      continue;
    }
    switch (a) {
      case '-b':
        brate = num();
        break;
      case '-B':
        opts.maxBitrate = num();
        break;
      case '-V':
        vbrq = num();
        if (vbr === undefined || vbr === 'off' || vbr === 'abr') vbr = 'new';
        break;
      case '--vbr-new':
        vbr = 'new';
        break;
      case '--vbr-old':
        vbr = 'old';
        break;
      case '--abr':
        vbr = 'abr';
        opts.abr = num();
        break;
      case '--cbr':
        cbr = true;
        break;
      case '-q':
        opts.quality = num();
        break;
      case '-h':
        opts.quality = 2;
        break;
      case '-f':
        opts.quality = 7;
        break;
      case '-m': {
        const m = argv[++i];
        const map: Record<string, ChannelMode> = { s: 'stereo', j: 'joint', f: 'forced-ms', d: 'dual', m: 'mono' };
        if (!(m in map)) fail(`unknown mode ${m}`);
        opts.mode = map[m];
        break;
      }
      case '--resample':
        opts.outSampleRate = freq(num());
        break;
      case '--lowpass':
        opts.lowpass = freq(num());
        break;
      case '--highpass':
        opts.highpass = freq(num());
        break;
      case '--scale':
        opts.scale = num();
        break;
      case '-F':
        opts.enforceMinBitrate = true;
        break;
      case '-p':
        opts.errorProtection = true;
        break;
      case '-c':
        opts.copyright = true;
        break;
      case '-o':
        opts.original = false;
        break;
      case '--nores':
        opts.disableReservoir = true;
        break;
      case '-t':
        opts.writeTag = false;
        break;
      case '--noreplaygain':
        opts.replayGain = false;
        break;
      case '--version':
        process.stdout.write(`lame-ts (LAME ${LAME_VERSION})\n`);
        return;
      case '--help':
      case '-?':
        process.stdout.write(USAGE);
        return;
      default:
        fail(`unknown option ${a} (try --help)`);
    }
  }

  if (files.length < 1) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const inPath = files[0];
  const outPath = files[1] ?? inPath.replace(/\.[^./\\]*$/, '') + '.mp3';

  const wav = parseWav(readFileSync(inPath));

  if (cbr) vbr = 'off';
  if (vbr === 'new' || vbr === 'old') {
    opts.vbrQuality = vbrq ?? 4;
    opts.vbrOld = vbr === 'old';
    delete opts.abr;
  } else if (vbr !== 'abr') {
    delete opts.abr;
  }

  const enc = new Mp3Encoder({
    ...opts,
    sampleRate: wav.sampleRate,
    channels: wav.channels as 1 | 2,
    numSamples: wav.numSamples,
    bitrate: brate,
  });

  const chunks: Uint8Array[] = [];
  const step = enc.frameSize;
  const ch = wav.channels;
  const norm = wav.samples instanceof Int32Array ? 1.0 / 65536 : 32767.0;
  for (let p = 0; p < wav.numSamples; p += step) {
    const n = Math.min(step, wav.numSamples - p);
    chunks.push(
      ch === 2
        ? enc.encodeRaw(wav.samples, 2 * p, wav.samples, 2 * p + 1, n, 2, norm)
        : enc.encodeRaw(wav.samples, p, null, 0, n, 1, norm),
    );
  }
  chunks.push(enc.flush());

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  total = 0;
  for (const c of chunks) {
    out.set(c, total);
    total += c.length;
  }
  const tag = enc.getLameTagFrame();
  if (tag !== null && tag.length <= out.length) out.set(tag, 0);
  writeFileSync(outPath, out);

  const cfg = enc.gfp.internal_flags.cfg;
  const kind = cfg.vbr === vbr_off ? `${cfg.avg_bitrate} kbps CBR` : `VBR(q=${enc.gfp.VBR_q})`;
  process.stderr.write(
    `${inPath} -> ${outPath}: ${enc.frameCount} frames, ${cfg.samplerate_out} Hz ` +
      `${cfg.channels_out === 1 ? 'mono' : cfg.mode === JOINT_STEREO ? 'j-stereo' : 'stereo'}, ${kind}, ${out.length} bytes\n`,
  );
}

main(process.argv.slice(2));
