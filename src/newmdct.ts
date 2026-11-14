// Port of libmp3lame/newmdct.c - polyphase analysis filterbank and MDCT (Takehiro Tominaga's routines).

import { SHORT_TYPE, SQRT2, f } from './constants.ts';
import { enwindow, win } from './tables.ts';
import type { LameInternalFlags } from './types.ts';

const NS = 12;
const NL = 36;

// The SHORT_TYPE row of `win` also carries these packed tables.
const WS = SHORT_TYPE * NL;
const tantab_l = WS + 3;
const cx = WS + 12;
const ca = WS + 20;
const cs = WS + 28;

const order = [
  0, 1, 16, 17, 8, 9, 24, 25, 4, 5, 20, 21, 12, 13, 28, 29, 2, 3, 18, 19, 10, 11, 26, 27, 6, 7, 22, 23, 14, 15, 30,
  31,
];

/** Scratch output of window_subband. */
const a = new Float32Array(32);

/**
 * Overlapping analysis window on PCM samples: computes the 32 subband samples for the
 * window positioned at `x[x1]` and stores them to `out[oo..oo+32)`.
 */
function window_subband(x: Float32Array, x1: number, out: Float32Array, oo: number): void {
  let wp = 10;
  let x2 = x1 + 238 - 14 - 286;

  for (let i = -15; i < 0; i++) {
    let w: number, s: number, t: number;

    w = enwindow[wp - 10];
    s = f(x[x2 - 224] * w);
    t = f(x[x1 + 224] * w);
    w = enwindow[wp - 9];
    s = f(s + f(x[x2 - 160] * w));
    t = f(t + f(x[x1 + 160] * w));
    w = enwindow[wp - 8];
    s = f(s + f(x[x2 - 96] * w));
    t = f(t + f(x[x1 + 96] * w));
    w = enwindow[wp - 7];
    s = f(s + f(x[x2 - 32] * w));
    t = f(t + f(x[x1 + 32] * w));
    w = enwindow[wp - 6];
    s = f(s + f(x[x2 + 32] * w));
    t = f(t + f(x[x1 - 32] * w));
    w = enwindow[wp - 5];
    s = f(s + f(x[x2 + 96] * w));
    t = f(t + f(x[x1 - 96] * w));
    w = enwindow[wp - 4];
    s = f(s + f(x[x2 + 160] * w));
    t = f(t + f(x[x1 - 160] * w));
    w = enwindow[wp - 3];
    s = f(s + f(x[x2 + 224] * w));
    t = f(t + f(x[x1 - 224] * w));

    w = enwindow[wp - 2];
    s = f(s + f(x[x1 - 256] * w));
    t = f(t - f(x[x2 + 256] * w));
    w = enwindow[wp - 1];
    s = f(s + f(x[x1 - 192] * w));
    t = f(t - f(x[x2 + 192] * w));
    w = enwindow[wp];
    s = f(s + f(x[x1 - 128] * w));
    t = f(t - f(x[x2 + 128] * w));
    w = enwindow[wp + 1];
    s = f(s + f(x[x1 - 64] * w));
    t = f(t - f(x[x2 + 64] * w));
    w = enwindow[wp + 2];
    s = f(s + f(x[x1] * w));
    t = f(t - f(x[x2] * w));
    w = enwindow[wp + 3];
    s = f(s + f(x[x1 + 64] * w));
    t = f(t - f(x[x2 - 64] * w));
    w = enwindow[wp + 4];
    s = f(s + f(x[x1 + 128] * w));
    t = f(t - f(x[x2 - 128] * w));
    w = enwindow[wp + 5];
    s = f(s + f(x[x1 + 192] * w));
    t = f(t - f(x[x2 - 192] * w));

    s = f(s * enwindow[wp + 6]);
    w = f(t - s);
    a[30 + i * 2] = t + s;
    a[31 + i * 2] = enwindow[wp + 7] * w;
    wp += 18;
    x1--;
    x2++;
  }
  {
    let s: number, t: number;

    t = f(x[x1 - 16] * enwindow[wp - 10]);
    s = f(x[x1 - 32] * enwindow[wp - 2]);
    t = f(t + f(f(x[x1 - 48] - x[x1 + 16]) * enwindow[wp - 9]));
    s = f(s + f(x[x1 - 96] * enwindow[wp - 1]));
    t = f(t + f(f(x[x1 - 80] + x[x1 + 48]) * enwindow[wp - 8]));
    s = f(s + f(x[x1 - 160] * enwindow[wp]));
    t = f(t + f(f(x[x1 - 112] - x[x1 + 80]) * enwindow[wp - 7]));
    s = f(s + f(x[x1 - 224] * enwindow[wp + 1]));
    t = f(t + f(f(x[x1 - 144] + x[x1 + 112]) * enwindow[wp - 6]));
    s = f(s - f(x[x1 + 32] * enwindow[wp + 2]));
    t = f(t + f(f(x[x1 - 176] - x[x1 + 144]) * enwindow[wp - 5]));
    s = f(s - f(x[x1 + 96] * enwindow[wp + 3]));
    t = f(t + f(f(x[x1 - 208] + x[x1 + 176]) * enwindow[wp - 4]));
    s = f(s - f(x[x1 + 160] * enwindow[wp + 4]));
    t = f(t + f(f(x[x1 - 240] - x[x1 + 208]) * enwindow[wp - 3]));
    s = f(s - x[x1 + 224]);

    const u = f(s - t);
    const v = f(s + t);

    t = a[14];
    s = f(a[15] - t);

    a[31] = v + t; /* A0 */
    a[30] = u + s; /* A1 */
    a[15] = u - s; /* A2 */
    a[14] = v - t; /* A3 */
  }
  let xr: number;
  xr = f(a[28] - a[0]);
  a[0] += a[28];
  a[28] = xr * enwindow[wp + -2*18+7];
  xr = f(a[29] - a[1]);
  a[1] += a[29];
  a[29] = xr * enwindow[wp + -2*18+7];

  xr = f(a[26] - a[2]);
  a[2] += a[26];
  a[26] = xr * enwindow[wp + -4*18+7];
  xr = f(a[27] - a[3]);
  a[3] += a[27];
  a[27] = xr * enwindow[wp + -4*18+7];

  xr = f(a[24] - a[4]);
  a[4] += a[24];
  a[24] = xr * enwindow[wp + -6*18+7];
  xr = f(a[25] - a[5]);
  a[5] += a[25];
  a[25] = xr * enwindow[wp + -6*18+7];

  xr = f(a[22] - a[6]);
  a[6] += a[22];
  a[22] = xr * SQRT2;
  xr = f(a[23] - a[7]);
  a[7] += a[23];
  a[23] = xr * SQRT2 - a[7];
  a[7] -= a[6];
  a[22] -= a[7];
  a[23] -= a[22];

  xr = f(a[6]);
  a[6] = a[31] - xr;
  a[31] = a[31] + xr;
  xr = f(a[7]);
  a[7] = a[30] - xr;
  a[30] = a[30] + xr;
  xr = f(a[22]);
  a[22] = a[15] - xr;
  a[15] = a[15] + xr;
  xr = f(a[23]);
  a[23] = a[14] - xr;
  a[14] = a[14] + xr;

  xr = f(a[20] - a[8]);
  a[8] += a[20];
  a[20] = xr * enwindow[wp + -10*18+7];
  xr = f(a[21] - a[9]);
  a[9] += a[21];
  a[21] = xr * enwindow[wp + -10*18+7];

  xr = f(a[18] - a[10]);
  a[10] += a[18];
  a[18] = xr * enwindow[wp + -12*18+7];
  xr = f(a[19] - a[11]);
  a[11] += a[19];
  a[19] = xr * enwindow[wp + -12*18+7];

  xr = f(a[16] - a[12]);
  a[12] += a[16];
  a[16] = xr * enwindow[wp + -14*18+7];
  xr = f(a[17] - a[13]);
  a[13] += a[17];
  a[17] = xr * enwindow[wp + -14*18+7];

  xr = f(-a[20] + a[24]);
  a[20] += a[24];
  a[24] = xr * enwindow[wp + -12*18+7];
  xr = f(-a[21] + a[25]);
  a[21] += a[25];
  a[25] = xr * enwindow[wp + -12*18+7];

  xr = f(a[4] - a[8]);
  a[4] += a[8];
  a[8] = xr * enwindow[wp + -12*18+7];
  xr = f(a[5] - a[9]);
  a[5] += a[9];
  a[9] = xr * enwindow[wp + -12*18+7];

  xr = f(a[0] - a[12]);
  a[0] += a[12];
  a[12] = xr * enwindow[wp + -4*18+7];
  xr = f(a[1] - a[13]);
  a[1] += a[13];
  a[13] = xr * enwindow[wp + -4*18+7];
  xr = f(a[16] - a[28]);
  a[16] += a[28];
  a[28] = xr * enwindow[wp + -4*18+7];
  xr = f(-a[17] + a[29]);
  a[17] += a[29];
  a[29] = xr * enwindow[wp + -4*18+7];

  xr = f(SQRT2 * f(a[2] - a[10]));
  a[2] += a[10];
  a[10] = xr;
  xr = f(SQRT2 * f(a[3] - a[11]));
  a[3] += a[11];
  a[11] = xr;
  xr = f(SQRT2 * f(-a[18] + a[26]));
  a[18] += a[26];
  a[26] = xr - a[18];
  xr = f(SQRT2 * f(-a[19] + a[27]));
  a[19] += a[27];
  a[27] = xr - a[19];

  xr = f(a[2]);
  a[19] -= a[3];
  a[3] -= xr;
  a[2] = a[31] - xr;
  a[31] += xr;
  xr = f(a[3]);
  a[11] -= a[19];
  a[18] -= xr;
  a[3] = a[30] - xr;
  a[30] += xr;
  xr = f(a[18]);
  a[27] -= a[11];
  a[19] -= xr;
  a[18] = a[15] - xr;
  a[15] += xr;

  xr = f(a[19]);
  a[10] -= xr;
  a[19] = a[14] - xr;
  a[14] += xr;
  xr = f(a[10]);
  a[11] -= xr;
  a[10] = a[23] - xr;
  a[23] += xr;
  xr = f(a[11]);
  a[26] -= xr;
  a[11] = a[22] - xr;
  a[22] += xr;
  xr = f(a[26]);
  a[27] -= xr;
  a[26] = a[7] - xr;
  a[7] += xr;

  xr = f(a[27]);
  a[27] = a[6] - xr;
  a[6] += xr;

  xr = f(SQRT2 * f(a[0] - a[4]));
  a[0] += a[4];
  a[4] = xr;
  xr = f(SQRT2 * f(a[1] - a[5]));
  a[1] += a[5];
  a[5] = xr;
  xr = f(SQRT2 * f(a[16] - a[20]));
  a[16] += a[20];
  a[20] = xr;
  xr = f(SQRT2 * f(a[17] - a[21]));
  a[17] += a[21];
  a[21] = xr;

  xr = f(-SQRT2 * f(a[8] - a[12]));
  a[8] += a[12];
  a[12] = xr - a[8];
  xr = f(-SQRT2 * f(a[9] - a[13]));
  a[9] += a[13];
  a[13] = xr - a[9];
  xr = f(-SQRT2 * f(a[25] - a[29]));
  a[25] += a[29];
  a[29] = xr - a[25];
  xr = f(-SQRT2 * f(a[24] + a[28]));
  a[24] -= a[28];
  a[28] = xr - a[24];

  xr = f(a[24] - a[16]);
  a[24] = xr;
  xr = f(a[20] - xr);
  a[20] = xr;
  xr = f(a[28] - xr);
  a[28] = xr;

  xr = f(a[25] - a[17]);
  a[25] = xr;
  xr = f(a[21] - xr);
  a[21] = xr;
  xr = f(a[29] - xr);
  a[29] = xr;

  xr = f(a[17] - a[1]);
  a[17] = xr;
  xr = f(a[9] - xr);
  a[9] = xr;
  xr = f(a[25] - xr);
  a[25] = xr;
  xr = f(a[5] - xr);
  a[5] = xr;
  xr = f(a[21] - xr);
  a[21] = xr;
  xr = f(a[13] - xr);
  a[13] = xr;
  xr = f(a[29] - xr);
  a[29] = xr;

  xr = f(a[1] - a[0]);
  a[1] = xr;
  xr = f(a[16] - xr);
  a[16] = xr;
  xr = f(a[17] - xr);
  a[17] = xr;
  xr = f(a[8] - xr);
  a[8] = xr;
  xr = f(a[9] - xr);
  a[9] = xr;
  xr = f(a[24] - xr);
  a[24] = xr;
  xr = f(a[25] - xr);
  a[25] = xr;
  xr = f(a[4] - xr);
  a[4] = xr;
  xr = f(a[5] - xr);
  a[5] = xr;
  xr = f(a[20] - xr);
  a[20] = xr;
  xr = f(a[21] - xr);
  a[21] = xr;
  xr = f(a[12] - xr);
  a[12] = xr;
  xr = f(a[13] - xr);
  a[13] = xr;
  xr = f(a[28] - xr);
  a[28] = xr;
  xr = f(a[29] - xr);
  a[29] = xr;

  xr = f(a[0]);
  a[0] += a[31];
  a[31] -= xr;
  xr = f(a[1]);
  a[1] += a[30];
  a[30] -= xr;
  xr = f(a[16]);
  a[16] += a[15];
  a[15] -= xr;
  xr = f(a[17]);
  a[17] += a[14];
  a[14] -= xr;
  xr = f(a[8]);
  a[8] += a[23];
  a[23] -= xr;
  xr = f(a[9]);
  a[9] += a[22];
  a[22] -= xr;
  xr = f(a[24]);
  a[24] += a[7];
  a[7] -= xr;
  xr = f(a[25]);
  a[25] += a[6];
  a[6] -= xr;
  xr = f(a[4]);
  a[4] += a[27];
  a[27] -= xr;
  xr = f(a[5]);
  a[5] += a[26];
  a[26] -= xr;
  xr = f(a[20]);
  a[20] += a[11];
  a[11] -= xr;
  xr = f(a[21]);
  a[21] += a[10];
  a[10] -= xr;
  xr = f(a[12]);
  a[12] += a[19];
  a[19] -= xr;
  xr = f(a[13]);
  a[13] += a[18];
  a[18] -= xr;
  xr = f(a[28]);
  a[28] += a[3];
  a[3] -= xr;
  xr = f(a[29]);
  a[29] += a[2];
  a[2] -= xr;
  out.set(a, oo);
}

/** Three short (12 -> 6) MDCTs, in place, results interleaved. */
function mdct_short(inout: Float32Array, o: number): void {
  const w0 = win[WS];
  const w1 = win[WS + 1];
  const w2 = win[WS + 2];
  for (let l = 0; l < 3; l++) {
    let tc0: number, tc1: number, tc2: number, ts0: number, ts1: number, ts2: number;

    ts0 = f(f(inout[o + 2 * 3] * w0) - inout[o + 5 * 3]);
    tc0 = f(f(inout[o] * w2) - inout[o + 3 * 3]);
    tc1 = f(ts0 + tc0);
    tc2 = f(ts0 - tc0);

    ts0 = f(f(inout[o + 5 * 3] * w0) + inout[o + 2 * 3]);
    tc0 = f(f(inout[o + 3 * 3] * w2) + inout[o]);
    ts1 = f(ts0 + tc0);
    ts2 = f(-ts0 + tc0);

    tc0 = f(f(f(inout[o + 1 * 3] * w1) - inout[o + 4 * 3]) * 2.069978111953089e-11); /* tritab_s[1] */
    ts0 = f(f(f(inout[o + 4 * 3] * w1) + inout[o + 1 * 3]) * 2.069978111953089e-11); /* tritab_s[1] */

    inout[o] = tc1 * 1.90752519173728e-11 /* tritab_s[2] */ + tc0;
    inout[o + 3 * 5] = -ts1 * 1.90752519173728e-11 /* tritab_s[0] */ + ts0;

    tc2 = f(tc2 * 0.86602540378443870761 * 1.907525191737281e-11); /* tritab_s[2] */
    ts1 = f(ts1 * 0.5 * 1.907525191737281e-11 + ts0);
    inout[o + 3 * 1] = tc2 - ts1;
    inout[o + 3 * 2] = tc2 + ts1;

    tc1 = f(tc1 * 0.5 * 1.907525191737281e-11 - tc0);
    ts2 = f(ts2 * 0.86602540378443870761 * 1.907525191737281e-11); /* tritab_s[0] */
    inout[o + 3 * 3] = tc1 + ts2;
    inout[o + 3 * 4] = tc1 - ts2;

    o++;
  }
}

/** Long (36 -> 18) MDCT of `inp[0..18)` into `out[o..o+18)`. */
function mdct_long(out: Float32Array, o: number, inp: Float32Array): void {
  let ct: number, st: number;
  const cx0 = win[cx];
  const cx1 = win[cx + 1];
  const cx2 = win[cx + 2];
  const cx3 = win[cx + 3];
  const cx4 = win[cx + 4];
  const cx5 = win[cx + 5];
  const cx6 = win[cx + 6];
  const cx7 = win[cx + 7];
  {
    /* 1,2, 5,6, 9,10, 13,14, 17 */
    const tc1 = f(inp[17] - inp[9]);
    const tc3 = f(inp[15] - inp[11]);
    const tc4 = f(inp[14] - inp[12]);
    const ts5 = f(inp[0] + inp[8]);
    let ts6 = f(inp[1] + inp[7]);
    const ts7 = f(inp[2] + inp[6]);
    const ts8 = f(inp[3] + inp[5]);

    out[o + 17] = f(f(ts5 + ts7) - ts8) - f(ts6 - inp[4]);
    st = f(f(f(f(ts5 + ts7) - ts8) * cx7) + f(ts6 - inp[4]));
    ct = f(f(f(tc1 - tc3) - tc4) * cx6);
    out[o + 5] = ct + st;
    out[o + 6] = ct - st;

    const tc2 = f(f(inp[16] - inp[10]) * cx6);
    ts6 = f(f(ts6 * cx7) + inp[4]);
    ct = f(f(f(f(tc1 * cx0) + tc2) + f(tc3 * cx1)) + f(tc4 * cx2));
    st = f(f(f(f(-ts5 * cx4) + ts6) - f(ts7 * cx5)) + f(ts8 * cx3));
    out[o + 1] = ct + st;
    out[o + 2] = ct - st;

    ct = f(f(f(f(tc1 * cx1) - tc2) - f(tc3 * cx2)) + f(tc4 * cx0));
    st = f(f(f(f(-ts5 * cx5) + ts6) - f(ts7 * cx3)) + f(ts8 * cx4));
    out[o + 9] = ct + st;
    out[o + 10] = ct - st;

    ct = f(f(f(f(tc1 * cx2) - tc2) + f(tc3 * cx0)) - f(tc4 * cx1));
    st = f(f(f(f(ts5 * cx3) - ts6) + f(ts7 * cx4)) - f(ts8 * cx5));
    out[o + 13] = ct + st;
    out[o + 14] = ct - st;
  }
  {
    const ts1 = f(inp[8] - inp[0]);
    const ts3 = f(inp[6] - inp[2]);
    const ts4 = f(inp[5] - inp[3]);
    const tc5 = f(inp[17] + inp[9]);
    let tc6 = f(inp[16] + inp[10]);
    const tc7 = f(inp[15] + inp[11]);
    const tc8 = f(inp[14] + inp[12]);

    out[o] = f(f(tc5 + tc7) + tc8) + f(tc6 + inp[13]);
    ct = f(f(f(f(tc5 + tc7) + tc8) * cx7) - f(tc6 + inp[13]));
    st = f(f(f(ts1 - ts3) + ts4) * cx6);
    out[o + 11] = ct + st;
    out[o + 12] = ct - st;

    const ts2 = f(f(inp[7] - inp[1]) * cx6);
    tc6 = f(inp[13] - f(tc6 * cx7));
    ct = f(f(f(f(tc5 * cx3) - tc6) + f(tc7 * cx4)) + f(tc8 * cx5));
    st = f(f(f(f(ts1 * cx2) + ts2) + f(ts3 * cx0)) + f(ts4 * cx1));
    out[o + 3] = ct + st;
    out[o + 4] = ct - st;

    ct = f(f(f(f(-tc5 * cx5) + tc6) - f(tc7 * cx3)) - f(tc8 * cx4));
    st = f(f(f(f(ts1 * cx1) + ts2) - f(ts3 * cx2)) - f(ts4 * cx0));
    out[o + 7] = ct + st;
    out[o + 8] = ct - st;

    ct = f(f(f(f(-tc5 * cx4) + tc6) - f(tc7 * cx5)) - f(tc8 * cx3));
    st = f(f(f(f(ts1 * cx0) - ts2) + f(ts3 * cx1)) - f(ts4 * cx2));
    out[o + 15] = ct + st;
    out[o + 16] = ct - st;
  }
}

const work = new Float32Array(18);

/**
 * Polyphase filterbank + MDCT for one frame. `w0`/`w1` are the per-channel PCM buffers,
 * the frame starts at index `wo`.
 */
export function mdct_sub48(gfc: LameInternalFlags, w0: Float32Array, w1: Float32Array, wo = 0): void {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  let w = w0;

  /* thinking cache performance, ch->gr loop is better than gr->ch loop */
  for (let ch = 0; ch < cfg.channels_out; ch++) {
    let wk = wo + 286;
    for (let gr = 0; gr < cfg.mode_gr; gr++) {
      const gi = gfc.l3_side.tt[gr][ch];
      const mdct_enc = gi.xr;
      let mo = 0;
      const sb1 = esv.sb_sample[ch][1 - gr];
      const sb0 = esv.sb_sample[ch][gr];
      let samp = 0;

      for (let k = 0; k < 18 / 2; k++) {
        window_subband(w, wk, sb1, samp);
        window_subband(w, wk + 32, sb1, samp + 32);
        samp += 64;
        wk += 64;
        /*
         * Compensate for inversion in the analysis filter
         */
        for (let band = 1; band < 32; band += 2) {
          sb1[samp + band - 32] *= -1;
        }
      }

      /*
       * Perform imdct of 18 previous subband samples
       * + 18 current subband samples
       */
      for (let band = 0; band < 32; band++, mo += 18) {
        let type = gi.block_type;
        const band0 = order[band];
        const band1 = order[band];
        if (gi.mixed_block_flag && band < 2) type = 0;
        if (esv.amp_filter[band] < 1e-12) {
          mdct_enc.fill(0, mo, mo + 18);
        } else {
          if (esv.amp_filter[band] < 1.0) {
            for (let k = 0; k < 18; k++) sb1[band1 + k * 32] *= esv.amp_filter[band];
          }
          if (type === SHORT_TYPE) {
            for (let k = -NS / 4; k < 0; k++) {
              const ww = win[WS + k + 3];
              mdct_enc[mo + k * 3 + 9] = f(sb0[band0 + (9 + k) * 32] * ww) - sb0[band0 + (8 - k) * 32];
              mdct_enc[mo + k * 3 + 18] = f(sb0[band0 + (14 - k) * 32] * ww) + sb0[band0 + (15 + k) * 32];
              mdct_enc[mo + k * 3 + 10] = f(sb0[band0 + (15 + k) * 32] * ww) - sb0[band0 + (14 - k) * 32];
              mdct_enc[mo + k * 3 + 19] = f(sb1[band1 + (2 - k) * 32] * ww) + sb1[band1 + (3 + k) * 32];
              mdct_enc[mo + k * 3 + 11] = f(sb1[band1 + (3 + k) * 32] * ww) - sb1[band1 + (2 - k) * 32];
              mdct_enc[mo + k * 3 + 20] = f(sb1[band1 + (8 - k) * 32] * ww) + sb1[band1 + (9 + k) * 32];
            }
            mdct_short(mdct_enc, mo);
          } else {
            const wt = type * NL;
            for (let k = -NL / 4; k < 0; k++) {
              const av = f(
                f(win[wt + k + 27] * sb1[band1 + (k + 9) * 32]) + f(win[wt + k + 36] * sb1[band1 + (8 - k) * 32]),
              );
              const bv = f(
                f(win[wt + k + 9] * sb0[band0 + (k + 9) * 32]) - f(win[wt + k + 18] * sb0[band0 + (8 - k) * 32]),
              );
              work[k + 9] = av - f(bv * win[tantab_l + k + 9]);
              work[k + 18] = f(av * win[tantab_l + k + 9]) + bv;
            }
            mdct_long(mdct_enc, mo, work);
          }
        }
        /*
         * Perform aliasing reduction butterfly
         */
        if (type !== SHORT_TYPE && band !== 0) {
          for (let k = 7; k >= 0; --k) {
            const bu = f(f(mdct_enc[mo + k] * win[ca + k]) + f(mdct_enc[mo - 1 - k] * win[cs + k]));
            const bd = f(f(mdct_enc[mo + k] * win[cs + k]) - f(mdct_enc[mo - 1 - k] * win[ca + k]));

            mdct_enc[mo - 1 - k] = bu;
            mdct_enc[mo + k] = bd;
          }
        }
      }
    }
    w = w1;
    if (cfg.mode_gr === 1) {
      esv.sb_sample[ch][0].set(esv.sb_sample[ch][1]);
    }
  }
}
