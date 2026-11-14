// Port of libmp3lame/takehiro.c - quantization of the spectrum and Huffman bit counting
// (table selection, region division, scalefactor storage).

import {
  IXMAX_VAL,
  LARGE_BITS,
  NORM_TYPE,
  SBMAX_l,
  SBPSY_l,
  SHORT_TYPE,
  f,
} from './constants.ts';
import { adj43, ipow20 } from './quantize_pvt.ts';
import type { CalcNoiseData } from './quantize_pvt.ts';
import { ht, largetbl, nr_of_sfb_block, pretab, scfsi_band, t32l, t33l, table23, table56 } from './tables.ts';
import { GrInfo } from './types.ts';
import type { III_side_info, LameInternalFlags } from './types.ts';

/* [region0_count, region1_count] by number of bands */
const subdv_table: ReadonlyArray<readonly [number, number]> = [
  [0, 0] /* 0 bands */,
  [0, 0] /* 1 bands */,
  [0, 0] /* 2 bands */,
  [0, 0] /* 3 bands */,
  [0, 0] /* 4 bands */,
  [0, 1] /* 5 bands */,
  [1, 1] /* 6 bands */,
  [1, 1] /* 7 bands */,
  [1, 2] /* 8 bands */,
  [2, 2] /* 9 bands */,
  [2, 3] /* 10 bands */,
  [2, 3] /* 11 bands */,
  [3, 4] /* 12 bands */,
  [3, 4] /* 13 bands */,
  [3, 4] /* 14 bands */,
  [4, 5] /* 15 bands */,
  [4, 5] /* 16 bands */,
  [4, 6] /* 17 bands */,
  [5, 6] /* 18 bands */,
  [5, 6] /* 19 bands */,
  [5, 7] /* 20 bands */,
  [6, 7] /* 21 bands */,
  [6, 7] /* 22 bands */,
];

const F_ONE_MINUS_ROUNDFAC = f(1.0 - f(0.4054));

/*********************************************************************
 * nonlinear quantization of xr
 * More accurate formula than the ISO formula.  Takes into account
 * the fact that we are quantizing xr -> ix, but we want ix^4/3 to be
 * as close as possible to x^4/3.  (taking the nearest int would mean
 * ix is as close as possible to xr, which is different.)
 *
 * From Segher Boessenkool <segher@eastsite.nl>  11/1999
 *********************************************************************/
function quantize_lines_xrpow_01(l: number, istep: number, xr: Float32Array, xo: number, ix: Int32Array, io: number): void {
  const compareval0 = f(F_ONE_MINUS_ROUNDFAC / istep);

  for (let i = 0; i < l; i += 2) {
    const xr_0 = xr[xo + i];
    const xr_1 = xr[xo + i + 1];
    ix[io + i] = compareval0 > xr_0 ? 0 : 1;
    ix[io + i + 1] = compareval0 > xr_1 ? 0 : 1;
  }
}

/* XRPOW_FTOI(x) = (int) x, QUANTFAC(x) = adj43[x], ROUNDFAC = 0.4054 */
function quantize_lines_xrpow(l: number, istep: number, xr: Float32Array, xo: number, ix: Int32Array, io: number): void {
  l = l >> 1;
  const remaining = l % 2;
  l = l >> 1;
  while (l--) {
    let x0 = f(xr[xo++] * istep);
    let x1 = f(xr[xo++] * istep);
    let x2 = f(xr[xo++] * istep);
    let x3 = f(xr[xo++] * istep);
    x0 = f(x0 + adj43[x0 | 0]);
    x1 = f(x1 + adj43[x1 | 0]);
    x2 = f(x2 + adj43[x2 | 0]);
    x3 = f(x3 + adj43[x3 | 0]);
    ix[io++] = x0 | 0;
    ix[io++] = x1 | 0;
    ix[io++] = x2 | 0;
    ix[io++] = x3 | 0;
  }
  if (remaining) {
    let x0 = f(xr[xo++] * istep);
    let x1 = f(xr[xo++] * istep);
    x0 = f(x0 + adj43[x0 | 0]);
    x1 = f(x1 + adj43[x1 | 0]);
    ix[io++] = x0 | 0;
    ix[io++] = x1 | 0;
  }
}

/*********************************************************************
 * Quantization function
 * This function will select which lines to quantize and call the
 * proper quantization function
 *********************************************************************/
function quantize_xrpow(
  xp: Float32Array,
  pi: Int32Array,
  istep: number,
  cod_info: GrInfo,
  prev_noise: CalcNoiseData | null,
): void {
  /* quantize on xr^(3/4) instead of xr */
  let sfb: number;
  let sfbmax: number;
  let j = 0;
  let iData = 0;
  let accumulate = 0;
  let accumulate01 = 0;
  let acc_iData = 0;

  /* Reusing previously computed data does not seems to work if global gain
     is changed. Finding why it behaves this way would allow to use a cache of
     previously computed values (let's 10 cached values per sfb) that would
     probably provide a noticeable speedup */
  const prev_data_use = prev_noise !== null && cod_info.global_gain === prev_noise.global_gain;

  if (cod_info.block_type === SHORT_TYPE) sfbmax = 38;
  else sfbmax = 21;

  for (sfb = 0; sfb <= sfbmax; sfb++) {
    let step = -1;

    if (prev_data_use || cod_info.block_type === NORM_TYPE) {
      step =
        cod_info.global_gain -
        ((cod_info.scalefac[sfb] + (cod_info.preflag ? pretab[sfb] : 0)) << (cod_info.scalefac_scale + 1)) -
        cod_info.subblock_gain[cod_info.window[sfb]] * 8;
    }
    if (prev_data_use && prev_noise!.step[sfb] === step) {
      /* do not recompute this part,
         but compute accumulated lines */
      if (accumulate) {
        quantize_lines_xrpow(accumulate, istep, xp, acc_iData, pi, acc_iData);
        accumulate = 0;
      }
      if (accumulate01) {
        quantize_lines_xrpow_01(accumulate01, istep, xp, acc_iData, pi, acc_iData);
        accumulate01 = 0;
      }
    } else {
      /*should compute this part */
      let l = cod_info.width[sfb];

      if (j + cod_info.width[sfb] > cod_info.max_nonzero_coeff) {
        /*do not compute upper zero part */
        const usefullsize = cod_info.max_nonzero_coeff - j + 1;
        pi.fill(0, cod_info.max_nonzero_coeff, 576);
        l = usefullsize;

        if (l < 0) {
          l = 0;
        }

        /* no need to compute higher sfb values */
        sfb = sfbmax + 1;
      }

      /*accumulate lines to quantize */
      if (!accumulate && !accumulate01) {
        acc_iData = iData;
      }
      // NOTE: `sfb` may be sfbmax + 1 here; for short blocks that reads one element past
      // step[] in C, which is the bit pattern of noise[0] (see CalcNoiseData.stepRaw).
      if (
        prev_noise &&
        prev_noise.sfb_count1 > 0 &&
        sfb >= prev_noise.sfb_count1 &&
        prev_noise.stepRaw[sfb] > 0 &&
        step >= prev_noise.stepRaw[sfb]
      ) {
        if (accumulate) {
          quantize_lines_xrpow(accumulate, istep, xp, acc_iData, pi, acc_iData);
          accumulate = 0;
          acc_iData = iData;
        }
        accumulate01 += l;
      } else {
        if (accumulate01) {
          quantize_lines_xrpow_01(accumulate01, istep, xp, acc_iData, pi, acc_iData);
          accumulate01 = 0;
          acc_iData = iData;
        }
        accumulate += l;
      }

      if (l <= 0) {
        /*  rh: 20040215
         *  may happen due to "prev_data_use" optimization
         */
        if (accumulate01) {
          quantize_lines_xrpow_01(accumulate01, istep, xp, acc_iData, pi, acc_iData);
          accumulate01 = 0;
        }
        if (accumulate) {
          quantize_lines_xrpow(accumulate, istep, xp, acc_iData, pi, acc_iData);
          accumulate = 0;
        }

        break; /* ends for-loop */
      }
    }
    if (sfb <= sfbmax) {
      iData += cod_info.width[sfb];
      j += cod_info.width[sfb];
    }
  }
  if (accumulate) {
    /*last data part */
    quantize_lines_xrpow(accumulate, istep, xp, acc_iData, pi, acc_iData);
    accumulate = 0;
  }
  if (accumulate01) {
    /*last data part */
    quantize_lines_xrpow_01(accumulate01, istep, xp, acc_iData, pi, acc_iData);
    accumulate01 = 0;
  }
}

/*************************************************************************/
/*	      ix_max							 */
/*************************************************************************/

function ix_max(ix: Int32Array, begin: number, end: number): number {
  let max1 = 0,
    max2 = 0;

  do {
    const x1 = ix[begin++];
    const x2 = ix[begin++];
    if (max1 < x1) max1 = x1;

    if (max2 < x2) max2 = x2;
  } while (begin < end);
  if (max1 < max2) max1 = max2;
  return max1;
}

/** Bit count accumulator of choose_table (the `*s` in/out parameter of the C code). */
let ct_s = 0;

function count_bit_ESC(ix: Int32Array, begin: number, end: number, t1: number, t2: number): number {
  /* ESC-table is used */
  const linbits = ht[t1].xlen * 65536 + ht[t2].xlen;
  let sum = 0;

  do {
    let x = ix[begin++];
    let y = ix[begin++];

    if (x >= 15) {
      x = 15;
      sum += linbits;
    }
    if (y >= 15) {
      y = 15;
      sum += linbits;
    }
    x <<= 4;
    x += y;
    sum += largetbl[x];
  } while (begin < end);

  sum >>>= 0;
  const sum2 = sum & 0xffff;
  sum >>>= 16;

  if (sum > sum2) {
    sum = sum2;
    t1 = t2;
  }

  ct_s += sum;
  return t1;
}

function count_bit_noESC(ix: Int32Array, begin: number, end: number): number {
  /* No ESC-words */
  let sum1 = 0;
  const hlen1 = ht[1].hlen!;

  do {
    const x0 = ix[begin++];
    const x1 = ix[begin++];
    sum1 += hlen1[x0 + x0 + x1];
  } while (begin < end);

  ct_s += sum1;
  return 1;
}

const huf_tbl_noESC = [1, 2, 5, 7, 7, 10, 10, 13, 13, 13, 13, 13, 13, 13, 13];

function count_bit_noESC_from2(ix: Int32Array, begin: number, end: number, max: number): number {
  let t1 = huf_tbl_noESC[max - 1];
  /* No ESC-words */
  const xlen = ht[t1].xlen;
  const table = t1 === 2 ? table23 : table56;
  let sum = 0;

  do {
    const x0 = ix[begin++];
    const x1 = ix[begin++];
    sum += table[x0 * xlen + x1];
  } while (begin < end);

  sum >>>= 0;
  const sum2 = sum & 0xffff;
  sum >>>= 16;

  if (sum > sum2) {
    sum = sum2;
    t1++;
  }

  ct_s += sum;
  return t1;
}

function count_bit_noESC_from3(ix: Int32Array, begin: number, end: number, max: number): number {
  const t1 = huf_tbl_noESC[max - 1];
  /* No ESC-words */
  let sum1 = 0;
  let sum2 = 0;
  let sum3 = 0;
  const xlen = ht[t1].xlen;
  const hlen1 = ht[t1].hlen!;
  const hlen2 = ht[t1 + 1].hlen!;
  const hlen3 = ht[t1 + 2].hlen!;
  let t: number;

  do {
    const x0 = ix[begin++];
    const x1 = ix[begin++];
    const x = x0 * xlen + x1;
    sum1 += hlen1[x];
    sum2 += hlen2[x];
    sum3 += hlen3[x];
  } while (begin < end);

  t = t1;
  if (sum1 > sum2) {
    sum1 = sum2;
    t++;
  }
  if (sum1 > sum3) {
    sum1 = sum3;
    t = t1 + 2;
  }
  ct_s += sum1;

  return t;
}

/*************************************************************************/
/*	      choose table						 */
/*************************************************************************/

/*
  Choose the Huffman table that will encode ix[begin..end] with
  the fewest bits. The bit count is added to `ct_s`.

  Note: This code contains knowledge about the sizes and characteristics
  of the Huffman tables as defined in the IS (Table B.7), and will not work
  with any arbitrary tables.
*/
function choose_table(ix: Int32Array, begin: number, end: number): number {
  let max = ix_max(ix, begin, end);

  if (max <= 15) {
    if (max === 0) return 0;
    if (max === 1) return count_bit_noESC(ix, begin, end);
    if (max <= 3) return count_bit_noESC_from2(ix, begin, end, max);
    return count_bit_noESC_from3(ix, begin, end, max);
  }
  /* try tables with linbits */
  if (max > IXMAX_VAL) {
    ct_s = LARGE_BITS;
    return -1;
  }
  max -= 15;
  let choice: number, choice2: number;
  for (choice2 = 24; choice2 < 32; choice2++) {
    if (ht[choice2].linmax >= max) {
      break;
    }
  }

  for (choice = choice2 - 8; choice < 24; choice++) {
    if (ht[choice].linmax >= max) {
      break;
    }
  }
  return count_bit_ESC(ix, begin, end, choice, choice2);
}

/*************************************************************************/
/*	      count_bit							 */
/*************************************************************************/
export function noquant_count_bits(gfc: LameInternalFlags, gi: GrInfo, prev_noise: CalcNoiseData | null): number {
  const cfg = gfc.cfg;
  let bits = 0;
  let i: number, a1: number, a2: number;
  const ix = gi.l3_enc;

  i = Math.min(576, ((gi.max_nonzero_coeff + 2) >> 1) << 1);

  if (prev_noise) prev_noise.sfb_count1 = 0;

  /* Determine count1 region */
  for (; i > 1; i -= 2) if (ix[i - 1] | ix[i - 2]) break;
  gi.count1 = i;

  /* Determines the number of bits to encode the quadruples. */
  a1 = a2 = 0;
  for (; i > 3; i -= 4) {
    const x4 = ix[i - 4];
    const x3 = ix[i - 3];
    const x2 = ix[i - 2];
    const x1 = ix[i - 1];
    /* hack to check if all values <= 1 */
    if ((x4 | x3 | x2 | x1) >>> 0 > 1) break;

    const p = ((x4 * 2 + x3) * 2 + x2) * 2 + x1;
    a1 += t32l[p];
    a2 += t33l[p];
  }

  bits = a1;
  gi.count1table_select = 0;
  if (a1 > a2) {
    bits = a2;
    gi.count1table_select = 1;
  }

  gi.count1bits = bits;
  gi.big_values = i;
  if (i === 0) return bits;

  if (gi.block_type === SHORT_TYPE) {
    a1 = 3 * gfc.scalefac_band.s[3];
    if (a1 > gi.big_values) a1 = gi.big_values;
    a2 = gi.big_values;
  } else if (gi.block_type === NORM_TYPE) {
    a1 = gi.region0_count = gfc.sv_qnt.bv_scf[i - 2];
    a2 = gi.region1_count = gfc.sv_qnt.bv_scf[i - 1];

    a2 = gfc.scalefac_band.l[a1 + a2 + 2];
    a1 = gfc.scalefac_band.l[a1 + 1];
    if (a2 < i) {
      ct_s = bits;
      gi.table_select[2] = choose_table(ix, a2, i);
      bits = ct_s;
    }
  } else {
    gi.region0_count = 7;
    /*gi.region1_count = SBPSY_l - 7 - 1; */
    gi.region1_count = SBMAX_l - 1 - 7 - 1;
    a1 = gfc.scalefac_band.l[7 + 1];
    a2 = i;
    if (a1 > a2) {
      a1 = a2;
    }
  }

  /* have to allow for the case when bigvalues < region0 < region1 */
  /* (and region0, region1 are ignored) */
  a1 = Math.min(a1, i);
  a2 = Math.min(a2, i);

  /* Count the number of bits necessary to code the bigvalues region. */
  ct_s = bits;
  if (0 < a1) gi.table_select[0] = choose_table(ix, 0, a1);
  if (a1 < a2) gi.table_select[1] = choose_table(ix, a1, a2);
  bits = ct_s;
  if (cfg.use_best_huffman === 2) {
    gi.part2_3_length = bits;
    best_huffman_divide(gfc, gi);
    bits = gi.part2_3_length;
  }

  if (prev_noise) {
    if (gi.block_type === NORM_TYPE) {
      let sfb = 0;
      while (gfc.scalefac_band.l[sfb] < gi.big_values) {
        sfb++;
      }
      prev_noise.sfb_count1 = sfb;
    }
  }

  return bits;
}

/**
 * Quantizes `xr` (which holds |xr|^(3/4)) with the granule's global gain / scalefactors into
 * `gi.l3_enc` and returns the number of Huffman bits needed.
 */
export function count_bits(
  gfc: LameInternalFlags,
  xr: Float32Array,
  gi: GrInfo,
  prev_noise: CalcNoiseData | null,
): number {
  const ix = gi.l3_enc;

  /* since quantize_xrpow uses table lookup, we need to check this first: */
  const w = f(IXMAX_VAL / ipow20[gi.global_gain]);

  if (gi.xrpow_max > w) return LARGE_BITS;

  quantize_xrpow(xr, ix, ipow20[gi.global_gain], gi, prev_noise);

  if (gfc.sv_qnt.substep_shaping & 2) {
    let j = 0;
    /* 0.634521682242439 = 0.5946*2**(.5*0.1875) */
    const gain = gi.global_gain + gi.scalefac_scale;
    const roundfac = f(0.634521682242439 / ipow20[gain]);
    for (let sfb = 0; sfb < gi.sfbmax; sfb++) {
      const width = gi.width[sfb];
      if (!gfc.sv_qnt.pseudohalf[sfb]) {
        j += width;
      } else {
        let k: number;
        for (k = j, j += width; k < j; ++k) {
          ix[k] = xr[k] >= roundfac ? ix[k] : 0;
        }
      }
    }
  }
  return noquant_count_bits(gfc, gi, prev_noise);
}

/***********************************************************************
  re-calculate the best scalefac_compress using scfsi
  the saved bits are kept in the bit reservoir.
 **********************************************************************/

function recalc_divide_init(
  gfc: LameInternalFlags,
  cod_info: GrInfo,
  ix: Int32Array,
  r01_bits: Int32Array,
  r01_div: Int32Array,
  r0_tbl: Int32Array,
  r1_tbl: Int32Array,
): void {
  let r0: number, r1: number;

  const bigv = cod_info.big_values;

  for (r0 = 0; r0 <= 7 + 15; r0++) {
    r01_bits[r0] = LARGE_BITS;
  }

  for (r0 = 0; r0 < 16; r0++) {
    const a1 = gfc.scalefac_band.l[r0 + 1];
    if (a1 >= bigv) break;
    ct_s = 0;
    const r0t = choose_table(ix, 0, a1);
    const r0bits = ct_s;

    for (r1 = 0; r1 < 8; r1++) {
      const a2 = gfc.scalefac_band.l[r0 + r1 + 2];
      if (a2 >= bigv) break;

      ct_s = r0bits;
      const r1t = choose_table(ix, a1, a2);
      const bits = ct_s;
      if (r01_bits[r0 + r1] > bits) {
        r01_bits[r0 + r1] = bits;
        r01_div[r0 + r1] = r0;
        r0_tbl[r0 + r1] = r0t;
        r1_tbl[r0 + r1] = r1t;
      }
    }
  }
}

function recalc_divide_sub(
  gfc: LameInternalFlags,
  cod_info2: GrInfo,
  gi: GrInfo,
  ix: Int32Array,
  r01_bits: Int32Array,
  r01_div: Int32Array,
  r0_tbl: Int32Array,
  r1_tbl: Int32Array,
): void {
  let bits: number, r2: number, a2: number;

  const bigv = cod_info2.big_values;

  for (r2 = 2; r2 < SBMAX_l + 1; r2++) {
    a2 = gfc.scalefac_band.l[r2];
    if (a2 >= bigv) break;

    bits = r01_bits[r2 - 2] + cod_info2.count1bits;
    if (gi.part2_3_length <= bits) break;

    ct_s = bits;
    const r2t = choose_table(ix, a2, bigv);
    bits = ct_s;
    if (gi.part2_3_length <= bits) continue;

    gi.assign(cod_info2);
    gi.part2_3_length = bits;
    gi.region0_count = r01_div[r2 - 2];
    gi.region1_count = r2 - 2 - r01_div[r2 - 2];
    gi.table_select[0] = r0_tbl[r2 - 2];
    gi.table_select[1] = r1_tbl[r2 - 2];
    gi.table_select[2] = r2t;
  }
}

const bhd_cod_info2 = new GrInfo();
const bhd_r01_bits = new Int32Array(7 + 15 + 1);
const bhd_r01_div = new Int32Array(7 + 15 + 1);
const bhd_r0_tbl = new Int32Array(7 + 15 + 1);
const bhd_r1_tbl = new Int32Array(7 + 15 + 1);

export function best_huffman_divide(gfc: LameInternalFlags, gi: GrInfo): void {
  const cfg = gfc.cfg;
  let i: number, a1: number, a2: number;
  const cod_info2 = bhd_cod_info2;
  const ix = gi.l3_enc;

  const r01_bits = bhd_r01_bits;
  const r01_div = bhd_r01_div;
  const r0_tbl = bhd_r0_tbl;
  const r1_tbl = bhd_r1_tbl;

  /* SHORT BLOCK stuff fails for MPEG2 */
  if (gi.block_type === SHORT_TYPE && cfg.mode_gr === 1) return;

  cod_info2.assign(gi);
  if (gi.block_type === NORM_TYPE) {
    recalc_divide_init(gfc, gi, ix, r01_bits, r01_div, r0_tbl, r1_tbl);
    recalc_divide_sub(gfc, cod_info2, gi, ix, r01_bits, r01_div, r0_tbl, r1_tbl);
  }

  i = cod_info2.big_values;
  if (i === 0 || (ix[i - 2] | ix[i - 1]) >>> 0 > 1) return;

  i = gi.count1 + 2;
  if (i > 576) return;

  /* Determines the number of bits to encode the quadruples. */
  cod_info2.assign(gi);
  cod_info2.count1 = i;
  a1 = a2 = 0;

  for (; i > cod_info2.big_values; i -= 4) {
    const p = ((ix[i - 4] * 2 + ix[i - 3]) * 2 + ix[i - 2]) * 2 + ix[i - 1];
    a1 += t32l[p];
    a2 += t33l[p];
  }
  cod_info2.big_values = i;

  cod_info2.count1table_select = 0;
  if (a1 > a2) {
    a1 = a2;
    cod_info2.count1table_select = 1;
  }

  cod_info2.count1bits = a1;

  if (cod_info2.block_type === NORM_TYPE)
    recalc_divide_sub(gfc, cod_info2, gi, ix, r01_bits, r01_div, r0_tbl, r1_tbl);
  else {
    /* Count the number of bits necessary to code the bigvalues region. */
    cod_info2.part2_3_length = a1;
    a1 = gfc.scalefac_band.l[7 + 1];
    if (a1 > i) {
      a1 = i;
    }
    ct_s = cod_info2.part2_3_length;
    if (a1 > 0) cod_info2.table_select[0] = choose_table(ix, 0, a1);
    if (i > a1) cod_info2.table_select[1] = choose_table(ix, a1, i);
    cod_info2.part2_3_length = ct_s;
    if (gi.part2_3_length > cod_info2.part2_3_length) gi.assign(cod_info2);
  }
}

const slen1_n = [1, 1, 1, 1, 8, 2, 2, 2, 4, 4, 4, 8, 8, 8, 16, 16];
const slen2_n = [1, 2, 4, 8, 1, 2, 4, 8, 2, 4, 8, 2, 4, 8, 4, 8];
export const slen1_tab = [0, 0, 0, 0, 3, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4];
export const slen2_tab = [0, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3, 1, 2, 3, 2, 3];

function scfsi_calc(ch: number, l3_side: III_side_info): void {
  let i: number;
  let s1: number, s2: number, c1: number, c2: number;
  let sfb: number;
  const gi = l3_side.tt[1][ch];
  const g0 = l3_side.tt[0][ch];

  for (i = 0; i < scfsi_band.length - 1; i++) {
    for (sfb = scfsi_band[i]; sfb < scfsi_band[i + 1]; sfb++) {
      if (g0.scalefac[sfb] !== gi.scalefac[sfb] && gi.scalefac[sfb] >= 0) break;
    }
    if (sfb === scfsi_band[i + 1]) {
      for (sfb = scfsi_band[i]; sfb < scfsi_band[i + 1]; sfb++) {
        gi.scalefac[sfb] = -1;
      }
      l3_side.scfsi[ch][i] = 1;
    }
  }

  s1 = c1 = 0;
  for (sfb = 0; sfb < 11; sfb++) {
    if (gi.scalefac[sfb] === -1) continue;
    c1++;
    if (s1 < gi.scalefac[sfb]) s1 = gi.scalefac[sfb];
  }

  s2 = c2 = 0;
  for (; sfb < SBPSY_l; sfb++) {
    if (gi.scalefac[sfb] === -1) continue;
    c2++;
    if (s2 < gi.scalefac[sfb]) s2 = gi.scalefac[sfb];
  }

  for (i = 0; i < 16; i++) {
    if (s1 < slen1_n[i] && s2 < slen2_n[i]) {
      const c = slen1_tab[i] * c1 + slen2_tab[i] * c2;
      if (gi.part2_length > c) {
        gi.part2_length = c;
        gi.scalefac_compress = i;
      }
    }
  }
}

/*
Find the optimal way to store the scalefactors.
Only call this routine after final scalefactors have been
chosen and the channel/granule will not be re-encoded.
 */
export function best_scalefac_store(gfc: LameInternalFlags, gr: number, ch: number, l3_side: III_side_info): void {
  const cfg = gfc.cfg;
  /* use scalefac_scale if we can */
  const gi = l3_side.tt[gr][ch];
  let sfb: number, i: number, j: number, l: number;
  let recalc = 0;

  /* remove scalefacs from bands with ix=0.  This idea comes
   * from the AAC ISO docs.  added mt 3/00 */
  /* check if l3_enc=0 */
  j = 0;
  for (sfb = 0; sfb < gi.sfbmax; sfb++) {
    const width = gi.width[sfb];
    for (l = j, j += width; l < j; ++l) {
      if (gi.l3_enc[l] !== 0) break;
    }
    if (l === j) gi.scalefac[sfb] = recalc = -2; /* anything goes. */
    /*  only best_scalefac_store and calc_scfsi
     *  know--and only they should know--about the magic number -2.
     */
  }

  if (!gi.scalefac_scale && !gi.preflag) {
    let s = 0;
    for (sfb = 0; sfb < gi.sfbmax; sfb++) if (gi.scalefac[sfb] > 0) s |= gi.scalefac[sfb];

    if (!(s & 1) && s !== 0) {
      for (sfb = 0; sfb < gi.sfbmax; sfb++) if (gi.scalefac[sfb] > 0) gi.scalefac[sfb] >>= 1;

      gi.scalefac_scale = recalc = 1;
    }
  }

  if (!gi.preflag && gi.block_type !== SHORT_TYPE && cfg.mode_gr === 2) {
    for (sfb = 11; sfb < SBPSY_l; sfb++) if (gi.scalefac[sfb] < pretab[sfb] && gi.scalefac[sfb] !== -2) break;
    if (sfb === SBPSY_l) {
      for (sfb = 11; sfb < SBPSY_l; sfb++) if (gi.scalefac[sfb] > 0) gi.scalefac[sfb] -= pretab[sfb];

      gi.preflag = recalc = 1;
    }
  }

  for (i = 0; i < 4; i++) l3_side.scfsi[ch][i] = 0;

  if (
    cfg.mode_gr === 2 &&
    gr === 1 &&
    l3_side.tt[0][ch].block_type !== SHORT_TYPE &&
    l3_side.tt[1][ch].block_type !== SHORT_TYPE
  ) {
    scfsi_calc(ch, l3_side);
    recalc = 0;
  }
  for (sfb = 0; sfb < gi.sfbmax; sfb++) {
    if (gi.scalefac[sfb] === -2) {
      gi.scalefac[sfb] = 0; /* if anything goes, then 0 is a good choice */
    }
  }
  if (recalc) {
    scale_bitcount(gfc, gi);
  }
}

/* number of bits used to encode scalefacs */

/* 18*slen1_tab[i] + 18*slen2_tab[i] */
const scale_short = [0, 18, 36, 54, 54, 36, 54, 72, 54, 72, 90, 72, 90, 108, 108, 126];

/* 17*slen1_tab[i] + 18*slen2_tab[i] */
const scale_mixed = [0, 18, 36, 54, 51, 35, 53, 71, 52, 70, 88, 69, 87, 105, 104, 122];

/* 11*slen1_tab[i] + 10*slen2_tab[i] */
const scale_long = [0, 10, 20, 30, 33, 21, 31, 41, 32, 42, 52, 43, 53, 63, 64, 74];

/*************************************************************************/
/*            scale_bitcount                                             */
/*************************************************************************/

/* Also calculates the number of bits necessary to code the scalefactors. */

function mpeg1_scale_bitcount(cod_info: GrInfo): number {
  let k: number,
    sfb: number,
    max_slen1 = 0,
    max_slen2 = 0;

  /* maximum values */
  let tab: number[];
  const scalefac = cod_info.scalefac;

  if (cod_info.block_type === SHORT_TYPE) {
    tab = scale_short;
    if (cod_info.mixed_block_flag) tab = scale_mixed;
  } else {
    /* block_type == 1,2,or 3 */
    tab = scale_long;
    if (!cod_info.preflag) {
      for (sfb = 11; sfb < SBPSY_l; sfb++) if (scalefac[sfb] < pretab[sfb]) break;

      if (sfb === SBPSY_l) {
        cod_info.preflag = 1;
        for (sfb = 11; sfb < SBPSY_l; sfb++) scalefac[sfb] -= pretab[sfb];
      }
    }
  }

  for (sfb = 0; sfb < cod_info.sfbdivide; sfb++) if (max_slen1 < scalefac[sfb]) max_slen1 = scalefac[sfb];

  for (; sfb < cod_info.sfbmax; sfb++) if (max_slen2 < scalefac[sfb]) max_slen2 = scalefac[sfb];

  /* from Takehiro TOMINAGA <tominaga@isoternet.org> 10/99
   * loop over *all* posible values of scalefac_compress to find the
   * one which uses the smallest number of bits.  ISO would stop
   * at first valid index */
  cod_info.part2_length = LARGE_BITS;
  for (k = 0; k < 16; k++) {
    if (max_slen1 < slen1_n[k] && max_slen2 < slen2_n[k] && cod_info.part2_length > tab[k]) {
      cod_info.part2_length = tab[k];
      cod_info.scalefac_compress = k;
    }
  }
  return cod_info.part2_length === LARGE_BITS ? 1 : 0;
}

/*
  table of largest scalefactor values for MPEG2
*/
const max_range_sfac_tab = [
  [15, 15, 7, 7],
  [15, 15, 7, 0],
  [7, 3, 0, 0],
  [15, 31, 31, 0],
  [7, 7, 7, 0],
  [3, 3, 0, 0],
];

const log2tab = [0, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4];

/*************************************************************************/
/*            scale_bitcount_lsf                                         */
/*************************************************************************/

/* Also counts the number of bits to encode the scalefacs but for MPEG 2 */
/* Lower sampling frequencies  (24, 22.05 and 16 kHz.)                   */

/*  This is reverse-engineered from section 2.4.3.2 of the MPEG2 IS,     */
/* "Audio Decoding Layer III"                                            */

function mpeg2_scale_bitcount(cod_info: GrInfo): number {
  let table_number: number, row_in_table: number, partition: number, nr_sfb: number, window: number, over: number;
  let i: number, sfb: number;
  const max_sfac = [0, 0, 0, 0];
  let partition_table: number;
  const scalefac = cod_info.scalefac;

  /*
     Set partition table. Note that should try to use table one,
     but do not yet...
   */
  if (cod_info.preflag) table_number = 2;
  else table_number = 0;

  if (cod_info.block_type === SHORT_TYPE) {
    row_in_table = 1;
    partition_table = table_number * 12 + row_in_table * 4;
    for (sfb = 0, partition = 0; partition < 4; partition++) {
      nr_sfb = (nr_of_sfb_block[partition_table + partition] / 3) | 0;
      for (i = 0; i < nr_sfb; i++, sfb++)
        for (window = 0; window < 3; window++)
          if (scalefac[sfb * 3 + window] > max_sfac[partition]) max_sfac[partition] = scalefac[sfb * 3 + window];
    }
  } else {
    row_in_table = 0;
    partition_table = table_number * 12 + row_in_table * 4;
    for (sfb = 0, partition = 0; partition < 4; partition++) {
      nr_sfb = nr_of_sfb_block[partition_table + partition];
      for (i = 0; i < nr_sfb; i++, sfb++) if (scalefac[sfb] > max_sfac[partition]) max_sfac[partition] = scalefac[sfb];
    }
  }

  for (over = 0, partition = 0; partition < 4; partition++) {
    if (max_sfac[partition] > max_range_sfac_tab[table_number][partition]) over++;
  }
  if (!over) {
    /*
       Since no bands have been over-amplified, we can set scalefac_compress
       and slen[] for the formatter
     */
    cod_info.sfb_partition_table = partition_table;
    for (partition = 0; partition < 4; partition++) cod_info.slen[partition] = log2tab[max_sfac[partition]];

    /* set scalefac_compress */
    const slen1 = cod_info.slen[0];
    const slen2 = cod_info.slen[1];
    const slen3 = cod_info.slen[2];
    const slen4 = cod_info.slen[3];

    switch (table_number) {
      case 0:
        cod_info.scalefac_compress = ((slen1 * 5 + slen2) << 4) + (slen3 << 2) + slen4;
        break;

      case 1:
        cod_info.scalefac_compress = 400 + ((slen1 * 5 + slen2) << 2) + slen3;
        break;

      case 2:
        cod_info.scalefac_compress = 500 + slen1 * 3 + slen2;
        break;
    }

    cod_info.part2_length = 0;
    for (partition = 0; partition < 4; partition++)
      cod_info.part2_length += cod_info.slen[partition] * nr_of_sfb_block[cod_info.sfb_partition_table + partition];
  }
  return over;
}

/** Returns non-zero if the scalefactors cannot be stored (some are too large). */
export function scale_bitcount(gfc: LameInternalFlags, cod_info: GrInfo): number {
  if (gfc.cfg.mode_gr === 2) {
    return mpeg1_scale_bitcount(cod_info);
  } else {
    return mpeg2_scale_bitcount(cod_info);
  }
}

export function huffman_init(gfc: LameInternalFlags): void {
  const l = gfc.scalefac_band.l;
  const bv_scf = gfc.sv_qnt.bv_scf;

  for (let i = 2; i <= 576; i += 2) {
    let scfb_anz = 0,
      bv_index: number;
    while (l[++scfb_anz] < i);

    bv_index = subdv_table[scfb_anz][0];
    while (l[bv_index + 1] > i) bv_index--;

    if (bv_index < 0) {
      /* this is an indication that everything is going to
         be encoded as region0:  bigvalues < region0 < region1
         so lets set region0, region1 to some value larger
         than bigvalues */
      bv_index = subdv_table[scfb_anz][0];
    }

    bv_scf[i - 2] = bv_index;

    bv_index = subdv_table[scfb_anz][1];
    while (l[bv_index + bv_scf[i - 2] + 2] > i) bv_index--;

    if (bv_index < 0) {
      bv_index = subdv_table[scfb_anz][1];
    }

    bv_scf[i - 1] = bv_index;
  }
}
