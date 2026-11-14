// The conformance cases: every case names a test signal, the `lame` command line options that
// were given to the reference encoder, and the equivalent lame-ts options.

import type { Mp3EncoderOptions } from '../src/index.ts';
import type { SignalSpec } from './signals.ts';

export interface Case {
  signal: SignalSpec;
  /** options for the reference `lame` binary */
  args: string;
  /** the same settings for lame-ts (sampleRate / channels / replayGain are filled in) */
  options: Partial<Mp3EncoderOptions>;
}

const s44: SignalSpec = { sampleRate: 44100, channels: 2, seconds: 2.5, seed: 1 };
const s48: SignalSpec = { sampleRate: 48000, channels: 2, seconds: 2, seed: 2 };
const s32: SignalSpec = { sampleRate: 32000, channels: 2, seconds: 2, seed: 3 };
const m44: SignalSpec = { sampleRate: 44100, channels: 1, seconds: 2, seed: 4 };
const s22: SignalSpec = { sampleRate: 22050, channels: 2, seconds: 2, seed: 5 };
const m16: SignalSpec = { sampleRate: 16000, channels: 1, seconds: 2, seed: 6 };
const s11: SignalSpec = { sampleRate: 11025, channels: 2, seconds: 2, seed: 7 };
const m8: SignalSpec = { sampleRate: 8000, channels: 1, seconds: 2, seed: 8 };

export const CASES: Case[] = [
  /* CBR */
  { signal: s44, args: '', options: {} },
  { signal: s44, args: '-b 128', options: { bitrate: 128 } },
  { signal: s44, args: '-b 320 -q 0', options: { bitrate: 320, quality: 0 } },
  { signal: s44, args: '-b 192 -h', options: { bitrate: 192, quality: 2 } },
  { signal: s44, args: '-b 96 -f', options: { bitrate: 96, quality: 7 } },
  { signal: s44, args: '-b 64', options: { bitrate: 64 } },
  { signal: s44, args: '-b 32 -q 9', options: { bitrate: 32, quality: 9 } },
  { signal: s44, args: '-b 160 -m s', options: { bitrate: 160, mode: 'stereo' } },
  { signal: s44, args: '-b 128 -m f', options: { bitrate: 128, mode: 'forced-ms' } },
  { signal: s44, args: '-b 128 -m d', options: { bitrate: 128, mode: 'dual' } },
  { signal: s44, args: '-b 96 -m m', options: { bitrate: 96, mode: 'mono' } },
  { signal: s44, args: '-b 128 -p -c -o', options: { bitrate: 128, errorProtection: true, copyright: true, original: false } },
  { signal: s44, args: '-b 128 --nores', options: { bitrate: 128, disableReservoir: true } },
  { signal: s44, args: '-b 128 -t', options: { bitrate: 128, writeTag: false } },
  { signal: s44, args: '-b 128 --scale 0.5', options: { bitrate: 128, scale: 0.5 } },
  { signal: s44, args: '-b 128 --lowpass 12 --highpass 0.4', options: { bitrate: 128, lowpass: 12000, highpass: 400 } },
  { signal: s44, args: '-b 64 --resample 24', options: { bitrate: 64, outSampleRate: 24000 } },
  { signal: s48, args: '-b 256', options: { bitrate: 256 } },
  { signal: s32, args: '-b 112', options: { bitrate: 112 } },
  { signal: m44, args: '-b 64', options: { bitrate: 64 } },
  { signal: s22, args: '-b 64', options: { bitrate: 64 } },
  { signal: m16, args: '-b 24', options: { bitrate: 24 } },
  { signal: s11, args: '-b 32', options: { bitrate: 32 } },
  { signal: m8, args: '-b 8', options: { bitrate: 8 } },
  /* ABR */
  { signal: s44, args: '--abr 128', options: { abr: 128 } },
  { signal: s44, args: '--abr 56', options: { abr: 56 } },
  { signal: s48, args: '--abr 200 -b 96 -B 256', options: { abr: 200, bitrate: 96, maxBitrate: 256 } },
  { signal: m16, args: '--abr 24', options: { abr: 24 } },
  /* VBR (new) */
  { signal: s44, args: '-V 0', options: { vbrQuality: 0 } },
  { signal: s44, args: '-V 2', options: { vbrQuality: 2 } },
  { signal: s44, args: '-V 4 -q 0', options: { vbrQuality: 4, quality: 0 } },
  { signal: s44, args: '-V 5.5', options: { vbrQuality: 5.5 } },
  { signal: s44, args: '-V 7', options: { vbrQuality: 7 } },
  { signal: s44, args: '-V 9.6', options: { vbrQuality: 9.6 } },
  { signal: s44, args: '-V 3 --noreplaygain', options: { vbrQuality: 3, replayGain: false } },
  { signal: s44, args: '-V 2 -b 128 -B 224 -F', options: { vbrQuality: 2, bitrate: 128, maxBitrate: 224, enforceMinBitrate: true } },
  { signal: s48, args: '-V 1', options: { vbrQuality: 1 } },
  { signal: s32, args: '-V 3', options: { vbrQuality: 3 } },
  { signal: m44, args: '-V 4', options: { vbrQuality: 4 } },
  { signal: s22, args: '-V 5', options: { vbrQuality: 5 } },
  { signal: s11, args: '-V 6', options: { vbrQuality: 6 } },
  { signal: m8, args: '-V 8', options: { vbrQuality: 8 } },
  /* VBR (old) */
  { signal: s44, args: '--vbr-old -V 2', options: { vbrQuality: 2, vbrOld: true } },
  { signal: s44, args: '--vbr-old -V 6 -q 0', options: { vbrQuality: 6, vbrOld: true, quality: 0 } },
  { signal: s22, args: '--vbr-old -V 4', options: { vbrQuality: 4, vbrOld: true } },
  { signal: m16, args: '--vbr-old -V 8', options: { vbrQuality: 8, vbrOld: true } },
];

export function caseName(c: Case): string {
  const s = c.signal;
  return `${s.sampleRate}Hz ${s.channels}ch ${c.args === '' ? '(defaults)' : c.args}`;
}
