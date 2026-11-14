// Port of libmp3lame/gain_analysis.c - ReplayGain analysis
// (David Robinson and Glen Sawyer; see the original file for the full description).

import { f } from './constants.ts';
import { ABButter, ABYule } from './tables.ts';

export const GAIN_NOT_ENOUGH_SAMPLES = -24601;
export const GAIN_ANALYSIS_ERROR = 0;
export const GAIN_ANALYSIS_OK = 1;
export const INIT_GAIN_ANALYSIS_ERROR = 0;
export const INIT_GAIN_ANALYSIS_OK = 1;

const PINK_REF = f(64.82); /* calibration value for 89dB */
const YULE_ORDER = 10;
const RMS_PERCENTILE = 0.95; /* percentile which is louder than the proposed level */
const MAX_SAMP_FREQ = 48000; /* maximum allowed sample frequency [Hz] */
const RMS_WINDOW_TIME_NUMERATOR = 1;
const RMS_WINDOW_TIME_DENOMINATOR = 20; /* numerator / denominator = time slice size [s] */
const STEPS_per_dB = 100; /* Table entries per dB */
const MAX_dB = 120; /* Table entries for 0...MAX_dB (normal max. values are 70...80 dB) */

const MAX_ORDER = YULE_ORDER;
const MAX_SAMPLES_PER_WINDOW = ((MAX_SAMP_FREQ * RMS_WINDOW_TIME_NUMERATOR) / RMS_WINDOW_TIME_DENOMINATOR + 1) | 0;

const YULE_ROW = 24;
const BUTTER_ROW = 8;

/** replaygain_t; the `xxx` pointers of the C struct are `xxxbuf` + MAX_ORDER here. */
export class ReplayGain {
  linprebuf = new Float32Array(MAX_ORDER * 2);
  lstepbuf = new Float32Array(MAX_SAMPLES_PER_WINDOW + MAX_ORDER);
  loutbuf = new Float32Array(MAX_SAMPLES_PER_WINDOW + MAX_ORDER);
  rinprebuf = new Float32Array(MAX_ORDER * 2);
  rstepbuf = new Float32Array(MAX_SAMPLES_PER_WINDOW + MAX_ORDER);
  routbuf = new Float32Array(MAX_SAMPLES_PER_WINDOW + MAX_ORDER);
  sampleWindow = 0; /* number of samples required to reach number of milliseconds required for RMS window */
  totsamp = 0;
  lsum = 0;
  rsum = 0;
  freqindex = 0;
  A = new Uint32Array(STEPS_per_dB * MAX_dB);
  B = new Uint32Array(STEPS_per_dB * MAX_dB);
}

/* When calling this procedure, make sure that ip[-order] and op[-order] point to real data! */
function filterYule(
  input: Float32Array,
  ip: number,
  output: Float32Array,
  op: number,
  nSamples: number,
  kernel: Float32Array,
  k: number,
): void {
  while (nSamples--) {
    const y0 = f(input[ip - 10] * kernel[k]);
    const y2 = f(input[ip - 9] * kernel[k + 1]);
    const y4 = f(input[ip - 8] * kernel[k + 2]);
    const y6 = f(input[ip - 7] * kernel[k + 3]);
    const s00 = f(f(f(y0 + y2) + y4) + y6);
    const y8 = f(input[ip - 6] * kernel[k + 4]);
    const yA = f(input[ip - 5] * kernel[k + 5]);
    const yC = f(input[ip - 4] * kernel[k + 6]);
    const yE = f(input[ip - 3] * kernel[k + 7]);
    const s01 = f(f(f(y8 + yA) + yC) + yE);
    const yG = f(f(input[ip - 2] * kernel[k + 8]) + f(input[ip - 1] * kernel[k + 9]));
    const yK = f(input[ip] * kernel[k + 10]);

    const s1 = f(f(f(s00 + s01) + yG) + yK);

    const x1 = f(f(output[op - 10] * kernel[k + 11]) + f(output[op - 9] * kernel[k + 12]));
    const x5 = f(f(output[op - 8] * kernel[k + 13]) + f(output[op - 7] * kernel[k + 14]));
    const x9 = f(f(output[op - 6] * kernel[k + 15]) + f(output[op - 5] * kernel[k + 16]));
    const xD = f(f(output[op - 4] * kernel[k + 17]) + f(output[op - 3] * kernel[k + 18]));
    const xH = f(f(output[op - 2] * kernel[k + 19]) + f(output[op - 1] * kernel[k + 20]));

    const s2 = f(f(f(f(x1 + x5) + x9) + xD) + xH);

    output[op] = s1 - s2;

    ++op;
    ++ip;
  }
}

function filterButter(
  input: Float32Array,
  ip: number,
  output: Float32Array,
  op: number,
  nSamples: number,
  kernel: Float32Array,
  k: number,
): void {
  while (nSamples--) {
    const s1 = f(
      f(f(input[ip - 2] * kernel[k]) + f(input[ip - 1] * kernel[k + 2])) + f(input[ip] * kernel[k + 4]),
    );
    const s2 = f(f(output[op - 2] * kernel[k + 1]) + f(output[op - 1] * kernel[k + 3]));
    output[op] = s1 - s2;
    ++op;
    ++ip;
  }
}

/* returns a INIT_GAIN_ANALYSIS_OK if successful, INIT_GAIN_ANALYSIS_ERROR if not */
function ResetSampleFrequency(rgData: ReplayGain, samplefreq: number): number {
  /* zero out initial values, only first MAX_ORDER values */
  rgData.linprebuf.fill(0, 0, MAX_ORDER);
  rgData.rinprebuf.fill(0, 0, MAX_ORDER);
  rgData.lstepbuf.fill(0, 0, MAX_ORDER);
  rgData.rstepbuf.fill(0, 0, MAX_ORDER);
  rgData.loutbuf.fill(0, 0, MAX_ORDER);
  rgData.routbuf.fill(0, 0, MAX_ORDER);

  const idx = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(samplefreq);
  if (idx < 0) return INIT_GAIN_ANALYSIS_ERROR;
  rgData.freqindex = idx;

  rgData.sampleWindow =
    ((samplefreq * RMS_WINDOW_TIME_NUMERATOR + RMS_WINDOW_TIME_DENOMINATOR - 1) / RMS_WINDOW_TIME_DENOMINATOR) | 0;

  rgData.lsum = 0;
  rgData.rsum = 0;
  rgData.totsamp = 0;

  rgData.A.fill(0);

  return INIT_GAIN_ANALYSIS_OK;
}

export function InitGainAnalysis(rgData: ReplayGain, samplefreq: number): number {
  if (ResetSampleFrequency(rgData, samplefreq) !== INIT_GAIN_ANALYSIS_OK) {
    return INIT_GAIN_ANALYSIS_ERROR;
  }

  rgData.B.fill(0);

  return INIT_GAIN_ANALYSIS_OK;
}

/* returns GAIN_ANALYSIS_OK if successful, GAIN_ANALYSIS_ERROR if not */
export function AnalyzeSamples(
  rgData: ReplayGain,
  left_samples: Float32Array,
  lo: number,
  right_samples: Float32Array,
  ro: number,
  num_samples: number,
  num_channels: number,
): number {
  let curleft: Float32Array, curright: Float32Array;
  let cl: number, cr: number;
  let batchsamples: number;
  let cursamples: number;
  let cursamplepos: number;
  let i: number;
  let sum_l: number, sum_r: number;

  if (num_samples === 0) return GAIN_ANALYSIS_OK;

  cursamplepos = 0;
  batchsamples = num_samples;

  switch (num_channels) {
    case 1:
      right_samples = left_samples;
      ro = lo;
      break;
    case 2:
      break;
    default:
      return GAIN_ANALYSIS_ERROR;
  }

  {
    const n = num_samples < MAX_ORDER ? num_samples : MAX_ORDER;
    for (i = 0; i < n; i++) {
      rgData.linprebuf[MAX_ORDER + i] = left_samples[lo + i];
      rgData.rinprebuf[MAX_ORDER + i] = right_samples[ro + i];
    }
  }

  const ky = rgData.freqindex * YULE_ROW;
  const kb = rgData.freqindex * BUTTER_ROW;

  while (batchsamples > 0) {
    cursamples =
      batchsamples > rgData.sampleWindow - rgData.totsamp ? rgData.sampleWindow - rgData.totsamp : batchsamples;
    if (cursamplepos < MAX_ORDER) {
      curleft = rgData.linprebuf;
      cl = MAX_ORDER + cursamplepos;
      curright = rgData.rinprebuf;
      cr = MAX_ORDER + cursamplepos;
      if (cursamples > MAX_ORDER - cursamplepos) cursamples = MAX_ORDER - cursamplepos;
    } else {
      curleft = left_samples;
      cl = lo + cursamplepos;
      curright = right_samples;
      cr = ro + cursamplepos;
    }

    const t = MAX_ORDER + rgData.totsamp;
    filterYule(curleft, cl, rgData.lstepbuf, t, cursamples, ABYule, ky);
    filterYule(curright, cr, rgData.rstepbuf, t, cursamples, ABYule, ky);

    filterButter(rgData.lstepbuf, t, rgData.loutbuf, t, cursamples, ABButter, kb);
    filterButter(rgData.rstepbuf, t, rgData.routbuf, t, cursamples, ABButter, kb);

    curleft = rgData.loutbuf; /* Get the squared values */
    curright = rgData.routbuf;
    cl = cr = t;

    sum_l = 0;
    sum_r = 0;
    i = cursamples & 0x03;
    while (i--) {
      const l = curleft[cl++];
      const r = curright[cr++];
      sum_l = f(sum_l + f(l * l));
      sum_r = f(sum_r + f(r * r));
    }
    i = (cursamples / 4) | 0;
    while (i--) {
      const l0 = f(curleft[cl] * curleft[cl]);
      const l1 = f(curleft[cl + 1] * curleft[cl + 1]);
      const l2 = f(curleft[cl + 2] * curleft[cl + 2]);
      const l3 = f(curleft[cl + 3] * curleft[cl + 3]);
      const sl = f(f(f(l0 + l1) + l2) + l3);
      const r0 = f(curright[cr] * curright[cr]);
      const r1 = f(curright[cr + 1] * curright[cr + 1]);
      const r2 = f(curright[cr + 2] * curright[cr + 2]);
      const r3 = f(curright[cr + 3] * curright[cr + 3]);
      const sr = f(f(f(r0 + r1) + r2) + r3);
      sum_l = f(sum_l + sl);
      cl += 4;
      sum_r = f(sum_r + sr);
      cr += 4;
    }
    rgData.lsum += sum_l;
    rgData.rsum += sum_r;

    batchsamples -= cursamples;
    cursamplepos += cursamples;
    rgData.totsamp += cursamples;
    if (rgData.totsamp === rgData.sampleWindow) {
      /* Get the Root Mean Square (RMS) for this set of samples */
      const val = STEPS_per_dB * 10 * Math.log10(((rgData.lsum + rgData.rsum) / rgData.totsamp) * 0.5 + 1e-37);
      let ival = val <= 0 ? 0 : Math.trunc(val);
      if (ival >= rgData.A.length) ival = rgData.A.length - 1;
      rgData.A[ival]++;
      rgData.lsum = rgData.rsum = 0;
      const n = rgData.totsamp;
      rgData.loutbuf.copyWithin(0, n, n + MAX_ORDER);
      rgData.routbuf.copyWithin(0, n, n + MAX_ORDER);
      rgData.lstepbuf.copyWithin(0, n, n + MAX_ORDER);
      rgData.rstepbuf.copyWithin(0, n, n + MAX_ORDER);
      rgData.totsamp = 0;
    }
    if (rgData.totsamp > rgData.sampleWindow) return GAIN_ANALYSIS_ERROR;
  }
  if (num_samples < MAX_ORDER) {
    rgData.linprebuf.copyWithin(0, num_samples, MAX_ORDER);
    rgData.rinprebuf.copyWithin(0, num_samples, MAX_ORDER);
    for (i = 0; i < num_samples; i++) {
      rgData.linprebuf[MAX_ORDER - num_samples + i] = left_samples[lo + i];
      rgData.rinprebuf[MAX_ORDER - num_samples + i] = right_samples[ro + i];
    }
  } else {
    for (i = 0; i < MAX_ORDER; i++) {
      rgData.linprebuf[i] = left_samples[lo + num_samples - MAX_ORDER + i];
      rgData.rinprebuf[i] = right_samples[ro + num_samples - MAX_ORDER + i];
    }
  }

  return GAIN_ANALYSIS_OK;
}

function analyzeResult(Array: Uint32Array, len: number): number {
  let elems = 0;
  let sum: number;
  let i: number;

  for (i = 0; i < len; i++) elems += Array[i];
  if (elems === 0) return GAIN_NOT_ENOUGH_SAMPLES;

  const upper = Math.ceil(elems * (1 - RMS_PERCENTILE));

  sum = 0;
  for (i = len; i-- > 0; ) {
    sum += Array[i];
    if (sum >= upper) {
      break;
    }
  }

  /* i wraps to SIZE_MAX in C when the loop runs out; that cannot happen as upper <= elems */
  return f(PINK_REF - f(f(i) / STEPS_per_dB));
}

export function GetTitleGain(rgData: ReplayGain): number {
  const retval = analyzeResult(rgData.A, rgData.A.length);

  for (let i = 0; i < rgData.A.length; i++) {
    rgData.B[i] += rgData.A[i];
    rgData.A[i] = 0;
  }

  rgData.linprebuf.fill(0, 0, MAX_ORDER);
  rgData.lstepbuf.fill(0, 0, MAX_ORDER);
  rgData.loutbuf.fill(0, 0, MAX_ORDER);
  rgData.rinprebuf.fill(0, 0, MAX_ORDER);
  rgData.rstepbuf.fill(0, 0, MAX_ORDER);
  rgData.routbuf.fill(0, 0, MAX_ORDER);

  rgData.totsamp = 0;
  rgData.lsum = rgData.rsum = 0;
  return retval;
}
