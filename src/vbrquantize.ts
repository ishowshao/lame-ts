// Port of libmp3lame/vbrquantize.c - MP3 VBR quantization (the "vbr new" / mtrh algorithm).
//
// This is the portable C path (TAKEHIRO_IEEE754_HACK undefined): quantization truncates
// towards zero and uses the adj43[] rounding table.

import {
  f,
  IXMAX_VAL,
  LARGE_BITS,
  MAX_BITS_PER_CHANNEL,
  MAX_BITS_PER_GRANULE,
  Q_MAX2,
  SFBMAX,
  SHORT_TYPE,
} from './constants.ts';
import { adj43, ipow20, pow20, pow43 } from './quantize_pvt.ts';
import { pretab } from './tables.ts';
import { best_huffman_divide, best_scalefac_store, noquant_count_bits, scale_bitcount } from './takehiro.ts';
import type { GrInfo, LameInternalFlags } from './types.ts';
import { log10f } from './util.ts';

type alloc_sf_f = (that: Algo, vbrsf: Int32Array, vbrsfmin: Int32Array, vbrmax: number) => void;
type find_sf_f = (
  xr: Float32Array,
  xr34: Float32Array,
  o: number,
  l3_xmin: number,
  bw: number,
  sf_min: number,
) => number;

class Algo {
  alloc!: alloc_sf_f;
  find!: find_sf_f;
  xr34orig!: Float32Array;
  gfc!: LameInternalFlags;
  cod_info!: GrInfo;
  mingain_l = 0;
  mingain_s = new Int32Array(3);
}

function vec_max_c(xr34: Float32Array, o: number, bw: number): number {
  let xfsf = 0;
  const end = o + bw;
  for (let i = o; i < end; i++) {
    if (xfsf < xr34[i]) xfsf = xr34[i];
  }
  return xfsf;
}

function find_lowest_scalefac(xr34: number): number {
  let sf_ok = 255;
  let sf = 128,
    delsf = 64;
  const ixmax_val = IXMAX_VAL;
  for (let i = 0; i < 8; ++i) {
    const xfsf = f(ipow20[sf] * xr34);
    if (xfsf <= ixmax_val) {
      sf_ok = sf;
      sf = (sf - delsf) & 0xff;
    } else {
      sf = (sf + delsf) & 0xff;
    }
    delsf >>= 1;
  }
  return sf_ok;
}

/* x <= IXMAX_VAL is guaranteed by the callers */
function k_34(x: number): number {
  return (f(x + adj43[x | 0]) | 0);
}

/*  do call the calc_sfb_noise_* functions only with sf values
 *  for which holds: sfpow34*xr34 <= IXMAX_VAL
 */
function calc_sfb_noise_x34(xr: Float32Array, xr34: Float32Array, o: number, bw: number, sf: number): number {
  const sfpow = pow20[sf + Q_MAX2]; /*pow(2.0,sf/4.0); */
  const sfpow34 = ipow20[sf]; /*pow(sfpow,-3.0/4.0); */

  let xfsf = 0;
  let i = bw >>> 2;
  const remaining = bw & 0x03;
  let p = o;
  let x0: number, x1: number, x2: number, x3: number;

  while (i-- > 0) {
    x0 = f(Math.abs(xr[p]) - f(sfpow * pow43[k_34(f(sfpow34 * xr34[p]))]));
    x1 = f(Math.abs(xr[p + 1]) - f(sfpow * pow43[k_34(f(sfpow34 * xr34[p + 1]))]));
    x2 = f(Math.abs(xr[p + 2]) - f(sfpow * pow43[k_34(f(sfpow34 * xr34[p + 2]))]));
    x3 = f(Math.abs(xr[p + 3]) - f(sfpow * pow43[k_34(f(sfpow34 * xr34[p + 3]))]));
    xfsf = f(xfsf + f(f(f(x0 * x0) + f(x1 * x1)) + f(f(x2 * x2) + f(x3 * x3))));
    p += 4;
  }
  if (remaining) {
    x0 = x1 = x2 = 0;
    if (remaining >= 3) x2 = f(Math.abs(xr[p + 2]) - f(sfpow * pow43[k_34(f(sfpow34 * xr34[p + 2]))]));
    if (remaining >= 2) x1 = f(Math.abs(xr[p + 1]) - f(sfpow * pow43[k_34(f(sfpow34 * xr34[p + 1]))]));
    x0 = f(Math.abs(xr[p]) - f(sfpow * pow43[k_34(f(sfpow34 * xr34[p]))]));
    xfsf = f(xfsf + f(f(f(x0 * x0) + f(x1 * x1)) + f(x2 * x2)));
  }
  return xfsf;
}

const did_it_valid = new Uint8Array(256);
const did_it_value = new Float32Array(256);

function tri_calc_sfb_noise_x34(
  xr: Float32Array,
  xr34: Float32Array,
  o: number,
  l3_xmin: number,
  bw: number,
  sf: number,
): number {
  if (did_it_valid[sf] === 0) {
    did_it_valid[sf] = 1;
    did_it_value[sf] = calc_sfb_noise_x34(xr, xr34, o, bw, sf);
  }
  if (l3_xmin < did_it_value[sf]) {
    return 1;
  }
  if (sf < 255) {
    const sf_x = sf + 1;
    if (did_it_valid[sf_x] === 0) {
      did_it_valid[sf_x] = 1;
      did_it_value[sf_x] = calc_sfb_noise_x34(xr, xr34, o, bw, sf_x);
    }
    if (l3_xmin < did_it_value[sf_x]) {
      return 1;
    }
  }
  if (sf > 0) {
    const sf_x = sf - 1;
    if (did_it_valid[sf_x] === 0) {
      did_it_valid[sf_x] = 1;
      did_it_value[sf_x] = calc_sfb_noise_x34(xr, xr34, o, bw, sf_x);
    }
    if (l3_xmin < did_it_value[sf_x]) {
      return 1;
    }
  }
  return 0;
}

const CALC_SCALEFAC_C = f(5.799142446); /* 10 * 10^(2/3) * log10(4/3) */

/**
 *  Robert Hegemann 2001-05-01
 *  calculates quantization step size determined by allowed masking
 */
function calc_scalefac(l3_xmin: number, bw: number): number {
  return 210 + Math.trunc(f(f(CALC_SCALEFAC_C * log10f(f(l3_xmin / bw))) - 0.5));
}

function guess_scalefac_x34(
  _xr: Float32Array,
  _xr34: Float32Array,
  _o: number,
  l3_xmin: number,
  bw: number,
  sf_min: number,
): number {
  const guess = calc_scalefac(l3_xmin, bw);
  if (guess < sf_min) return sf_min;
  if (guess >= 255) return 255;
  return guess;
}

/* the find_scalefac* routines calculate
 * a quantization step size which would
 * introduce as much noise as is allowed.
 * The larger the step size the more
 * quantization noise we'll get. The
 * scalefactors are there to lower the
 * global step size, allowing limited
 * differences in quantization step sizes
 * per band (shaping the noise).
 */
function find_scalefac_x34(
  xr: Float32Array,
  xr34: Float32Array,
  o: number,
  l3_xmin: number,
  bw: number,
  sf_min: number,
): number {
  let sf = 128,
    sf_ok = 255,
    delsf = 128,
    seen_good_one = 0;
  did_it_valid.fill(0);
  for (let i = 0; i < 8; ++i) {
    delsf >>= 1;
    if (sf <= sf_min) {
      sf += delsf;
    } else {
      const bad = tri_calc_sfb_noise_x34(xr, xr34, o, l3_xmin, bw, sf);
      if (bad) {
        /* distortion.  try a smaller scalefactor */
        sf -= delsf;
      } else {
        sf_ok = sf;
        sf += delsf;
        seen_good_one = 1;
      }
    }
  }
  /*  returning a scalefac without distortion, if possible
   */
  if (seen_good_one > 0) {
    sf = sf_ok;
  }
  if (sf <= sf_min) {
    sf = sf_min;
  }
  return sf;
}

/***********************************************************************
 *
 *      calc_short_block_vbr_sf()
 *      calc_long_block_vbr_sf()
 *
 *  Mark Taylor 2000-??-??
 *  Robert Hegemann 2000-10-25 made functions of it
 *
 ***********************************************************************/

/* a variation for vbr-mtrh */
function block_sf(that: Algo, l3_xmin: Float32Array, vbrsf: Int32Array, vbrsfmin: Int32Array): number {
  let max_xr34: number;
  const xr = that.cod_info.xr;
  const xr34_orig = that.xr34orig;
  const width = that.cod_info.width;
  const energy_above_cutoff = that.cod_info.energy_above_cutoff;
  const max_nonzero_coeff = that.cod_info.max_nonzero_coeff;
  let maxsf = 0;
  let sfb = 0,
    m_o = -1;
  let j = 0,
    i = 0;
  const psymax = that.cod_info.psymax;

  that.mingain_l = 0;
  that.mingain_s[0] = 0;
  that.mingain_s[1] = 0;
  that.mingain_s[2] = 0;
  while (j <= max_nonzero_coeff) {
    const w = width[sfb];
    const m = max_nonzero_coeff - j + 1;
    let l = w;
    let m2: number;
    if (l > m) {
      l = m;
    }
    max_xr34 = vec_max_c(xr34_orig, j, l);

    const m1 = find_lowest_scalefac(max_xr34);
    vbrsfmin[sfb] = m1;
    if (that.mingain_l < m1) {
      that.mingain_l = m1;
    }
    if (that.mingain_s[i] < m1) {
      that.mingain_s[i] = m1;
    }
    if (++i > 2) {
      i = 0;
    }
    if (sfb < psymax && w > 2) {
      /* mpeg2.5 at 8 kHz doesn't use all scalefactors, unused have width 2 */
      if (energy_above_cutoff[sfb]) {
        m2 = that.find(xr, xr34_orig, j, l3_xmin[sfb], l, m1);
        if (maxsf < m2) {
          maxsf = m2;
        }
        if (m_o < m2 && m2 < 255) {
          m_o = m2;
        }
      } else {
        m2 = 255;
        maxsf = 255;
      }
    } else {
      if (maxsf < m1) {
        maxsf = m1;
      }
      m2 = maxsf;
    }
    vbrsf[sfb] = m2;
    ++sfb;
    j += w;
  }
  for (; sfb < SFBMAX; ++sfb) {
    vbrsf[sfb] = maxsf;
    vbrsfmin[sfb] = 0;
  }
  if (m_o > -1) {
    maxsf = m_o;
    for (sfb = 0; sfb < SFBMAX; ++sfb) {
      if (vbrsf[sfb] === 255) {
        vbrsf[sfb] = m_o;
      }
    }
  }
  return maxsf;
}

/***********************************************************************
 *
 *  quantize xr34 based on scalefactors
 *
 *  block_xr34
 *
 *  Mark Taylor 2000-??-??
 *  Robert Hegemann 2000-10-20 made functions of them
 *
 ***********************************************************************/

function quantize_x34(that: Algo): void {
  const xr34_orig = that.xr34orig;
  const cod_info = that.cod_info;
  const ifqstep = cod_info.scalefac_scale === 0 ? 2 : 4;
  const l3 = cod_info.l3_enc;
  let j = 0,
    sfb = 0;
  let p = 0;
  const max_nonzero_coeff = cod_info.max_nonzero_coeff;

  while (j <= max_nonzero_coeff) {
    const s =
      (cod_info.scalefac[sfb] + (cod_info.preflag ? pretab[sfb] : 0)) * ifqstep +
      cod_info.subblock_gain[cod_info.window[sfb]] * 8;
    const sfac = (cod_info.global_gain - s) & 0xff;
    const sfpow34 = ipow20[sfac];
    const w = cod_info.width[sfb];
    const m = max_nonzero_coeff - j + 1;

    j += w;
    ++sfb;

    const n = w <= m ? w : m;
    const end = p + n;
    for (; p < end; p++) {
      l3[p] = k_34(f(sfpow34 * xr34_orig[p]));
    }
  }
}

const max_range_short = new Uint8Array([
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 0, 0, 0,
]);

const max_range_long = new Uint8Array([15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 0]);

const max_range_long_lsf_pretab = new Uint8Array([7, 7, 7, 7, 7, 7, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/*
    sfb=0..5  scalefac < 16
    sfb>5     scalefac < 8

    ifqstep = ( cod_info->scalefac_scale == 0 ) ? 2 : 4;
    ol_sf =  (cod_info->global_gain-210.0);
    ol_sf -= 8*cod_info->subblock_gain[i];
    ol_sf -= ifqstep*scalefac[gr][ch].s[sfb][i];
*/

function set_subblock_gain(cod_info: GrInfo, mingain_s: Int32Array, sf: Int32Array): void {
  const maxrange1 = 15,
    maxrange2 = 7;
  const ifqstepShift = cod_info.scalefac_scale === 0 ? 1 : 2;
  const sbg = cod_info.subblock_gain;
  const psymax = cod_info.psymax;
  let psydiv = 18;
  let sfb: number, i: number;
  let min_sbg = 7;

  if (psydiv > psymax) {
    psydiv = psymax;
  }
  for (i = 0; i < 3; ++i) {
    let maxsf1 = 0,
      maxsf2 = 0,
      minsf = 1000;
    /* see if we should use subblock gain */
    for (sfb = i; sfb < psydiv; sfb += 3) {
      /* part 1 */
      const v = -sf[sfb];
      if (maxsf1 < v) {
        maxsf1 = v;
      }
      if (minsf > v) {
        minsf = v;
      }
    }
    for (; sfb < SFBMAX; sfb += 3) {
      /* part 2 */
      const v = -sf[sfb];
      if (maxsf2 < v) {
        maxsf2 = v;
      }
      if (minsf > v) {
        minsf = v;
      }
    }

    /* boost subblock gain as little as possible so we can
     * reach maxsf1 with scalefactors
     * 8*sbg >= maxsf1
     */
    {
      const m1 = maxsf1 - (maxrange1 << ifqstepShift);
      const m2 = maxsf2 - (maxrange2 << ifqstepShift);

      maxsf1 = m1 > m2 ? m1 : m2;
    }
    if (minsf > 0) {
      sbg[i] = minsf >> 3;
    } else {
      sbg[i] = 0;
    }
    if (maxsf1 > 0) {
      const m1 = sbg[i];
      const m2 = (maxsf1 + 7) >> 3;
      sbg[i] = m1 > m2 ? m1 : m2;
    }
    if (sbg[i] > 0 && mingain_s[i] > cod_info.global_gain - sbg[i] * 8) {
      sbg[i] = (cod_info.global_gain - mingain_s[i]) >> 3;
    }
    if (sbg[i] > 7) {
      sbg[i] = 7;
    }
    if (min_sbg > sbg[i]) {
      min_sbg = sbg[i];
    }
  }
  const sbg0 = sbg[0] * 8;
  const sbg1 = sbg[1] * 8;
  const sbg2 = sbg[2] * 8;
  for (sfb = 0; sfb < SFBMAX; sfb += 3) {
    sf[sfb + 0] += sbg0;
    sf[sfb + 1] += sbg1;
    sf[sfb + 2] += sbg2;
  }
  if (min_sbg > 0) {
    for (i = 0; i < 3; ++i) {
      sbg[i] -= min_sbg;
    }
    cod_info.global_gain -= min_sbg * 8;
  }
}

/*
	  ifqstep = ( cod_info->scalefac_scale == 0 ) ? 2 : 4;
	  ol_sf =  (cod_info->global_gain-210.0);
	  ol_sf -= ifqstep*scalefac[gr][ch].l[sfb];
	  if (cod_info->preflag && sfb>=11)
	  ol_sf -= ifqstep*pretab[sfb];
*/
function set_scalefacs(cod_info: GrInfo, vbrsfmin: Int32Array, sf: Int32Array, max_range: Uint8Array): void {
  const ifqstep = cod_info.scalefac_scale === 0 ? 2 : 4;
  const ifqstepShift = cod_info.scalefac_scale === 0 ? 1 : 2;
  const scalefac = cod_info.scalefac;
  const sfbmax = cod_info.sfbmax;
  let sfb: number;
  const sbg = cod_info.subblock_gain;
  const window = cod_info.window;
  const preflag = cod_info.preflag;

  if (preflag) {
    for (sfb = 11; sfb < sfbmax; ++sfb) {
      sf[sfb] += pretab[sfb] * ifqstep;
    }
  }
  for (sfb = 0; sfb < sfbmax; ++sfb) {
    const gain = cod_info.global_gain - sbg[window[sfb]] * 8 - (preflag ? pretab[sfb] : 0) * ifqstep;

    if (sf[sfb] < 0) {
      const m = gain - vbrsfmin[sfb];
      /* ifqstep*scalefac >= -sf[sfb], so round UP */
      scalefac[sfb] = (ifqstep - 1 - sf[sfb]) >> ifqstepShift;

      if (scalefac[sfb] > max_range[sfb]) {
        scalefac[sfb] = max_range[sfb];
      }
      if (scalefac[sfb] > 0 && scalefac[sfb] << ifqstepShift > m) {
        scalefac[sfb] = m >> ifqstepShift;
      }
    } else {
      scalefac[sfb] = 0;
    }
  }
  for (; sfb < SFBMAX; ++sfb) {
    scalefac[sfb] = 0; /* sfb21 */
  }
}

const sf_temp = new Int32Array(SFBMAX);

/******************************************************************
 *
 *  short block scalefacs
 *
 ******************************************************************/

function short_block_constrain(that: Algo, vbrsf: Int32Array, vbrsfmin: Int32Array, vbrmax: number): void {
  const cod_info = that.cod_info;
  const cfg = that.gfc.cfg;
  const maxminsfb = that.mingain_l;
  let mover: number,
    maxover0 = 0,
    maxover1 = 0,
    delta = 0;
  let v: number, v0: number, v1: number;
  let sfb: number;
  const psymax = cod_info.psymax;

  for (sfb = 0; sfb < psymax; ++sfb) {
    v = vbrmax - vbrsf[sfb];
    if (delta < v) {
      delta = v;
    }
    v0 = v - (4 * 14 + 2 * max_range_short[sfb]);
    v1 = v - (4 * 14 + 4 * max_range_short[sfb]);
    if (maxover0 < v0) {
      maxover0 = v0;
    }
    if (maxover1 < v1) {
      maxover1 = v1;
    }
  }
  if (cfg.noise_shaping === 2) {
    /* allow scalefac_scale=1 */
    mover = maxover0 < maxover1 ? maxover0 : maxover1;
  } else {
    mover = maxover0;
  }
  if (delta > mover) {
    delta = mover;
  }
  vbrmax -= delta;
  maxover0 -= mover;
  maxover1 -= mover;

  if (maxover0 === 0) {
    cod_info.scalefac_scale = 0;
  } else if (maxover1 === 0) {
    cod_info.scalefac_scale = 1;
  }
  if (vbrmax < maxminsfb) {
    vbrmax = maxminsfb;
  }
  cod_info.global_gain = vbrmax;

  if (cod_info.global_gain < 0) {
    cod_info.global_gain = 0;
  } else if (cod_info.global_gain > 255) {
    cod_info.global_gain = 255;
  }
  for (sfb = 0; sfb < SFBMAX; ++sfb) {
    sf_temp[sfb] = vbrsf[sfb] - vbrmax;
  }
  set_subblock_gain(cod_info, that.mingain_s, sf_temp);
  set_scalefacs(cod_info, vbrsfmin, sf_temp, max_range_short);
}

/******************************************************************
 *
 *  long block scalefacs
 *
 ******************************************************************/

function long_block_constrain(that: Algo, vbrsf: Int32Array, vbrsfmin: Int32Array, vbrmax: number): void {
  const cod_info = that.cod_info;
  const cfg = that.gfc.cfg;
  let max_rangep: Uint8Array;
  const maxminsfb = that.mingain_l;
  let sfb: number;
  let maxover0: number,
    maxover1: number,
    maxover0p: number,
    maxover1p: number,
    mover: number,
    delta = 0;
  let v: number,
    v0: number,
    v1: number,
    v0p: number,
    v1p: number,
    vm0p = 1,
    vm1p = 1;
  const psymax = cod_info.psymax;

  max_rangep = cfg.mode_gr === 2 ? max_range_long : max_range_long_lsf_pretab;

  maxover0 = 0;
  maxover1 = 0;
  maxover0p = 0; /* pretab */
  maxover1p = 0; /* pretab */

  for (sfb = 0; sfb < psymax; ++sfb) {
    v = vbrmax - vbrsf[sfb];
    if (delta < v) {
      delta = v;
    }
    v0 = v - 2 * max_range_long[sfb];
    v1 = v - 4 * max_range_long[sfb];
    v0p = v - 2 * (max_rangep[sfb] + pretab[sfb]);
    v1p = v - 4 * (max_rangep[sfb] + pretab[sfb]);
    if (maxover0 < v0) {
      maxover0 = v0;
    }
    if (maxover1 < v1) {
      maxover1 = v1;
    }
    if (maxover0p < v0p) {
      maxover0p = v0p;
    }
    if (maxover1p < v1p) {
      maxover1p = v1p;
    }
  }
  if (vm0p === 1) {
    let gain = vbrmax - maxover0p;
    if (gain < maxminsfb) {
      gain = maxminsfb;
    }
    for (sfb = 0; sfb < psymax; ++sfb) {
      const a = gain - vbrsfmin[sfb] - 2 * pretab[sfb];
      if (a <= 0) {
        vm0p = 0;
        vm1p = 0;
        break;
      }
    }
  }
  if (vm1p === 1) {
    let gain = vbrmax - maxover1p;
    if (gain < maxminsfb) {
      gain = maxminsfb;
    }
    for (sfb = 0; sfb < psymax; ++sfb) {
      const b = gain - vbrsfmin[sfb] - 4 * pretab[sfb];
      if (b <= 0) {
        vm1p = 0;
        break;
      }
    }
  }
  if (vm0p === 0) {
    maxover0p = maxover0;
  }
  if (vm1p === 0) {
    maxover1p = maxover1;
  }
  if (cfg.noise_shaping !== 2) {
    maxover1 = maxover0;
    maxover1p = maxover0p;
  }
  mover = Math.min(maxover0, maxover0p, maxover1, maxover1p);

  if (delta > mover) {
    delta = mover;
  }
  vbrmax -= delta;
  if (vbrmax < maxminsfb) {
    vbrmax = maxminsfb;
  }
  maxover0 -= mover;
  maxover0p -= mover;
  maxover1 -= mover;
  maxover1p -= mover;

  if (maxover0 === 0) {
    cod_info.scalefac_scale = 0;
    cod_info.preflag = 0;
    max_rangep = max_range_long;
  } else if (maxover0p === 0) {
    cod_info.scalefac_scale = 0;
    cod_info.preflag = 1;
  } else if (maxover1 === 0) {
    cod_info.scalefac_scale = 1;
    cod_info.preflag = 0;
    max_rangep = max_range_long;
  } else if (maxover1p === 0) {
    cod_info.scalefac_scale = 1;
    cod_info.preflag = 1;
  } else {
    throw new Error('lame-ts: internal error in long_block_constrain'); /* this should not happen */
  }
  cod_info.global_gain = vbrmax;
  if (cod_info.global_gain < 0) {
    cod_info.global_gain = 0;
  } else if (cod_info.global_gain > 255) {
    cod_info.global_gain = 255;
  }
  for (sfb = 0; sfb < SFBMAX; ++sfb) {
    sf_temp[sfb] = vbrsf[sfb] - vbrmax;
  }
  set_scalefacs(cod_info, vbrsfmin, sf_temp, max_rangep);
}

function bitcount(that: Algo): void {
  const rc = scale_bitcount(that.gfc, that.cod_info);

  if (rc === 0) {
    return;
  }
  /*  this should not happen due to the way the scalefactors are selected  */
  throw new Error('INTERNAL ERROR IN VBR NEW CODE (986), please send bug report');
}

function quantizeAndCountBits(that: Algo): number {
  quantize_x34(that);
  that.cod_info.part2_3_length = noquant_count_bits(that.gfc, that.cod_info, null);
  return that.cod_info.part2_3_length;
}

const tgs_sftemp = new Int32Array(SFBMAX);

function tryGlobalStepsize(that: Algo, sfwork: Int32Array, vbrsfmin: Int32Array, delta: number): number {
  const xrpow_max = that.cod_info.xrpow_max;
  const sftemp = tgs_sftemp;
  let gain: number,
    vbrmax = 0;
  for (let i = 0; i < SFBMAX; ++i) {
    gain = sfwork[i] + delta;
    if (gain < vbrsfmin[i]) {
      gain = vbrsfmin[i];
    }
    if (gain > 255) {
      gain = 255;
    }
    if (vbrmax < gain) {
      vbrmax = gain;
    }
    sftemp[i] = gain;
  }
  that.alloc(that, sftemp, vbrsfmin, vbrmax);
  bitcount(that);
  const nbits = quantizeAndCountBits(that);
  that.cod_info.xrpow_max = xrpow_max;
  return nbits;
}

function searchGlobalStepsizeMax(that: Algo, sfwork: Int32Array, vbrsfmin: Int32Array, target: number): void {
  const cod_info = that.cod_info;
  const gain = cod_info.global_gain;
  let curr = gain;
  let gain_ok = 1024;
  let nbits = LARGE_BITS;
  let l = gain,
    r = 512;

  while (l <= r) {
    curr = (l + r) >> 1;
    nbits = tryGlobalStepsize(that, sfwork, vbrsfmin, curr - gain);
    if (nbits === 0 || nbits + cod_info.part2_length < target) {
      r = curr - 1;
      gain_ok = curr;
    } else {
      l = curr + 1;
      if (gain_ok === 1024) {
        gain_ok = curr;
      }
    }
  }
  if (gain_ok !== curr) {
    curr = gain_ok;
    nbits = tryGlobalStepsize(that, sfwork, vbrsfmin, curr - gain);
  }
}

function sfDepth(sfwork: Int32Array): number {
  let m = 0;
  for (let i = 0; i < SFBMAX; ++i) {
    const di = 255 - sfwork[i];
    if (m < di) {
      m = di;
    }
  }
  return m;
}

function cutDistribution(sfwork: Int32Array, sf_out: Int32Array, cut: number): void {
  for (let i = 0; i < SFBMAX; ++i) {
    const x = sfwork[i];
    sf_out[i] = x < cut ? x : cut;
  }
}

function flattenDistribution(sfwork: Int32Array, sf_out: Int32Array, dm: number, k: number, p: number): number {
  let x: number,
    sfmax = 0;
  if (dm > 0) {
    for (let i = 0; i < SFBMAX; ++i) {
      const di = p - sfwork[i];
      x = sfwork[i] + (((k * di) / dm) | 0);
      if (x < 0) {
        x = 0;
      } else {
        if (x > 255) {
          x = 255;
        }
      }
      sf_out[i] = x;
      if (sfmax < x) {
        sfmax = x;
      }
    }
  } else {
    for (let i = 0; i < SFBMAX; ++i) {
      x = sfwork[i];
      sf_out[i] = x;
      if (sfmax < x) {
        sfmax = x;
      }
    }
  }
  return sfmax;
}

function tryThatOne(that: Algo, sftemp: Int32Array, vbrsfmin: Int32Array, vbrmax: number): number {
  const xrpow_max = that.cod_info.xrpow_max;
  let nbits: number;
  that.alloc(that, sftemp, vbrsfmin, vbrmax);
  bitcount(that);
  nbits = quantizeAndCountBits(that);
  nbits += that.cod_info.part2_length;
  that.cod_info.xrpow_max = xrpow_max;
  return nbits;
}

const oob_wrk = new Int32Array(SFBMAX);

function outOfBitsStrategy(that: Algo, sfwork: Int32Array, vbrsfmin: Int32Array, target: number): void {
  const wrk = oob_wrk;
  const dm = sfDepth(sfwork);
  const p = that.cod_info.global_gain;
  let nbits: number;

  /* PART 1 */
  {
    let bi = (dm / 2) | 0;
    let bi_ok = -1;
    let bu = 0;
    let bo = dm;
    for (;;) {
      const sfmax = flattenDistribution(sfwork, wrk, dm, bi, p);
      nbits = tryThatOne(that, wrk, vbrsfmin, sfmax);
      if (nbits <= target) {
        bi_ok = bi;
        bo = bi - 1;
      } else {
        bu = bi + 1;
      }
      if (bu <= bo) {
        bi = ((bu + bo) / 2) | 0;
      } else {
        break;
      }
    }
    if (bi_ok >= 0) {
      if (bi !== bi_ok) {
        const sfmax = flattenDistribution(sfwork, wrk, dm, bi_ok, p);
        nbits = tryThatOne(that, wrk, vbrsfmin, sfmax);
      }
      return;
    }
  }

  /* PART 2: */
  {
    let bi = ((255 + p) / 2) | 0;
    let bi_ok = -1;
    let bu = p;
    let bo = 255;
    for (;;) {
      const sfmax = flattenDistribution(sfwork, wrk, dm, dm, bi);
      nbits = tryThatOne(that, wrk, vbrsfmin, sfmax);
      if (nbits <= target) {
        bi_ok = bi;
        bo = bi - 1;
      } else {
        bu = bi + 1;
      }
      if (bu <= bo) {
        bi = ((bu + bo) / 2) | 0;
      } else {
        break;
      }
    }
    if (bi_ok >= 0) {
      if (bi !== bi_ok) {
        const sfmax = flattenDistribution(sfwork, wrk, dm, dm, bi_ok);
        nbits = tryThatOne(that, wrk, vbrsfmin, sfmax);
      }
      return;
    }
  }

  /* fall back to old code, likely to be never called */
  searchGlobalStepsizeMax(that, wrk, vbrsfmin, target);
}

function reduce_bit_usage(gfc: LameInternalFlags, gr: number, ch: number): number {
  const cfg = gfc.cfg;
  const cod_info = gfc.l3_side.tt[gr][ch];
  /*  try some better scalefac storage
   */
  best_scalefac_store(gfc, gr, ch, gfc.l3_side);

  /*  best huffman_divide may save some bits too
   */
  if (cfg.use_best_huffman === 1) best_huffman_divide(gfc, cod_info);
  return cod_info.part2_3_length + cod_info.part2_length;
}

function mk2x2<T>(fn: () => T): T[][] {
  return [
    [fn(), fn()],
    [fn(), fn()],
  ];
}

const sfwork_ = mk2x2(() => new Int32Array(SFBMAX));
const vbrsfmin_ = mk2x2(() => new Int32Array(SFBMAX));
const that_ = mk2x2(() => new Algo());
const max_nbits_ch = [new Int32Array(2), new Int32Array(2)];
const max_nbits_gr = new Int32Array(2);
const use_nbits_ch = [new Int32Array(2), new Int32Array(2)];
const use_nbits_gr = new Int32Array(2);
const fbuf = new Float32Array(2);

/** Shifts bits between the two channels of a granule, as in VBR_encode_frame(). */
function rebalance_ch(gr: number): void {
  const mx = max_nbits_ch[gr];
  const us = use_nbits_ch[gr];
  if (mx[0] > us[0] + 32) {
    mx[1] += mx[0];
    mx[1] -= us[0] + 32;
    mx[0] = us[0] + 32;
  }
  if (mx[1] > us[1] + 32) {
    mx[0] += mx[1];
    mx[0] -= us[1] + 32;
    mx[1] = us[1] + 32;
  }
}

export function VBR_encode_frame(
  gfc: LameInternalFlags,
  xr34orig: Float32Array[][],
  l3_xmin: Float32Array[][],
  max_bits: Int32Array[],
): number {
  const cfg = gfc.cfg;
  const ngr = cfg.mode_gr;
  const nch = cfg.channels_out;
  let max_nbits_fr = 0;
  let use_nbits_fr: number;
  let gr: number, ch: number;
  let ok: number, sum_fr: number;
  let s: number;
  const fl = fbuf;

  max_nbits_ch[0].fill(0);
  max_nbits_ch[1].fill(0);
  max_nbits_gr.fill(0);
  use_nbits_ch[0].fill(MAX_BITS_PER_CHANNEL + 1);
  use_nbits_ch[1].fill(MAX_BITS_PER_CHANNEL + 1);
  use_nbits_gr.fill(MAX_BITS_PER_GRANULE + 1);

  /* set up some encoding parameters
   */
  for (gr = 0; gr < ngr; ++gr) {
    max_nbits_gr[gr] = 0;
    for (ch = 0; ch < nch; ++ch) {
      max_nbits_ch[gr][ch] = max_bits[gr][ch];
      use_nbits_ch[gr][ch] = 0;
      max_nbits_gr[gr] += max_bits[gr][ch];
      max_nbits_fr += max_bits[gr][ch];
      const that = that_[gr][ch];
      that.find = cfg.full_outer_loop < 0 ? guess_scalefac_x34 : find_scalefac_x34;
      that.gfc = gfc;
      that.cod_info = gfc.l3_side.tt[gr][ch];
      that.xr34orig = xr34orig[gr][ch];
      if (that.cod_info.block_type === SHORT_TYPE) {
        that.alloc = short_block_constrain;
      } else {
        that.alloc = long_block_constrain;
      }
    } /* for ch */
  }
  /* searches scalefactors
   */
  for (gr = 0; gr < ngr; ++gr) {
    for (ch = 0; ch < nch; ++ch) {
      if (max_bits[gr][ch] > 0) {
        const that = that_[gr][ch];
        const sfwork = sfwork_[gr][ch];
        const vbrsfmin = vbrsfmin_[gr][ch];
        const vbrmax = block_sf(that, l3_xmin[gr][ch], sfwork, vbrsfmin);
        that.alloc(that, sfwork, vbrsfmin, vbrmax);
        bitcount(that);
      } else {
        /*  xr contains no energy
         *  l3_enc, our encoding data, will be quantized to zero
         *  continue with next channel
         */
      }
    } /* for ch */
  }
  /* encode 'as is'
   */
  use_nbits_fr = 0;
  for (gr = 0; gr < ngr; ++gr) {
    use_nbits_gr[gr] = 0;
    for (ch = 0; ch < nch; ++ch) {
      const that = that_[gr][ch];
      if (max_bits[gr][ch] > 0) {
        that.cod_info.l3_enc.fill(0);
        quantizeAndCountBits(that);
      } else {
        /*  xr contains no energy
         *  l3_enc, our encoding data, will be quantized to zero
         *  continue with next channel
         */
      }
      use_nbits_ch[gr][ch] = reduce_bit_usage(gfc, gr, ch);
      use_nbits_gr[gr] += use_nbits_ch[gr][ch];
    } /* for ch */
    use_nbits_fr += use_nbits_gr[gr];
  }
  /* check bit constrains
   */
  if (use_nbits_fr <= max_nbits_fr) {
    ok = 1;
    for (gr = 0; gr < ngr; ++gr) {
      if (use_nbits_gr[gr] > MAX_BITS_PER_GRANULE) {
        /* violates the rule that every granule has to use no more
         * bits than MAX_BITS_PER_GRANULE
         */
        ok = 0;
      }
      for (ch = 0; ch < nch; ++ch) {
        if (use_nbits_ch[gr][ch] > MAX_BITS_PER_CHANNEL) {
          /* violates the rule that every gr_ch has to use no more
           * bits than MAX_BITS_PER_CHANNEL
           *
           * This isn't explicitly stated in the ISO docs, but the
           * part2_3_length field has only 12 bits, that makes it
           * up to a maximum size of 4095 bits!!!
           */
          ok = 0;
        }
      }
    }
    if (ok) {
      return use_nbits_fr;
    }
  }

  /* OK, we are in trouble and have to define how many bits are
   * to be used for each granule
   */
  {
    ok = 1;
    sum_fr = 0;

    for (gr = 0; gr < ngr; ++gr) {
      max_nbits_gr[gr] = 0;
      for (ch = 0; ch < nch; ++ch) {
        if (use_nbits_ch[gr][ch] > MAX_BITS_PER_CHANNEL) {
          max_nbits_ch[gr][ch] = MAX_BITS_PER_CHANNEL;
        } else {
          max_nbits_ch[gr][ch] = use_nbits_ch[gr][ch];
        }
        max_nbits_gr[gr] += max_nbits_ch[gr][ch];
      }
      if (max_nbits_gr[gr] > MAX_BITS_PER_GRANULE) {
        fl[0] = fl[1] = 0;
        s = 0;
        for (ch = 0; ch < nch; ++ch) {
          if (max_nbits_ch[gr][ch] > 0) {
            fl[ch] = Math.sqrt(Math.sqrt(max_nbits_ch[gr][ch]));
            s = f(s + fl[ch]);
          } else {
            fl[ch] = 0;
          }
        }
        for (ch = 0; ch < nch; ++ch) {
          if (s > 0) {
            max_nbits_ch[gr][ch] = Math.trunc(f(f(MAX_BITS_PER_GRANULE * fl[ch]) / s));
          } else {
            max_nbits_ch[gr][ch] = 0;
          }
        }
        if (nch > 1) {
          rebalance_ch(gr);
          if (max_nbits_ch[gr][0] > MAX_BITS_PER_CHANNEL) {
            max_nbits_ch[gr][0] = MAX_BITS_PER_CHANNEL;
          }
          if (max_nbits_ch[gr][1] > MAX_BITS_PER_CHANNEL) {
            max_nbits_ch[gr][1] = MAX_BITS_PER_CHANNEL;
          }
        }
        max_nbits_gr[gr] = 0;
        for (ch = 0; ch < nch; ++ch) {
          max_nbits_gr[gr] += max_nbits_ch[gr][ch];
        }
      }
      sum_fr += max_nbits_gr[gr];
    }
    if (sum_fr > max_nbits_fr) {
      {
        fl[0] = fl[1] = 0;
        s = 0;
        for (gr = 0; gr < ngr; ++gr) {
          if (max_nbits_gr[gr] > 0) {
            fl[gr] = Math.sqrt(max_nbits_gr[gr]);
            s = f(s + fl[gr]);
          } else {
            fl[gr] = 0;
          }
        }
        for (gr = 0; gr < ngr; ++gr) {
          if (s > 0) {
            max_nbits_gr[gr] = Math.trunc(f(f(max_nbits_fr * fl[gr]) / s));
          } else {
            max_nbits_gr[gr] = 0;
          }
        }
      }
      if (ngr > 1) {
        if (max_nbits_gr[0] > use_nbits_gr[0] + 125) {
          max_nbits_gr[1] += max_nbits_gr[0];
          max_nbits_gr[1] -= use_nbits_gr[0] + 125;
          max_nbits_gr[0] = use_nbits_gr[0] + 125;
        }
        if (max_nbits_gr[1] > use_nbits_gr[1] + 125) {
          max_nbits_gr[0] += max_nbits_gr[1];
          max_nbits_gr[0] -= use_nbits_gr[1] + 125;
          max_nbits_gr[1] = use_nbits_gr[1] + 125;
        }
        for (gr = 0; gr < ngr; ++gr) {
          if (max_nbits_gr[gr] > MAX_BITS_PER_GRANULE) {
            max_nbits_gr[gr] = MAX_BITS_PER_GRANULE;
          }
        }
      }
      for (gr = 0; gr < ngr; ++gr) {
        fl[0] = fl[1] = 0;
        s = 0;
        for (ch = 0; ch < nch; ++ch) {
          if (max_nbits_ch[gr][ch] > 0) {
            fl[ch] = Math.sqrt(max_nbits_ch[gr][ch]);
            s = f(s + fl[ch]);
          } else {
            fl[ch] = 0;
          }
        }
        for (ch = 0; ch < nch; ++ch) {
          if (s > 0) {
            max_nbits_ch[gr][ch] = Math.trunc(f(f(max_nbits_gr[gr] * fl[ch]) / s));
          } else {
            max_nbits_ch[gr][ch] = 0;
          }
        }
        if (nch > 1) {
          rebalance_ch(gr);
          for (ch = 0; ch < nch; ++ch) {
            if (max_nbits_ch[gr][ch] > MAX_BITS_PER_CHANNEL) {
              max_nbits_ch[gr][ch] = MAX_BITS_PER_CHANNEL;
            }
          }
        }
      }
    }
    /* sanity check */
    sum_fr = 0;
    for (gr = 0; gr < ngr; ++gr) {
      let sum_gr = 0;
      for (ch = 0; ch < nch; ++ch) {
        sum_gr += max_nbits_ch[gr][ch];
        if (max_nbits_ch[gr][ch] > MAX_BITS_PER_CHANNEL) {
          ok = 0;
        }
      }
      sum_fr += sum_gr;
      if (sum_gr > MAX_BITS_PER_GRANULE) {
        ok = 0;
      }
    }
    if (sum_fr > max_nbits_fr) {
      ok = 0;
    }
    if (!ok) {
      /* we must have done something wrong, fallback to 'on_pe' based constrain */
      for (gr = 0; gr < ngr; ++gr) {
        for (ch = 0; ch < nch; ++ch) {
          max_nbits_ch[gr][ch] = max_bits[gr][ch];
        }
      }
    }
  }

  /* we already called the 'best_scalefac_store' function, so we need to reset some
   * variables before we can do it again.
   */
  for (ch = 0; ch < nch; ++ch) {
    gfc.l3_side.scfsi[ch][0] = 0;
    gfc.l3_side.scfsi[ch][1] = 0;
    gfc.l3_side.scfsi[ch][2] = 0;
    gfc.l3_side.scfsi[ch][3] = 0;
  }
  for (gr = 0; gr < ngr; ++gr) {
    for (ch = 0; ch < nch; ++ch) {
      gfc.l3_side.tt[gr][ch].scalefac_compress = 0;
    }
  }

  /* alter our encoded data, until it fits into the target bitrate
   */
  use_nbits_fr = 0;
  for (gr = 0; gr < ngr; ++gr) {
    use_nbits_gr[gr] = 0;
    for (ch = 0; ch < nch; ++ch) {
      const that = that_[gr][ch];
      use_nbits_ch[gr][ch] = 0;
      if (max_bits[gr][ch] > 0) {
        const sfwork = sfwork_[gr][ch];
        const vbrsfmin = vbrsfmin_[gr][ch];
        cutDistribution(sfwork, sfwork, that.cod_info.global_gain);
        outOfBitsStrategy(that, sfwork, vbrsfmin, max_nbits_ch[gr][ch]);
      }
      use_nbits_ch[gr][ch] = reduce_bit_usage(gfc, gr, ch);
      use_nbits_gr[gr] += use_nbits_ch[gr][ch];
    } /* for ch */
    use_nbits_fr += use_nbits_gr[gr];
  }

  /* check bit constrains, but it should always be ok, iff there are no bugs ;-)
   */
  if (use_nbits_fr <= max_nbits_fr) {
    return use_nbits_fr;
  }

  throw new Error(
    `INTERNAL ERROR IN VBR NEW CODE (1313), please send bug report\nmaxbits=${max_nbits_fr} usedbits=${use_nbits_fr}`,
  );
}
