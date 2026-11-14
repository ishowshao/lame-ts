// Port of libmp3lame/psymodel.c - the psychoacoustic model (L3psycho_anal_vbr and its setup).
//
// The model computes, with one granule of delay, the masking thresholds and energies per
// scalefactor band for L/R and M/S, the perceptual entropy and the block type decision.

import {
  BLKSIZE,
  BLKSIZE_s,
  CBANDS,
  FLT_MAX,
  HBLKSIZE,
  HBLKSIZE_s,
  JOINT_STEREO,
  LOG10,
  NORM_TYPE,
  PI,
  SBMAX_l,
  SBMAX_s,
  SHORT_TYPE,
  SQRT2,
  START_TYPE,
  STOP_TYPE,
  f,
  short_block_coupled,
  short_block_dispensed,
  short_block_forced,
} from './constants.ts';
import { fft_long, fft_short, init_fft } from './fft.ts';
import { III_psy_xmin, PsyConst } from './types.ts';
import type { III_psy_ratio, LameGlobalFlags, LameInternalFlags, PsyConst_CB2SB, SessionConfig } from './types.ts';
import { ATHformula, FAST_LOG10, FAST_LOG10_X, freq2bark, powf } from './util.ts';

const NSFIRLEN = 21;
const LN_TO_LOG10 = LOG10 / 10;

const rpelev = 2;
const rpelev2 = 16;
/* size of each partition band, in barks: */
const DELBARK = 0.34;
/* tuned for output level (sensitive to energy scale) */
const VO_SCALE = 1 / (14752 * 14752) / (BLKSIZE / 2);
const temporalmask_sustain_sec = 0.01;
const NS_PREECHO_ATT0 = 0.8;
const NS_PREECHO_ATT1 = 0.6;
const NS_PREECHO_ATT2 = 0.3;
const NS_MSFIX = 3.5;
const NSATTACKTHRE = 4.4;
const NSATTACKTHRE_S = 25;

const f32 = (list: number[]): Float32Array => new Float32Array(list);

/* psycho_loudness_approx
   in:  energy   - BLKSIZE/2 elements of frequency magnitudes ^ 2
   returns: loudness^2 approximation, a positive value roughly tuned for a value
            of 1.0 for signals near clipping.
*/
function psycho_loudness_approx(energy: Float32Array, eql_w: Float32Array): number {
  let loudness_power = 0.0;
  /* apply weights to power in freq. bands */
  for (let i = 0; i < BLKSIZE / 2; ++i) loudness_power = f(loudness_power + f(energy[i] * eql_w[i]));
  loudness_power = f(loudness_power * VO_SCALE);

  return loudness_power;
}

/* mask_add optimization */
/* pow(10, (I1LIMIT + 1) / 16.0); */
const ma_max_i1 = f(3.6517412725483771);
/* pow(10, (I2LIMIT + 1) / 16.0); */
const ma_max_i2 = f(31.622776601683793);

/* This is the masking table:
   According to tonality, values are going from 0dB (TMN) to 9.3dB (NMT).
   After additive masking computation, 8dB are added, so
   final values are going from 8dB to 17.3dB
 */
const tab = f32([1.0, 0.79433, 0.63096, 0.63096, 0.63096, 0.63096, 0.63096, 0.25119, 0.11749]);

const tab_mask_add_delta = [2, 2, 2, 1, 1, 1, 0, 0, -1];

const table2 = f32([
  1.33352 * 1.33352,
  1.35879 * 1.35879,
  1.38454 * 1.38454,
  1.39497 * 1.39497,
  1.40548 * 1.40548,
  1.3537 * 1.3537,
  1.30382 * 1.30382,
  1.22321 * 1.22321,
  1.14758 * 1.14758,
  1,
]);

/* addition of simultaneous masking   Naoki Shibata 2000/7 */
function vbrpsy_mask_add(m1: number, m2: number, b: number, delta: number): number {
  let ratio: number;

  if (m1 < 0) m1 = 0;
  if (m2 < 0) m2 = 0;
  if (m1 <= 0) return m2;
  if (m2 <= 0) return m1;
  if (m2 > m1) {
    ratio = f(m2 / m1);
  } else {
    ratio = f(m1 / m2);
  }
  if (Math.abs(b) <= delta) {
    /* approximately, 1 bark = 3 partitions */
    /* originally 'if(i > 8)' */
    if (ratio >= ma_max_i1) {
      return f(m1 + m2);
    } else {
      const i = Math.trunc(FAST_LOG10_X(ratio, 16.0));
      return f(f(m1 + m2) * table2[i]);
    }
  }
  if (ratio < ma_max_i2) {
    return f(m1 + m2);
  }
  if (m1 < m2) {
    m1 = m2;
  }
  return m1;
}

const p2sb_enn = new Float32Array(SBMAX_l);
const p2sb_thm = new Float32Array(SBMAX_l);

/* short block threshold calculation (part 2)

    partition band bo_s[sfb] is at the transition from scalefactor
    band sfb to the next one sfb+1; enn and thmm have to be split
    between them
*/
function convert_partition2scalefac(
  gd: PsyConst_CB2SB,
  eb: Float32Array,
  thr: Float32Array,
  enn_out: Float32Array,
  thm_out: Float32Array,
): void {
  let enn = 0.0,
    thmm = 0.0;
  let sb: number, b: number;
  const n = gd.n_sb;
  for (sb = b = 0; sb < n; ++b, ++sb) {
    const bo_sb = gd.bo[sb];
    const npart = gd.npart;
    const b_lim = bo_sb < npart ? bo_sb : npart;
    while (b < b_lim) {
      enn = f(enn + eb[b]);
      thmm = f(thmm + thr[b]);
      b++;
    }
    if (b >= npart) {
      enn_out[sb] = enn;
      thm_out[sb] = thmm;
      ++sb;
      break;
    }
    {
      /* at transition sfb -> sfb+1 */
      const w_curr = gd.bo_weight[sb];
      const w_next = f(1.0 - w_curr);
      enn = f(enn + f(w_curr * eb[b]));
      thmm = f(thmm + f(w_curr * thr[b]));
      enn_out[sb] = enn;
      thm_out[sb] = thmm;
      enn = f(w_next * eb[b]);
      thmm = f(w_next * thr[b]);
    }
  }
  /* zero initialize the rest */
  for (; sb < n; ++sb) {
    enn_out[sb] = 0;
    thm_out[sb] = 0;
  }
}

function convert_partition2scalefac_s(
  gfc: LameInternalFlags,
  eb: Float32Array,
  thr: Float32Array,
  chn: number,
  sblock: number,
): void {
  const psv = gfc.sv_psy;
  const en = psv.en[chn].s;
  const thm = psv.thm[chn].s;
  convert_partition2scalefac(gfc.cd_psy!.s, eb, thr, p2sb_enn, p2sb_thm);
  for (let sb = 0; sb < SBMAX_s; ++sb) {
    en[sb * 3 + sblock] = p2sb_enn[sb];
    thm[sb * 3 + sblock] = p2sb_thm[sb];
  }
}

/* longblock threshold calculation (part 2) */
function convert_partition2scalefac_l(gfc: LameInternalFlags, eb: Float32Array, thr: Float32Array, chn: number): void {
  const psv = gfc.sv_psy;
  convert_partition2scalefac(gfc.cd_psy!.l, eb, thr, psv.en[chn].l, psv.thm[chn].l);
}

function convert_partition2scalefac_l_to_s(
  gfc: LameInternalFlags,
  eb: Float32Array,
  thr: Float32Array,
  chn: number,
): void {
  const psv = gfc.sv_psy;
  const en = psv.en[chn].s;
  const thm = psv.thm[chn].s;
  convert_partition2scalefac(gfc.cd_psy!.l_to_s, eb, thr, p2sb_enn, p2sb_thm);
  for (let sb = 0; sb < SBMAX_s; ++sb) {
    const scale = 1 / 64;
    const tmp_enn = p2sb_enn[sb];
    const tmp_thm = f(p2sb_thm[sb] * scale);
    for (let sblock = 0; sblock < 3; ++sblock) {
      en[sb * 3 + sblock] = tmp_enn;
      thm[sb * 3 + sblock] = tmp_thm;
    }
  }
}

function NS_INTERP(x: number, y: number, r: number): number {
  /* was pow((x),(r))*pow((y),1-(r)) */
  if (r >= 1.0) return x; /* 99.7% of the time */
  if (r <= 0.0) return y;
  if (y > 0.0) return f(powf(f(x / y), r) * y); /* rest of the time */
  return 0.0; /* never happens */
}

/* these values are tuned only for 44.1kHz... */
const regcoef_s = f32([11.8, 13.6, 17.2, 32, 46.5, 51.3, 57.5, 67.1, 71.5, 84.6, 97.6, 130 /* 255.8 */]);

const TEN_LOG10 = 10.0 * LOG10;
const F_1E10 = f(1e10);

function pecalc_s(mr: III_psy_ratio, masking_lower: number): number {
  let pe_s = f(f(1236.28) / 4);
  for (let sb = 0; sb < SBMAX_s - 1; sb++) {
    for (let sblock = 0; sblock < 3; sblock++) {
      const thm = mr.thm.s[sb * 3 + sblock];
      if (thm > 0.0) {
        const x = f(thm * masking_lower);
        const en = mr.en.s[sb * 3 + sblock];
        if (en > x) {
          if (en > f(x * F_1E10)) {
            pe_s = f(pe_s + regcoef_s[sb] * TEN_LOG10);
          } else {
            pe_s = f(pe_s + regcoef_s[sb] * FAST_LOG10(f(en / x)));
          }
        }
      }
    }
  }

  return pe_s;
}

/* these values are tuned only for 44.1kHz... */
const regcoef_l = f32([
  6.8, 5.8, 5.8, 6.4, 6.5, 9.9, 12.1, 14.4, 15, 18.9, 21.6, 26.9, 34.2, 40.2, 46.8, 56.5, 60.7, 73.9, 85.7, 93.4,
  126.1 /* 241.3 */,
]);

function pecalc_l(mr: III_psy_ratio, masking_lower: number): number {
  let pe_l = f(f(1124.23) / 4);
  for (let sb = 0; sb < SBMAX_l - 1; sb++) {
    const thm = mr.thm.l[sb];
    if (thm > 0.0) {
      const x = f(thm * masking_lower);
      const en = mr.en.l[sb];
      if (en > x) {
        if (en > f(x * F_1E10)) {
          pe_l = f(pe_l + regcoef_l[sb] * TEN_LOG10);
        } else {
          pe_l = f(pe_l + regcoef_l[sb] * FAST_LOG10(f(en / x)));
        }
      }
    }
  }

  return pe_l;
}

function calc_energy(l: PsyConst_CB2SB, fftenergy: Float32Array, eb: Float32Array, max: Float32Array, avg: Float32Array): void {
  let b: number, j: number;

  for (b = j = 0; b < l.npart; ++b) {
    let ebb = 0,
      m = 0;
    const n = l.numlines[b];
    for (let i = 0; i < n; ++i, ++j) {
      const el = fftenergy[j];
      ebb = f(ebb + el);
      if (m < el) m = el;
    }
    eb[b] = ebb;
    max[b] = m;
    avg[b] = ebb * l.rnumlines[b];
  }
}

/** calc_mask_index_l / vbrpsy_calc_mask_index_s (the two C functions are identical). */
function calc_mask_index(gd: PsyConst_CB2SB, max: Float32Array, avg: Float32Array, mask_idx: Uint8Array): void {
  let m: number, a: number;
  let b: number, k: number;
  const last_tab_entry = tab.length - 1;
  const numlines = gd.numlines;
  b = 0;
  a = f(avg[b] + avg[b + 1]);
  if (a > 0.0) {
    m = max[b];
    if (m < max[b + 1]) m = max[b + 1];
    a = f(f(20.0 * f(f(m * 2.0) - a)) / f(a * (numlines[b] + numlines[b + 1] - 1)));
    k = Math.trunc(a);
    if (k > last_tab_entry) k = last_tab_entry;
    mask_idx[b] = k;
  } else {
    mask_idx[b] = 0;
  }

  for (b = 1; b < gd.npart - 1; b++) {
    a = f(f(avg[b - 1] + avg[b]) + avg[b + 1]);
    if (a > 0.0) {
      m = max[b - 1];
      if (m < max[b]) m = max[b];
      if (m < max[b + 1]) m = max[b + 1];
      a = f(f(20.0 * f(f(m * 3.0) - a)) / f(a * (numlines[b - 1] + numlines[b] + numlines[b + 1] - 1)));
      k = Math.trunc(a);
      if (k > last_tab_entry) k = last_tab_entry;
      mask_idx[b] = k;
    } else {
      mask_idx[b] = 0;
    }
  }

  a = f(avg[b - 1] + avg[b]);
  if (a > 0.0) {
    m = max[b - 1];
    if (m < max[b]) m = max[b];
    a = f(f(20.0 * f(f(m * 2.0) - a)) / f(a * (numlines[b - 1] + numlines[b] - 1)));
    k = Math.trunc(a);
    if (k > last_tab_entry) k = last_tab_entry;
    mask_idx[b] = k;
  } else {
    mask_idx[b] = 0;
  }
}

const sqrt2_half = f(SQRT2 * 0.5);

function vbrpsy_compute_fft_l(
  gfc: LameInternalFlags,
  buffer: Float32Array[],
  bo: number,
  chn: number,
  fftenergy: Float32Array,
  wsamp_L: Float32Array[],
): void {
  const psv = gfc.sv_psy;
  const wsamp_l = wsamp_L[chn & 1];

  if (chn < 2) {
    fft_long(gfc.cd_psy!.window, wsamp_l, buffer[chn], bo);
  } else if (chn === 2) {
    const w0 = wsamp_L[0];
    const w1 = wsamp_L[1];
    /* FFT data for mid and side channel is derived from L & R */
    for (let j = BLKSIZE - 1; j >= 0; --j) {
      const l = w0[j];
      const r = w1[j];
      w0[j] = f(l + r) * sqrt2_half;
      w1[j] = f(l - r) * sqrt2_half;
    }
  }

  /*********************************************************************
   *  compute energies
   *********************************************************************/
  fftenergy[0] = wsamp_l[0];
  fftenergy[0] *= fftenergy[0];

  for (let j = BLKSIZE / 2 - 1; j >= 0; --j) {
    const re = wsamp_l[BLKSIZE / 2 - j];
    const im = wsamp_l[BLKSIZE / 2 + j];
    fftenergy[BLKSIZE / 2 - j] = f(f(re * re) + f(im * im)) * 0.5;
  }
  /* total energy */
  {
    let totalenergy = 0.0;
    for (let j = 11; j < HBLKSIZE; j++) totalenergy = f(totalenergy + fftenergy[j]);

    psv.tot_ener[chn] = totalenergy;
  }
}

function vbrpsy_compute_fft_s(
  gfc: LameInternalFlags,
  buffer: Float32Array[],
  bo: number,
  chn: number,
  sblock: number,
  fftenergy_s: Float32Array[],
  wsamp_S: Float32Array[][],
): void {
  const wsamp_s = wsamp_S[chn & 1];
  if (sblock === 0 && chn < 2) {
    fft_short(gfc.cd_psy!.window_s, wsamp_s, buffer[chn], bo);
  }
  if (chn === 2) {
    const w0 = wsamp_S[0][sblock];
    const w1 = wsamp_S[1][sblock];
    /* FFT data for mid and side channel is derived from L & R */
    for (let j = BLKSIZE_s - 1; j >= 0; --j) {
      const l = w0[j];
      const r = w1[j];
      w0[j] = f(l + r) * sqrt2_half;
      w1[j] = f(l - r) * sqrt2_half;
    }
  }

  /*********************************************************************
   *  compute energies
   *********************************************************************/
  const ws = wsamp_s[sblock];
  const fe = fftenergy_s[sblock];
  fe[0] = ws[0];
  fe[0] *= fe[0];
  for (let j = BLKSIZE_s / 2 - 1; j >= 0; --j) {
    const re = ws[BLKSIZE_s / 2 - j];
    const im = ws[BLKSIZE_s / 2 + j];
    fe[BLKSIZE_s / 2 - j] = f(f(re * re) + f(im * im)) * 0.5;
  }
}

/*********************************************************************
 * compute loudness approximation (used for ATH auto-level adjustment)
 *********************************************************************/
function vbrpsy_compute_loudness_approximation_l(
  gfc: LameInternalFlags,
  gr_out: number,
  chn: number,
  fftenergy: Float32Array,
): void {
  const psv = gfc.sv_psy;
  if (chn < 2) {
    /*no loudness for mid/side ch */
    gfc.ov_psy.loudness_sq[gr_out][chn] = psv.loudness_sq_save[chn];
    psv.loudness_sq_save[chn] = psycho_loudness_approx(fftenergy, gfc.ATH.eql_w);
  }
}

const attack_fircoef = f32([
  -8.65163e-18 * 2,
  -0.00851586 * 2,
  -6.74764e-18 * 2,
  0.0209036 * 2,
  -3.36639e-17 * 2,
  -0.0438162 * 2,
  -1.54175e-17 * 2,
  0.0931738 * 2,
  -5.52212e-17 * 2,
  -0.313819 * 2,
]);

const F_1_7 = f(1.7);

/** Per-call scratch state of the psychoacoustic model (one per encoder). */
export class PsyScratch {
  ns_hpfsmpl = [new Float32Array(576), new Float32Array(576)];
  attack_intensity = new Float32Array(12);
  en_subshort = new Float32Array(12);
  en_short = new Float32Array(4);
  max = new Float32Array(CBANDS);
  avg = new Float32Array(CBANDS);
  mask_idx = new Uint8Array(CBANDS + 2);
  last_thm = [new III_psy_xmin(), new III_psy_xmin(), new III_psy_xmin(), new III_psy_xmin()];
  fftenergy = new Float32Array(HBLKSIZE);
  fftenergy_s = [new Float32Array(HBLKSIZE_s), new Float32Array(HBLKSIZE_s), new Float32Array(HBLKSIZE_s)];
  wsamp_L = [new Float32Array(BLKSIZE), new Float32Array(BLKSIZE)];
  wsamp_S = [
    [new Float32Array(BLKSIZE_s), new Float32Array(BLKSIZE_s), new Float32Array(BLKSIZE_s)],
    [new Float32Array(BLKSIZE_s), new Float32Array(BLKSIZE_s), new Float32Array(BLKSIZE_s)],
  ];
  eb = [new Float32Array(CBANDS), new Float32Array(CBANDS), new Float32Array(CBANDS), new Float32Array(CBANDS)];
  thr = [new Float32Array(CBANDS), new Float32Array(CBANDS), new Float32Array(CBANDS), new Float32Array(CBANDS)];
  sub_short_factor = [new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3)];
  ns_attacks = [new Int32Array(4), new Int32Array(4), new Int32Array(4), new Int32Array(4)];
  uselongblock = new Int32Array(2);
  new_thmm = new Float32Array(3);
}

const scratchOf = new WeakMap<LameInternalFlags, PsyScratch>();

/**********************************************************************
 *  Apply HPF of fs/4 to the input signal.
 *  This is used for attack detection / handling.
 **********************************************************************/
function vbrpsy_attack_detection(
  gfc: LameInternalFlags,
  sc: PsyScratch,
  buffer: Float32Array[],
  bo: number,
  gr_out: number,
  masking_ratio: III_psy_ratio[][],
  masking_MS_ratio: III_psy_ratio[][],
  energy: Float32Array,
  sub_short_factor: Float32Array[],
  ns_attacks: Int32Array[],
  uselongblock: Int32Array,
): void {
  const ns_hpfsmpl = sc.ns_hpfsmpl;
  const cfg = gfc.cfg;
  const psv = gfc.sv_psy;
  const n_chn_out = cfg.channels_out;
  /* chn=2 and 3 = Mid and Side channels */
  const n_chn_psy = cfg.mode === JOINT_STEREO ? 4 : n_chn_out;
  let chn: number, i: number, j: number;

  ns_hpfsmpl[0].fill(0);
  ns_hpfsmpl[1].fill(0);

  /* Don't copy the input buffer into a temporary buffer */
  /* unroll the loop 2 times */
  for (chn = 0; chn < n_chn_out; chn++) {
    /* apply high pass filter of fs/4 */
    const buf = buffer[chn];
    const firbuf = bo + 576 - 350 - NSFIRLEN + 192;
    const out = ns_hpfsmpl[chn];
    for (i = 0; i < 576; i++) {
      let sum1 = buf[firbuf + i + 10];
      let sum2 = 0.0;
      for (j = 0; j < (NSFIRLEN - 1) / 2 - 1; j += 2) {
        sum1 = f(sum1 + f(attack_fircoef[j] * f(buf[firbuf + i + j] + buf[firbuf + i + NSFIRLEN - j])));
        sum2 = f(sum2 + f(attack_fircoef[j + 1] * f(buf[firbuf + i + j + 1] + buf[firbuf + i + NSFIRLEN - j - 1])));
      }
      out[i] = sum1 + sum2;
    }
    masking_ratio[gr_out][chn].en.assign(psv.en[chn]);
    masking_ratio[gr_out][chn].thm.assign(psv.thm[chn]);
    if (n_chn_psy > 2) {
      /* MS maskings  */
      masking_MS_ratio[gr_out][chn].en.assign(psv.en[chn + 2]);
      masking_MS_ratio[gr_out][chn].thm.assign(psv.thm[chn + 2]);
    }
  }
  for (chn = 0; chn < n_chn_psy; chn++) {
    const attack_intensity = sc.attack_intensity;
    const en_subshort = sc.en_subshort;
    const en_short = sc.en_short;
    en_short.fill(0);
    const pfb = ns_hpfsmpl[chn & 1];
    let pf = 0;
    let ns_uselongblock = 1;
    const last_en_subshort = psv.last_en_subshort[chn];
    const attacks = ns_attacks[chn];

    if (chn === 2) {
      const h0 = ns_hpfsmpl[0];
      const h1 = ns_hpfsmpl[1];
      for (i = 0, j = 576; j > 0; ++i, --j) {
        const l = h0[i];
        const r = h1[i];
        h0[i] = l + r;
        h1[i] = l - r;
      }
    }
    /***************************************************************
     * determine the block type (window type)
     ***************************************************************/
    /* calculate energies of each sub-shortblocks */
    for (i = 0; i < 3; i++) {
      en_subshort[i] = last_en_subshort[i + 6];
      attack_intensity[i] = en_subshort[i] / last_en_subshort[i + 4];
      en_short[0] += en_subshort[i];
    }

    for (i = 0; i < 9; i++) {
      const pfe = pf + ((576 / 9) | 0);
      let p = 1;
      for (; pf < pfe; pf++) {
        const v = Math.abs(pfb[pf]);
        if (p < v) p = v;
      }
      last_en_subshort[i] = en_subshort[i + 3] = p;
      en_short[1 + ((i / 3) | 0)] += p;
      if (p > en_subshort[i + 3 - 2]) {
        p = f(p / en_subshort[i + 3 - 2]);
      } else if (en_subshort[i + 3 - 2] > f(p * 10.0)) {
        p = f(en_subshort[i + 3 - 2] / f(p * 10.0));
      } else {
        p = 0.0;
      }
      attack_intensity[i + 3] = p;
    }

    /* pulse like signal detection for fatboy.wav and so on */
    for (i = 0; i < 3; ++i) {
      const enn = f(f(en_subshort[i * 3 + 3] + en_subshort[i * 3 + 4]) + en_subshort[i * 3 + 5]);
      let factor = 1;
      if (f(en_subshort[i * 3 + 5] * 6) < enn) {
        factor *= 0.5;
        if (f(en_subshort[i * 3 + 4] * 6) < enn) {
          factor *= 0.5;
        }
      }
      sub_short_factor[chn][i] = factor;
    }

    /* compare energies between sub-shortblocks */
    {
      const x = gfc.cd_psy!.attack_threshold[chn];
      for (i = 0; i < 12; i++) {
        if (attacks[(i / 3) | 0] === 0) {
          if (attack_intensity[i] > x) {
            attacks[(i / 3) | 0] = (i % 3) + 1;
          }
        }
      }
    }

    /* should have energy change between short blocks, in order to avoid periodic signals */
    /* Good samples to show the effect are Trumpet test songs */
    /* GB: tuned (1) to avoid too many short blocks for test sample TRUMPET */
    /* RH: tuned (2) to let enough short blocks through for test sample FSOL and SNAPS */
    for (i = 1; i < 4; i++) {
      const u = en_short[i - 1];
      const v = en_short[i];
      const m = u > v ? u : v;
      if (m < 40000) {
        /* (2) */
        if (u < f(F_1_7 * v) && v < f(F_1_7 * u)) {
          /* (1) */
          if (i === 1 && attacks[0] <= attacks[i]) {
            attacks[0] = 0;
          }
          attacks[i] = 0;
        }
      }
    }

    if (attacks[0] <= psv.last_attacks[chn]) {
      attacks[0] = 0;
    }

    if (psv.last_attacks[chn] === 3 || attacks[0] + attacks[1] + attacks[2] + attacks[3]) {
      ns_uselongblock = 0;

      if (attacks[1] && attacks[0]) {
        attacks[1] = 0;
      }
      if (attacks[2] && attacks[1]) {
        attacks[2] = 0;
      }
      if (attacks[3] && attacks[2]) {
        attacks[3] = 0;
      }
    }
    if (chn < 2) {
      uselongblock[chn] = ns_uselongblock;
    } else {
      if (ns_uselongblock === 0) {
        uselongblock[0] = uselongblock[1] = 0;
      }
    }

    /* there is a one granule delay.  Copy maskings computed last call
     * into masking_ratio to return to calling program.
     */
    energy[chn] = psv.tot_ener[chn];
  }
}

function vbrpsy_skip_masking_s(gfc: LameInternalFlags, chn: number, sblock: number): void {
  if (sblock === 0) {
    const nbs2 = gfc.sv_psy.nb_s2[chn];
    const nbs1 = gfc.sv_psy.nb_s1[chn];
    const n = gfc.cd_psy!.s.npart;
    for (let b = 0; b < n; b++) {
      nbs2[b] = nbs1[b];
    }
  }
}

function vbrpsy_compute_masking_s(
  gfc: LameInternalFlags,
  sc: PsyScratch,
  fftenergy_s: Float32Array[],
  eb: Float32Array,
  thr: Float32Array,
  chn: number,
  sblock: number,
): void {
  const psv = gfc.sv_psy;
  const gds = gfc.cd_psy!.s;
  const max = sc.max;
  const avg = sc.avg;
  let i: number, j: number, b: number;
  const mask_idx_s = sc.mask_idx;
  const fe = fftenergy_s[sblock];
  const s3 = gds.s3;

  max.fill(0);
  avg.fill(0);

  for (b = j = 0; b < gds.npart; ++b) {
    let ebb = 0,
      m = 0;
    const n = gds.numlines[b];
    for (i = 0; i < n; ++i, ++j) {
      const el = fe[j];
      ebb = f(ebb + el);
      if (m < el) m = el;
    }
    eb[b] = ebb;
    max[b] = m;
    avg[b] = ebb * gds.rnumlines[b];
  }
  calc_mask_index(gds, max, avg, mask_idx_s);
  for (j = b = 0; b < gds.npart; b++) {
    let kk = gds.s3ind[b * 2];
    const last = gds.s3ind[b * 2 + 1];
    const delta = tab_mask_add_delta[mask_idx_s[b]];
    let dd: number, dd_n: number;
    let x: number, ecb: number;
    const masking_lower = f(gds.masking_lower[b] * gfc.sv_qnt.masking_lower);

    dd = mask_idx_s[kk];
    dd_n = 1;
    ecb = f(f(s3[j] * eb[kk]) * tab[mask_idx_s[kk]]);
    ++j, ++kk;
    while (kk <= last) {
      dd += mask_idx_s[kk];
      dd_n += 1;
      x = f(f(s3[j] * eb[kk]) * tab[mask_idx_s[kk]]);
      ecb = vbrpsy_mask_add(ecb, x, kk - b, delta);
      ++j, ++kk;
    }
    dd = ((1 + 2 * dd) / (2 * dd_n)) | 0;
    const avg_mask = f(tab[dd] * 0.5);
    ecb = f(ecb * avg_mask);
    /* we do pre-echo control later */
    thr[b] = ecb;
    psv.nb_s2[chn][b] = psv.nb_s1[chn][b];
    psv.nb_s1[chn][b] = ecb;
    {
      /*  if THR exceeds EB, the quantization routines will take the difference
       *  from other bands. in case of strong tonal samples (tonaltest.wav)
       *  this leads to heavy distortions. that's why we limit THR here.
       */
      x = max[b];
      x = f(x * gds.minval[b]);
      x = f(x * avg_mask);
      if (thr[b] > x) {
        thr[b] = x;
      }
    }
    if (masking_lower > 1) {
      thr[b] *= masking_lower;
    }
    if (thr[b] > eb[b]) {
      thr[b] = eb[b];
    }
    if (masking_lower < 1) {
      thr[b] *= masking_lower;
    }
  }
  for (; b < CBANDS; ++b) {
    eb[b] = 0;
    thr[b] = 0;
  }
}

function vbrpsy_compute_masking_l(
  gfc: LameInternalFlags,
  sc: PsyScratch,
  fftenergy: Float32Array,
  eb_l: Float32Array,
  thr: Float32Array,
  chn: number,
): void {
  const psv = gfc.sv_psy;
  const gdl = gfc.cd_psy!.l;
  const max = sc.max;
  const avg = sc.avg;
  const mask_idx_l = sc.mask_idx;
  const s3 = gdl.s3;
  let k: number, b: number;

  /*********************************************************************
   *    Calculate the energy and the tonality of each partition.
   *********************************************************************/
  calc_energy(gdl, fftenergy, eb_l, max, avg);
  calc_mask_index(gdl, max, avg, mask_idx_l);

  /*********************************************************************
   *      convolve the partitioned energy and unpredictability
   *      with the spreading function, s3_l[b][k]
   ********************************************************************/
  k = 0;
  for (b = 0; b < gdl.npart; b++) {
    let x: number, ecb: number;
    const masking_lower = f(gdl.masking_lower[b] * gfc.sv_qnt.masking_lower);
    /* convolve the partitioned energy with the spreading function */
    let kk = gdl.s3ind[b * 2];
    const last = gdl.s3ind[b * 2 + 1];
    const delta = tab_mask_add_delta[mask_idx_l[b]];
    let dd = 0,
      dd_n = 0;

    dd = mask_idx_l[kk];
    dd_n += 1;
    ecb = f(f(s3[k] * eb_l[kk]) * tab[mask_idx_l[kk]]);
    ++k, ++kk;
    while (kk <= last) {
      dd += mask_idx_l[kk];
      dd_n += 1;
      x = f(f(s3[k] * eb_l[kk]) * tab[mask_idx_l[kk]]);
      ecb = vbrpsy_mask_add(ecb, x, kk - b, delta);
      ++k, ++kk;
    }
    dd = ((1 + 2 * dd) / (2 * dd_n)) | 0;
    const avg_mask = f(tab[dd] * 0.5);
    ecb = f(ecb * avg_mask);

    /****   long block pre-echo control   ****/
    /* dont use long block pre-echo control if previous granule was
     * a short block.  This is to avoid the situation:
     * frame0:  quiet (very low masking)
     * frame1:  surge  (triggers short blocks)
     * frame2:  regular frame.  looks like pre-echo when compared to
     *          frame0, but all pre-echo was in frame1.
     */
    /* chn=0,1   L and R channels
       chn=2,3   S and M channels.
     */
    if (psv.blocktype_old[chn & 0x01] === SHORT_TYPE) {
      const ecb_limit = f(rpelev * psv.nb_l1[chn][b]);
      if (ecb_limit > 0) {
        thr[b] = ecb < ecb_limit ? ecb : ecb_limit;
      } else {
        /* Robert 071209:
           Because we don't calculate long block psy when we know a granule
           should be of short blocks, we don't have any clue how the granule
           before would have looked like as a long block. So we have to guess
           a little bit for this END_TYPE block.
           Most of the time we get away with this sloppyness. (fingers crossed :)
           The speed increase is worth it.
         */
        const lim = eb_l[b] * NS_PREECHO_ATT2;
        thr[b] = ecb < lim ? ecb : lim;
      }
    } else {
      let ecb_limit_2 = f(rpelev2 * psv.nb_l2[chn][b]);
      let ecb_limit_1 = f(rpelev * psv.nb_l1[chn][b]);
      let ecb_limit: number;
      if (ecb_limit_2 <= 0) {
        ecb_limit_2 = ecb;
      }
      if (ecb_limit_1 <= 0) {
        ecb_limit_1 = ecb;
      }
      if (psv.blocktype_old[chn & 0x01] === NORM_TYPE) {
        ecb_limit = ecb_limit_1 < ecb_limit_2 ? ecb_limit_1 : ecb_limit_2;
      } else {
        ecb_limit = ecb_limit_1;
      }
      thr[b] = ecb < ecb_limit ? ecb : ecb_limit;
    }
    psv.nb_l2[chn][b] = psv.nb_l1[chn][b];
    psv.nb_l1[chn][b] = ecb;
    {
      /*  if THR exceeds EB, the quantization routines will take the difference
       *  from other bands. in case of strong tonal samples (tonaltest.wav)
       *  this leads to heavy distortions. that's why we limit THR here.
       */
      x = max[b];
      x = f(x * gdl.minval[b]);
      x = f(x * avg_mask);
      if (thr[b] > x) {
        thr[b] = x;
      }
    }
    if (masking_lower > 1) {
      thr[b] *= masking_lower;
    }
    if (thr[b] > eb_l[b]) {
      thr[b] = eb_l[b];
    }
    if (masking_lower < 1) {
      thr[b] *= masking_lower;
    }
  }
  for (; b < CBANDS; ++b) {
    eb_l[b] = 0;
    thr[b] = 0;
  }
}

function vbrpsy_compute_block_type(cfg: SessionConfig, uselongblock: Int32Array): void {
  if (
    cfg.short_blocks === short_block_coupled &&
    /* force both channels to use the same block type */
    /* this is necessary if the frame is to be encoded in ms_stereo.  */
    /* But even without ms_stereo, FhG  does this */
    !(uselongblock[0] && uselongblock[1])
  )
    uselongblock[0] = uselongblock[1] = 0;

  for (let chn = 0; chn < cfg.channels_out; chn++) {
    /* disable short blocks */
    if (cfg.short_blocks === short_block_dispensed) {
      uselongblock[chn] = 1;
    }
    if (cfg.short_blocks === short_block_forced) {
      uselongblock[chn] = 0;
    }
  }
}

function vbrpsy_apply_block_type(
  psv: LameInternalFlags['sv_psy'],
  nch: number,
  uselongblock: Int32Array,
  blocktype_d: Int32Array,
): void {
  /* update the blocktype of the previous granule, since it depends on what
   * happend in this granule */
  for (let chn = 0; chn < nch; chn++) {
    let blocktype = NORM_TYPE;
    /* disable short blocks */

    if (uselongblock[chn]) {
      /* no attack : use long blocks */
      if (psv.blocktype_old[chn] === SHORT_TYPE) blocktype = STOP_TYPE;
    } else {
      /* attack : use short blocks */
      blocktype = SHORT_TYPE;
      if (psv.blocktype_old[chn] === NORM_TYPE) {
        psv.blocktype_old[chn] = START_TYPE;
      }
      if (psv.blocktype_old[chn] === STOP_TYPE) psv.blocktype_old[chn] = SHORT_TYPE;
    }

    blocktype_d[chn] = psv.blocktype_old[chn]; /* value returned to calling program */
    psv.blocktype_old[chn] = blocktype; /* save for next call to l3psy_anal */
  }
}

const F_1_58 = f(1.58);

/***************************************************************
 * compute M/S thresholds from Johnston & Ferreira 1992 ICASSP paper
 ***************************************************************/
function vbrpsy_compute_MS_thresholds(
  eb: Float32Array[],
  thr: Float32Array[],
  cb_mld: Float32Array,
  ath_cb: Float32Array,
  athlower: number,
  msfix: number,
  n: number,
): void {
  const msfix2 = f(msfix * 2);
  let rside: number, rmid: number;
  for (let b = 0; b < n; ++b) {
    const ebM = eb[2][b];
    const ebS = eb[3][b];
    const thmL = thr[0][b];
    const thmR = thr[1][b];
    let thmM = thr[2][b];
    let thmS = thr[3][b];

    /* use this fix if L & R masking differs by 2db or less */
    /* if db = 10*log10(x2/x1) < 2 */
    /* if (x2 < 1.58*x1) { */
    if (thmL <= f(F_1_58 * thmR) && thmR <= f(F_1_58 * thmL)) {
      const mld_m = f(cb_mld[b] * ebS);
      const mld_s = f(cb_mld[b] * ebM);
      const tmp_m = thmS < mld_m ? thmS : mld_m;
      const tmp_s = thmM < mld_s ? thmM : mld_s;
      rmid = thmM > tmp_m ? thmM : tmp_m;
      rside = thmS > tmp_s ? thmS : tmp_s;
    } else {
      rmid = thmM;
      rside = thmS;
    }
    if (msfix > 0) {
      /***************************************************************/
      /* Adjust M/S maskings if user set "msfix"                     */
      /***************************************************************/
      /* Naoki Shibata 2000 */
      const ath = f(ath_cb[b] * athlower);
      const tmp_l = thmL > ath ? thmL : ath;
      const tmp_r = thmR > ath ? thmR : ath;
      const thmLR = tmp_l < tmp_r ? tmp_l : tmp_r;
      thmM = rmid > ath ? rmid : ath;
      thmS = rside > ath ? rside : ath;
      const thmMS = f(thmM + thmS);
      if (thmMS > 0 && f(thmLR * msfix2) < thmMS) {
        const fac = f(f(thmLR * msfix2) / thmMS);
        thmM = f(thmM * fac);
        thmS = f(thmS * fac);
      }
      rmid = thmM < rmid ? thmM : rmid;
      rside = thmS < rside ? thmS : rside;
    }
    if (rmid > ebM) {
      rmid = ebM;
    }
    if (rside > ebS) {
      rside = ebS;
    }
    thr[2][b] = rmid;
    thr[3][b] = rside;
  }
}

const PCFACT = f(0.6);
const INTERP_ATT1 = f(NS_PREECHO_ATT1 * PCFACT);
const INTERP_ATT2 = f(NS_PREECHO_ATT2 * PCFACT);

/**
 * Psychoacoustic analysis of one granule.
 *
 * `buffer[ch][bo..]` is the PCM of the granule to analyse; the returned maskings, energies
 * and block types belong to the previous granule (the model has one granule of delay).
 */
export function L3psycho_anal_vbr(
  gfc: LameInternalFlags,
  buffer: Float32Array[],
  bo: number,
  gr_out: number,
  masking_ratio: III_psy_ratio[][],
  masking_MS_ratio: III_psy_ratio[][],
  percep_entropy: Float32Array,
  percep_MS_entropy: Float32Array,
  energy: Float32Array,
  blocktype_d: Int32Array,
): number {
  const cfg = gfc.cfg;
  const psv = gfc.sv_psy;
  const gd = gfc.cd_psy!;
  const gdl = gd.l;
  const gds = gd.s;

  let sc = scratchOf.get(gfc);
  if (!sc) {
    sc = new PsyScratch();
    scratchOf.set(gfc, sc);
  }
  const last_thm = sc.last_thm;

  /* fft and energy calculation   */
  const fftenergy = sc.fftenergy;
  const fftenergy_s = sc.fftenergy_s;
  const wsamp_L = sc.wsamp_L;
  const wsamp_S = sc.wsamp_S;
  const eb = sc.eb;
  const thr = sc.thr;

  const sub_short_factor = sc.sub_short_factor;
  let thmm: number;
  const ath_factor = cfg.msfix > 0 ? f(cfg.ATH_offset_factor * gfc.ATH.adjust_factor) : 1;

  /* block type  */
  const ns_attacks = sc.ns_attacks;
  for (let i = 0; i < 4; i++) ns_attacks[i].fill(0);
  const uselongblock = sc.uselongblock;

  /* usual variables like loop indices, etc..    */
  let chn: number, sb: number, sblock: number;

  /* chn=2 and 3 = Mid and Side channels */
  const n_chn_psy = cfg.mode === JOINT_STEREO ? 4 : cfg.channels_out;

  for (chn = 0; chn < 4; chn++) last_thm[chn].assign(psv.thm[chn]);

  vbrpsy_attack_detection(
    gfc,
    sc,
    buffer,
    bo,
    gr_out,
    masking_ratio,
    masking_MS_ratio,
    energy,
    sub_short_factor,
    ns_attacks,
    uselongblock,
  );

  vbrpsy_compute_block_type(cfg, uselongblock);

  /* LONG BLOCK CASE */
  {
    for (chn = 0; chn < n_chn_psy; chn++) {
      vbrpsy_compute_fft_l(gfc, buffer, bo, chn, fftenergy, wsamp_L);
      vbrpsy_compute_loudness_approximation_l(gfc, gr_out, chn, fftenergy);
      vbrpsy_compute_masking_l(gfc, sc, fftenergy, eb[chn], thr[chn], chn);
    }
    if (cfg.mode === JOINT_STEREO) {
      if (uselongblock[0] + uselongblock[1] === 2) {
        vbrpsy_compute_MS_thresholds(eb, thr, gdl.mld_cb, gfc.ATH.cb_l, ath_factor, cfg.msfix, gdl.npart);
      }
    }
    /* TODO: apply adaptive ATH masking here ?? */
    for (chn = 0; chn < n_chn_psy; chn++) {
      convert_partition2scalefac_l(gfc, eb[chn], thr[chn], chn);
      convert_partition2scalefac_l_to_s(gfc, eb[chn], thr[chn], chn);
    }
  }
  /* SHORT BLOCKS CASE */
  {
    const force_short_block_calc = gd.force_short_block_calc;
    for (sblock = 0; sblock < 3; sblock++) {
      for (chn = 0; chn < n_chn_psy; ++chn) {
        const ch01 = chn & 0x01;

        if (uselongblock[ch01] && !force_short_block_calc) {
          vbrpsy_skip_masking_s(gfc, chn, sblock);
        } else {
          /* compute masking thresholds for short blocks */
          vbrpsy_compute_fft_s(gfc, buffer, bo, chn, sblock, fftenergy_s, wsamp_S);
          vbrpsy_compute_masking_s(gfc, sc, fftenergy_s, eb[chn], thr[chn], chn, sblock);
        }
      }
      if (cfg.mode === JOINT_STEREO) {
        if (uselongblock[0] + uselongblock[1] === 0) {
          vbrpsy_compute_MS_thresholds(eb, thr, gds.mld_cb, gfc.ATH.cb_s, ath_factor, cfg.msfix, gds.npart);
        }
      }
      /* TODO: apply adaptive ATH masking here ?? */
      for (chn = 0; chn < n_chn_psy; ++chn) {
        const ch01 = chn & 0x01;
        if (!uselongblock[ch01] || force_short_block_calc) {
          convert_partition2scalefac_s(gfc, eb[chn], thr[chn], chn, sblock);
        }
      }
    }

    /****   short block pre-echo control   ****/
    for (chn = 0; chn < n_chn_psy; chn++) {
      const thm_s = psv.thm[chn].s;
      const last_s = last_thm[chn].s;
      const attacks = ns_attacks[chn];
      for (sb = 0; sb < SBMAX_s; sb++) {
        const new_thmm = sc.new_thmm;
        let prev_thm: number, t1: number, t2: number;
        for (sblock = 0; sblock < 3; sblock++) {
          thmm = thm_s[sb * 3 + sblock];
          thmm = f(thmm * NS_PREECHO_ATT0);

          t1 = t2 = thmm;

          if (sblock > 0) {
            prev_thm = new_thmm[sblock - 1];
          } else {
            prev_thm = last_s[sb * 3 + 2];
          }
          if (attacks[sblock] >= 2 || attacks[sblock + 1] === 1) {
            t1 = NS_INTERP(prev_thm, thmm, INTERP_ATT1);
          }
          thmm = t1 < thmm ? t1 : thmm;
          if (attacks[sblock] === 1) {
            t2 = NS_INTERP(prev_thm, thmm, INTERP_ATT2);
          } else if (
            (sblock === 0 && psv.last_attacks[chn] === 3) ||
            (sblock > 0 && attacks[sblock - 1] === 3)
          ) {
            /* 2nd preceeding block */
            switch (sblock) {
              case 0:
                prev_thm = last_s[sb * 3 + 1];
                break;
              case 1:
                prev_thm = last_s[sb * 3 + 2];
                break;
              case 2:
                prev_thm = new_thmm[0];
                break;
            }
            t2 = NS_INTERP(prev_thm, thmm, INTERP_ATT2);
          }

          thmm = t1 < thmm ? t1 : thmm;
          thmm = t2 < thmm ? t2 : thmm;

          /* pulse like signal detection for fatboy.wav and so on */
          thmm = f(thmm * sub_short_factor[chn][sblock]);

          new_thmm[sblock] = thmm;
        }
        for (sblock = 0; sblock < 3; sblock++) {
          thm_s[sb * 3 + sblock] = new_thmm[sblock];
        }
      }
    }
  }
  for (chn = 0; chn < n_chn_psy; chn++) {
    psv.last_attacks[chn] = ns_attacks[chn][2];
  }

  /***************************************************************
   * determine final block type
   ***************************************************************/
  vbrpsy_apply_block_type(psv, cfg.channels_out, uselongblock, blocktype_d);

  /*********************************************************************
   * compute the value of PE to return ... no delay and advance
   *********************************************************************/
  for (chn = 0; chn < n_chn_psy; chn++) {
    let ppe: Float32Array;
    let pi: number;
    let type: number;
    let mr: III_psy_ratio;

    if (chn > 1) {
      ppe = percep_MS_entropy;
      pi = chn - 2;
      type = NORM_TYPE;
      if (blocktype_d[0] === SHORT_TYPE || blocktype_d[1] === SHORT_TYPE) type = SHORT_TYPE;
      mr = masking_MS_ratio[gr_out][chn - 2];
    } else {
      ppe = percep_entropy;
      pi = chn;
      type = blocktype_d[chn];
      mr = masking_ratio[gr_out][chn];
    }
    if (type === SHORT_TYPE) {
      ppe[pi] = pecalc_s(mr, gfc.sv_qnt.masking_lower);
    } else {
      ppe[pi] = pecalc_l(mr, gfc.sv_qnt.masking_lower);
    }
  }
  return 0;
}

/*
 *   The spreading function.  Values returned in units of energy
 */
function s3_func(bark: number): number {
  let tempx: number, x: number;
  tempx = bark;
  if (tempx >= 0) tempx = f(tempx * 3);
  else tempx = f(tempx * 1.5);

  if (tempx >= 0.5 && tempx <= 2.5) {
    const temp = f(tempx - 0.5);
    x = f(8.0 * (f(temp * temp) - 2.0 * temp));
  } else x = 0.0;
  tempx = f(tempx + 0.474);
  const tempy = f(15.811389 + 7.5 * tempx - 17.5 * Math.sqrt(1.0 + f(tempx * tempx)));

  if (tempy <= -60.0) return 0.0;

  tempx = f(Math.exp(f(x + tempy) * LN_TO_LOG10));

  /* Normalization.  The spreading function should be normalized so that:
     +inf
     /
     |  s3 [ bark ]  d(bark)   =  1
     /
     -inf
   */
  tempx = f(tempx / 0.6609193);
  return tempx;
}

/** setup stereo demasking thresholds; `freq` is a float, the result is a float */
function stereo_demask(freq: number): number {
  /* formula reverse enginerred from plot in paper */
  let arg: number = freq2bark(f(freq));
  arg = (arg < 15.5 ? arg : 15.5) / 15.5;

  return f(Math.pow(10.0, 1.25 * (1 - Math.cos(PI * arg)) - 2.5));
}

function init_numline(
  gd: PsyConst_CB2SB,
  sfreq: number,
  fft_size: number,
  mdct_size: number,
  sbmax: number,
  scalepos: Int32Array,
): void {
  const b_frq = new Float32Array(CBANDS + 1);
  const mdct_freq_frac = f(sfreq / f(2.0 * mdct_size));
  const deltafreq = f(fft_size / f(2.0 * mdct_size));
  const partition = new Int32Array(HBLKSIZE);
  let i: number, j: number, ni: number;
  sfreq = f(sfreq / fft_size);
  j = 0;
  ni = 0;
  /* compute numlines, the number of spectral lines in each partition band */
  /* each partition band should be about DELBARK wide. */
  for (i = 0; i < CBANDS; i++) {
    let j2: number;
    const bark1 = freq2bark(f(sfreq * j));

    b_frq[i] = sfreq * j;

    for (j2 = j; f(freq2bark(f(sfreq * j2)) - bark1) < DELBARK && j2 <= fft_size / 2; j2++);

    const nl = j2 - j;
    gd.numlines[i] = nl;
    gd.rnumlines[i] = nl > 0 ? 1.0 / nl : 0;

    ni = i + 1;

    while (j < j2) {
      partition[j++] = i;
    }
    if (j > fft_size / 2) {
      j = fft_size / 2;
      ++i;
      break;
    }
  }
  b_frq[i] = sfreq * j;

  gd.n_sb = sbmax;
  gd.npart = ni;

  {
    j = 0;
    for (i = 0; i < gd.npart; i++) {
      const nl = gd.numlines[i];
      const freq = f(sfreq * (j + ((nl / 2) | 0)));
      gd.mld_cb[i] = stereo_demask(freq);
      j += nl;
    }
    for (; i < CBANDS; ++i) {
      gd.mld_cb[i] = 1;
    }
  }
  for (let sfb = 0; sfb < sbmax; sfb++) {
    let i1: number, i2: number;
    const start = scalepos[sfb];
    const end = scalepos[sfb + 1];

    i1 = Math.floor(0.5 + deltafreq * (start - 0.5));
    if (i1 < 0) i1 = 0;
    i2 = Math.floor(0.5 + deltafreq * (end - 0.5));

    if (i2 > fft_size / 2) i2 = fft_size / 2;

    const bo = partition[i2];
    gd.bm[sfb] = ((partition[i1] + partition[i2]) / 2) | 0;
    gd.bo[sfb] = bo;

    /* calculate how much of this band belongs to current scalefactor band */
    {
      const f_tmp = f(mdct_freq_frac * end);
      let bo_w = f(f(f_tmp - b_frq[bo]) / f(b_frq[bo + 1] - b_frq[bo]));
      if (bo_w < 0) {
        bo_w = 0;
      } else {
        if (bo_w > 1) {
          bo_w = 1;
        }
      }
      gd.bo_weight[sfb] = bo_w;
    }
    gd.mld[sfb] = stereo_demask(f(mdct_freq_frac * start));
  }
}

/** compute bark values of each critical band */
function compute_bark_values(
  gd: PsyConst_CB2SB,
  sfreq: number,
  fft_size: number,
  bval: Float32Array,
  bval_width: Float32Array,
): void {
  let j = 0;
  const ni = gd.npart;
  sfreq = f(sfreq / fft_size);
  for (let k = 0; k < ni; k++) {
    const w = gd.numlines[k];
    let bark1: number, bark2: number;

    bark1 = freq2bark(f(sfreq * j));
    bark2 = freq2bark(f(sfreq * (j + w - 1)));
    bval[k] = 0.5 * f(bark1 + bark2);

    bark1 = freq2bark(f(sfreq * (j - 0.5)));
    bark2 = freq2bark(f(sfreq * (j + w - 0.5)));
    bval_width[k] = bark2 - bark1;
    j += w;
  }
}

function init_s3_values(
  gd: PsyConst_CB2SB,
  bval: Float32Array,
  bval_width: Float32Array,
  norm: Float32Array,
): void {
  const npart = gd.npart;
  const s3ind = gd.s3ind;
  const s3 = new Float32Array(CBANDS * CBANDS);
  /* The s3 array is not linear in the bark scale.
   * bval[x] should be used to get the bark value.
   */
  let i: number, j: number, k: number;
  let numberOfNoneZero = 0;

  /* s[i][j], the value of the spreading function,
   * centered at band j (masker), for band i (maskee)
   *
   * i.e.: sum over j to spread into signal barkval=i
   * NOTE: i and j are used opposite as in the ISO docs
   */
  for (i = 0; i < npart; i++) {
    for (j = 0; j < npart; j++) {
      const v = f(s3_func(f(bval[i] - bval[j])) * bval_width[j]);
      s3[i * CBANDS + j] = v * norm[i];
    }
  }
  for (i = 0; i < npart; i++) {
    for (j = 0; j < npart; j++) {
      if (s3[i * CBANDS + j] > 0.0) break;
    }
    s3ind[i * 2] = j;

    for (j = npart - 1; j > 0; j--) {
      if (s3[i * CBANDS + j] > 0.0) break;
    }
    s3ind[i * 2 + 1] = j;
    numberOfNoneZero += s3ind[i * 2 + 1] - s3ind[i * 2] + 1;
  }
  const p = new Float32Array(numberOfNoneZero);

  k = 0;
  for (i = 0; i < npart; i++) for (j = s3ind[i * 2]; j <= s3ind[i * 2 + 1]; j++) p[k++] = s3[i * CBANDS + j];

  gd.s3 = p;
}

const sk = f32([-7.4, -7.4, -7.4, -9.5, -7.4, -6.1, -5.5, -4.7, -4.7, -4.7, -4.7]);

export function psymodel_init(gfp: LameGlobalFlags): number {
  const gfc = gfp.internal_flags;
  const cfg = gfc.cfg;
  const psv = gfc.sv_psy;
  let i: number, j: number, b: number, sb: number, k: number;
  const bvl_a = 13,
    bvl_b = 24;
  const snr_l_a = 0,
    snr_l_b = 0;
  const snr_s_a = -8.25,
    snr_s_b = -4.5;

  const bval = new Float32Array(CBANDS);
  const bval_width = new Float32Array(CBANDS);
  const norm = new Float32Array(CBANDS);
  const sfreq = f(cfg.samplerate_out);

  const xav = 10,
    xbv = 12;
  const minval_low = f(0 - cfg.minval);

  if (gfc.cd_psy !== null) {
    return 0;
  }

  const gd = new PsyConst();
  gfc.cd_psy = gd;

  gd.force_short_block_calc = gfp.experimentalZ;

  psv.blocktype_old[0] = psv.blocktype_old[1] = NORM_TYPE; /* the vbr header is long blocks */

  for (i = 0; i < 4; ++i) {
    for (j = 0; j < CBANDS; ++j) {
      psv.nb_l1[i][j] = 1e20;
      psv.nb_l2[i][j] = 1e20;
      psv.nb_s1[i][j] = psv.nb_s2[i][j] = 1.0;
    }
    for (sb = 0; sb < SBMAX_l; sb++) {
      psv.en[i].l[sb] = 1e20;
      psv.thm[i].l[sb] = 1e20;
    }
    for (j = 0; j < 3; ++j) {
      for (sb = 0; sb < SBMAX_s; sb++) {
        psv.en[i].s[sb * 3 + j] = 1e20;
        psv.thm[i].s[sb * 3 + j] = 1e20;
      }
      psv.last_attacks[i] = 0;
    }
    for (j = 0; j < 9; j++) psv.last_en_subshort[i][j] = 10;
  }

  /* init. for loudness approx. -jd 2001 mar 27 */
  psv.loudness_sq_save[0] = psv.loudness_sq_save[1] = 0.0;

  /*************************************************************************
   * now compute the psychoacoustic model specific constants
   ************************************************************************/
  /* compute numlines, bo, bm, bval, bval_width, mld */
  init_numline(gd.l, sfreq, BLKSIZE, 576, SBMAX_l, gfc.scalefac_band.l);
  compute_bark_values(gd.l, sfreq, BLKSIZE, bval, bval_width);

  /* compute the spreading function */
  for (i = 0; i < gd.l.npart; i++) {
    let snr: number = snr_l_a;
    if (bval[i] >= bvl_a) {
      snr = f(
        f(f(snr_l_b * f(bval[i] - bvl_a)) / f(bvl_b - bvl_a)) + f(f(snr_l_a * f(bvl_b - bval[i])) / f(bvl_b - bvl_a)),
      );
    }
    norm[i] = Math.pow(10.0, snr / 10.0);
  }
  init_s3_values(gd.l, bval, bval_width, norm);

  /* compute long block specific values, ATH and MINVAL */
  j = 0;
  for (i = 0; i < gd.l.npart; i++) {
    let x: number;

    /* ATH */
    x = FLT_MAX;
    for (k = 0; k < gd.l.numlines[i]; k++, j++) {
      const freq = f(f(sfreq * j) / (1000.0 * BLKSIZE));
      let level: number;
      /* freq = Min(.1,freq); */ /* ATH below 100 Hz constant, not further climbing */
      level = f(ATHformula(cfg, f(freq * 1000)) - 20); /* scale to FFT units; returned value is in dB */
      level = f(Math.pow(10, 0.1 * level)); /* convert from dB -> energy */
      level = f(level * gd.l.numlines[i]);
      if (x > level) x = level;
    }
    gfc.ATH.cb_l[i] = x;

    /* MINVAL.
       For low freq, the strength of the masking is limited by minval
       this is an ISO MPEG1 thing, dont know if it is really needed */
    /* FIXME: it does work to reduce low-freq problems in S53-Wind-Sax
       and lead-voice samples, but introduces some 3 kbps bit bloat too.
       TODO: Further refinement of the shape of this hack.
     */
    x = 20.0 * (f(bval[i] / xav) - 1.0);
    if (x > 6) {
      x = 30;
    }
    if (x < minval_low) {
      x = minval_low;
    }
    if (cfg.samplerate_out < 44000) {
      x = 30;
    }
    x -= 8;
    gd.l.minval[i] = Math.pow(10.0, x / 10) * gd.l.numlines[i];
  }

  /************************************************************************
   * do the same things for short blocks
   ************************************************************************/
  init_numline(gd.s, sfreq, BLKSIZE_s, 192, SBMAX_s, gfc.scalefac_band.s);
  compute_bark_values(gd.s, sfreq, BLKSIZE_s, bval, bval_width);

  /* SNR formula. short block is normalized by SNR. is it still right ? */
  j = 0;
  for (i = 0; i < gd.s.npart; i++) {
    let x: number;
    let snr: number = snr_s_a;
    if (bval[i] >= bvl_a) {
      snr = f(
        f(f(snr_s_b * f(bval[i] - bvl_a)) / f(bvl_b - bvl_a)) + f(f(snr_s_a * f(bvl_b - bval[i])) / f(bvl_b - bvl_a)),
      );
    }
    norm[i] = Math.pow(10.0, snr / 10.0);

    /* ATH */
    x = FLT_MAX;
    for (k = 0; k < gd.s.numlines[i]; k++, j++) {
      const freq = f(f(sfreq * j) / (1000.0 * BLKSIZE_s));
      let level: number;
      /* freq = Min(.1,freq); */ /* ATH below 100 Hz constant, not further climbing */
      level = f(ATHformula(cfg, f(freq * 1000)) - 20); /* scale to FFT units; returned value is in dB */
      level = f(Math.pow(10, 0.1 * level)); /* convert from dB -> energy */
      level = f(level * gd.s.numlines[i]);
      if (x > level) x = level;
    }
    gfc.ATH.cb_s[i] = x;

    /* MINVAL.
       For low freq, the strength of the masking is limited by minval
       this is an ISO MPEG1 thing, dont know if it is really needed */
    x = 7.0 * (f(bval[i] / xbv) - 1.0);
    if (bval[i] > xbv) {
      x *= 1 + Math.log(1 + x) * 3.1;
    }
    if (bval[i] < xbv) {
      x *= 1 + Math.log(1 - x) * 2.3;
    }
    if (x > 6) {
      x = 30;
    }
    if (x < minval_low) {
      x = minval_low;
    }
    if (cfg.samplerate_out < 44000) {
      x = 30;
    }
    x -= 8;
    gd.s.minval[i] = Math.pow(10.0, x / 10) * gd.s.numlines[i];
  }

  init_s3_values(gd.s, bval, bval_width, norm);

  init_fft(gd.window, gd.window_s);

  /* setup temporal masking */
  gd.decay = f(Math.exp((-1.0 * LOG10) / ((temporalmask_sustain_sec * sfreq) / 192.0)));

  {
    let msfix = NS_MSFIX;
    if (cfg.use_safe_joint_stereo) msfix = 1.0;
    if (Math.abs(cfg.msfix) > 0.0) msfix = cfg.msfix;
    cfg.msfix = msfix;

    /* spread only from npart_l bands.  Normally, we use the spreading
     * function to convolve from npart_l down to npart_l bands
     */
    for (b = 0; b < gd.l.npart; b++)
      if (gd.l.s3ind[b * 2 + 1] > gd.l.npart - 1) gd.l.s3ind[b * 2 + 1] = gd.l.npart - 1;
  }

  /*  prepare for ATH auto adjustment:
   *  we want to decrease the ATH by 12 dB per second
   */
  const frame_duration = (576 * cfg.mode_gr) / sfreq;
  gfc.ATH.decay = f(Math.pow(10, (-12 / 10) * frame_duration));
  gfc.ATH.adjust_factor = f(0.01); /* minimum, for leading low loudness */
  gfc.ATH.adjust_limit = 1.0; /* on lead, allow adjust up to maximum */

  if (cfg.ATHtype !== -1) {
    /* compute equal loudness weights (eql_w) */
    let freq: number;
    const freq_inc = f(cfg.samplerate_out / BLKSIZE);
    let eql_balance = 0.0;
    freq = 0.0;
    for (i = 0; i < BLKSIZE / 2; ++i) {
      /* convert ATH dB to relative power (not dB) */
      /*  to determine eql_w */
      freq = f(freq + freq_inc);
      gfc.ATH.eql_w[i] = 1 / Math.pow(10, f(ATHformula(cfg, freq) / 10));
      eql_balance = f(eql_balance + gfc.ATH.eql_w[i]);
    }
    eql_balance = f(1.0 / eql_balance);
    for (i = BLKSIZE / 2; --i >= 0; ) {
      /* scale weights */
      gfc.ATH.eql_w[i] *= eql_balance;
    }
  }
  /* short block attack threshold */
  {
    let x = gfp.attackthre;
    let y = gfp.attackthre_s;
    if (x < 0) {
      x = f(NSATTACKTHRE);
    }
    if (y < 0) {
      y = NSATTACKTHRE_S;
    }
    gd.attack_threshold[0] = gd.attack_threshold[1] = gd.attack_threshold[2] = x;
    gd.attack_threshold[3] = y;
  }
  {
    let sk_s: number, sk_l: number;
    if (gfp.VBR_q < 4) {
      sk_l = sk_s = sk[0];
    } else {
      sk_l = sk_s = f(sk[gfp.VBR_q] + f(gfp.VBR_q_frac * f(sk[gfp.VBR_q] - sk[gfp.VBR_q + 1])));
    }
    const F_0_1 = f(0.1);
    b = 0;
    for (; b < gd.s.npart; b++) {
      const m = f((gd.s.npart - b) / gd.s.npart);
      gd.s.masking_lower[b] = powf(10, f(f(sk_s * m) * F_0_1));
    }
    for (; b < CBANDS; ++b) {
      gd.s.masking_lower[b] = 1;
    }
    b = 0;
    for (; b < gd.l.npart; b++) {
      const m = f((gd.l.npart - b) / gd.l.npart);
      gd.l.masking_lower[b] = powf(10, f(f(sk_l * m) * F_0_1));
    }
    for (; b < CBANDS; ++b) {
      gd.l.masking_lower[b] = 1;
    }
  }
  gd.l_to_s.assign(gd.l);
  init_numline(gd.l_to_s, sfreq, BLKSIZE, 192, SBMAX_s, gfc.scalefac_band.s);
  return 0;
}
