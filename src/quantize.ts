// Port of libmp3lame/quantize.c - MP3 quantization (CBR / ABR / VBR outer loops).

import { getframebits } from './bitstream.ts';
import {
  EQ,
  f,
  MAX_BITS_PER_CHANNEL,
  MAX_BITS_PER_GRANULE,
  MPG_MD_MS_LR,
  NEQ,
  PSFB12,
  PSFB21,
  SBMAX_l,
  SBMAX_s,
  SBPSY_l,
  SBPSY_s,
  SFBMAX,
  SHORT_TYPE,
  SQRT2,
  vbr_abr,
  vbr_mt,
  vbr_mtrh,
  vbr_off,
  vbr_rh,
} from './constants.ts';
import {
  athAdjust,
  calc_noise,
  calc_xmin,
  CalcNoiseData,
  CalcNoiseResult,
  ipow20,
  on_pe,
  reduce_side,
} from './quantize_pvt.ts';
import { ResvAdjust, ResvFrameBegin, ResvFrameEnd } from './reservoir.ts';
import { pretab } from './tables.ts';
import {
  best_huffman_divide,
  best_scalefac_store,
  count_bits,
  noquant_count_bits,
  scale_bitcount,
} from './takehiro.ts';
import { GrInfo } from './types.ts';
import type { III_psy_ratio, III_side_info, LameInternalFlags } from './types.ts';
import { FAST_LOG10 } from './util.ts';
import { VBR_encode_frame } from './vbrquantize.ts';

const MS_SCALE = f(SQRT2 * 0.5);

/* convert from L/R <-> Mid/Side */
function ms_convert(l3_side: III_side_info, gr: number): void {
  const xl = l3_side.tt[gr][0].xr;
  const xr = l3_side.tt[gr][1].xr;
  for (let i = 0; i < 576; ++i) {
    const l = xl[i];
    const r = xr[i];
    xl[i] = f(l + r) * MS_SCALE;
    xr[i] = f(l - r) * MS_SCALE;
  }
}

/************************************************************************
 *
 *      init_outer_loop()
 *  mt 6/99
 *
 *  initializes cod_info, scalefac and xrpow
 *
 *  returns 0 if all energies in xr are zero, else 1
 *
 ************************************************************************/

/** Returns the sum of |xr|. */
function init_xrpow_core(cod_info: GrInfo, xrpow: Float32Array, upper: number): number {
  const xr = cod_info.xr;
  let sum = 0;
  let xrpow_max = cod_info.xrpow_max;
  for (let i = 0; i <= upper; ++i) {
    const tmp = Math.abs(xr[i]);
    sum = f(sum + tmp);
    const v = f(Math.sqrt(tmp * Math.sqrt(tmp)));
    xrpow[i] = v;
    if (v > xrpow_max) xrpow_max = v;
  }
  cod_info.xrpow_max = xrpow_max;
  return sum;
}

const SUM_EPS = f(1e-20);

export function init_xrpow(gfc: LameInternalFlags, cod_info: GrInfo, xrpow: Float32Array): number {
  const upper = cod_info.max_nonzero_coeff;

  cod_info.xrpow_max = 0;

  /*  check if there is some energy we have to quantize
   *  and calculate xrpow matching our fresh scalefactors
   */
  xrpow.fill(0, upper, 576);

  const sum = init_xrpow_core(cod_info, xrpow, upper);

  /*  return 1 if we have something to quantize, else 0
   */
  if (sum > SUM_EPS) {
    let j = 0;
    if (gfc.sv_qnt.substep_shaping & 2) j = 1;

    const pseudohalf = gfc.sv_qnt.pseudohalf;
    for (let i = 0; i < cod_info.psymax; i++) pseudohalf[i] = j;

    return 1;
  }

  cod_info.l3_enc.fill(0);
  return 0;
}

const F_1EM12 = f(1e-12);

/*
Gabriel Bouvigne feb/apr 2003
Analog silence detection in partitionned sfb21
or sfb12 for short blocks

From top to bottom of sfb, changes to 0
coeffs which are below ath. It stops on the first
coeff higher than ath.
*/
function psfb21_analogsilence(gfc: LameInternalFlags, cod_info: GrInfo): void {
  const ATH = gfc.ATH;
  const xr = cod_info.xr;
  const sb = gfc.scalefac_band;

  if (cod_info.block_type !== SHORT_TYPE) {
    /* NORM, START or STOP type, but not SHORT blocks */
    let stop = 0;
    for (let gsfb = PSFB21 - 1; gsfb >= 0 && !stop; gsfb--) {
      const start = sb.psfb21[gsfb];
      const end = sb.psfb21[gsfb + 1];
      let ath21 = athAdjust(ATH.adjust_factor, ATH.psfb21[gsfb], ATH.floor, 0);

      if (gfc.sv_qnt.longfact[21] > F_1EM12) ath21 = f(ath21 * gfc.sv_qnt.longfact[21]);

      for (let j = end - 1; j >= start; j--) {
        if (Math.abs(xr[j]) < ath21) xr[j] = 0;
        else {
          stop = 1;
          break;
        }
      }
    }
  } else {
    /*note: short blocks coeffs are reordered */
    for (let block = 0; block < 3; block++) {
      let stop = 0;
      for (let gsfb = PSFB12 - 1; gsfb >= 0 && !stop; gsfb--) {
        const start =
          sb.s[12] * 3 + (sb.s[13] - sb.s[12]) * block + (sb.psfb12[gsfb] - sb.psfb12[0]);
        const end = start + (sb.psfb12[gsfb + 1] - sb.psfb12[gsfb]);
        let ath12 = athAdjust(ATH.adjust_factor, ATH.psfb12[gsfb], ATH.floor, 0);

        if (gfc.sv_qnt.shortfact[12] > F_1EM12) ath12 = f(ath12 * gfc.sv_qnt.shortfact[12]);

        for (let j = end - 1; j >= start; j--) {
          if (Math.abs(xr[j]) < ath12) xr[j] = 0;
          else {
            stop = 1;
            break;
          }
        }
      }
    }
  }
}

const ixwork = new Float32Array(576);

export function init_outer_loop(gfc: LameInternalFlags, cod_info: GrInfo): void {
  const cfg = gfc.cfg;
  const sb = gfc.scalefac_band;
  let sfb: number, j: number;

  /*  initialize fresh cod_info
   */
  cod_info.part2_3_length = 0;
  cod_info.big_values = 0;
  cod_info.count1 = 0;
  cod_info.global_gain = 210;
  cod_info.scalefac_compress = 0;
  /* mixed_block_flag, block_type was set in psymodel.c */
  cod_info.table_select[0] = 0;
  cod_info.table_select[1] = 0;
  cod_info.table_select[2] = 0;
  cod_info.subblock_gain[0] = 0;
  cod_info.subblock_gain[1] = 0;
  cod_info.subblock_gain[2] = 0;
  cod_info.subblock_gain[3] = 0; /* this one is always 0 */
  cod_info.region0_count = 0;
  cod_info.region1_count = 0;
  cod_info.preflag = 0;
  cod_info.scalefac_scale = 0;
  cod_info.count1table_select = 0;
  cod_info.part2_length = 0;
  if (cfg.samplerate_out <= 8000) {
    cod_info.sfb_lmax = 17;
    cod_info.sfb_smin = 9;
    cod_info.psy_lmax = 17;
  } else {
    cod_info.sfb_lmax = SBPSY_l;
    cod_info.sfb_smin = SBPSY_s;
    cod_info.psy_lmax = gfc.sv_qnt.sfb21_extra ? SBMAX_l : SBPSY_l;
  }
  cod_info.psymax = cod_info.psy_lmax;
  cod_info.sfbmax = cod_info.sfb_lmax;
  cod_info.sfbdivide = 11;
  for (sfb = 0; sfb < SBMAX_l; sfb++) {
    cod_info.width[sfb] = sb.l[sfb + 1] - sb.l[sfb];
    cod_info.window[sfb] = 3; /* which is always 0. */
  }
  if (cod_info.block_type === SHORT_TYPE) {
    cod_info.sfb_smin = 0;
    cod_info.sfb_lmax = 0;
    if (cod_info.mixed_block_flag) {
      /*
       *  MPEG-1:      sfbs 0-7 long block, 3-12 short blocks
       *  MPEG-2(.5):  sfbs 0-5 long block, 3-12 short blocks
       */
      cod_info.sfb_smin = 3;
      cod_info.sfb_lmax = cfg.mode_gr * 2 + 4;
    }
    if (cfg.samplerate_out <= 8000) {
      cod_info.psymax = cod_info.sfb_lmax + 3 * (9 - cod_info.sfb_smin);
      cod_info.sfbmax = cod_info.sfb_lmax + 3 * (9 - cod_info.sfb_smin);
    } else {
      cod_info.psymax =
        cod_info.sfb_lmax + 3 * ((gfc.sv_qnt.sfb21_extra ? SBMAX_s : SBPSY_s) - cod_info.sfb_smin);
      cod_info.sfbmax = cod_info.sfb_lmax + 3 * (SBPSY_s - cod_info.sfb_smin);
    }
    cod_info.sfbdivide = cod_info.sfbmax - 18;
    cod_info.psy_lmax = cod_info.sfb_lmax;
    /* re-order the short blocks, for more efficient encoding below */
    /* By Takehiro TOMINAGA */
    /*
       Within each scalefactor band, data is given for successive
       time windows, beginning with window 0 and ending with window 2.
       Within each window, the quantized values are then arranged in
       order of increasing frequency...
     */
    const xr = cod_info.xr;
    let ix = sb.l[cod_info.sfb_lmax];
    ixwork.set(xr);
    for (sfb = cod_info.sfb_smin; sfb < SBMAX_s; sfb++) {
      const start = sb.s[sfb];
      const end = sb.s[sfb + 1];
      for (let window = 0; window < 3; window++) {
        for (let l = start; l < end; l++) {
          xr[ix++] = ixwork[3 * l + window];
        }
      }
    }

    j = cod_info.sfb_lmax;
    for (sfb = cod_info.sfb_smin; sfb < SBMAX_s; sfb++) {
      cod_info.width[j] = cod_info.width[j + 1] = cod_info.width[j + 2] = sb.s[sfb + 1] - sb.s[sfb];
      cod_info.window[j] = 0;
      cod_info.window[j + 1] = 1;
      cod_info.window[j + 2] = 2;
      j += 3;
    }
  }

  cod_info.count1bits = 0;
  cod_info.sfb_partition_table = 0;
  cod_info.slen[0] = 0;
  cod_info.slen[1] = 0;
  cod_info.slen[2] = 0;
  cod_info.slen[3] = 0;

  cod_info.max_nonzero_coeff = 575;

  /*  fresh scalefactors are all zero
   */
  cod_info.scalefac.fill(0);

  if (cfg.vbr !== vbr_mt && cfg.vbr !== vbr_mtrh && cfg.vbr !== vbr_abr && cfg.vbr !== vbr_off) {
    psfb21_analogsilence(gfc, cod_info);
  }
}

/************************************************************************
 *
 *      bin_search_StepSize()
 *
 *  author/date??
 *
 *  binary step size search
 *  used by outer_loop to get a quantizer step size to start with
 *
 ************************************************************************/

const BINSEARCH_NONE = 0;
const BINSEARCH_UP = 1;
const BINSEARCH_DOWN = 2;

function bin_search_StepSize(
  gfc: LameInternalFlags,
  cod_info: GrInfo,
  desired_rate: number,
  ch: number,
  xrpow: Float32Array,
): number {
  let nBits: number;
  let CurrentStep = gfc.sv_qnt.CurrentStep[ch];
  let flag_GoneOver = 0;
  const start = gfc.sv_qnt.OldValue[ch];
  let Direction = BINSEARCH_NONE;
  cod_info.global_gain = start;
  desired_rate -= cod_info.part2_length;

  for (;;) {
    let step: number;
    nBits = count_bits(gfc, xrpow, cod_info, null);

    if (CurrentStep === 1 || nBits === desired_rate) break; /* nothing to adjust anymore */

    if (nBits > desired_rate) {
      /* increase Quantize_StepSize */
      if (Direction === BINSEARCH_DOWN) flag_GoneOver = 1;

      if (flag_GoneOver) CurrentStep = (CurrentStep / 2) | 0;
      Direction = BINSEARCH_UP;
      step = CurrentStep;
    } else {
      /* decrease Quantize_StepSize */
      if (Direction === BINSEARCH_UP) flag_GoneOver = 1;

      if (flag_GoneOver) CurrentStep = (CurrentStep / 2) | 0;
      Direction = BINSEARCH_DOWN;
      step = -CurrentStep;
    }
    cod_info.global_gain += step;
    if (cod_info.global_gain < 0) {
      cod_info.global_gain = 0;
      flag_GoneOver = 1;
    }
    if (cod_info.global_gain > 255) {
      cod_info.global_gain = 255;
      flag_GoneOver = 1;
    }
  }

  while (nBits > desired_rate && cod_info.global_gain < 255) {
    cod_info.global_gain++;
    nBits = count_bits(gfc, xrpow, cod_info, null);
  }
  gfc.sv_qnt.CurrentStep[ch] = start - cod_info.global_gain >= 4 ? 4 : 2;
  gfc.sv_qnt.OldValue[ch] = cod_info.global_gain;
  cod_info.part2_3_length = nBits;
  return nBits;
}

/************************************************************************
 *
 *      trancate_smallspectrums()
 *
 *  Takehiro TOMINAGA 2002-07-21
 *
 *  trancate smaller nubmers into 0 as long as the noise threshold is allowed.
 *
 ************************************************************************/

const ts_distort = new Float32Array(SFBMAX);
const ts_dummy = new CalcNoiseResult();

function trancate_smallspectrums(
  gfc: LameInternalFlags,
  gi: GrInfo,
  l3_xmin: Float32Array,
  work: Float32Array,
): void {
  let sfb: number, j: number, width: number;
  const distort = ts_distort;

  if ((!(gfc.sv_qnt.substep_shaping & 4) && gi.block_type === SHORT_TYPE) || gfc.sv_qnt.substep_shaping & 0x80)
    return;
  calc_noise(gi, l3_xmin, distort, ts_dummy, null);
  for (j = 0; j < 576; j++) {
    let xr = 0.0;
    if (gi.l3_enc[j] !== 0) xr = Math.abs(gi.xr[j]);
    work[j] = xr;
  }

  j = 0;
  sfb = 8;
  if (gi.block_type === SHORT_TYPE) sfb = 6;
  do {
    let allowedNoise: number, trancateThreshold: number;
    let nsame: number, start: number;

    width = gi.width[sfb];
    j += width;
    if (distort[sfb] >= 1.0) continue;

    work.subarray(j - width, j).sort();
    if (EQ(work[j - 1], 0.0)) continue; /* all zero sfb */

    allowedNoise = f((1.0 - distort[sfb]) * l3_xmin[sfb]);
    trancateThreshold = 0.0;
    start = 0;
    do {
      for (nsame = 1; start + nsame < width; nsame++)
        if (NEQ(work[start + j - width], work[start + j + nsame - width])) break;

      const w = work[start + j - width];
      const noise = f(f(w * w) * nsame);
      if (allowedNoise < noise) {
        if (start !== 0) trancateThreshold = work[start + j - width - 1];
        break;
      }
      allowedNoise = f(allowedNoise - noise);
      start += nsame;
    } while (start < width);
    if (EQ(trancateThreshold, 0.0)) continue;

    do {
      if (Math.abs(gi.xr[j - width]) <= trancateThreshold) gi.l3_enc[j - width] = 0;
    } while (--width > 0);
  } while (++sfb < gi.psymax);

  gi.part2_3_length = noquant_count_bits(gfc, gi, null);
}

/*************************************************************************
 *
 *      loop_break()
 *
 *  author/date??
 *
 *  Function: Returns zero if there is a scalefac which has not been
 *            amplified. Otherwise it returns one.
 *
 *************************************************************************/
function loop_break(cod_info: GrInfo): number {
  for (let sfb = 0; sfb < cod_info.sfbmax; sfb++)
    if (cod_info.scalefac[sfb] + cod_info.subblock_gain[cod_info.window[sfb]] === 0) return 0;

  return 1;
}

/*************************************************************************
 *
 *      quant_compare()
 *
 *  author/date??
 *
 *  several different codes to decide which quantization is better
 *
 *************************************************************************/

function penalties(noise: number): number {
  return FAST_LOG10(0.368 + 0.632 * noise * noise * noise);
}

function get_klemm_noise(distort: Float32Array, gi: GrInfo): number {
  let klemm_noise = 1e-37;
  for (let sfb = 0; sfb < gi.psymax; sfb++) klemm_noise += penalties(distort[sfb]);

  return 1e-20 > klemm_noise ? 1e-20 : klemm_noise;
}

function quant_compare(
  quant_comp: number,
  best: CalcNoiseResult,
  calc: CalcNoiseResult,
  gi: GrInfo,
  distort: Float32Array,
): boolean {
  /*
     noise is given in decibels (dB) relative to masking thesholds.

     over_noise:  ??? (the previous comment is fully wrong)
     tot_noise:   ??? (the previous comment is fully wrong)
     max_noise:   max quantization noise

   */
  let better: boolean;

  switch (quant_comp) {
    default:
    case 9: {
      if (best.over_count > 0) {
        /* there are distorted sfb */
        better = calc.over_SSD <= best.over_SSD;
        if (calc.over_SSD === best.over_SSD) better = calc.bits < best.bits;
      } else {
        /* no distorted sfb */
        better =
          calc.max_noise < 0 &&
          f(f(calc.max_noise * 10) + calc.bits) <= f(f(best.max_noise * 10) + best.bits);
      }
      break;
    }

    case 0:
      better =
        calc.over_count < best.over_count ||
        (calc.over_count === best.over_count && calc.over_noise < best.over_noise) ||
        (calc.over_count === best.over_count &&
          EQ(calc.over_noise, best.over_noise) &&
          calc.tot_noise < best.tot_noise);
      break;

    case 8:
      calc.max_noise = f(get_klemm_noise(distort, gi));
    /* fallthrough */
    case 1:
      better = calc.max_noise < best.max_noise;
      break;
    case 2:
      better = calc.tot_noise < best.tot_noise;
      break;
    case 3:
      better = calc.tot_noise < best.tot_noise && calc.max_noise < best.max_noise;
      break;
    case 4:
      better =
        (calc.max_noise <= 0.0 && best.max_noise > 0.2) ||
        (calc.max_noise <= 0.0 &&
          best.max_noise < 0.0 &&
          best.max_noise > calc.max_noise - 0.2 &&
          calc.tot_noise < best.tot_noise) ||
        (calc.max_noise <= 0.0 &&
          best.max_noise > 0.0 &&
          best.max_noise > calc.max_noise - 0.2 &&
          calc.tot_noise < f(best.tot_noise + best.over_noise)) ||
        (calc.max_noise > 0.0 &&
          best.max_noise > -0.05 &&
          best.max_noise > calc.max_noise - 0.1 &&
          f(calc.tot_noise + calc.over_noise) < f(best.tot_noise + best.over_noise)) ||
        (calc.max_noise > 0.0 &&
          best.max_noise > -0.1 &&
          best.max_noise > calc.max_noise - 0.15 &&
          f(f(calc.tot_noise + calc.over_noise) + calc.over_noise) <
            f(f(best.tot_noise + best.over_noise) + best.over_noise));
      break;
    case 5:
      better =
        calc.over_noise < best.over_noise ||
        (EQ(calc.over_noise, best.over_noise) && calc.tot_noise < best.tot_noise);
      break;
    case 6:
      better =
        calc.over_noise < best.over_noise ||
        (EQ(calc.over_noise, best.over_noise) &&
          (calc.max_noise < best.max_noise ||
            (EQ(calc.max_noise, best.max_noise) && calc.tot_noise <= best.tot_noise)));
      break;
    case 7:
      better = calc.over_count < best.over_count || calc.over_noise < best.over_noise;
      break;
  }

  if (best.over_count === 0) {
    /*
       If no distorted bands, only use this quantization
       if it is better, and if it uses less bits.
       Unfortunately, part2_3_length is sometimes a poor
       estimator of the final size at low bitrates.
     */
    better = better && calc.bits < best.bits;
  }

  return better;
}

/*************************************************************************
 *
 *          amp_scalefac_bands()
 *
 *  author/date??
 *
 *  Amplify the scalefactor bands that violate the masking threshold.
 *  See ISO 11172-3 Section C.1.5.4.3.5
 *
 *  distort[] = noise/masking
 *  distort[] > 1   ==> noise is not masked
 *  distort[] < 1   ==> noise is masked
 *  max_dist = maximum value of distort[]
 *
 *  Three algorithms:
 *  noise_shaping_amp
 *        0             Amplify all bands with distort[]>1.
 *
 *        1             Amplify all bands with distort[] >= max_dist^(.5);
 *                     ( 50% in the db scale)
 *
 *        2             Amplify first band with distort[] >= max_dist;
 *
 *
 *  For algorithms 0 and 1, if max_dist < 1, then amplify all bands
 *  with distort[] >= .95*max_dist.  This is to make sure we always
 *  amplify at least one band.
 *
 *
 *************************************************************************/

const IFQSTEP34_0 = f(1.29683955465100964055); /* 2**(.75*.5) */
const IFQSTEP34_1 = f(1.68179283050742922612); /* 2**(.75*1) */

function amp_scalefac_bands(
  gfc: LameInternalFlags,
  cod_info: GrInfo,
  distort: Float32Array,
  xrpow: Float32Array,
  bRefine: number,
): void {
  const cfg = gfc.cfg;
  let j: number, sfb: number;
  let trigger: number;
  let noise_shaping_amp: number;

  const ifqstep34 = cod_info.scalefac_scale === 0 ? IFQSTEP34_0 : IFQSTEP34_1;

  /* compute maximum value of distort[]  */
  trigger = 0;
  for (sfb = 0; sfb < cod_info.sfbmax; sfb++) {
    if (trigger < distort[sfb]) trigger = distort[sfb];
  }

  noise_shaping_amp = cfg.noise_shaping_amp;
  if (noise_shaping_amp === 3) {
    if (bRefine === 1) noise_shaping_amp = 2;
    else noise_shaping_amp = 1;
  }
  switch (noise_shaping_amp) {
    case 2:
      /* amplify exactly 1 band */
      break;

    case 1:
      /* amplify bands within 50% of max (on db scale) */
      if (trigger > 1.0) trigger = f(Math.pow(trigger, 0.5));
      else trigger = f(trigger * 0.95);
      break;

    case 0:
    default:
      /* ISO algorithm.  amplify all bands with distort>1 */
      if (trigger > 1.0) trigger = 1.0;
      else trigger = f(trigger * 0.95);
      break;
  }

  j = 0;
  for (sfb = 0; sfb < cod_info.sfbmax; sfb++) {
    const width = cod_info.width[sfb];
    j += width;
    if (distort[sfb] < trigger) continue;

    if (gfc.sv_qnt.substep_shaping & 2) {
      gfc.sv_qnt.pseudohalf[sfb] = gfc.sv_qnt.pseudohalf[sfb] ? 0 : 1;
      if (!gfc.sv_qnt.pseudohalf[sfb] && cfg.noise_shaping_amp === 2) return;
    }
    cod_info.scalefac[sfb]++;
    for (let l = -width; l < 0; l++) {
      const v = f(xrpow[j + l] * ifqstep34);
      xrpow[j + l] = v;
      if (v > cod_info.xrpow_max) cod_info.xrpow_max = v;
    }

    if (cfg.noise_shaping_amp === 2) return;
  }
}

/*************************************************************************
 *
 *      inc_scalefac_scale()
 *
 *  Takehiro Tominaga 2000-xx-xx
 *
 *  turns on scalefac scale and adjusts scalefactors
 *
 *************************************************************************/
function inc_scalefac_scale(cod_info: GrInfo, xrpow: Float32Array): void {
  const ifqstep34 = IFQSTEP34_0;

  let j = 0;
  for (let sfb = 0; sfb < cod_info.sfbmax; sfb++) {
    const width = cod_info.width[sfb];
    let s = cod_info.scalefac[sfb];
    if (cod_info.preflag) s += pretab[sfb];
    j += width;
    if (s & 1) {
      s++;
      for (let l = -width; l < 0; l++) {
        const v = f(xrpow[j + l] * ifqstep34);
        xrpow[j + l] = v;
        if (v > cod_info.xrpow_max) cod_info.xrpow_max = v;
      }
    }
    cod_info.scalefac[sfb] = s >> 1;
  }
  cod_info.preflag = 0;
  cod_info.scalefac_scale = 1;
}

/*************************************************************************
 *
 *      inc_subblock_gain()
 *
 *  Takehiro Tominaga 2000-xx-xx
 *
 *  increases the subblock gain and adjusts scalefactors
 *
 *************************************************************************/
function inc_subblock_gain(gfc: LameInternalFlags, cod_info: GrInfo, xrpow: Float32Array): number {
  let sfb: number, window: number;
  const scalefac = cod_info.scalefac;

  /* subbloc_gain can't do anything in the long block region */
  for (sfb = 0; sfb < cod_info.sfb_lmax; sfb++) {
    if (scalefac[sfb] >= 16) return 1;
  }

  for (window = 0; window < 3; window++) {
    let s1: number, s2: number, l: number, j: number;
    s1 = s2 = 0;

    for (sfb = cod_info.sfb_lmax + window; sfb < cod_info.sfbdivide; sfb += 3) {
      if (s1 < scalefac[sfb]) s1 = scalefac[sfb];
    }
    for (; sfb < cod_info.sfbmax; sfb += 3) {
      if (s2 < scalefac[sfb]) s2 = scalefac[sfb];
    }

    if (s1 < 16 && s2 < 8) continue;

    if (cod_info.subblock_gain[window] >= 7) return 1;

    /* even though there is no scalefactor for sfb12
     * subblock gain affects upper frequencies too, that's why
     * we have to go up to SBMAX_s
     */
    cod_info.subblock_gain[window]++;
    j = gfc.scalefac_band.l[cod_info.sfb_lmax];
    for (sfb = cod_info.sfb_lmax + window; sfb < cod_info.sfbmax; sfb += 3) {
      const width = cod_info.width[sfb];
      let s = scalefac[sfb];
      s = s - (4 >> cod_info.scalefac_scale);
      if (s >= 0) {
        scalefac[sfb] = s;
        j += width * 3;
        continue;
      }

      scalefac[sfb] = 0;
      const gain = 210 + (s << (cod_info.scalefac_scale + 1));
      const amp = ipow20[gain];
      j += width * (window + 1);
      for (l = -width; l < 0; l++) {
        const v = f(xrpow[j + l] * amp);
        xrpow[j + l] = v;
        if (v > cod_info.xrpow_max) cod_info.xrpow_max = v;
      }
      j += width * (3 - window - 1);
    }

    {
      const amp = ipow20[202];
      j += cod_info.width[sfb] * (window + 1);
      for (l = -cod_info.width[sfb]; l < 0; l++) {
        const v = f(xrpow[j + l] * amp);
        xrpow[j + l] = v;
        if (v > cod_info.xrpow_max) cod_info.xrpow_max = v;
      }
    }
  }
  return 0;
}

/********************************************************************
 *
 *      balance_noise()
 *
 *  Takehiro Tominaga /date??
 *  Robert Hegemann 2000-09-06: made a function of it
 *
 *  amplifies scalefactor bands,
 *   - if all are already amplified returns 0
 *   - if some bands are amplified too much:
 *      * try to increase scalefac_scale
 *      * if already scalefac_scale was set
 *          try on short blocks to increase subblock gain
 *
 ********************************************************************/
function balance_noise(
  gfc: LameInternalFlags,
  cod_info: GrInfo,
  distort: Float32Array,
  xrpow: Float32Array,
  bRefine: number,
): number {
  const cfg = gfc.cfg;
  let status: number;

  amp_scalefac_bands(gfc, cod_info, distort, xrpow, bRefine);

  /* check to make sure we have not amplified too much
   * loop_break returns 0 if there is an unamplified scalefac
   * scale_bitcount returns 0 if no scalefactors are too large
   */

  status = loop_break(cod_info);

  if (status) return 0; /* all bands amplified */

  /* not all scalefactors have been amplified.  so these
   * scalefacs are possibly valid.  encode them:
   */
  status = scale_bitcount(gfc, cod_info);

  if (!status) return 1; /* amplified some bands not exceeding limits */

  /*  some scalefactors are too large.
   *  lets try setting scalefac_scale=1
   */
  if (cfg.noise_shaping > 1) {
    gfc.sv_qnt.pseudohalf.fill(0);
    if (!cod_info.scalefac_scale) {
      inc_scalefac_scale(cod_info, xrpow);
      status = 0;
    } else {
      if (cod_info.block_type === SHORT_TYPE && cfg.subblock_gain > 0) {
        status = inc_subblock_gain(gfc, cod_info, xrpow) || loop_break(cod_info) ? 1 : 0;
      }
    }
  }

  if (!status) {
    status = scale_bitcount(gfc, cod_info);
  }
  return status ? 0 : 1;
}

/************************************************************************
 *
 *  outer_loop ()
 *
 *  Function: The outer iteration loop controls the masking conditions
 *  of all scalefactorbands. It computes the best scalefac and
 *  global gain. This module calls the inner iteration loop
 *
 *  mt 5/99 completely rewritten to allow for bit reservoir control,
 *  mid/side channels with L/R or mid/side masking thresholds,
 *  and chooses best quantization instead of last quantization when
 *  no distortion free quantization can be found.
 *
 *  added VBR support mt 5/99
 *
 *  some code shuffle rh 9/00
 ************************************************************************/

const ol_cod_info_w = new GrInfo();
const ol_save_xrpow = new Float32Array(576);
const ol_distort = new Float32Array(SFBMAX);
const ol_best_noise_info = new CalcNoiseResult();
const ol_noise_info = new CalcNoiseResult();
const ol_prev_noise = new CalcNoiseData();

function outer_loop(
  gfc: LameInternalFlags,
  cod_info: GrInfo,
  l3_xmin: Float32Array /* allowed distortion */,
  xrpow: Float32Array /* coloured magnitudes of spectral */,
  ch: number,
  targ_bits: number /* maximum allowed bits */,
): number {
  const cfg = gfc.cfg;
  const cod_info_w = ol_cod_info_w;
  const save_xrpow = ol_save_xrpow;
  const distort = ol_distort;
  const best_noise_info = ol_best_noise_info;
  const noise_info = ol_noise_info;
  const prev_noise = ol_prev_noise;
  let huff_bits: number;
  let better: boolean;
  let age: number;
  let best_part2_3_length = 9999999;
  let bEndOfSearch = 0;
  let bRefine = 0;
  let best_ggain_pass1 = 0;

  bin_search_StepSize(gfc, cod_info, targ_bits, ch, xrpow);

  if (!cfg.noise_shaping) /* fast mode, no noise shaping, we are ready */ return 100; /* default noise_info.over_count */

  prev_noise.clear();

  /* compute the distortion in this quantization */
  /* coefficients and thresholds both l/r (or both mid/side) */
  calc_noise(cod_info, l3_xmin, distort, best_noise_info, prev_noise);
  best_noise_info.bits = cod_info.part2_3_length;

  cod_info_w.assign(cod_info);
  age = 0;
  save_xrpow.set(xrpow);

  while (!bEndOfSearch) {
    /* BEGIN MAIN LOOP */
    do {
      let search_limit: number;
      let maxggain = 255;

      /* When quantization with no distorted bands is found,
       * allow up to X new unsuccesful tries in serial. This
       * gives us more possibilities for different quant_compare modes.
       * Much more than 3 makes not a big difference, it is only slower.
       */

      if (gfc.sv_qnt.substep_shaping & 2) {
        search_limit = 20;
      } else {
        search_limit = 3;
      }

      /* Check if the last scalefactor band is distorted.
       * in VBR mode we can't get rid of the distortion, so quit now
       * and VBR mode will try again with more bits.
       * (makes a 10% speed increase, the files I tested were
       * binary identical, 2000/05/20 Robert Hegemann)
       * distort[] > 1 means noise > allowed noise
       */
      if (gfc.sv_qnt.sfb21_extra) {
        if (distort[cod_info_w.sfbmax] > 1.0) break;
        if (
          cod_info_w.block_type === SHORT_TYPE &&
          (distort[cod_info_w.sfbmax + 1] > 1.0 || distort[cod_info_w.sfbmax + 2] > 1.0)
        )
          break;
      }

      /* try a new scalefactor conbination on cod_info_w */
      if (balance_noise(gfc, cod_info_w, distort, xrpow, bRefine) === 0) break;
      if (cod_info_w.scalefac_scale) maxggain = 254;

      /* inner_loop starts with the initial quantization step computed above
       * and slowly increases until the bits < huff_bits.
       * Thus it is important not to start with too large of an inital
       * quantization step.  Too small is ok, but inner_loop will take longer
       */
      huff_bits = targ_bits - cod_info_w.part2_length;
      if (huff_bits <= 0) break;

      /*  increase quantizer stepsize until needed bits are below maximum
       */
      while (
        (cod_info_w.part2_3_length = count_bits(gfc, xrpow, cod_info_w, prev_noise)) > huff_bits &&
        cod_info_w.global_gain <= maxggain
      )
        cod_info_w.global_gain++;

      if (cod_info_w.global_gain > maxggain) break;

      if (best_noise_info.over_count === 0) {
        while (
          (cod_info_w.part2_3_length = count_bits(gfc, xrpow, cod_info_w, prev_noise)) > best_part2_3_length &&
          cod_info_w.global_gain <= maxggain
        )
          cod_info_w.global_gain++;

        if (cod_info_w.global_gain > maxggain) break;
      }

      /* compute the distortion in this quantization */
      calc_noise(cod_info_w, l3_xmin, distort, noise_info, prev_noise);
      noise_info.bits = cod_info_w.part2_3_length;

      /* check if this quantization is better
       * than our saved quantization */
      const quant_comp = cod_info.block_type !== SHORT_TYPE ? cfg.quant_comp : cfg.quant_comp_short;

      better = quant_compare(quant_comp, best_noise_info, noise_info, cod_info_w, distort);

      /* save data so we can restore this quantization later */
      if (better) {
        best_part2_3_length = cod_info.part2_3_length;
        best_noise_info.assign(noise_info);
        cod_info.assign(cod_info_w);
        age = 0;
        /* store for later reuse */
        save_xrpow.set(xrpow);
      } else {
        /* early stop? */
        if (cfg.full_outer_loop === 0) {
          if (++age > search_limit && best_noise_info.over_count === 0) break;
          if (cfg.noise_shaping_amp === 3 && bRefine && age > 30) break;
          if (cfg.noise_shaping_amp === 3 && bRefine && cod_info_w.global_gain - best_ggain_pass1 > 15) break;
        }
      }
    } while (cod_info_w.global_gain + cod_info_w.scalefac_scale < 255);

    if (cfg.noise_shaping_amp === 3) {
      if (!bRefine) {
        /* refine search */
        cod_info_w.assign(cod_info);
        xrpow.set(save_xrpow);
        age = 0;
        best_ggain_pass1 = cod_info_w.global_gain;

        bRefine = 1;
      } else {
        /* search already refined, stop */
        bEndOfSearch = 1;
      }
    } else {
      bEndOfSearch = 1;
    }
  }

  /*  finish up
   */
  if (cfg.vbr === vbr_rh || cfg.vbr === vbr_mtrh || cfg.vbr === vbr_mt)
    /* restore for reuse on next try */
    xrpow.set(save_xrpow);
  /*  do the 'substep shaping'
   */ else if (gfc.sv_qnt.substep_shaping & 1) trancate_smallspectrums(gfc, cod_info, l3_xmin, xrpow);

  return best_noise_info.over_count;
}

/************************************************************************
 *
 *      iteration_finish_one()
 *
 *  Robert Hegemann 2000-09-06
 *
 *  update reservoir status after FINAL quantization/bitrate
 *
 ************************************************************************/
function iteration_finish_one(gfc: LameInternalFlags, gr: number, ch: number): void {
  const cfg = gfc.cfg;
  const l3_side = gfc.l3_side;
  const cod_info = l3_side.tt[gr][ch];

  /*  try some better scalefac storage
   */
  best_scalefac_store(gfc, gr, ch, l3_side);

  /*  best huffman_divide may save some bits too
   */
  if (cfg.use_best_huffman === 1) best_huffman_divide(gfc, cod_info);

  /*  update reservoir status after FINAL quantization/bitrate
   */
  ResvAdjust(gfc, cod_info);
}

/*********************************************************************
 *
 *      VBR_encode_granule()
 *
 *  2000-09-04 Robert Hegemann
 *
 *********************************************************************/

const veg_bst_cod_info = new GrInfo();
const veg_bst_xrpow = new Float32Array(576);

function VBR_encode_granule(
  gfc: LameInternalFlags,
  cod_info: GrInfo,
  l3_xmin: Float32Array /* allowed distortion of the scalefactor */,
  xrpow: Float32Array /* coloured magnitudes of spectral values */,
  ch: number,
  min_bits: number,
  max_bits: number,
): void {
  const bst_cod_info = veg_bst_cod_info;
  const bst_xrpow = veg_bst_xrpow;
  const Max_bits = max_bits;
  let real_bits = max_bits + 1;
  let this_bits = ((max_bits + min_bits) / 2) | 0;
  let dbits: number,
    over: number,
    found = 0;
  const sfb21_extra = gfc.sv_qnt.sfb21_extra;

  bst_cod_info.l3_enc.fill(0);

  /*  search within round about 40 bits of optimal
   */
  do {
    if (this_bits > Max_bits - 42) gfc.sv_qnt.sfb21_extra = 0;
    else gfc.sv_qnt.sfb21_extra = sfb21_extra;

    over = outer_loop(gfc, cod_info, l3_xmin, xrpow, ch, this_bits);

    /*  is quantization as good as we are looking for ?
     *  in this case: is no scalefactor band distorted?
     */
    if (over <= 0) {
      found = 1;
      /*  now we know it can be done with "real_bits"
       *  and maybe we can skip some iterations
       */
      real_bits = cod_info.part2_3_length;

      /*  store best quantization so far
       */
      bst_cod_info.assign(cod_info);
      bst_xrpow.set(xrpow);

      /*  try with fewer bits
       */
      max_bits = real_bits - 32;
      dbits = max_bits - min_bits;
      this_bits = ((max_bits + min_bits) / 2) | 0;
    } else {
      /*  try with more bits
       */
      min_bits = this_bits + 32;
      dbits = max_bits - min_bits;
      this_bits = ((max_bits + min_bits) / 2) | 0;

      if (found) {
        found = 2;
        /*  start again with best quantization so far
         */
        cod_info.assign(bst_cod_info);
        xrpow.set(bst_xrpow);
      }
    }
  } while (dbits > 12);

  gfc.sv_qnt.sfb21_extra = sfb21_extra;

  /*  found=0 => nothing found, use last one
   *  found=1 => we just found the best and left the loop
   *  found=2 => we restored a good one and have now l3_enc to restore too
   */
  if (found === 2) {
    cod_info.l3_enc.set(bst_cod_info.l3_enc);
  }
}

/************************************************************************
 *
 *      get_framebits()
 *
 *  Robert Hegemann 2000-09-05
 *
 *  calculates
 *  * how many bits are available for analog silent granules
 *  * how many bits to use for the lowest allowed bitrate
 *  * how many bits each bitrate would provide
 *
 ************************************************************************/
function get_framebits(gfc: LameInternalFlags, frameBits: Int32Array): void {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;

  for (let i = 1; i <= cfg.vbr_max_bitrate_index; i++) {
    eov.bitrate_index = i;
    frameBits[i] = ResvFrameBegin(gfc)[0];
  }
}

/*********************************************************************
 *
 *      VBR_prepare()
 *
 *  2000-09-04 Robert Hegemann
 *
 *  * converts LR to MS coding when necessary
 *  * calculates allowed/adjusted quantization noise amounts
 *  * detects analog silent frames
 *
 *  some remarks:
 *  - lower masking depending on Quality setting
 *  - quality control together with adjusted ATH MDCT scaling
 *    on lower quality setting allocate more noise from
 *    ATH masking, and on higher quality setting allocate
 *    less noise from ATH masking.
 *  - experiments show that going more than 2dB over GPSYCHO's
 *    limits ends up in very annoying artefacts
 *
 *********************************************************************/

/* RH: this one needs to be overhauled sometime */

function VBR_old_prepare(
  gfc: LameInternalFlags,
  pe: Float32Array[],
  ms_ener_ratio: Float32Array,
  ratio: III_psy_ratio[][],
  l3_xmin: Float32Array[][],
  frameBits: Int32Array,
  min_bits: Int32Array[],
  max_bits: Int32Array[],
  bands: Int32Array[],
): number {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;

  let masking_lower_db: number,
    adjust = 0.0;
  let gr: number, ch: number;
  let analog_silence = 1;
  let bits = 0;

  eov.bitrate_index = cfg.vbr_max_bitrate_index;
  const avg = (ResvFrameBegin(gfc)[0] / cfg.mode_gr) | 0;

  get_framebits(gfc, frameBits);

  for (gr = 0; gr < cfg.mode_gr; gr++) {
    const mxb = on_pe(gfc, pe[gr], max_bits[gr], avg, 0);
    if (gfc.ov_enc.mode_ext === MPG_MD_MS_LR) {
      ms_convert(gfc.l3_side, gr);
      reduce_side(max_bits[gr], ms_ener_ratio[gr], avg, mxb);
    }
    for (ch = 0; ch < cfg.channels_out; ++ch) {
      const cod_info = gfc.l3_side.tt[gr][ch];

      if (cod_info.block_type !== SHORT_TYPE) {
        /* NORM, START or STOP type */
        adjust = f(1.28 / (1 + Math.exp(3.5 - pe[gr][ch] / 300)) - 0.05);
        masking_lower_db = f(gfc.sv_qnt.mask_adjust - adjust);
      } else {
        adjust = f(2.56 / (1 + Math.exp(3.5 - pe[gr][ch] / 300)) - 0.14);
        masking_lower_db = f(gfc.sv_qnt.mask_adjust_short - adjust);
      }
      gfc.sv_qnt.masking_lower = f(Math.pow(10.0, masking_lower_db * 0.1));

      init_outer_loop(gfc, cod_info);
      bands[gr][ch] = calc_xmin(gfc, ratio[gr][ch], cod_info, l3_xmin[gr][ch]);
      if (bands[gr][ch]) analog_silence = 0;

      min_bits[gr][ch] = 126;

      bits += max_bits[gr][ch];
    }
  }
  for (gr = 0; gr < cfg.mode_gr; gr++) {
    for (ch = 0; ch < cfg.channels_out; ch++) {
      if (bits > frameBits[cfg.vbr_max_bitrate_index] && bits > 0) {
        max_bits[gr][ch] = Math.imul(max_bits[gr][ch], frameBits[cfg.vbr_max_bitrate_index]);
        max_bits[gr][ch] = (max_bits[gr][ch] / bits) | 0;
      }
      if (min_bits[gr][ch] > max_bits[gr][ch]) min_bits[gr][ch] = max_bits[gr][ch];
    } /* for ch */
  } /* for gr */

  return analog_silence;
}

function bitpressure_strategy(
  gfc: LameInternalFlags,
  l3_xmin: Float32Array[][],
  min_bits: Int32Array[],
  max_bits: Int32Array[],
): void {
  const cfg = gfc.cfg;
  let sfb: number;
  for (let gr = 0; gr < cfg.mode_gr; gr++) {
    for (let ch = 0; ch < cfg.channels_out; ch++) {
      const gi = gfc.l3_side.tt[gr][ch];
      const pxmin = l3_xmin[gr][ch];
      let p = 0;
      for (sfb = 0; sfb < gi.psy_lmax; sfb++) {
        pxmin[p] = pxmin[p] * (1 + (0.029 * sfb * sfb) / SBMAX_l / SBMAX_l);
        p++;
      }

      if (gi.block_type === SHORT_TYPE) {
        for (sfb = gi.sfb_smin; sfb < SBMAX_s; sfb++) {
          const m = 1 + (0.029 * sfb * sfb) / SBMAX_s / SBMAX_s;
          pxmin[p] = pxmin[p] * m;
          p++;
          pxmin[p] = pxmin[p] * m;
          p++;
          pxmin[p] = pxmin[p] * m;
          p++;
        }
      }
      const a = min_bits[gr][ch];
      const b = 0.9 * max_bits[gr][ch];
      max_bits[gr][ch] = Math.trunc(a > b ? a : b);
    }
  }
}

function mk2x2f(n: number): Float32Array[][] {
  return [
    [new Float32Array(n), new Float32Array(n)],
    [new Float32Array(n), new Float32Array(n)],
  ];
}
function mk2x2i(): Int32Array[] {
  return [new Int32Array(2), new Int32Array(2)];
}

const vbr_l3_xmin = mk2x2f(SFBMAX);
const vbr_xrpow1 = new Float32Array(576);
const vbr_xrpow = mk2x2f(576);
const vbr_bands = mk2x2i();
const vbr_frameBits = new Int32Array(16);
const vbr_min_bits = mk2x2i();
const vbr_max_bits = mk2x2i();

/************************************************************************
 *
 *      VBR_iteration_loop()
 *
 *  tries to find out how many bits are needed for each granule and channel
 *  to get an acceptable quantization. An appropriate bitrate will then be
 *  choosed for quantization.  rh 8/99
 *
 *  Robert Hegemann 2000-09-06 rewrite
 *
 ************************************************************************/
export function VBR_old_iteration_loop(
  gfc: LameInternalFlags,
  pe: Float32Array[],
  ms_ener_ratio: Float32Array,
  ratio: III_psy_ratio[][],
): void {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;
  const l3_xmin = vbr_l3_xmin;
  const xrpow = vbr_xrpow1;
  const bands = vbr_bands;
  const frameBits = vbr_frameBits;
  let used_bits: number;
  let bits: number;
  const min_bits = vbr_min_bits,
    max_bits = vbr_max_bits;
  let mean_bits: number;
  let ch: number, gr: number;
  const l3_side = gfc.l3_side;

  const analog_silence = VBR_old_prepare(
    gfc,
    pe,
    ms_ener_ratio,
    ratio,
    l3_xmin,
    frameBits,
    min_bits,
    max_bits,
    bands,
  );

  /*---------------------------------*/
  for (;;) {
    /*  quantize granules with lowest possible number of bits
     */

    used_bits = 0;

    for (gr = 0; gr < cfg.mode_gr; gr++) {
      for (ch = 0; ch < cfg.channels_out; ch++) {
        const cod_info = l3_side.tt[gr][ch];

        /*  init_outer_loop sets up cod_info, scalefac and xrpow
         */
        const ret = init_xrpow(gfc, cod_info, xrpow);
        if (ret === 0 || max_bits[gr][ch] === 0) {
          /*  xr contains no energy
           *  l3_enc, our encoding data, will be quantized to zero
           */
          continue; /* with next channel */
        }

        VBR_encode_granule(gfc, cod_info, l3_xmin[gr][ch], xrpow, ch, min_bits[gr][ch], max_bits[gr][ch]);

        /*  do the 'substep shaping'
         */
        if (gfc.sv_qnt.substep_shaping & 1) {
          trancate_smallspectrums(gfc, l3_side.tt[gr][ch], l3_xmin[gr][ch], xrpow);
        }

        used_bits += cod_info.part2_3_length + cod_info.part2_length;
      } /* for ch */
    } /* for gr */

    /*  find lowest bitrate able to hold used bits
     */
    if (analog_silence && !cfg.enforce_min_bitrate)
      /*  we detected analog silence and the user did not specify
       *  any hard framesize limit, so start with smallest possible frame
       */
      eov.bitrate_index = 1;
    else eov.bitrate_index = cfg.vbr_min_bitrate_index;

    for (; eov.bitrate_index < cfg.vbr_max_bitrate_index; eov.bitrate_index++) {
      if (used_bits <= frameBits[eov.bitrate_index]) break;
    }
    const r = ResvFrameBegin(gfc);
    bits = r[0];
    mean_bits = r[1];

    if (used_bits <= bits) break;

    bitpressure_strategy(gfc, l3_xmin, min_bits, max_bits);
  } /* breaks adjusted */
  /*--------------------------------------*/

  for (gr = 0; gr < cfg.mode_gr; gr++) {
    for (ch = 0; ch < cfg.channels_out; ch++) {
      iteration_finish_one(gfc, gr, ch);
    } /* for ch */
  } /* for gr */
  ResvFrameEnd(gfc, mean_bits);
}

/** Returns [analog_silence, max_resv]. */
function VBR_new_prepare(
  gfc: LameInternalFlags,
  pe: Float32Array[],
  ratio: III_psy_ratio[][],
  l3_xmin: Float32Array[][],
  frameBits: Int32Array,
  max_bits: Int32Array[],
): [number, number] {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;

  let gr: number, ch: number;
  let analog_silence = 1;
  let avg: number,
    bits = 0;
  let maximum_framebits: number;
  let max_resv: number;

  if (!cfg.free_format) {
    eov.bitrate_index = cfg.vbr_max_bitrate_index;
    avg = ResvFrameBegin(gfc)[1];
    max_resv = gfc.sv_enc.ResvMax;

    get_framebits(gfc, frameBits);
    maximum_framebits = frameBits[cfg.vbr_max_bitrate_index];
  } else {
    eov.bitrate_index = 0;
    const r = ResvFrameBegin(gfc);
    maximum_framebits = r[0];
    avg = r[1];
    frameBits[0] = maximum_framebits;
    max_resv = gfc.sv_enc.ResvMax;
  }

  for (gr = 0; gr < cfg.mode_gr; gr++) {
    on_pe(gfc, pe[gr], max_bits[gr], avg, 0);
    if (gfc.ov_enc.mode_ext === MPG_MD_MS_LR) {
      ms_convert(gfc.l3_side, gr);
    }
    for (ch = 0; ch < cfg.channels_out; ++ch) {
      const cod_info = gfc.l3_side.tt[gr][ch];

      gfc.sv_qnt.masking_lower = f(Math.pow(10.0, gfc.sv_qnt.mask_adjust * 0.1));

      init_outer_loop(gfc, cod_info);
      if (0 !== calc_xmin(gfc, ratio[gr][ch], cod_info, l3_xmin[gr][ch])) analog_silence = 0;

      bits += max_bits[gr][ch];
    }
  }
  for (gr = 0; gr < cfg.mode_gr; gr++) {
    for (ch = 0; ch < cfg.channels_out; ch++) {
      if (bits > maximum_framebits && bits > 0) {
        max_bits[gr][ch] = Math.imul(max_bits[gr][ch], maximum_framebits);
        max_bits[gr][ch] = (max_bits[gr][ch] / bits) | 0;
      }
    } /* for ch */
  } /* for gr */
  if (analog_silence) {
    max_resv = 0;
  }
  return [analog_silence, max_resv];
}

export function VBR_new_iteration_loop(
  gfc: LameInternalFlags,
  pe: Float32Array[],
  _ms_ener_ratio: Float32Array,
  ratio: III_psy_ratio[][],
): void {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;
  const l3_xmin = vbr_l3_xmin;
  const xrpow = vbr_xrpow;
  const frameBits = vbr_frameBits;
  const max_bits = vbr_max_bits;
  let ch: number, gr: number;
  const l3_side = gfc.l3_side;

  for (gr = 0; gr < 2; gr++) for (ch = 0; ch < 2; ch++) xrpow[gr][ch].fill(0);

  const pr = VBR_new_prepare(gfc, pe, ratio, l3_xmin, frameBits, max_bits);
  const analog_silence = pr[0];
  const pad = pr[1];

  for (gr = 0; gr < cfg.mode_gr; gr++) {
    for (ch = 0; ch < cfg.channels_out; ch++) {
      const cod_info = l3_side.tt[gr][ch];

      /*  init_outer_loop sets up cod_info, scalefac and xrpow
       */
      if (0 === init_xrpow(gfc, cod_info, xrpow[gr][ch])) {
        max_bits[gr][ch] = 0; /* silent granule needs no bits */
      }
    } /* for ch */
  } /* for gr */

  /*  quantize granules with lowest possible number of bits
   */

  const used_bits = VBR_encode_frame(gfc, xrpow, l3_xmin, max_bits);

  if (!cfg.free_format) {
    let i: number, j: number;

    /*  find lowest bitrate able to hold used bits
     */
    if (analog_silence && !cfg.enforce_min_bitrate) {
      /*  we detected analog silence and the user did not specify
       *  any hard framesize limit, so start with smallest possible frame
       */
      i = 1;
    } else {
      i = cfg.vbr_min_bitrate_index;
    }

    for (; i < cfg.vbr_max_bitrate_index; i++) {
      if (used_bits <= frameBits[i]) break;
    }
    if (i > cfg.vbr_max_bitrate_index) {
      i = cfg.vbr_max_bitrate_index;
    }
    if (pad > 0) {
      for (j = cfg.vbr_max_bitrate_index; j > i; --j) {
        const unused = frameBits[j] - used_bits;
        if (unused <= pad) break;
      }
      eov.bitrate_index = j;
    } else {
      eov.bitrate_index = i;
    }
  } else {
    eov.bitrate_index = 0;
  }
  if (used_bits <= frameBits[eov.bitrate_index]) {
    /* update Reservoire status */
    const mean_bits = ResvFrameBegin(gfc)[1];
    for (gr = 0; gr < cfg.mode_gr; gr++) {
      for (ch = 0; ch < cfg.channels_out; ch++) {
        ResvAdjust(gfc, l3_side.tt[gr][ch]);
      }
    }
    ResvFrameEnd(gfc, mean_bits);
  } else {
    /* SHOULD NOT HAPPEN INTERNAL ERROR
     */
    throw new Error('INTERNAL ERROR IN VBR NEW CODE, please send bug report');
  }
}

/********************************************************************
 *
 *  calc_target_bits()
 *
 *  calculates target bits for ABR encoding
 *
 *  mt 2000/05/31
 *
 ********************************************************************/

/** Returns [analog_silence_bits, max_frame_bits]. */
function calc_target_bits(
  gfc: LameInternalFlags,
  pe: Float32Array[],
  ms_ener_ratio: Float32Array,
  targ_bits: Int32Array[],
): [number, number] {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;
  const l3_side = gfc.l3_side;
  let res_factor: number;
  let gr: number, ch: number, totbits: number, mean_bits: number;
  const framesize = 576 * cfg.mode_gr;

  eov.bitrate_index = cfg.vbr_max_bitrate_index;
  const max_frame_bits = ResvFrameBegin(gfc)[0];

  eov.bitrate_index = 1;
  mean_bits = getframebits(gfc) - cfg.sideinfo_len * 8;
  const analog_silence_bits = (mean_bits / (cfg.mode_gr * cfg.channels_out)) | 0;

  mean_bits = cfg.vbr_avg_bitrate_kbps * framesize * 1000;
  if (gfc.sv_qnt.substep_shaping & 1) mean_bits = Math.trunc(mean_bits * 1.09);
  mean_bits = (mean_bits / cfg.samplerate_out) | 0;
  mean_bits -= cfg.sideinfo_len * 8;
  mean_bits = (mean_bits / (cfg.mode_gr * cfg.channels_out)) | 0;

  /*
     res_factor is the percentage of the target bitrate that should
     be used on average.  the remaining bits are added to the
     bitreservoir and used for difficult to encode frames.

     Since we are tracking the average bitrate, we should adjust
     res_factor "on the fly", increasing it if the average bitrate
     is greater than the requested bitrate, and decreasing it
     otherwise.  Reasonable ranges are from .9 to 1.0

     Until we get the above suggestion working, we use the following
     tuning:
     compression ratio    res_factor
     5.5  (256kbps)         1.0      no need for bitreservoir
     11   (128kbps)         .93      7% held for reservoir

     with linear interpolation for other values.

   */
  res_factor = f(0.93 + (0.07 * (11.0 - cfg.compression_ratio)) / (11.0 - 5.5));
  if (res_factor < 0.9) res_factor = f(0.9);
  if (res_factor > 1.0) res_factor = 1.0;

  for (gr = 0; gr < cfg.mode_gr; gr++) {
    let sum = 0;
    for (ch = 0; ch < cfg.channels_out; ch++) {
      targ_bits[gr][ch] = Math.trunc(f(res_factor * mean_bits));

      if (pe[gr][ch] > 700) {
        let add_bits = Math.trunc(f(pe[gr][ch] - 700) / 1.4);

        const cod_info = l3_side.tt[gr][ch];
        targ_bits[gr][ch] = Math.trunc(f(res_factor * mean_bits));

        /* short blocks use a little extra, no matter what the pe */
        if (cod_info.block_type === SHORT_TYPE) {
          if (add_bits < ((mean_bits / 2) | 0)) add_bits = (mean_bits / 2) | 0;
        }
        /* at most increase bits by 1.5*average */
        if (add_bits > (((mean_bits * 3) / 2) | 0)) add_bits = ((mean_bits * 3) / 2) | 0;
        else if (add_bits < 0) add_bits = 0;

        targ_bits[gr][ch] += add_bits;
      }
      if (targ_bits[gr][ch] > MAX_BITS_PER_CHANNEL) {
        targ_bits[gr][ch] = MAX_BITS_PER_CHANNEL;
      }
      sum += targ_bits[gr][ch];
    } /* for ch */
    if (sum > MAX_BITS_PER_GRANULE) {
      for (ch = 0; ch < cfg.channels_out; ++ch) {
        targ_bits[gr][ch] = ((targ_bits[gr][ch] * MAX_BITS_PER_GRANULE) / sum) | 0;
      }
    }
  } /* for gr */

  if (gfc.ov_enc.mode_ext === MPG_MD_MS_LR)
    for (gr = 0; gr < cfg.mode_gr; gr++) {
      reduce_side(targ_bits[gr], ms_ener_ratio[gr], mean_bits * cfg.channels_out, MAX_BITS_PER_GRANULE);
    }

  /*  sum target bits
   */
  totbits = 0;
  for (gr = 0; gr < cfg.mode_gr; gr++) {
    for (ch = 0; ch < cfg.channels_out; ch++) {
      if (targ_bits[gr][ch] > MAX_BITS_PER_CHANNEL) targ_bits[gr][ch] = MAX_BITS_PER_CHANNEL;
      totbits += targ_bits[gr][ch];
    }
  }

  /*  repartion target bits if needed
   */
  if (totbits > max_frame_bits && totbits > 0) {
    for (gr = 0; gr < cfg.mode_gr; gr++) {
      for (ch = 0; ch < cfg.channels_out; ch++) {
        targ_bits[gr][ch] = ((targ_bits[gr][ch] * max_frame_bits) / totbits) | 0;
      }
    }
  }
  return [analog_silence_bits, max_frame_bits];
}

const cbr_l3_xmin = new Float32Array(SFBMAX);
const cbr_xrpow = new Float32Array(576);
const cbr_targ_bits = new Int32Array(2);
const abr_targ_bits = mk2x2i();

/********************************************************************
 *
 *  ABR_iteration_loop()
 *
 *  encode a frame with a disired average bitrate
 *
 *  mt 2000/05/31
 *
 ********************************************************************/
export function ABR_iteration_loop(
  gfc: LameInternalFlags,
  pe: Float32Array[],
  ms_ener_ratio: Float32Array,
  ratio: III_psy_ratio[][],
): void {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;
  const l3_xmin = cbr_l3_xmin;
  const xrpow = cbr_xrpow;
  const targ_bits = abr_targ_bits;
  let mean_bits = 0;
  let ch: number, gr: number;
  const l3_side = gfc.l3_side;

  const analog_silence_bits = calc_target_bits(gfc, pe, ms_ener_ratio, targ_bits)[0];

  /*  encode granules
   */
  for (gr = 0; gr < cfg.mode_gr; gr++) {
    if (gfc.ov_enc.mode_ext === MPG_MD_MS_LR) {
      ms_convert(gfc.l3_side, gr);
    }
    for (ch = 0; ch < cfg.channels_out; ch++) {
      const cod_info = l3_side.tt[gr][ch];
      const masking_lower_db =
        cod_info.block_type !== SHORT_TYPE ? gfc.sv_qnt.mask_adjust : gfc.sv_qnt.mask_adjust_short;
      gfc.sv_qnt.masking_lower = f(Math.pow(10.0, masking_lower_db * 0.1));

      /*  cod_info, scalefac and xrpow get initialized in init_outer_loop
       */
      init_outer_loop(gfc, cod_info);
      if (init_xrpow(gfc, cod_info, xrpow)) {
        /*  xr contains energy we will have to encode
         *  calculate the masking abilities
         *  find some good quantization in outer_loop
         */
        const ath_over = calc_xmin(gfc, ratio[gr][ch], cod_info, l3_xmin);
        if (0 === ath_over) /* analog silence */ targ_bits[gr][ch] = analog_silence_bits;

        outer_loop(gfc, cod_info, l3_xmin, xrpow, ch, targ_bits[gr][ch]);
      }
      iteration_finish_one(gfc, gr, ch);
    } /* ch */
  } /* gr */

  /*  find a bitrate which can refill the resevoir to positive size.
   */
  for (
    eov.bitrate_index = cfg.vbr_min_bitrate_index;
    eov.bitrate_index <= cfg.vbr_max_bitrate_index;
    eov.bitrate_index++
  ) {
    const r = ResvFrameBegin(gfc);
    mean_bits = r[1];
    if (r[0] >= 0) break;
  }

  ResvFrameEnd(gfc, mean_bits);
}

/************************************************************************
 *
 *      CBR_iteration_loop()
 *
 *  author/date??
 *
 *  encodes one frame of MP3 data with constant bitrate
 *
 ************************************************************************/
export function CBR_iteration_loop(
  gfc: LameInternalFlags,
  pe: Float32Array[],
  ms_ener_ratio: Float32Array,
  ratio: III_psy_ratio[][],
): void {
  const cfg = gfc.cfg;
  const l3_xmin = cbr_l3_xmin;
  const xrpow = cbr_xrpow;
  const targ_bits = cbr_targ_bits;
  let gr: number, ch: number;
  const l3_side = gfc.l3_side;

  const mean_bits = ResvFrameBegin(gfc)[1];

  /* quantize! */
  for (gr = 0; gr < cfg.mode_gr; gr++) {
    /*  calculate needed bits
     */
    const max_bits = on_pe(gfc, pe[gr], targ_bits, mean_bits, gr);

    if (gfc.ov_enc.mode_ext === MPG_MD_MS_LR) {
      ms_convert(gfc.l3_side, gr);
      reduce_side(targ_bits, ms_ener_ratio[gr], mean_bits, max_bits);
    }

    for (ch = 0; ch < cfg.channels_out; ch++) {
      const cod_info = l3_side.tt[gr][ch];
      const masking_lower_db =
        cod_info.block_type !== SHORT_TYPE ? gfc.sv_qnt.mask_adjust : gfc.sv_qnt.mask_adjust_short;
      gfc.sv_qnt.masking_lower = f(Math.pow(10.0, masking_lower_db * 0.1));

      /*  init_outer_loop sets up cod_info, scalefac and xrpow
       */
      init_outer_loop(gfc, cod_info);
      if (init_xrpow(gfc, cod_info, xrpow)) {
        /*  xr contains energy we will have to encode
         *  calculate the masking abilities
         *  find some good quantization in outer_loop
         */
        calc_xmin(gfc, ratio[gr][ch], cod_info, l3_xmin);
        outer_loop(gfc, cod_info, l3_xmin, xrpow, ch, targ_bits[ch]);
      }

      iteration_finish_one(gfc, gr, ch);
    } /* for ch */
  } /* for gr */

  ResvFrameEnd(gfc, mean_bits);
}
