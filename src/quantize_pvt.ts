// Port of libmp3lame/quantize_pvt.c - quantization helpers shared by the CBR/ABR/VBR loops:
// lookup tables, ATH per scalefactor band, bit allocation between channels, allowed
// distortion (calc_xmin) and quantization noise (calc_noise).

import {
  FLT_MAX,
  MAX_BITS_PER_CHANNEL,
  MAX_BITS_PER_GRANULE,
  PRECALC_SIZE,
  PSFB12,
  PSFB21,
  Q_MAX,
  Q_MAX2,
  SBMAX_l,
  SBMAX_s,
  SHORT_TYPE,
  f,
} from './constants.ts';
import { ResvMaxBits } from './reservoir.ts';
import { pretab } from './tables.ts';
import { huffman_init } from './takehiro.ts';
import type { GrInfo, III_psy_ratio, LameInternalFlags, SessionConfig } from './types.ts';
import { ATHformula, FAST_LOG10, FAST_LOG10_X, powf } from './util.ts';

const NSATHSCALE = 100; /* Assuming dynamic range=96dB, this value should be 92 */

const DBL_EPSILON = 2.220446049250313e-16;
const F_DBL_EPSILON = f(DBL_EPSILON);
const F_0_1 = f(0.1);
const F_1E_12 = f(1e-12);
const F_1E_14 = f(1e-14);
const F_1E_20 = f(1e-20);

/** x^(4/3) for the integer quantized values */
export const pow43 = new Float32Array(PRECALC_SIZE);
/** rounding adjustment for the x^(3/4) quantizer */
export const adj43 = new Float32Array(PRECALC_SIZE);
/** 2^((x - 210 - Q_MAX2) / 4): quantizer step size */
export const pow20 = new Float32Array(Q_MAX + Q_MAX2 + 1);
/** 2^(-(x - 210) * 3/16): inverse step size ^ (3/4) */
export const ipow20 = new Float32Array(Q_MAX);

let tables_ready = false;

function init_tables(): void {
  if (tables_ready) return;
  tables_ready = true;
  let i: number;

  pow43[0] = 0.0;
  for (i = 1; i < PRECALC_SIZE; i++) pow43[i] = Math.pow(i, 4.0 / 3.0);

  for (i = 0; i < PRECALC_SIZE - 1; i++) adj43[i] = i + 1 - Math.pow(0.5 * f(pow43[i] + pow43[i + 1]), 0.75);
  adj43[i] = 0.5;

  for (i = 0; i < Q_MAX; i++) ipow20[i] = Math.pow(2.0, (i - 210) * -0.1875);
  for (i = 0; i <= Q_MAX + Q_MAX2; i++) pow20[i] = Math.pow(2.0, (i - 210 - Q_MAX2) * 0.25);
}

export class CalcNoiseResult {
  over_noise = 0; /* sum of quantization noise > masking */
  tot_noise = 0; /* sum of all quantization noise */
  max_noise = 0; /* max quantization noise */
  over_count = 0; /* number of quantization noise > masking */
  over_SSD = 0; /* SSD-like cost of distorted bands */
  bits = 0;

  assign(o: CalcNoiseResult): void {
    this.over_noise = o.over_noise;
    this.tot_noise = o.tot_noise;
    this.max_noise = o.max_noise;
    this.over_count = o.over_count;
    this.over_SSD = o.over_SSD;
    this.bits = o.bits;
  }
}

/**
 * allows re-use of previously computed noise values
 *
 * The three arrays share one buffer in the same layout as the C struct. quantize_xrpow()
 * reads `step[sfbmax + 1]`, which for short blocks is one element past the end of step[]
 * and therefore aliases the bit pattern of noise[0]; `stepRaw` reproduces that read.
 */
export class CalcNoiseData {
  global_gain = 0;
  sfb_count1 = 0;
  private readonly buf = new ArrayBuffer(39 * 4 * 3);
  step = new Int32Array(this.buf, 0, 39);
  noise = new Float32Array(this.buf, 39 * 4, 39);
  noise_log = new Float32Array(this.buf, 39 * 4 * 2, 39);
  stepRaw = new Int32Array(this.buf, 0, 40);

  clear(): void {
    this.global_gain = 0;
    this.sfb_count1 = 0;
    this.step.fill(0);
    this.noise.fill(0);
    this.noise_log.fill(0);
  }
}

/*
compute the ATH for each scalefactor band
cd range:  0..96db

Input:  3.3kHz signal  32767 amplitude  (3.3kHz is where ATH is smallest = -5db)
longblocks:  sfb=12   en0/bw=-11db    max_en0 = 1.3db
shortblocks: sfb=5           -9db              0db

ATH formula for this wave: -5db.  To adjust to LAME scaling, we need
ATH = ATH_formula  - 103  (db)
ATH = ATH * 2.5e-10      (ener)
*/
function ATHmdct(cfg: SessionConfig, freq: number): number {
  let ath = ATHformula(cfg, freq);

  if (cfg.ATHfixpoint > 0) {
    ath = f(ath - cfg.ATHfixpoint);
  } else {
    ath = f(ath - NSATHSCALE);
  }
  ath = f(ath + cfg.ATH_offset_db);

  /* modify the MDCT scaling for the ATH and convert to energy */
  ath = powf(10.0, f(ath * F_0_1));
  return ath;
}

function compute_ath(gfc: LameInternalFlags): void {
  const cfg = gfc.cfg;
  const ATH_l = gfc.ATH.l;
  const ATH_psfb21 = gfc.ATH.psfb21;
  const ATH_s = gfc.ATH.s;
  const ATH_psfb12 = gfc.ATH.psfb12;
  let sfb: number, i: number, start: number, end: number;
  let ATH_f: number;
  const samp_freq = f(cfg.samplerate_out);

  for (sfb = 0; sfb < SBMAX_l; sfb++) {
    start = gfc.scalefac_band.l[sfb];
    end = gfc.scalefac_band.l[sfb + 1];
    ATH_l[sfb] = FLT_MAX;
    for (i = start; i < end; i++) {
      const freq = f(f(i * samp_freq) / (2 * 576));
      ATH_f = ATHmdct(cfg, freq); /* freq in kHz */
      ATH_l[sfb] = ATH_l[sfb] < ATH_f ? ATH_l[sfb] : ATH_f;
    }
  }

  for (sfb = 0; sfb < PSFB21; sfb++) {
    start = gfc.scalefac_band.psfb21[sfb];
    end = gfc.scalefac_band.psfb21[sfb + 1];
    ATH_psfb21[sfb] = FLT_MAX;
    for (i = start; i < end; i++) {
      const freq = f(f(i * samp_freq) / (2 * 576));
      ATH_f = ATHmdct(cfg, freq); /* freq in kHz */
      ATH_psfb21[sfb] = ATH_psfb21[sfb] < ATH_f ? ATH_psfb21[sfb] : ATH_f;
    }
  }

  for (sfb = 0; sfb < SBMAX_s; sfb++) {
    start = gfc.scalefac_band.s[sfb];
    end = gfc.scalefac_band.s[sfb + 1];
    ATH_s[sfb] = FLT_MAX;
    for (i = start; i < end; i++) {
      const freq = f(f(i * samp_freq) / (2 * 192));
      ATH_f = ATHmdct(cfg, freq); /* freq in kHz */
      ATH_s[sfb] = ATH_s[sfb] < ATH_f ? ATH_s[sfb] : ATH_f;
    }
    ATH_s[sfb] *= gfc.scalefac_band.s[sfb + 1] - gfc.scalefac_band.s[sfb];
  }

  for (sfb = 0; sfb < PSFB12; sfb++) {
    start = gfc.scalefac_band.psfb12[sfb];
    end = gfc.scalefac_band.psfb12[sfb + 1];
    ATH_psfb12[sfb] = FLT_MAX;
    for (i = start; i < end; i++) {
      const freq = f(f(i * samp_freq) / (2 * 192));
      ATH_f = ATHmdct(cfg, freq); /* freq in kHz */
      ATH_psfb12[sfb] = ATH_psfb12[sfb] < ATH_f ? ATH_psfb12[sfb] : ATH_f;
    }
    /*not sure about the following */
    ATH_psfb12[sfb] *= gfc.scalefac_band.s[13] - gfc.scalefac_band.s[12];
  }

  /*  no-ATH mode:
   *  reduce ATH to -200 dB
   */
  if (cfg.noATH) {
    for (sfb = 0; sfb < SBMAX_l; sfb++) {
      ATH_l[sfb] = 1e-20;
    }
    for (sfb = 0; sfb < PSFB21; sfb++) {
      ATH_psfb21[sfb] = 1e-20;
    }
    for (sfb = 0; sfb < SBMAX_s; sfb++) {
      ATH_s[sfb] = 1e-20;
    }
    for (sfb = 0; sfb < PSFB12; sfb++) {
      ATH_psfb12[sfb] = 1e-20;
    }
  }

  /*  work in progress, don't rely on it too much
   */
  gfc.ATH.floor = f(10 * Math.log10(ATHmdct(cfg, -1)));
}

const payload_long = [-0.5, -0.25, f(-0.025), 0.5];
const payload_short = [-2.0, -1.0, f(-0.05), 0.5];

/************************************************************************/
/*  initialization for iteration_loop */
/************************************************************************/
export function iteration_init(gfc: LameInternalFlags): void {
  const cfg = gfc.cfg;
  const l3_side = gfc.l3_side;
  let adjust: number, db: number;
  let i: number;

  if (gfc.iteration_init_init === 0) {
    gfc.iteration_init_init = 1;

    l3_side.main_data_begin = 0;
    compute_ath(gfc);

    init_tables();

    huffman_init(gfc);

    /* long */
    db = f(cfg.adjust_bass_db + payload_long[0]);
    adjust = powf(10, f(db * F_0_1));
    for (i = 0; i <= 6; ++i) {
      gfc.sv_qnt.longfact[i] = adjust;
    }
    db = f(cfg.adjust_alto_db + payload_long[1]);
    adjust = powf(10, f(db * F_0_1));
    for (; i <= 13; ++i) {
      gfc.sv_qnt.longfact[i] = adjust;
    }
    db = f(cfg.adjust_treble_db + payload_long[2]);
    adjust = powf(10, f(db * F_0_1));
    for (; i <= 20; ++i) {
      gfc.sv_qnt.longfact[i] = adjust;
    }
    db = f(cfg.adjust_sfb21_db + payload_long[3]);
    adjust = powf(10, f(db * F_0_1));
    for (; i < SBMAX_l; ++i) {
      gfc.sv_qnt.longfact[i] = adjust;
    }

    /* short */
    db = f(cfg.adjust_bass_db + payload_short[0]);
    adjust = powf(10, f(db * F_0_1));
    for (i = 0; i <= 2; ++i) {
      gfc.sv_qnt.shortfact[i] = adjust;
    }
    db = f(cfg.adjust_alto_db + payload_short[1]);
    adjust = powf(10, f(db * F_0_1));
    for (; i <= 6; ++i) {
      gfc.sv_qnt.shortfact[i] = adjust;
    }
    db = f(cfg.adjust_treble_db + payload_short[2]);
    adjust = powf(10, f(db * F_0_1));
    for (; i <= 11; ++i) {
      gfc.sv_qnt.shortfact[i] = adjust;
    }
    db = f(cfg.adjust_sfb21_db + payload_short[3]);
    adjust = powf(10, f(db * F_0_1));
    for (; i < SBMAX_s; ++i) {
      gfc.sv_qnt.shortfact[i] = adjust;
    }
  }
}

/************************************************************************
 * allocate bits among 2 channels based on PE
 * mt 6/99
 * bugfixes rh 8/01: often allocated more than the allowed 4095 bits
 *
 * `pe` is the perceptual entropy of this granule, [ch]. Returns max_bits.
 ************************************************************************/
export function on_pe(
  gfc: LameInternalFlags,
  pe: Float32Array,
  targ_bits: Int32Array,
  mean_bits: number,
  cbr: number,
): number {
  const cfg = gfc.cfg;
  let bits: number;
  const add_bits = [0, 0];
  let ch: number;

  /* allocate targ_bits for granule */
  const r = ResvMaxBits(gfc, mean_bits, cbr);
  const tbits = r[0];
  let extra_bits = r[1];
  let max_bits = tbits + extra_bits; /* maximum allowed bits for this granule */
  if (max_bits > MAX_BITS_PER_GRANULE)
    /* hard limit per granule */
    max_bits = MAX_BITS_PER_GRANULE;

  for (bits = 0, ch = 0; ch < cfg.channels_out; ++ch) {
    /******************************************************************
     * allocate bits for each channel
     ******************************************************************/
    targ_bits[ch] = Math.min(MAX_BITS_PER_CHANNEL, (tbits / cfg.channels_out) | 0);

    add_bits[ch] = Math.trunc(f(targ_bits[ch] * pe[ch]) / 700.0 - targ_bits[ch]);

    /* at most increase bits by 1.5*average */
    const add_max = ((mean_bits * 3) / 4) | 0;
    if (add_bits[ch] > add_max) add_bits[ch] = add_max;
    if (add_bits[ch] < 0) add_bits[ch] = 0;

    if (add_bits[ch] + targ_bits[ch] > MAX_BITS_PER_CHANNEL)
      add_bits[ch] = Math.max(0, MAX_BITS_PER_CHANNEL - targ_bits[ch]);

    bits += add_bits[ch];
  }
  if (bits > extra_bits && bits > 0) {
    for (ch = 0; ch < cfg.channels_out; ++ch) {
      add_bits[ch] = ((extra_bits * add_bits[ch]) / bits) | 0;
    }
  }

  for (ch = 0; ch < cfg.channels_out; ++ch) {
    targ_bits[ch] += add_bits[ch];
    extra_bits -= add_bits[ch];
  }

  for (bits = 0, ch = 0; ch < cfg.channels_out; ++ch) {
    bits += targ_bits[ch];
  }
  if (bits > MAX_BITS_PER_GRANULE) {
    for (ch = 0; ch < cfg.channels_out; ++ch) {
      targ_bits[ch] *= MAX_BITS_PER_GRANULE;
      targ_bits[ch] = (targ_bits[ch] / bits) | 0;
    }
  }

  return max_bits;
}

export function reduce_side(targ_bits: Int32Array, ms_ener_ratio: number, mean_bits: number, max_bits: number): void {
  let move_bits: number;
  let fac: number;

  /*  ms_ener_ratio = 0:  allocate 66/33  mid/side  fac=.33
   *  ms_ener_ratio =.5:  allocate 50/50 mid/side   fac= 0 */
  /* 75/25 split is fac=.5 */
  fac = f((0.33 * (0.5 - ms_ener_ratio)) / 0.5);
  if (fac < 0) fac = 0;
  if (fac > 0.5) fac = 0.5;

  /* number of bits to move from side channel to mid channel */
  /*    move_bits = fac*targ_bits[1];  */
  move_bits = Math.trunc(fac * 0.5 * (targ_bits[0] + targ_bits[1]));

  if (move_bits > MAX_BITS_PER_CHANNEL - targ_bits[0]) {
    move_bits = MAX_BITS_PER_CHANNEL - targ_bits[0];
  }
  if (move_bits < 0) move_bits = 0;

  if (targ_bits[1] >= 125) {
    /* dont reduce side channel below 125 bits */
    if (targ_bits[1] - move_bits > 125) {
      /* if mid channel already has 2x more than average, dont bother */
      /* mean_bits = bits per granule (for both channels) */
      if (targ_bits[0] < mean_bits) targ_bits[0] += move_bits;
      targ_bits[1] -= move_bits;
    } else {
      targ_bits[0] += targ_bits[1] - 125;
      targ_bits[1] = 125;
    }
  }

  move_bits = targ_bits[0] + targ_bits[1];
  if (move_bits > max_bits) {
    targ_bits[0] = ((max_bits * targ_bits[0]) / move_bits) | 0;
    targ_bits[1] = ((max_bits * targ_bits[1]) / move_bits) | 0;
  }
}

const ATH_ADJ_O = f(90.30873362);
const ATH_ADJ_P = f(94.82444863);
const ATH_ADJ_10_O = f(10.0 / ATH_ADJ_O);

/**
 *  Robert Hegemann 2001-04-27:
 *  this adjusts the ATH, keeping the original noise floor
 *  affects the higher frequencies more than the lower ones
 */
export function athAdjust(a: number, x: number, athFloor: number, ATHfixpoint: number): number {
  /*  work in progress
   */
  const o = ATH_ADJ_O;
  const p = ATHfixpoint < 1 ? ATH_ADJ_P : ATHfixpoint;
  let u = f(FAST_LOG10_X(x, 10.0));
  const v = f(a * a);
  let w = 0.0;
  u = f(u - athFloor); /* undo scaling */
  if (v > F_1E_20) w = f(1 + FAST_LOG10_X(v, ATH_ADJ_10_O));
  if (w < 0) w = 0;
  u = f(u * w);
  u = f(u + f(f(athFloor + o) - p)); /* redo scaling */

  return powf(10, f(F_0_1 * u));
}

/*************************************************************************/
/*            calc_xmin                                                  */
/*************************************************************************/

/*
  Calculate the allowed distortion for each scalefactor band,
  as determined by the psychoacoustic model.
  xmin(sb) = ratio(sb) * en(sb) / bw(sb)

  returns number of sfb's with energy > ATH
*/
export function calc_xmin(gfc: LameInternalFlags, ratio: III_psy_ratio, cod_info: GrInfo, pxmin: Float32Array): number {
  const cfg = gfc.cfg;
  let sfb: number,
    gsfb: number,
    j = 0,
    ath_over = 0,
    k: number;
  const ATH = gfc.ATH;
  const xr = cod_info.xr;
  let max_nonzero: number;
  let pi = 0;

  for (gsfb = 0; gsfb < cod_info.psy_lmax; gsfb++) {
    let en0: number, xmin: number;
    let rh2: number, rh3: number;

    xmin = athAdjust(ATH.adjust_factor, ATH.l[gsfb], ATH.floor, cfg.ATHfixpoint);
    xmin = f(xmin * gfc.sv_qnt.longfact[gsfb]);
    const width = cod_info.width[gsfb];
    const rh1 = f(xmin / width);
    rh2 = F_DBL_EPSILON;
    en0 = 0.0;
    for (let l = 0; l < width; ++l) {
      const xa = xr[j++];
      const x2 = f(xa * xa);
      en0 = f(en0 + x2);
      rh2 = f(rh2 + (x2 < rh1 ? x2 : rh1));
    }
    if (en0 > xmin) ath_over++;

    if (en0 < xmin) {
      rh3 = en0;
    } else if (rh2 < xmin) {
      rh3 = xmin;
    } else {
      rh3 = rh2;
    }
    xmin = rh3;
    {
      const e = ratio.en.l[gsfb];
      if (e > F_1E_12) {
        let x = f(f(en0 * ratio.thm.l[gsfb]) / e);
        x = f(x * gfc.sv_qnt.longfact[gsfb]);
        if (xmin < x) xmin = x;
      }
    }
    xmin = f(xmin > DBL_EPSILON ? xmin : DBL_EPSILON);
    cod_info.energy_above_cutoff[gsfb] = en0 > f(xmin + F_1E_14) ? 1 : 0;
    pxmin[pi++] = xmin;
  } /* end of long block loop */

  /*use this function to determine the highest non-zero coeff */
  max_nonzero = 0;
  for (k = 575; k > 0; --k) {
    if (Math.abs(xr[k]) > F_1E_12) {
      max_nonzero = k;
      break;
    }
  }
  if (cod_info.block_type !== SHORT_TYPE) {
    /* NORM, START or STOP type, but not SHORT */
    max_nonzero |= 1; /* only odd numbers */
  } else {
    max_nonzero = (max_nonzero / 6) | 0; /* 3 short blocks */
    max_nonzero *= 6;
    max_nonzero += 5;
  }

  if (gfc.sv_qnt.sfb21_extra === 0 && cfg.samplerate_out < 44000) {
    const sfb_l = cfg.samplerate_out <= 8000 ? 17 : 21;
    const sfb_s = cfg.samplerate_out <= 8000 ? 9 : 12;
    let limit: number;
    if (cod_info.block_type !== SHORT_TYPE) {
      /* NORM, START or STOP type, but not SHORT */
      limit = gfc.scalefac_band.l[sfb_l] - 1;
    } else {
      limit = 3 * gfc.scalefac_band.s[sfb_s] - 1;
    }
    if (max_nonzero > limit) {
      max_nonzero = limit;
    }
  }
  cod_info.max_nonzero_coeff = max_nonzero;

  for (sfb = cod_info.sfb_smin; gsfb < cod_info.psymax; sfb++, gsfb += 3) {
    let tmpATH = athAdjust(ATH.adjust_factor, ATH.s[sfb], ATH.floor, cfg.ATHfixpoint);
    tmpATH = f(tmpATH * gfc.sv_qnt.shortfact[sfb]);

    const width = cod_info.width[gsfb];
    for (let b = 0; b < 3; b++) {
      let en0 = 0.0,
        xmin: number;
      let rh2: number, rh3: number;

      const rh1 = f(tmpATH / width);
      rh2 = F_DBL_EPSILON;
      for (let l = 0; l < width; ++l) {
        const xa = xr[j++];
        const x2 = f(xa * xa);
        en0 = f(en0 + x2);
        rh2 = f(rh2 + (x2 < rh1 ? x2 : rh1));
      }
      if (en0 > tmpATH) ath_over++;

      if (en0 < tmpATH) {
        rh3 = en0;
      } else if (rh2 < tmpATH) {
        rh3 = tmpATH;
      } else {
        rh3 = rh2;
      }
      xmin = rh3;
      {
        const e = ratio.en.s[sfb * 3 + b];
        if (e > F_1E_12) {
          let x = f(f(en0 * ratio.thm.s[sfb * 3 + b]) / e);
          x = f(x * gfc.sv_qnt.shortfact[sfb]);
          if (xmin < x) xmin = x;
        }
      }
      xmin = f(xmin > DBL_EPSILON ? xmin : DBL_EPSILON);
      cod_info.energy_above_cutoff[gsfb + b] = en0 > f(xmin + F_1E_14) ? 1 : 0;
      pxmin[pi++] = xmin;
    } /* b */
    if (cfg.use_temporal_masking_effect) {
      const decay = gfc.cd_psy!.decay;
      if (pxmin[pi - 3] > pxmin[pi - 3 + 1])
        pxmin[pi - 3 + 1] = f(pxmin[pi - 3 + 1] + f(f(pxmin[pi - 3] - pxmin[pi - 3 + 1]) * decay));
      if (pxmin[pi - 3 + 1] > pxmin[pi - 3 + 2])
        pxmin[pi - 3 + 2] = f(pxmin[pi - 3 + 2] + f(f(pxmin[pi - 3 + 1] - pxmin[pi - 3 + 2]) * decay));
    }
  } /* end of short block sfb loop */

  return ath_over;
}

/** Sum of squared quantization errors of `l` pairs of lines starting at `startline`; returns [noise, next line]. */
let cnc_j = 0;
function calc_noise_core_c(cod_info: GrInfo, startline: number, l: number, step: number): number {
  let noise = 0;
  let j = startline;
  const ix = cod_info.l3_enc;
  const xr = cod_info.xr;

  if (j > cod_info.count1) {
    while (l--) {
      let temp: number;
      temp = xr[j];
      j++;
      noise = f(noise + f(temp * temp));
      temp = xr[j];
      j++;
      noise = f(noise + f(temp * temp));
    }
  } else if (j > cod_info.big_values) {
    while (l--) {
      let temp: number;
      temp = f(Math.abs(xr[j]) - (ix[j] ? step : 0));
      j++;
      noise = f(noise + f(temp * temp));
      temp = f(Math.abs(xr[j]) - (ix[j] ? step : 0));
      j++;
      noise = f(noise + f(temp * temp));
    }
  } else {
    while (l--) {
      let temp: number;
      temp = f(Math.abs(xr[j]) - f(pow43[ix[j]] * step));
      j++;
      noise = f(noise + f(temp * temp));
      temp = f(Math.abs(xr[j]) - f(pow43[ix[j]] * step));
      j++;
      noise = f(noise + f(temp * temp));
    }
  }

  cnc_j = j;
  return noise;
}

/*************************************************************************/
/*            calc_noise                                                 */
/*************************************************************************/

/* -oo dB  =>  -1.00 */
/* - 6 dB  =>  -0.97 */
/* - 3 dB  =>  -0.80 */
/* - 2 dB  =>  -0.64 */
/* - 1 dB  =>  -0.38 */
/*   0 dB  =>   0.00 */
/* + 1 dB  =>  +0.49 */
/* + 2 dB  =>  +1.06 */
/* + 3 dB  =>  +1.68 */
/* + 6 dB  =>  +3.69 */
/* +10 dB  =>  +6.45 */

export function calc_noise(
  cod_info: GrInfo,
  l3_xmin: Float32Array,
  distort: Float32Array,
  res: CalcNoiseResult,
  prev_noise: CalcNoiseData | null,
): number {
  let sfb: number,
    l: number,
    over = 0;
  let over_noise_db = 0;
  let tot_noise_db = 0; /*    0 dB relative to masking */
  let max_noise = -20.0; /* -200 dB relative to masking */
  let j = 0;
  const scalefac = cod_info.scalefac;

  res.over_SSD = 0;

  for (sfb = 0; sfb < cod_info.psymax; sfb++) {
    const s =
      cod_info.global_gain -
      ((scalefac[sfb] + (cod_info.preflag ? pretab[sfb] : 0)) << (cod_info.scalefac_scale + 1)) -
      cod_info.subblock_gain[cod_info.window[sfb]] * 8;
    const r_l3_xmin = f(1 / l3_xmin[sfb]);
    let distort_: number;
    let noise: number;

    if (prev_noise && prev_noise.step[sfb] === s) {
      /* use previously computed values */
      j += cod_info.width[sfb];
      distort_ = f(r_l3_xmin * prev_noise.noise[sfb]);

      noise = prev_noise.noise_log[sfb];
    } else {
      const step = pow20[s + Q_MAX2];
      l = cod_info.width[sfb] >> 1;

      if (j + cod_info.width[sfb] > cod_info.max_nonzero_coeff) {
        const usefullsize = cod_info.max_nonzero_coeff - j + 1;

        if (usefullsize > 0) l = usefullsize >> 1;
        else l = 0;
      }

      noise = calc_noise_core_c(cod_info, j, l, step);
      j = cnc_j;

      if (prev_noise) {
        /* save noise values */
        prev_noise.step[sfb] = s;
        prev_noise.noise[sfb] = noise;
      }

      distort_ = f(r_l3_xmin * noise);

      /* multiplying here is adding in dB, but can overflow */
      noise = f(FAST_LOG10(distort_ > F_1E_20 ? distort_ : F_1E_20));

      if (prev_noise) {
        /* save noise values */
        prev_noise.noise_log[sfb] = noise;
      }
    }
    distort[sfb] = distort_;

    if (prev_noise) {
      /* save noise values */
      prev_noise.global_gain = cod_info.global_gain;
    }

    /*tot_noise *= Max(noise, 1E-20); */
    tot_noise_db = f(tot_noise_db + noise);

    if (noise > 0.0) {
      let tmp = Math.trunc(f(noise * 10) + 0.5);
      if (tmp < 1) tmp = 1;
      res.over_SSD += tmp * tmp;

      over++;
      /* multiplying here is adding in dB -but can overflow */
      /*over_noise *= noise; */
      over_noise_db = f(over_noise_db + noise);
    }
    max_noise = max_noise > noise ? max_noise : noise;
  }

  res.over_count = over;
  res.tot_noise = tot_noise_db;
  res.over_noise = over_noise_db;
  res.max_noise = max_noise;

  return over;
}
