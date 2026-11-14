// Port of libmp3lame/presets.c - translates presets (-V n, ABR bitrates, legacy names)
// into tuning parameters.

import {
  EXTREME,
  EXTREME_FAST,
  f,
  INSANE,
  MEDIUM,
  MEDIUM_FAST,
  R3MIX,
  STANDARD,
  STANDARD_FAST,
  V0,
  V1,
  V2,
  V3,
  V4,
  V5,
  V6,
  V7,
  V8,
  V9,
  vbr_abr,
  vbr_mt,
  vbr_mtrh,
  vbr_off,
} from './constants.ts';
import type { LameGlobalFlags } from './types.ts';
import { nearestBitrateFullIndex } from './util.ts';

/* ---- the few set_get.c accessors with non-trivial semantics ---- */

export function lame_set_VBR_q(gfp: LameGlobalFlags, VBR_q: number): number {
  let ret = 0;

  if (0 > VBR_q) {
    ret = -1; /* Unknown VBR quality level! */
    VBR_q = 0;
  }
  if (9 < VBR_q) {
    ret = -1;
    VBR_q = 9;
  }
  gfp.VBR_q = VBR_q;
  gfp.VBR_q_frac = 0;
  return ret;
}

export function lame_set_VBR_quality(gfp: LameGlobalFlags, VBR_q: number): number {
  let ret = 0;

  VBR_q = f(VBR_q);
  if (0 > VBR_q) {
    ret = -1; /* Unknown VBR quality level! */
    VBR_q = 0;
  }
  if (9.999 < VBR_q) {
    ret = -1;
    VBR_q = f(9.999);
  }

  gfp.VBR_q = Math.trunc(VBR_q);
  gfp.VBR_q_frac = f(VBR_q - gfp.VBR_q);
  return ret;
}

export function lame_set_brate(gfp: LameGlobalFlags, brate: number): void {
  gfp.brate = brate;
  if (brate > 320) {
    gfp.disable_reservoir = 1;
  }
}

function lame_set_interChRatio(gfp: LameGlobalFlags, ratio: number): void {
  ratio = f(ratio);
  /* default = 0.0 (no inter-channel maskin) */
  if (0 <= ratio && ratio <= 1.0) {
    gfp.interChRatio = ratio;
  }
}

/** SET_OPTION for float fields: "set if enforced, or if the option still has its default". */
function unset(cur: number, def: number): boolean {
  return !(Math.abs(cur - def) > 0);
}

interface VbrPreset {
  vbr_q: number;
  quant_comp: number;
  quant_comp_s: number;
  expY: number;
  st_lrm: number; /*short threshold */
  st_s: number;
  masking_adj: number;
  masking_adj_short: number;
  ath_lower: number;
  ath_curve: number;
  ath_sensitivity: number;
  interch: number;
  safejoint: number;
  sfb21mod: number;
  msfix: number;
  minval: number;
  ath_fixpoint: number;
}

function vp(r: number[]): VbrPreset {
  return {
    vbr_q: r[0],
    quant_comp: r[1],
    quant_comp_s: r[2],
    expY: r[3],
    st_lrm: f(r[4]),
    st_s: f(r[5]),
    masking_adj: f(r[6]),
    masking_adj_short: f(r[7]),
    ath_lower: f(r[8]),
    ath_curve: f(r[9]),
    ath_sensitivity: f(r[10]),
    interch: f(r[11]),
    safejoint: r[12],
    sfb21mod: r[13],
    msfix: f(r[14]),
    minval: f(r[15]),
    ath_fixpoint: f(r[16]),
  };
}

/* Switch mappings for VBR mode VBR_RH */
// prettier-ignore
const vbr_old_switch_map: VbrPreset[] = [
  /*vbr_q  qcomp_l  qcomp_s  expY  st_lrm   st_s  mask adj_l  adj_s  ath_lower  ath_curve  ath_sens  interChR  safejoint sfb21mod  msfix */
  [0, 9, 9, 0, 5.20, 125.0, -4.2, -6.3, 4.8, 1, 0, 0, 2, 21, 0.97, 5, 100],
  [1, 9, 9, 0, 5.30, 125.0, -3.6, -5.6, 4.5, 1.5, 0, 0, 2, 21, 1.35, 5, 100],
  [2, 9, 9, 0, 5.60, 125.0, -2.2, -3.5, 2.8, 2, 0, 0, 2, 21, 1.49, 5, 100],
  [3, 9, 9, 1, 5.80, 130.0, -1.8, -2.8, 2.6, 3, -4, 0, 2, 20, 1.64, 5, 100],
  [4, 9, 9, 1, 6.00, 135.0, -0.7, -1.1, 1.1, 3.5, -8, 0, 2, 0, 1.79, 5, 100],
  [5, 9, 9, 1, 6.40, 140.0, 0.5, 0.4, -7.5, 4, -12, 0.0002, 0, 0, 1.95, 5, 100],
  [6, 9, 9, 1, 6.60, 145.0, 0.67, 0.65, -14.7, 6.5, -19, 0.0004, 0, 0, 2.30, 5, 100],
  [7, 9, 9, 1, 6.60, 145.0, 0.8, 0.75, -19.7, 8, -22, 0.0006, 0, 0, 2.70, 5, 100],
  [8, 9, 9, 1, 6.60, 145.0, 1.2, 1.15, -27.5, 10, -23, 0.0007, 0, 0, 0, 5, 100],
  [9, 9, 9, 1, 6.60, 145.0, 1.6, 1.6, -36, 11, -25, 0.0008, 0, 0, 0, 5, 100],
  [10, 9, 9, 1, 6.60, 145.0, 2.0, 2.0, -36, 12, -25, 0.0008, 0, 0, 0, 5, 100],
].map(vp);

// prettier-ignore
const vbr_mt_psy_switch_map: VbrPreset[] = [
  /*vbr_q  qcomp_l  qcomp_s  expY  st_lrm   st_s  mask adj_l  adj_s  ath_lower  ath_curve  ath_sens  ---  safejoint sfb21mod  msfix */
  [0, 9, 9, 0, 4.20, 25.0, -6.8, -6.8, 7.1, 1, 0, 0, 2, 31, 1.000, 5, 100],
  [1, 9, 9, 0, 4.20, 25.0, -4.8, -4.8, 5.4, 1.4, -1, 0, 2, 27, 1.122, 5, 98],
  [2, 9, 9, 0, 4.20, 25.0, -2.6, -2.6, 3.7, 2.0, -3, 0, 2, 23, 1.288, 5, 97],
  [3, 9, 9, 1, 4.20, 25.0, -1.6, -1.6, 2.0, 2.0, -5, 0, 2, 18, 1.479, 5, 96],
  [4, 9, 9, 1, 4.20, 25.0, -0.0, -0.0, 0.0, 2.0, -8, 0, 2, 12, 1.698, 5, 95],
  [5, 9, 9, 1, 4.20, 25.0, 1.3, 1.3, -6, 3.5, -11, 0, 2, 8, 1.950, 5, 94.2],
  [6, 9, 9, 1, 4.50, 100.0, 2.2, 2.3, -12.0, 6.0, -14, 0, 2, 4, 2.239, 3, 93.9],
  [7, 9, 9, 1, 4.80, 200.0, 2.7, 2.7, -18.0, 9.0, -17, 0, 2, 0, 2.570, 1, 93.6],
  [8, 9, 9, 1, 5.30, 300.0, 2.8, 2.8, -21.0, 10.0, -23, 0.0002, 0, 0, 2.951, 0, 93.3],
  [9, 9, 9, 1, 6.60, 300.0, 2.8, 2.8, -23.0, 11.0, -25, 0.0006, 0, 0, 3.388, 0, 93.3],
  [10, 9, 9, 1, 25.00, 300.0, 2.8, 2.8, -25.0, 12.0, -27, 0.0025, 0, 0, 3.500, 0, 93.3],
].map(vp);

function get_vbr_preset(v: number): VbrPreset[] {
  switch (v) {
    case vbr_mtrh:
    case vbr_mt:
      return vbr_mt_psy_switch_map;
    default:
      return vbr_old_switch_map;
  }
}

/** p + x * (q - p) evaluated in single precision. */
function LERP(p: number, q: number, x: number): number {
  return f(p + f(x * f(q - p)));
}

function apply_vbr_preset(gfp: LameGlobalFlags, a: number, enforce: number): void {
  const vbr_preset = get_vbr_preset(gfp.VBR);
  const x = gfp.VBR_q_frac;
  const p = vbr_preset[a];
  const q = vbr_preset[a + 1];

  const set: VbrPreset = {
    vbr_q: p.vbr_q,
    quant_comp: p.quant_comp,
    quant_comp_s: p.quant_comp_s,
    expY: p.expY,
    st_lrm: LERP(p.st_lrm, q.st_lrm, x),
    st_s: LERP(p.st_s, q.st_s, x),
    masking_adj: LERP(p.masking_adj, q.masking_adj, x),
    masking_adj_short: LERP(p.masking_adj_short, q.masking_adj_short, x),
    ath_lower: LERP(p.ath_lower, q.ath_lower, x),
    ath_curve: LERP(p.ath_curve, q.ath_curve, x),
    ath_sensitivity: LERP(p.ath_sensitivity, q.ath_sensitivity, x),
    interch: LERP(p.interch, q.interch, x),
    safejoint: p.safejoint,
    /* int = int + float * int */
    sfb21mod: Math.trunc(f(p.sfb21mod + f(x * (q.sfb21mod - p.sfb21mod)))),
    msfix: LERP(p.msfix, q.msfix, x),
    minval: LERP(p.minval, q.minval, x),
    ath_fixpoint: LERP(p.ath_fixpoint, q.ath_fixpoint, x),
  };

  lame_set_VBR_q(gfp, set.vbr_q);
  if (enforce || unset(gfp.quant_comp, -1)) gfp.quant_comp = set.quant_comp;
  if (enforce || unset(gfp.quant_comp_short, -1)) gfp.quant_comp_short = set.quant_comp_s;
  if (set.expY) {
    gfp.experimentalY = set.expY;
  }
  if (enforce || unset(gfp.attackthre, -1)) gfp.attackthre = set.st_lrm;
  if (enforce || unset(gfp.attackthre_s, -1)) gfp.attackthre_s = set.st_s;
  if (enforce || unset(gfp.maskingadjust, 0)) gfp.maskingadjust = set.masking_adj;
  if (enforce || unset(gfp.maskingadjust_short, 0)) gfp.maskingadjust_short = set.masking_adj_short;
  if (gfp.VBR === vbr_mt || gfp.VBR === vbr_mtrh) {
    gfp.ATHtype = 5;
  }
  if (enforce || unset(gfp.ATH_lower_db, 0)) gfp.ATH_lower_db = set.ath_lower;
  if (enforce || unset(gfp.ATHcurve, -1)) gfp.ATHcurve = set.ath_curve;
  if (enforce || unset(gfp.athaa_sensitivity, 0)) gfp.athaa_sensitivity = set.ath_sensitivity;
  if (set.interch > 0) {
    if (enforce || unset(gfp.interChRatio, -1)) lame_set_interChRatio(gfp, set.interch);
  }

  /* parameters for which there is no proper set/get interface */
  if (set.safejoint > 0) {
    gfp.exp_nspsytune = gfp.exp_nspsytune | 2;
  }
  if (set.sfb21mod > 0) {
    const nsp = gfp.exp_nspsytune;
    const val = (nsp >> 20) & 63;
    if (val === 0) {
      gfp.exp_nspsytune = (set.sfb21mod << 20) | nsp;
    }
  }
  if (enforce || unset(gfp.msfix, -1)) gfp.msfix = set.msfix;

  if (enforce === 0) {
    gfp.VBR_q = a;
    gfp.VBR_q_frac = x;
  }
  gfp.internal_flags.cfg.minval = set.minval;
  {
    /* take care of gain adjustments */
    const xs = Math.abs(gfp.scale);
    const y = xs > 0 ? 10 * Math.log10(xs) : 0;
    gfp.internal_flags.cfg.ATHfixpoint = f(set.ath_fixpoint - y);
  }
}

/*
 *  Switch mappings for ABR mode
 */
// prettier-ignore
const abr_switch_map = [
  /* kbps  quant q_s safejoint nsmsfix st_lrm  st_s  scale   msk ath_lwr ath_curve  interch , sfscale */
  [8, 9, 9, 0, 0, 6.60, 145, 0.95, 0, -30.0, 11, 0.0012, 1], /*   8, impossible to use in stereo */
  [16, 9, 9, 0, 0, 6.60, 145, 0.95, 0, -25.0, 11, 0.0010, 1], /*  16 */
  [24, 9, 9, 0, 0, 6.60, 145, 0.95, 0, -20.0, 11, 0.0010, 1], /*  24 */
  [32, 9, 9, 0, 0, 6.60, 145, 0.95, 0, -15.0, 11, 0.0010, 1], /*  32 */
  [40, 9, 9, 0, 0, 6.60, 145, 0.95, 0, -10.0, 11, 0.0009, 1], /*  40 */
  [48, 9, 9, 0, 0, 6.60, 145, 0.95, 0, -10.0, 11, 0.0009, 1], /*  48 */
  [56, 9, 9, 0, 0, 6.60, 145, 0.95, 0, -6.0, 11, 0.0008, 1], /*  56 */
  [64, 9, 9, 0, 0, 6.60, 145, 0.95, 0, -2.0, 11, 0.0008, 1], /*  64 */
  [80, 9, 9, 0, 0, 6.60, 145, 0.95, 0, 0.0, 8, 0.0007, 1], /*  80 */
  [96, 9, 9, 0, 2.50, 6.60, 145, 0.95, 0, 1.0, 5.5, 0.0006, 1], /*  96 */
  [112, 9, 9, 0, 2.25, 6.60, 145, 0.95, 0, 2.0, 4.5, 0.0005, 1], /* 112 */
  [128, 9, 9, 0, 1.95, 6.40, 140, 0.95, 0, 3.0, 4, 0.0002, 1], /* 128 */
  [160, 9, 9, 1, 1.79, 6.00, 135, 0.95, -2, 5.0, 3.5, 0, 1], /* 160 */
  [192, 9, 9, 1, 1.49, 5.60, 125, 0.97, -4, 7.0, 3, 0, 0], /* 192 */
  [224, 9, 9, 1, 1.25, 5.20, 125, 0.98, -6, 9.0, 2, 0, 0], /* 224 */
  [256, 9, 9, 1, 0.97, 5.20, 125, 1.00, -8, 10.0, 1, 0, 0], /* 256 */
  [320, 9, 9, 1, 0.90, 5.20, 125, 1.00, -10, 12.0, 0, 0, 0], /* 320 */
].map((r) => ({
  abr_kbps: r[0],
  quant_comp: r[1],
  quant_comp_s: r[2],
  safejoint: r[3],
  nsmsfix: f(r[4]),
  st_lrm: f(r[5]),
  st_s: f(r[6]),
  scale: f(r[7]),
  masking_adj: f(r[8]),
  ath_lower: f(r[9]),
  ath_curve: f(r[10]),
  interch: f(r[11]),
  sfscale: r[12],
}));

function apply_abr_preset(gfp: LameGlobalFlags, preset: number, enforce: number): number {
  /* Variables for the ABR stuff */
  const actual_bitrate = preset;

  const m = abr_switch_map[nearestBitrateFullIndex(preset)];

  gfp.VBR = vbr_abr;
  gfp.VBR_mean_bitrate_kbps = actual_bitrate;
  gfp.VBR_mean_bitrate_kbps = Math.min(gfp.VBR_mean_bitrate_kbps, 320);
  gfp.VBR_mean_bitrate_kbps = Math.max(gfp.VBR_mean_bitrate_kbps, 8);
  lame_set_brate(gfp, gfp.VBR_mean_bitrate_kbps);

  /* parameters for which there is no proper set/get interface */
  if (m.safejoint > 0) gfp.exp_nspsytune = gfp.exp_nspsytune | 2; /* safejoint */

  if (m.sfscale > 0) gfp.noise_shaping = 2;

  if (enforce || unset(gfp.quant_comp, -1)) gfp.quant_comp = m.quant_comp;
  if (enforce || unset(gfp.quant_comp_short, -1)) gfp.quant_comp_short = m.quant_comp_s;

  if (enforce || unset(gfp.msfix, -1)) gfp.msfix = m.nsmsfix;

  if (enforce || unset(gfp.attackthre, -1)) gfp.attackthre = m.st_lrm;
  if (enforce || unset(gfp.attackthre_s, -1)) gfp.attackthre_s = m.st_s;

  /* ABR seems to have big problems with clipping, especially at low bitrates */
  /* so we compensate for that here by using a scale value depending on bitrate */
  gfp.scale = f(gfp.scale * m.scale);

  if (enforce || unset(gfp.maskingadjust, 0)) gfp.maskingadjust = m.masking_adj;
  if (m.masking_adj > 0) {
    if (enforce || unset(gfp.maskingadjust_short, 0)) gfp.maskingadjust_short = f(m.masking_adj * 0.9);
  } else {
    if (enforce || unset(gfp.maskingadjust_short, 0)) gfp.maskingadjust_short = f(m.masking_adj * 1.1);
  }

  if (enforce || unset(gfp.ATH_lower_db, 0)) gfp.ATH_lower_db = m.ath_lower;
  if (enforce || unset(gfp.ATHcurve, -1)) gfp.ATHcurve = m.ath_curve;

  if (enforce || unset(gfp.interChRatio, -1)) lame_set_interChRatio(gfp, m.interch);

  gfp.internal_flags.cfg.minval = f(5 * (m.abr_kbps / 320));

  return preset;
}

export function apply_preset(gfp: LameGlobalFlags, preset: number, enforce: number): number {
  /*translate legacy presets */
  switch (preset) {
    case R3MIX: {
      preset = V3;
      gfp.VBR = vbr_mtrh;
      break;
    }
    case MEDIUM:
    case MEDIUM_FAST: {
      preset = V4;
      gfp.VBR = vbr_mtrh;
      break;
    }
    case STANDARD:
    case STANDARD_FAST: {
      preset = V2;
      gfp.VBR = vbr_mtrh;
      break;
    }
    case EXTREME:
    case EXTREME_FAST: {
      preset = V0;
      gfp.VBR = vbr_mtrh;
      break;
    }
    case INSANE: {
      preset = 320;
      gfp.preset = preset;
      apply_abr_preset(gfp, preset, enforce);
      gfp.VBR = vbr_off;
      return preset;
    }
  }

  gfp.preset = preset;
  {
    const vq = [V0, V1, V2, V3, V4, V5, V6, V7, V8, V9].indexOf(preset);
    if (vq >= 0) {
      apply_vbr_preset(gfp, vq, enforce);
      return preset;
    }
  }
  if (8 <= preset && preset <= 320) {
    return apply_abr_preset(gfp, preset, enforce);
  }

  gfp.preset = 0; /*no corresponding preset found */
  return preset;
}
