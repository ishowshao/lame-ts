// lame-ts - a TypeScript port of the libmp3lame 3.100 MP3 encoder.
//
// This file is the public API. Everything underneath it is a line-by-line port of the C
// sources of LAME (see README.md), kept numerically identical to the portable C code path.

import {
  DUAL_CHANNEL,
  JOINT_STEREO,
  MONO,
  STEREO,
  vbr_abr,
  vbr_mtrh,
  vbr_off,
  vbr_rh,
} from './constants.ts';
import {
  lame_encode_buffer_template,
  lame_encode_flush,
  lame_encode_flush_nogap,
  lame_init_bitstream,
  lame_init_params,
} from './lame.ts';
import type { PcmArray } from './lame.ts';
import { apply_preset, lame_set_brate, lame_set_VBR_quality } from './presets.ts';
import { LameGlobalFlags } from './types.ts';
import { lame_get_lametag_frame } from './vbrtag.ts';
import { get_lame_version } from './version.ts';

export type ChannelMode = 'stereo' | 'joint' | 'forced-ms' | 'dual' | 'mono';

export interface Mp3EncoderOptions {
  /** Input sample rate in Hz. */
  sampleRate: number;
  /** Number of input channels (1 or 2). Default 2. */
  channels?: 1 | 2;

  /**
   * Constant bitrate in kbps (`lame -b`). This is the default mode (128 kbps) when none of
   * `bitrate`, `vbrQuality`, `abr` is given.
   */
  bitrate?: number;
  /** VBR quality 0 (best) .. 9.999 (smallest), like `lame -V`. Selects VBR. */
  vbrQuality?: number;
  /** Use the older "vbr rh" algorithm (`lame --vbr-old`) instead of the default one. */
  vbrOld?: boolean;
  /** Average bitrate in kbps (`lame --abr`). Selects ABR. */
  abr?: number;
  /** Minimum / maximum bitrate for VBR and ABR, in kbps (`-b` / `-B` together with -V/--abr). */
  minBitrate?: number;
  maxBitrate?: number;

  /** Algorithm quality 0 (slowest, best) .. 9 (fastest), like `lame -q`. Default 3. */
  quality?: number;
  /** Channel mode, like `lame -m`. Default: joint stereo for 2 channels, mono for 1. */
  mode?: ChannelMode;
  /** Output sample rate in Hz (`--resample`). Default: chosen by the encoder. */
  outSampleRate?: number;
  /** Lowpass frequency in Hz (`--lowpass`); -1 disables the filter. Default: automatic. */
  lowpass?: number;
  /** Highpass frequency in Hz (`--highpass`); -1 disables the filter. Default: off. */
  highpass?: number;
  /** Scale the input by this factor (`--scale`). Default 1. */
  scale?: number;

  /**
   * Write the Xing/Info ("LAME") tag frame at the start of the stream. Default true.
   * The frame emitted first is a placeholder; replace it with `getLameTagFrame()` after
   * `flush()` (the one-shot `encodeMp3()` does this for you).
   */
  writeTag?: boolean;
  /**
   * Run the ReplayGain analysis and store the result in the tag. Default false, like
   * libmp3lame (the `lame` command line program turns it on).
   */
  replayGain?: boolean;

  /** Add CRC error protection (`-p`). */
  errorProtection?: boolean;
  /** Frame header flags (`-c`, `-o`). */
  copyright?: boolean;
  original?: boolean;
  /** Disable the bit reservoir (`--nores`). */
  disableReservoir?: boolean;
  /** Strictly enforce the minimum bitrate in VBR (`-F`). */
  enforceMinBitrate?: boolean;
  /** Total number of samples per channel, if known (only informational). */
  numSamples?: number;

  /** Escape hatch: tweak the raw libmp3lame settings before `lame_init_params()` runs. */
  configure?: (gfp: LameGlobalFlags) => void;
}

/** PCM input: 16-bit samples, 32-bit full-scale samples, or floats in [-1, 1]. */
export type PcmInput = Int16Array | Int32Array | Float32Array | Float64Array;

const INT_NORM = 1.0 / 65536;

function normOf(pcm: PcmInput): number {
  if (pcm instanceof Int16Array) return 1.0; /* lame_encode_buffer() */
  if (pcm instanceof Int32Array) return INT_NORM; /* lame_encode_buffer_int() */
  return 32767.0; /* lame_encode_buffer_ieee_float() / _ieee_double() */
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const c of chunks) {
    out.set(c, n);
    n += c.length;
  }
  return out;
}

/**
 * Streaming MP3 encoder.
 *
 * ```ts
 * const enc = new Mp3Encoder({ sampleRate: 44100, channels: 2, bitrate: 128 });
 * const a = enc.encode(left, right);   // any number of times
 * const b = enc.flush();
 * ```
 */
export class Mp3Encoder {
  /** The underlying libmp3lame state (`lame_global_flags`). */
  readonly gfp: LameGlobalFlags;
  private readonly channels: number;
  private finished = false;

  constructor(options: Mp3EncoderOptions) {
    const gfp = new LameGlobalFlags();
    this.gfp = gfp;
    const o = options;

    const channels = o.channels ?? 2;
    if (channels !== 1 && channels !== 2) throw new RangeError('lame-ts: channels must be 1 or 2');
    this.channels = channels;

    gfp.num_channels = channels;
    gfp.samplerate_in = o.sampleRate;
    if (o.numSamples !== undefined) gfp.num_samples = o.numSamples;
    if (o.outSampleRate !== undefined) gfp.samplerate_out = o.outSampleRate;
    if (o.scale !== undefined) gfp.scale = Math.fround(o.scale);
    if (o.quality !== undefined) gfp.quality = Math.min(9, Math.max(0, o.quality | 0));
    if (o.lowpass !== undefined) gfp.lowpassfreq = o.lowpass | 0;
    if (o.highpass !== undefined) gfp.highpassfreq = o.highpass | 0;
    if (o.errorProtection) gfp.error_protection = 1;
    if (o.copyright) gfp.copyright = 1;
    if (o.original !== undefined) gfp.original = o.original ? 1 : 0;
    if (o.disableReservoir) gfp.disable_reservoir = 1;
    if (o.enforceMinBitrate) gfp.VBR_hard_min = 1;
    gfp.write_lame_tag = o.writeTag === false ? 0 : 1;
    gfp.findReplayGain = o.replayGain ? 1 : 0;
    gfp.write_id3tag_automatic = 0;

    switch (o.mode) {
      case undefined:
        break;
      case 'stereo':
        gfp.mode = STEREO;
        break;
      case 'joint':
        gfp.mode = JOINT_STEREO;
        break;
      case 'forced-ms':
        gfp.mode = JOINT_STEREO;
        gfp.force_ms = 1;
        break;
      case 'dual':
        gfp.mode = DUAL_CHANNEL;
        break;
      case 'mono':
        gfp.mode = MONO;
        break;
      default:
        throw new RangeError(`lame-ts: unknown mode ${String(o.mode)}`);
    }

    if (o.vbrQuality !== undefined) {
      gfp.VBR = o.vbrOld ? vbr_rh : vbr_mtrh;
      lame_set_VBR_quality(gfp, o.vbrQuality);
    } else if (o.abr !== undefined) {
      /* same as `lame --abr`: values >= 8000 are taken as bps, then clamped to 8..320 */
      let kbps = o.abr | 0;
      if (kbps >= 8000) kbps = ((kbps + 500) / 1000) | 0;
      kbps = Math.min(320, Math.max(8, kbps));
      gfp.VBR = vbr_abr;
      gfp.VBR_mean_bitrate_kbps = kbps;
    } else {
      gfp.VBR = vbr_off;
      if (o.bitrate !== undefined) {
        lame_set_brate(gfp, o.bitrate | 0);
        gfp.VBR_min_bitrate_kbps = gfp.brate;
      }
    }
    if (gfp.VBR !== vbr_off && o.bitrate !== undefined) {
      /* `lame -V2 -b 128` */
      lame_set_brate(gfp, o.bitrate | 0);
      gfp.VBR_min_bitrate_kbps = gfp.brate;
    }
    if (o.minBitrate !== undefined) gfp.VBR_min_bitrate_kbps = o.minBitrate | 0;
    if (o.maxBitrate !== undefined) gfp.VBR_max_bitrate_kbps = o.maxBitrate | 0;

    o.configure?.(gfp);

    if (lame_init_params(gfp) < 0) {
      throw new RangeError('lame-ts: invalid encoder parameters (lame_init_params failed)');
    }
  }

  /** Output sample rate in Hz. */
  get outSampleRate(): number {
    return this.gfp.internal_flags.cfg.samplerate_out;
  }

  /** Number of PCM samples per channel in one MP3 frame (1152 or 576). */
  get frameSize(): number {
    return 576 * this.gfp.internal_flags.cfg.mode_gr;
  }

  /** Number of frames encoded so far. */
  get frameCount(): number {
    return this.gfp.internal_flags.ov_enc.frame_number;
  }

  /** Encoder delay in samples (as written to the LAME tag). */
  get encoderDelay(): number {
    return this.gfp.internal_flags.ov_enc.encoder_delay;
  }

  /** Padding in samples appended at the end (known after `flush()`). */
  get encoderPadding(): number {
    return this.gfp.internal_flags.ov_enc.encoder_padding;
  }

  /**
   * Encodes planar PCM. `right` is required for 2-channel input and ignored for mono.
   * Returns the MP3 bytes that became available (possibly empty).
   *
   * - `Int16Array`: 16-bit samples (`lame_encode_buffer`)
   * - `Int32Array`: 32-bit samples, full scale = +/- 2^31 (`lame_encode_buffer_int`)
   * - `Float32Array` / `Float64Array`: full scale = +/- 1.0 (`lame_encode_buffer_ieee_float`)
   */
  encode(left: PcmInput, right?: PcmInput | null, nsamples?: number): Uint8Array {
    const n = nsamples ?? left.length;
    if (this.channels === 2) {
      if (!right) throw new TypeError('lame-ts: the right channel is required for 2-channel input');
      if (right.length < n || left.length < n) throw new RangeError('lame-ts: channel buffers are too short');
      if (normOf(left) !== normOf(right)) throw new TypeError('lame-ts: both channels must use the same sample type');
    }
    return this.run(left, 0, this.channels === 2 ? right! : null, 0, n, 1, normOf(left));
  }

  /** Encodes interleaved PCM (L R L R ... for 2 channels). See `encode()` for sample types. */
  encodeInterleaved(pcm: PcmInput, nsamples?: number): Uint8Array {
    if (this.channels === 1) return this.run(pcm, 0, null, 0, nsamples ?? pcm.length, 1, normOf(pcm));
    const n = nsamples ?? (pcm.length / 2) | 0;
    return this.run(pcm, 0, pcm, 1, n, 2, normOf(pcm));
  }

  /**
   * Low level entry: samples are read from `left[lo + i * jump]` / `right[ro + i * jump]` and
   * multiplied by `norm`; after that 16-bit full scale (+/- 32768) is expected.
   */
  encodeRaw(
    left: PcmArray,
    lo: number,
    right: PcmArray | null,
    ro: number,
    nsamples: number,
    jump: number,
    norm: number,
  ): Uint8Array {
    return this.run(left, lo, right, ro, nsamples, jump, norm);
  }

  private run(
    left: PcmArray,
    lo: number,
    right: PcmArray | null,
    ro: number,
    nsamples: number,
    jump: number,
    norm: number,
  ): Uint8Array {
    if (this.finished) throw new Error('lame-ts: encode() called after flush()');
    if (nsamples <= 0) return new Uint8Array(0);
    /* worst case estimate given in lame.h */
    const out = new Uint8Array(Math.ceil(1.25 * nsamples) + 7200 + 2880);
    const n = lame_encode_buffer_template(this.gfp, left, lo, right, ro, nsamples, out, 0, out.length, jump, norm);
    if (n < 0) throw new Error(`lame-ts: internal encoder error ${n}`);
    return out.subarray(0, n);
  }

  /** Encodes what is still buffered, pads the last frame and returns the final MP3 bytes. */
  flush(): Uint8Array {
    if (this.finished) return new Uint8Array(0);
    const out = new Uint8Array(32 * 1024);
    const n = lame_encode_flush(this.gfp, out, 0, out.length);
    if (n < 0) throw new Error(`lame-ts: internal encoder error ${n}`);
    this.finished = true;
    return out.subarray(0, n);
  }

  /**
   * `lame_encode_flush_nogap()`: completes the current frame without discarding the PCM
   * overlap, for gapless encoding of consecutive tracks. Call `startNextTrack()` afterwards.
   */
  flushNoGap(): Uint8Array {
    const out = new Uint8Array(32 * 1024);
    const n = lame_encode_flush_nogap(this.gfp, out, 0, out.length);
    if (n < 0) throw new Error(`lame-ts: internal encoder error ${n}`);
    return out.subarray(0, n);
  }

  /** `lame_init_bitstream()`: starts a new stream (and a new tag frame) after `flushNoGap()`. */
  startNextTrack(): void {
    lame_init_bitstream(this.gfp);
  }

  /**
   * The final Xing/Info/LAME tag frame. It has the same size as the placeholder frame that
   * was emitted at the very start of the stream and must be written over it. Returns null
   * when no tag was written (`writeTag: false`, or the frame did not fit). Call after `flush()`.
   */
  getLameTagFrame(): Uint8Array | null {
    return lame_get_lametag_frame(this.gfp);
  }
}

/**
 * One-shot helper: encodes a whole clip and returns a complete MP3 file image, with the
 * Xing/Info tag frame already filled in - the same bytes the `lame` command line tool writes.
 *
 * For 2-channel input pass either `[left, right]` or an interleaved array.
 */
export function encodeMp3(pcm: PcmInput | [PcmInput, PcmInput], options: Mp3EncoderOptions): Uint8Array {
  const enc = new Mp3Encoder(options);
  const chunks: Uint8Array[] = [];
  const channels = options.channels ?? 2;
  /* feed frame sized blocks, like the lame frontend does */
  const step = enc.frameSize;
  if (Array.isArray(pcm)) {
    const [l, r] = pcm;
    const norm = normOf(l);
    for (let p = 0; p < l.length; p += step) {
      const n = Math.min(step, l.length - p);
      chunks.push(enc.encodeRaw(l, p, channels === 2 ? r : null, p, n, 1, norm));
    }
  } else {
    const norm = normOf(pcm);
    const total = channels === 2 ? (pcm.length / 2) | 0 : pcm.length;
    for (let p = 0; p < total; p += step) {
      const n = Math.min(step, total - p);
      if (channels === 2) chunks.push(enc.encodeRaw(pcm, 2 * p, pcm, 2 * p + 1, n, 2, norm));
      else chunks.push(enc.encodeRaw(pcm, p, null, 0, n, 1, norm));
    }
  }
  chunks.push(enc.flush());
  const out = concat(chunks);
  const tag = enc.getLameTagFrame();
  if (tag !== null && tag.length <= out.length) out.set(tag, 0);
  return out;
}

/** Version of the LAME release this port tracks ("3.100"). */
export const LAME_VERSION: string = get_lame_version();

export { apply_preset, LameGlobalFlags };
export type { PcmArray };
export { parseWav } from './wav.ts';
export type { WavData } from './wav.ts';
