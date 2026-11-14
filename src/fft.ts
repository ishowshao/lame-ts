// Port of libmp3lame/fft.c - FFT (as a fast Hartley transform) used by the psychoacoustic model.

import { BLKSIZE, BLKSIZE_s, PI, SQRT2, f } from './constants.ts';
import { costab, rv_tbl } from './tables.ts';

function fht(fz: Float32Array, n: number): void {
  let tri = 0;
  let k4: number;
  let fi: number, gi: number;

  n <<= 1; /* to get BLKSIZE, because of 3DNow! ASM routine */
  const fn = n;
  k4 = 4;
  do {
    let s1: number, c1: number;
    const kx = k4 >> 1;
    const k1 = k4;
    const k2 = k4 << 1;
    const k3 = k2 + k1;
    k4 = k2 << 1;
    fi = 0;
    gi = fi + kx;
    do {
      let f0: number, f1: number, f2: number, f3: number;
      f1 = f(fz[fi] - fz[fi + k1]);
      f0 = f(fz[fi] + fz[fi + k1]);
      f3 = f(fz[fi + k2] - fz[fi + k3]);
      f2 = f(fz[fi + k2] + fz[fi + k3]);
      fz[fi + k2] = f0 - f2;
      fz[fi] = f0 + f2;
      fz[fi + k3] = f1 - f3;
      fz[fi + k1] = f1 + f3;
      f1 = f(fz[gi] - fz[gi + k1]);
      f0 = f(fz[gi] + fz[gi + k1]);
      f3 = f(SQRT2 * fz[gi + k3]);
      f2 = f(SQRT2 * fz[gi + k2]);
      fz[gi + k2] = f0 - f2;
      fz[gi] = f0 + f2;
      fz[gi + k3] = f1 - f3;
      fz[gi + k1] = f1 + f3;
      gi += k4;
      fi += k4;
    } while (fi < fn);
    c1 = costab[tri];
    s1 = costab[tri + 1];
    for (let i = 1; i < kx; i++) {
      let c2 = f(1 - f(f(2 * s1) * s1));
      const s2 = f(f(2 * s1) * c1);
      fi = i;
      gi = k1 - i;
      do {
        let a: number, b: number;
        b = f(f(s2 * fz[fi + k1]) - f(c2 * fz[gi + k1]));
        a = f(f(c2 * fz[fi + k1]) + f(s2 * fz[gi + k1]));
        const f1 = f(fz[fi] - a);
        const f0 = f(fz[fi] + a);
        const g1 = f(fz[gi] - b);
        const g0 = f(fz[gi] + b);
        b = f(f(s2 * fz[fi + k3]) - f(c2 * fz[gi + k3]));
        a = f(f(c2 * fz[fi + k3]) + f(s2 * fz[gi + k3]));
        const f3 = f(fz[fi + k2] - a);
        const f2 = f(fz[fi + k2] + a);
        const g3 = f(fz[gi + k2] - b);
        const g2 = f(fz[gi + k2] + b);
        b = f(f(s1 * f2) - f(c1 * g3));
        a = f(f(c1 * f2) + f(s1 * g3));
        fz[fi + k2] = f0 - a;
        fz[fi] = f0 + a;
        fz[gi + k3] = g1 - b;
        fz[gi + k1] = g1 + b;
        b = f(f(c1 * g2) - f(s1 * f3));
        a = f(f(s1 * g2) + f(c1 * f3));
        fz[gi + k2] = g0 - a;
        fz[gi] = g0 + a;
        fz[fi + k3] = f1 - b;
        fz[fi + k1] = f1 + b;
        gi += k4;
        fi += k4;
      } while (fi < fn);
      c2 = c1;
      c1 = f(f(c2 * costab[tri]) - f(s1 * costab[tri + 1]));
      s1 = f(f(c2 * costab[tri + 1]) + f(s1 * costab[tri]));
    }
    tri += 2;
  } while (k4 < n);
}

/**
 * Windowed short-block FFTs (3 x 256) of `buffer[bo..]`.
 * `x_real` receives the three transforms.
 */
export function fft_short(
  window_s: Float32Array,
  x_real: Float32Array[],
  buffer: Float32Array,
  bo: number,
): void {
  for (let b = 0; b < 3; b++) {
    const x = x_real[b];
    let xi = BLKSIZE_s / 2;
    const k = ((576 / 3) | 0) * (b + 1) + bo;
    let j = BLKSIZE_s / 8 - 1;
    do {
      let f0: number, f1: number, f2: number, f3: number, w: number;
      const i = rv_tbl[j << 2];

      f0 = f(window_s[i] * buffer[i + k]);
      w = f(window_s[0x7f - i] * buffer[i + k + 0x80]);
      f1 = f(f0 - w);
      f0 = f(f0 + w);
      f2 = f(window_s[i + 0x40] * buffer[i + k + 0x40]);
      w = f(window_s[0x3f - i] * buffer[i + k + 0xc0]);
      f3 = f(f2 - w);
      f2 = f(f2 + w);

      xi -= 4;
      x[xi] = f0 + f2;
      x[xi + 2] = f0 - f2;
      x[xi + 1] = f1 + f3;
      x[xi + 3] = f1 - f3;

      f0 = f(window_s[i + 0x01] * buffer[i + k + 0x01]);
      w = f(window_s[0x7e - i] * buffer[i + k + 0x81]);
      f1 = f(f0 - w);
      f0 = f(f0 + w);
      f2 = f(window_s[i + 0x41] * buffer[i + k + 0x41]);
      w = f(window_s[0x3e - i] * buffer[i + k + 0xc1]);
      f3 = f(f2 - w);
      f2 = f(f2 + w);

      x[xi + BLKSIZE_s / 2] = f0 + f2;
      x[xi + BLKSIZE_s / 2 + 2] = f0 - f2;
      x[xi + BLKSIZE_s / 2 + 1] = f1 + f3;
      x[xi + BLKSIZE_s / 2 + 3] = f1 - f3;
    } while (--j >= 0);

    fht(x, BLKSIZE_s / 2);
  }
}

/** Windowed long-block FFT (1024) of `buffer[bo..]` into `x`. */
export function fft_long(window: Float32Array, x: Float32Array, buffer: Float32Array, bo: number): void {
  let jj = BLKSIZE / 8 - 1;
  let xi = BLKSIZE / 2;

  do {
    let f0: number, f1: number, f2: number, f3: number, w: number;
    const i = rv_tbl[jj];
    const p = i + bo;

    f0 = f(window[i] * buffer[p]);
    w = f(window[i + 0x200] * buffer[p + 0x200]);
    f1 = f(f0 - w);
    f0 = f(f0 + w);
    f2 = f(window[i + 0x100] * buffer[p + 0x100]);
    w = f(window[i + 0x300] * buffer[p + 0x300]);
    f3 = f(f2 - w);
    f2 = f(f2 + w);

    xi -= 4;
    x[xi] = f0 + f2;
    x[xi + 2] = f0 - f2;
    x[xi + 1] = f1 + f3;
    x[xi + 3] = f1 - f3;

    f0 = f(window[i + 0x001] * buffer[p + 0x001]);
    w = f(window[i + 0x201] * buffer[p + 0x201]);
    f1 = f(f0 - w);
    f0 = f(f0 + w);
    f2 = f(window[i + 0x101] * buffer[p + 0x101]);
    w = f(window[i + 0x301] * buffer[p + 0x301]);
    f3 = f(f2 - w);
    f2 = f(f2 + w);

    x[xi + BLKSIZE / 2] = f0 + f2;
    x[xi + BLKSIZE / 2 + 2] = f0 - f2;
    x[xi + BLKSIZE / 2 + 1] = f1 + f3;
    x[xi + BLKSIZE / 2 + 3] = f1 - f3;
  } while (--jj >= 0);

  fht(x, BLKSIZE / 2);
}

/** Builds the Blackman (long) and Hann (short) analysis windows. */
export function init_fft(window: Float32Array, window_s: Float32Array): void {
  for (let i = 0; i < BLKSIZE; i++) {
    window[i] =
      0.42 - 0.5 * Math.cos((2 * PI * (i + 0.5)) / BLKSIZE) + 0.08 * Math.cos((4 * PI * (i + 0.5)) / BLKSIZE);
  }
  for (let i = 0; i < BLKSIZE_s / 2; i++) {
    window_s[i] = 0.5 * (1.0 - Math.cos((2.0 * PI * (i + 0.5)) / BLKSIZE_s));
  }
}
