// Port of libmp3lame/util.c - ATH formulas, bitrate/samplerate helpers and the input resampler.

import { BPC, FLT_EPSILON, PI, f } from './constants.ts';
import { bitrate_table } from './tables.ts';
import type { LameInternalFlags, SessionConfig } from './types.ts';

/**
 * C `powf`. The result is the correctly rounded single-precision power, which is what
 * a strict IEEE-754 libm is specified to approximate.
 */
export function powf(x: number, y: number): number {
  return f(Math.pow(x, y));
}

/** C `log10f` (correctly rounded). */
export function log10f(x: number): number {
  return f(Math.log10(x));
}

/** FAST_LOG10(x) of util.h (portable build: plain log10, evaluated in double). */
export function FAST_LOG10(x: number): number {
  return Math.log10(x);
}

/** FAST_LOG10_X(x, y) of util.h. */
export function FAST_LOG10_X(x: number, y: number): number {
  return Math.log10(x) * y;
}

/* those ATH formulas are returning their minimum value for input = -1 */
function ATHformula_GB(freq: number, value: number, f_min: number, f_max: number): number {
  /* from Painter & Spanias, modified by Gabriel Bouvigne to better fit the reality */
  /* the following Hack allows to ask for the lowest value */
  if (freq < -0.3) freq = 3410;

  freq = f(freq / 1000); /* convert to khz */
  freq = f_min > freq ? f_min : freq;
  freq = f_max < freq ? f_max : freq;

  return f(
    3.64 * Math.pow(freq, -0.8) -
      6.8 * Math.exp(-0.6 * Math.pow(freq - 3.4, 2.0)) +
      6.0 * Math.exp(-0.15 * Math.pow(freq - 8.7, 2.0)) +
      (0.6 + 0.04 * value) * 0.001 * Math.pow(freq, 4.0),
  );
}

/** Absolute threshold of hearing in dB for frequency `freq` (Hz). All arguments/results are floats. */
export function ATHformula(cfg: SessionConfig, freq: number): number {
  const lo = f(0.1);
  switch (cfg.ATHtype) {
    case 0:
      return ATHformula_GB(freq, 9, lo, 24.0);
    case 1:
      return ATHformula_GB(freq, -1, lo, 24.0); /* over sensitive, should probably be removed */
    case 2:
      return ATHformula_GB(freq, 0, lo, 24.0);
    case 3:
      return f(ATHformula_GB(freq, 1, lo, 24.0) + 6); /* modification of GB formula by Roel */
    case 4:
      return ATHformula_GB(freq, cfg.ATHcurve, lo, 24.0);
    case 5:
      return ATHformula_GB(freq, cfg.ATHcurve, f(3.41), f(16.1));
    default:
      return ATHformula_GB(freq, 0, lo, 24.0);
  }
}

/* see for example "Zwicker: Psychoakustik, 1982; ISBN 3-540-11401-7 */
/** input: freq in hz (float)  output: barks (float) */
export function freq2bark(freq: number): number {
  if (freq < 0) freq = 0;
  freq = f(freq * 0.001);
  return f(13.0 * Math.atan(0.76 * freq) + 3.5 * Math.atan(f(freq * freq) / (7.5 * 7.5)));
}

export function FindNearestBitrate(bRate: number, version: number, samplerate: number): number {
  if (samplerate < 16000) version = 2;

  let bitrate = bitrate_table[version][1];

  for (let i = 2; i <= 14; i++) {
    if (bitrate_table[version][i] > 0) {
      if (Math.abs(bitrate_table[version][i] - bRate) < Math.abs(bitrate - bRate)) {
        bitrate = bitrate_table[version][i];
      }
    }
  }
  return bitrate;
}

const full_bitrate_table = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** Table index used when bitrate-based tuning values are looked up. `bitrate` in kbps. */
export function nearestBitrateFullIndex(bitrate: number): number {
  bitrate &= 0xffff; /* uint16_t parameter */

  /* We assume specified bitrate will be 320kbps */
  let upper_range_kbps = full_bitrate_table[16];
  let upper_range = 16;
  let lower_range_kbps = full_bitrate_table[16];
  let lower_range = 16;

  /* Determine which significant bitrates the value specified falls between,
   * if loop ends without breaking then we were correct above that the value was 320
   */
  for (let b = 0; b < 16; b++) {
    if (Math.max(bitrate, full_bitrate_table[b + 1]) !== bitrate) {
      upper_range_kbps = full_bitrate_table[b + 1];
      upper_range = b + 1;
      lower_range_kbps = full_bitrate_table[b];
      lower_range = b;
      break; /* We found upper range */
    }
  }

  /* Determine which range the value specified is closer to */
  if (upper_range_kbps - bitrate > bitrate - lower_range_kbps) {
    return lower_range;
  }
  return upper_range;
}

/** map frequency to a valid MP3 sample frequency */
export function map2MP3Frequency(freq: number): number {
  if (freq <= 8000) return 8000;
  if (freq <= 11025) return 11025;
  if (freq <= 12000) return 12000;
  if (freq <= 16000) return 16000;
  if (freq <= 22050) return 22050;
  if (freq <= 24000) return 24000;
  if (freq <= 32000) return 32000;
  if (freq <= 44100) return 44100;

  return 48000;
}

/** convert bitrate in kbps to index, -1 if it is not a legal bitrate */
export function BitrateIndex(bRate: number, version: number, samplerate: number): number {
  if (samplerate < 16000) version = 2;
  for (let i = 0; i <= 14; i++) {
    if (bitrate_table[version][i] > 0) {
      if (bitrate_table[version][i] === bRate) {
        return i;
      }
    }
  }
  return -1;
}

/** MPEG version (1 = MPEG-1, 0 = MPEG-2/2.5) for an output sample rate. */
export function SmpFrqVersion(sample_freq: number): number {
  return sample_freq === 44100 || sample_freq === 48000 || sample_freq === 32000 ? 1 : 0;
}

/** convert samp freq in Hz to index, -1 if it is not an MPEG sample rate */
export function SmpFrqIndex(sample_freq: number): number {
  switch (sample_freq) {
    case 44100:
    case 22050:
    case 11025:
      return 0;
    case 48000:
    case 24000:
    case 12000:
      return 1;
    case 32000:
    case 16000:
    case 8000:
      return 2;
    default:
      return -1;
  }
}

/* resampling via FIR filter, blackman window */
function blackman(x: number, fcn: number, l: number): number {
  /* This algorithm from:
     SIGNAL PROCESSING ALGORITHMS IN FORTRAN AND C
     S.D. Stearns and R.A. David, Prentice-Hall, 1992
   */
  const wcn = f(PI * fcn);

  x = f(x / l);
  if (x < 0) x = 0;
  if (x > 1) x = 1;
  const x2 = f(x - 0.5);

  const bkwn = f(0.42 - 0.5 * Math.cos(2 * x * PI) + 0.08 * Math.cos(4 * x * PI));
  if (Math.abs(x2) < 1e-9) return f(wcn / PI);
  else return f((bkwn * Math.sin(f(f(l * wcn) * x2))) / (PI * l * x2));
}

/* gcd - greatest common divisor */
function gcd(i: number, j: number): number {
  return j ? gcd(j, i % j) : i;
}

/**
 * Resamples `inbuf[ino..ino+len)` into `outbuf[oo..oo+desired_len)`.
 * Returns [samples created, input samples consumed].
 */
function fill_buffer_resample(
  gfc: LameInternalFlags,
  outbuf: Float32Array,
  oo: number,
  desired_len: number,
  inbuf: Float32Array,
  ino: number,
  len: number,
  ch: number,
): [number, number] {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  const resample_ratio = cfg.samplerate_in / cfg.samplerate_out;
  let offset: number, xvalue: number;
  let i: number,
    j = 0,
    k: number;

  /* number of convolution functions to pre-compute */
  let bpc = (cfg.samplerate_out / gcd(cfg.samplerate_out, cfg.samplerate_in)) | 0;
  if (bpc > BPC) bpc = BPC;

  const intratio = Math.abs(resample_ratio - Math.floor(0.5 + resample_ratio)) < FLT_EPSILON ? 1 : 0;
  let fcn = f(1.0 / resample_ratio);
  if (fcn > 1.0) fcn = 1.0;
  let filter_l = 31; /* must be odd */
  filter_l += intratio; /* unless resample_ratio=int, it must be even */

  const BLACKSIZE = filter_l + 1; /* size of data needed for FIR */

  if (gfc.fill_buffer_resample_init === 0) {
    esv.inbuf_old[0] = new Float32Array(BLACKSIZE);
    esv.inbuf_old[1] = new Float32Array(BLACKSIZE);
    for (i = 0; i <= 2 * bpc; ++i) esv.blackfilt[i] = new Float32Array(BLACKSIZE);

    esv.itime[0] = 0;
    esv.itime[1] = 0;

    /* precompute blackman filter coefficients */
    for (j = 0; j <= 2 * bpc; j++) {
      let sum = 0;
      offset = f((j - bpc) / (2 * bpc));
      const bf = esv.blackfilt[j];
      for (i = 0; i <= filter_l; i++) {
        bf[i] = blackman(f(i - offset), fcn, filter_l);
        sum = f(sum + bf[i]);
      }
      for (i = 0; i <= filter_l; i++) bf[i] /= sum;
    }
    gfc.fill_buffer_resample_init = 1;
  }

  const inbuf_old = esv.inbuf_old[ch];

  /* time of j'th element in inbuf = itime + j/ifreq; */
  /* time of k'th element in outbuf   =  j/ofreq */
  for (k = 0; k < desired_len; k++) {
    const time0 = k * resample_ratio; /* time of k'th output sample */

    j = Math.floor(time0 - esv.itime[ch]);

    /* check if we need more input data */
    if (filter_l + j - ((filter_l / 2) | 0) >= len) break;

    /* blackman filter.  by default, window centered at j+.5(filter_l%2) */
    /* but we want a window centered at time0.   */
    offset = f(time0 - esv.itime[ch] - (j + 0.5 * (filter_l % 2)));

    /* find the closest precomputed window for this offset: */
    const joff = Math.floor(f(f(f(offset * 2) * bpc) + bpc) + 0.5);

    xvalue = 0;
    const bf = esv.blackfilt[joff];
    for (i = 0; i <= filter_l; ++i) {
      const j2 = i + j - ((filter_l / 2) | 0);
      const y = j2 < 0 ? inbuf_old[BLACKSIZE + j2] : inbuf[ino + j2];
      xvalue = f(xvalue + f(y * bf[i]));
    }
    outbuf[oo + k] = xvalue;
  }

  /* k = number of samples added to outbuf */
  /* last k sample used data from [j-filter_l/2,j+filter_l-filter_l/2]  */

  /* how many samples of input data were used:  */
  const num_used = Math.min(len, filter_l + j - ((filter_l / 2) | 0));

  /* adjust our input time counter.  Incriment by the number of samples used,
   * then normalize so that next output sample is at time 0, next
   * input buffer is at time itime[ch] */
  esv.itime[ch] += num_used - k * resample_ratio;

  /* save the last BLACKSIZE samples into the inbuf_old buffer */
  if (num_used >= BLACKSIZE) {
    for (i = 0; i < BLACKSIZE; i++) inbuf_old[i] = inbuf[ino + num_used + i - BLACKSIZE];
  } else {
    /* shift in num_used samples into inbuf_old  */
    const n_shift = BLACKSIZE - num_used; /* number of samples to shift */

    /* shift n_shift samples by num_used, to make room for the
     * num_used new samples */
    for (i = 0; i < n_shift; ++i) inbuf_old[i] = inbuf_old[i + num_used];

    /* shift in the num_used samples */
    for (j = 0; i < BLACKSIZE; ++i, ++j) inbuf_old[i] = inbuf[ino + j];
  }
  return [k, num_used]; /* return the number samples created at the new samplerate */
}

export function isResamplingNecessary(cfg: SessionConfig): boolean {
  const l = Math.trunc(f(cfg.samplerate_out * f(0.9995)));
  const h = Math.trunc(f(cfg.samplerate_out * f(1.0005)));
  return cfg.samplerate_in < l || h < cfg.samplerate_in;
}

/**
 * copy in new samples from in_buffer into mfbuf, with resampling if necessary.
 * Returns [n_in, n_out]: the number of input samples used and the number of samples
 * copied into mfbuf.
 */
export function fill_buffer(
  gfc: LameInternalFlags,
  mfbuf: Float32Array[],
  in_buffer: Float32Array[],
  ino: number,
  nsamples: number,
): [number, number] {
  const cfg = gfc.cfg;
  const mf_size = gfc.sv_enc.mf_size;
  const framesize = 576 * cfg.mode_gr;
  let nout = 0,
    n_in = 0,
    ch = 0;
  const nch = cfg.channels_out;

  /* copy in new samples into mfbuf, with resampling if necessary */
  if (isResamplingNecessary(cfg)) {
    do {
      [nout, n_in] = fill_buffer_resample(gfc, mfbuf[ch], mf_size, framesize, in_buffer[ch], ino, nsamples, ch);
    } while (++ch < nch);
    return [n_in, nout];
  } else {
    nout = Math.min(framesize, nsamples);
    do {
      mfbuf[ch].set(in_buffer[ch].subarray(ino, ino + nout), mf_size);
    } while (++ch < nch);
    return [nout, nout];
  }
}
