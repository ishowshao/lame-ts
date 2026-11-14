// Port of libmp3lame/lame.c - parameter setup and the buffering front end of the encoder.

import {
  copy_buffer,
  flush_bitstream,
  get_max_frame_buffer_size_by_constraint,
  init_bit_stream_w,
} from './bitstream.ts';
import {
  BLKSIZE,
  ENCDELAY,
  EQ,
  f,
  FFTOFFSET,
  INT_MAX,
  JOINT_STEREO,
  MDB_MAXIMUM,
  MONO,
  NEQ,
  NOT_SET,
  PI,
  POSTDELAY,
  PSFB12,
  PSFB21,
  SBMAX_l,
  SBMAX_s,
  short_block_allowed,
  short_block_coupled,
  short_block_not_set,
  STEREO,
  vbr_abr,
  vbr_mt,
  vbr_mtrh,
  vbr_off,
  vbr_rh,
} from './constants.ts';
import { lame_encode_mp3_frame } from './encoder.ts';
import {
  AnalyzeSamples,
  GAIN_ANALYSIS_ERROR,
  GAIN_NOT_ENOUGH_SAMPLES,
  GetTitleGain,
  INIT_GAIN_ANALYSIS_ERROR,
  InitGainAnalysis,
  ReplayGain,
} from './gain_analysis.ts';
import { apply_preset } from './presets.ts';
import { psymodel_init } from './psymodel.ts';
import { iteration_init } from './quantize_pvt.ts';
import { bitrate_table, sfBandIndex } from './tables.ts';
import type { LameGlobalFlags, LameInternalFlags, SessionConfig } from './types.ts';
import {
  BitrateIndex,
  fill_buffer,
  FindNearestBitrate,
  isResamplingNecessary,
  map2MP3Frequency,
  nearestBitrateFullIndex,
  powf,
  SmpFrqIndex,
  SmpFrqVersion,
} from './util.ts';
import { InitVbrTag } from './vbrtag.ts';

const LAME_DEFAULT_QUALITY = 3;

function filter_coef(x: number): number {
  if (x > 1.0) return 0.0;
  if (x <= 0.0) return 1.0;

  return f(Math.cos((PI / 2) * x));
}

function lame_init_params_ppflt(gfc: LameInternalFlags): void {
  const cfg = gfc.cfg;

  /***************************************************************/
  /* compute info needed for polyphase filter (filter type==0, default) */
  /***************************************************************/

  let band: number, maxband: number, minband: number;
  let freq: number;
  let lowpass_band = 32;
  let highpass_band = -1;

  if (cfg.lowpass1 > 0) {
    minband = 999;
    for (band = 0; band <= 31; band++) {
      freq = f(band / 31.0);
      /* this band and above will be zeroed: */
      if (freq >= cfg.lowpass2) {
        lowpass_band = Math.min(lowpass_band, band);
      }
      if (cfg.lowpass1 < freq && freq < cfg.lowpass2) {
        minband = Math.min(minband, band);
      }
    }

    /* compute the *actual* transition band implemented by
     * the polyphase filter */
    if (minband === 999) {
      cfg.lowpass1 = f((lowpass_band - 0.75) / 31.0);
    } else {
      cfg.lowpass1 = f((minband - 0.75) / 31.0);
    }
    cfg.lowpass2 = f(lowpass_band / 31.0);
  }

  /* make sure highpass filter is within 90% of what the effective
   * highpass frequency will be */
  if (cfg.highpass2 > 0) {
    if (cfg.highpass2 < 0.9 * (0.75 / 31.0)) {
      cfg.highpass1 = 0;
      cfg.highpass2 = 0;
      /* Warning: highpass filter disabled. highpass frequency too small */
    }
  }

  if (cfg.highpass2 > 0) {
    maxband = -1;
    for (band = 0; band <= 31; band++) {
      freq = f(band / 31.0);
      /* this band and below will be zereod */
      if (freq <= cfg.highpass1) {
        highpass_band = Math.max(highpass_band, band);
      }
      if (cfg.highpass1 < freq && freq < cfg.highpass2) {
        maxband = Math.max(maxband, band);
      }
    }
    /* compute the *actual* transition band implemented by
     * the polyphase filter */
    cfg.highpass1 = f(highpass_band / 31.0);
    if (maxband === -1) {
      cfg.highpass2 = f((highpass_band + 0.75) / 31.0);
    } else {
      cfg.highpass2 = f((maxband + 0.75) / 31.0);
    }
  }

  for (band = 0; band < 32; band++) {
    let fc1: number, fc2: number;
    freq = f(band / 31.0);
    if (cfg.highpass2 > cfg.highpass1) {
      fc1 = filter_coef(f(f(cfg.highpass2 - freq) / (f(cfg.highpass2 - cfg.highpass1) + 1e-20)));
    } else {
      fc1 = 1.0;
    }
    if (cfg.lowpass2 > cfg.lowpass1) {
      fc2 = filter_coef(f(f(freq - cfg.lowpass1) / (f(cfg.lowpass2 - cfg.lowpass1) + 1e-20)));
    } else {
      fc2 = 1.0;
    }
    gfc.sv_enc.amp_filter[band] = fc1 * fc2;
  }
}

const freq_map_lowpass = [
  2000, 3700, 3900, 5500, 7000, 7500, 10000, 11000, 13500, 15100, 15600, 17000, 17500, 18600, 19400, 19700, 20500,
];

/** Best lowpass frequency limit for the input filter in Hz, for a total bitrate in kbps. */
function optimum_bandwidth(bitrate: number): number {
  return freq_map_lowpass[nearestBitrateFullIndex(bitrate)];
}

function optimum_samplefreq(lowpassfreq: number, input_samplefreq: number): number {
  /*
   * Rules:
   *  - if possible, sfb21 should NOT be used
   *
   */
  let suggested_samplefreq = 44100;

  if (input_samplefreq >= 48000) suggested_samplefreq = 48000;
  else if (input_samplefreq >= 44100) suggested_samplefreq = 44100;
  else if (input_samplefreq >= 32000) suggested_samplefreq = 32000;
  else if (input_samplefreq >= 24000) suggested_samplefreq = 24000;
  else if (input_samplefreq >= 22050) suggested_samplefreq = 22050;
  else if (input_samplefreq >= 16000) suggested_samplefreq = 16000;
  else if (input_samplefreq >= 12000) suggested_samplefreq = 12000;
  else if (input_samplefreq >= 11025) suggested_samplefreq = 11025;
  else if (input_samplefreq >= 8000) suggested_samplefreq = 8000;

  if (lowpassfreq === -1) return suggested_samplefreq;

  if (lowpassfreq <= 15960) suggested_samplefreq = 44100;
  if (lowpassfreq <= 15250) suggested_samplefreq = 32000;
  if (lowpassfreq <= 11220) suggested_samplefreq = 24000;
  if (lowpassfreq <= 9970) suggested_samplefreq = 22050;
  if (lowpassfreq <= 7230) suggested_samplefreq = 16000;
  if (lowpassfreq <= 5420) suggested_samplefreq = 12000;
  if (lowpassfreq <= 4510) suggested_samplefreq = 11025;
  if (lowpassfreq <= 3970) suggested_samplefreq = 8000;

  if (input_samplefreq < suggested_samplefreq) {
    /* choose a valid MPEG sample frequency above the input sample frequency
       to avoid SFB21/12 bitrate bloat
       rh 061115
     */
    if (input_samplefreq > 44100) {
      return 48000;
    }
    if (input_samplefreq > 32000) {
      return 44100;
    }
    if (input_samplefreq > 24000) {
      return 32000;
    }
    if (input_samplefreq > 22050) {
      return 24000;
    }
    if (input_samplefreq > 16000) {
      return 22050;
    }
    if (input_samplefreq > 12000) {
      return 16000;
    }
    if (input_samplefreq > 11025) {
      return 12000;
    }
    if (input_samplefreq > 8000) {
      return 11025;
    }
    return 8000;
  }
  return suggested_samplefreq;
}

/* set internal feature flags.  USER should not access these since
 * some combinations will produce strange results */
function lame_init_qval(gfp: LameGlobalFlags): void {
  const gfc = gfp.internal_flags;
  const cfg = gfc.cfg;

  if (gfp.quality === 8) gfp.quality = 7;

  const q = gfp.quality;
  if (q >= 0 && q <= 6) {
    if (cfg.noise_shaping === 0) cfg.noise_shaping = 1;
    if (q <= 2 && gfc.sv_qnt.substep_shaping === 0) gfc.sv_qnt.substep_shaping = 2;
    cfg.noise_shaping_amp = q <= 1 ? 2 : q <= 3 ? 1 : 0;
    cfg.noise_shaping_stop = q <= 3 ? 1 : 0;
    if (cfg.subblock_gain === -1) cfg.subblock_gain = 1;
    cfg.use_best_huffman = q <= 4 ? 1 : 0;
    cfg.full_outer_loop = q === 0 ? 1 : 0;
  } else {
    /* 7: use psymodel (for short block and m/s switching), but no noise shapping */
    /* 9 / default: no psymodel, no noise shaping */
    cfg.noise_shaping = 0;
    cfg.noise_shaping_amp = 0;
    cfg.noise_shaping_stop = 0;
    cfg.use_best_huffman = 0;
    cfg.full_outer_loop = 0;
    if (q === 7 && (cfg.vbr === vbr_mt || cfg.vbr === vbr_mtrh)) {
      cfg.full_outer_loop = -1;
    }
  }
}

function linear_int(a: number, b: number, m: number): number {
  return a + m * (b - a);
}

const q_map = [
  [48000, 0.0, 6.5, 0.0, 6.5, 23700],
  [44100, 0.0, 6.5, 0.0, 6.5, 21780],
  [32000, 6.5, 8.0, 5.2, 6.5, 15800],
  [24000, 8.0, 8.5, 5.2, 6.0, 11850],
  [22050, 8.5, 9.01, 5.2, 6.5, 10892],
  [16000, 9.01, 9.4, 4.9, 6.5, 7903],
  [12000, 9.4, 9.6, 4.5, 6.0, 5928],
  [11025, 9.6, 9.9, 5.1, 6.5, 5446],
  [8000, 9.9, 10, 4.9, 6.5, 3952],
].map((r) => ({ sr_a: r[0], qa: f(r[1]), qb: f(r[2]), ta: f(r[3]), tb: f(r[4]), lp: r[5] }));

const cmp_ratio = new Float32Array([5.7, 6.5, 7.3, 8.2, 10, 11.9, 13, 14, 15, 16.5]);

/********************************************************************
 *   initialize internal params based on data in gf
 *   (globalflags struct filled in by calling program)
 *
 *  (see the outline in lame.c)
 ********************************************************************/
export function lame_init_params(gfp: LameGlobalFlags): number {
  let i: number;

  const gfc = gfp.internal_flags;
  if (gfc.lame_init_params_successful > 0) return -1; /* already initialized */

  gfc.lame_init_params_successful = 0; /* will be set to one, when we get through until the end */

  if (!(gfp.samplerate_in >= 1)) return -1; /* input sample rate makes no sense */
  if (gfp.num_channels < 1 || 2 < gfp.num_channels) return -1; /* number of input channels makes no sense */
  if (gfp.samplerate_out !== 0) {
    if (SmpFrqIndex(gfp.samplerate_out) < 0) return -1; /* output sample rate makes no sense */
  }

  const cfg = gfc.cfg;

  cfg.enforce_min_bitrate = gfp.VBR_hard_min;
  cfg.analysis = gfp.analysis;
  if (cfg.analysis) gfp.write_lame_tag = 0;

  cfg.vbr = gfp.VBR;
  cfg.error_protection = gfp.error_protection;
  cfg.copyright = gfp.copyright;
  cfg.original = gfp.original;
  cfg.extension = gfp.extension;
  cfg.emphasis = gfp.emphasis;

  cfg.channels_in = gfp.num_channels;
  if (cfg.channels_in === 1) gfp.mode = MONO;
  cfg.channels_out = gfp.mode === MONO ? 1 : 2;
  if (gfp.mode !== JOINT_STEREO) gfp.force_ms = 0; /* forced mid/side stereo for j-stereo only */
  cfg.force_ms = gfp.force_ms;

  if (cfg.vbr === vbr_off && gfp.VBR_mean_bitrate_kbps !== 128 && gfp.brate === 0)
    gfp.brate = gfp.VBR_mean_bitrate_kbps;

  switch (cfg.vbr) {
    case vbr_off:
    case vbr_mtrh:
    case vbr_mt:
      /* these modes can handle free format condition */
      break;
    default:
      gfp.free_format = 0; /* mode can't be mixed with free format */
      break;
  }

  cfg.free_format = gfp.free_format;

  if (cfg.vbr === vbr_off && gfp.brate === 0) {
    /* no bitrate or compression ratio specified, use 11.025 */
    if (EQ(gfp.compression_ratio, 0))
      gfp.compression_ratio = f(11.025); /* rate to compress a CD down to exactly 128000 bps */
  }

  /* find bitrate if user specify a compression ratio */
  if (cfg.vbr === vbr_off && gfp.compression_ratio > 0) {
    if (gfp.samplerate_out === 0)
      gfp.samplerate_out = map2MP3Frequency(Math.trunc(0.97 * gfp.samplerate_in)); /* round up with a margin of 3% */

    /* choose a bitrate for the output samplerate which achieves
     * specified compression ratio
     */
    gfp.brate = Math.trunc((gfp.samplerate_out * 16 * cfg.channels_out) / (1e3 * gfp.compression_ratio));

    /* we need the version for the bitrate table look up */
    cfg.samplerate_index = SmpFrqIndex(gfp.samplerate_out);
    cfg.version = SmpFrqVersion(gfp.samplerate_out);

    if (!cfg.free_format)
      /* for non Free Format find the nearest allowed bitrate */
      gfp.brate = FindNearestBitrate(gfp.brate, cfg.version, gfp.samplerate_out);
  }
  if (gfp.samplerate_out) {
    if (gfp.samplerate_out < 16000) {
      gfp.VBR_mean_bitrate_kbps = Math.max(gfp.VBR_mean_bitrate_kbps, 8);
      gfp.VBR_mean_bitrate_kbps = Math.min(gfp.VBR_mean_bitrate_kbps, 64);
    } else if (gfp.samplerate_out < 32000) {
      gfp.VBR_mean_bitrate_kbps = Math.max(gfp.VBR_mean_bitrate_kbps, 8);
      gfp.VBR_mean_bitrate_kbps = Math.min(gfp.VBR_mean_bitrate_kbps, 160);
    } else {
      gfp.VBR_mean_bitrate_kbps = Math.max(gfp.VBR_mean_bitrate_kbps, 32);
      gfp.VBR_mean_bitrate_kbps = Math.min(gfp.VBR_mean_bitrate_kbps, 320);
    }
  }
  /* WORK IN PROGRESS */
  /* mapping VBR scale to internal VBR quality settings */
  if (gfp.samplerate_out === 0 && (cfg.vbr === vbr_mt || cfg.vbr === vbr_mtrh)) {
    const qval = f(gfp.VBR_q + gfp.VBR_q_frac);
    for (i = 2; i < 9; ++i) {
      const m = q_map[i];
      if (gfp.samplerate_in === m.sr_a) {
        if (qval < m.qa) {
          let d: number = f(qval / m.qa);
          d = d * m.ta;
          gfp.VBR_q = Math.trunc(d);
          gfp.VBR_q_frac = f(d - gfp.VBR_q);
        }
      }
      if (gfp.samplerate_in >= m.sr_a) {
        if (m.qa <= qval && qval < m.qb) {
          const q_ = f(m.qb - m.qa);
          const t_ = f(m.tb - m.ta);
          const d = f(m.ta + f(f(t_ * f(qval - m.qa)) / q_));
          gfp.VBR_q = Math.trunc(d);
          gfp.VBR_q_frac = f(d - gfp.VBR_q);
          gfp.samplerate_out = m.sr_a;
          if (gfp.lowpassfreq === 0) {
            gfp.lowpassfreq = -1;
          }
          break;
        }
      }
    }
  }

  /****************************************************************/
  /* if a filter has not been enabled, see if we should add one: */
  /****************************************************************/
  if (gfp.lowpassfreq === 0) {
    let lowpass = 16000;

    switch (cfg.vbr) {
      case vbr_off: {
        lowpass = optimum_bandwidth(gfp.brate);
        break;
      }
      case vbr_abr: {
        lowpass = optimum_bandwidth(gfp.VBR_mean_bitrate_kbps);
        break;
      }
      case vbr_rh: {
        const x = [19500, 19000, 18600, 18000, 17500, 16000, 15600, 14900, 12500, 10000, 3950];
        if (0 <= gfp.VBR_q && gfp.VBR_q <= 9) {
          lowpass = linear_int(x[gfp.VBR_q], x[gfp.VBR_q + 1], gfp.VBR_q_frac);
        } else {
          lowpass = 19500;
        }
        break;
      }
      case vbr_mtrh:
      case vbr_mt: {
        const x = [24000, 19500, 18500, 18000, 17500, 17000, 16500, 15600, 15200, 7230, 3950];
        if (0 <= gfp.VBR_q && gfp.VBR_q <= 9) {
          lowpass = linear_int(x[gfp.VBR_q], x[gfp.VBR_q + 1], gfp.VBR_q_frac);
        } else {
          lowpass = 21500;
        }
        break;
      }
      default: {
        const x = [19500, 19000, 18500, 18000, 17500, 16500, 15500, 14500, 12500, 9500, 3950];
        if (0 <= gfp.VBR_q && gfp.VBR_q <= 9) {
          lowpass = linear_int(x[gfp.VBR_q], x[gfp.VBR_q + 1], gfp.VBR_q_frac);
        } else {
          lowpass = 19500;
        }
      }
    }

    if (gfp.mode === MONO && (cfg.vbr === vbr_off || cfg.vbr === vbr_abr)) lowpass *= 1.5;

    gfp.lowpassfreq = Math.trunc(lowpass);
  }

  if (gfp.samplerate_out === 0) {
    if (2 * gfp.lowpassfreq > gfp.samplerate_in) {
      gfp.lowpassfreq = (gfp.samplerate_in / 2) | 0;
    }
    gfp.samplerate_out = optimum_samplefreq(gfp.lowpassfreq, gfp.samplerate_in);
  }
  if (cfg.vbr === vbr_mt || cfg.vbr === vbr_mtrh) {
    gfp.lowpassfreq = Math.min(24000, gfp.lowpassfreq);
  } else {
    gfp.lowpassfreq = Math.min(20500, gfp.lowpassfreq);
  }
  gfp.lowpassfreq = Math.min((gfp.samplerate_out / 2) | 0, gfp.lowpassfreq);

  if (cfg.vbr === vbr_off) {
    gfp.compression_ratio = f((gfp.samplerate_out * 16 * cfg.channels_out) / (1e3 * gfp.brate));
  }
  if (cfg.vbr === vbr_abr) {
    gfp.compression_ratio = f((gfp.samplerate_out * 16 * cfg.channels_out) / (1e3 * gfp.VBR_mean_bitrate_kbps));
  }

  cfg.disable_reservoir = gfp.disable_reservoir;
  cfg.lowpassfreq = gfp.lowpassfreq;
  cfg.highpassfreq = gfp.highpassfreq;
  cfg.samplerate_in = gfp.samplerate_in;
  cfg.samplerate_out = gfp.samplerate_out;
  cfg.mode_gr = cfg.samplerate_out <= 24000 ? 1 : 2; /* Number of granules per frame */

  /*
   *  For VBR, take a guess at the compression_ratio.
   *  (see the table in lame.c)
   */
  switch (cfg.vbr) {
    case vbr_mt:
    case vbr_rh:
    case vbr_mtrh:
      /*numbers are a bit strange, but they determine the lowpass value */
      gfp.compression_ratio = cmp_ratio[gfp.VBR_q];
      break;
    case vbr_abr:
      gfp.compression_ratio = f((cfg.samplerate_out * 16 * cfg.channels_out) / (1e3 * gfp.VBR_mean_bitrate_kbps));
      break;
    default:
      gfp.compression_ratio = f((cfg.samplerate_out * 16 * cfg.channels_out) / (1e3 * gfp.brate));
      break;
  }

  /* mode = -1 (not set by user) or
   * mode = MONO (because of only 1 input channel).
   * If mode has not been set, then select J-STEREO
   */
  if (gfp.mode === NOT_SET) {
    gfp.mode = JOINT_STEREO;
  }

  cfg.mode = gfp.mode;

  /* apply user driven high pass filter */
  if (cfg.highpassfreq > 0) {
    cfg.highpass1 = f(2 * cfg.highpassfreq);

    if (gfp.highpasswidth >= 0) cfg.highpass2 = f(2 * (cfg.highpassfreq + gfp.highpasswidth));
    /* 0% above on default */ else cfg.highpass2 = f((1 + 0.0) * 2 * cfg.highpassfreq);

    cfg.highpass1 = f(cfg.highpass1 / cfg.samplerate_out);
    cfg.highpass2 = f(cfg.highpass2 / cfg.samplerate_out);
  } else {
    cfg.highpass1 = 0;
    cfg.highpass2 = 0;
  }
  /* apply user driven low pass filter */
  cfg.lowpass1 = 0;
  cfg.lowpass2 = 0;
  if (cfg.lowpassfreq > 0 && cfg.lowpassfreq < ((cfg.samplerate_out / 2) | 0)) {
    cfg.lowpass2 = f(2 * cfg.lowpassfreq);
    if (gfp.lowpasswidth >= 0) {
      cfg.lowpass1 = f(2 * (cfg.lowpassfreq - gfp.lowpasswidth));
      if (cfg.lowpass1 < 0) /* has to be >= 0 */ cfg.lowpass1 = 0;
    } else {
      /* 0% below on default */
      cfg.lowpass1 = f((1 - 0.0) * 2 * cfg.lowpassfreq);
    }
    cfg.lowpass1 = f(cfg.lowpass1 / cfg.samplerate_out);
    cfg.lowpass2 = f(cfg.lowpass2 / cfg.samplerate_out);
  }

  /**********************************************************************/
  /* compute info needed for polyphase filter (filter type==0, default) */
  /**********************************************************************/
  lame_init_params_ppflt(gfc);

  /*******************************************************
   * samplerate and bitrate index
   *******************************************************/
  cfg.samplerate_index = SmpFrqIndex(cfg.samplerate_out);
  cfg.version = SmpFrqVersion(cfg.samplerate_out);
  if (cfg.samplerate_index < 0) return -1;

  if (cfg.vbr === vbr_off) {
    if (cfg.free_format) {
      gfc.ov_enc.bitrate_index = 0;
    } else {
      gfp.brate = FindNearestBitrate(gfp.brate, cfg.version, cfg.samplerate_out);
      gfc.ov_enc.bitrate_index = BitrateIndex(gfp.brate, cfg.version, cfg.samplerate_out);
      if (gfc.ov_enc.bitrate_index <= 0) {
        /* This never happens, because of preceding FindNearestBitrate!
         * But, set a sane value, just in case
         */
        gfc.ov_enc.bitrate_index = 8;
      }
    }
  } else {
    gfc.ov_enc.bitrate_index = 1;
  }

  init_bit_stream_w(gfc);

  const j = cfg.samplerate_index + 3 * cfg.version + 6 * (cfg.samplerate_out < 16000 ? 1 : 0);
  const sb = gfc.scalefac_band;
  for (i = 0; i < SBMAX_l + 1; i++) sb.l[i] = sfBandIndex[j].l[i];

  for (i = 0; i < PSFB21 + 1; i++) {
    const size = ((sb.l[22] - sb.l[21]) / PSFB21) | 0;
    const start = sb.l[21] + i * size;
    sb.psfb21[i] = start;
  }
  sb.psfb21[PSFB21] = 576;

  for (i = 0; i < SBMAX_s + 1; i++) sb.s[i] = sfBandIndex[j].s[i];

  for (i = 0; i < PSFB12 + 1; i++) {
    const size = ((sb.s[13] - sb.s[12]) / PSFB12) | 0;
    const start = sb.s[12] + i * size;
    sb.psfb12[i] = start;
  }
  sb.psfb12[PSFB12] = 192;

  /* determine the mean bitrate for main data */
  if (cfg.mode_gr === 2)
    /* MPEG 1 */
    cfg.sideinfo_len = cfg.channels_out === 1 ? 4 + 17 : 4 + 32;
  /* MPEG 2 */ else cfg.sideinfo_len = cfg.channels_out === 1 ? 4 + 9 : 4 + 17;

  if (cfg.error_protection) cfg.sideinfo_len += 2;

  {
    for (let k = 0; k < 19; k++) gfc.sv_enc.pefirbuf[k] = 700 * cfg.mode_gr * cfg.channels_out;

    if (gfp.ATHtype === -1) gfp.ATHtype = 4;
  }

  switch (cfg.vbr) {
    case vbr_mt:
    case vbr_mtrh: {
      if (gfp.strict_ISO < 0) {
        gfp.strict_ISO = MDB_MAXIMUM;
      }
      if (gfp.useTemporal < 0) {
        gfp.useTemporal = 0; /* off by default for this VBR mode */
      }

      apply_preset(gfp, 500 - gfp.VBR_q * 10, 0);
      /*  The newer VBR code supports only a limited
         subset of quality levels:
         9-5=5 are the same, uses x^3/4 quantization
         4-0=0 are the same  5 plus best huffman divide code
       */
      if (gfp.quality < 0) gfp.quality = LAME_DEFAULT_QUALITY;
      if (gfp.quality < 5) gfp.quality = 0;
      if (gfp.quality > 7) gfp.quality = 7;

      /*  sfb21 extra only with MPEG-1 at higher sampling rates
       */
      if (gfp.experimentalY) gfc.sv_qnt.sfb21_extra = 0;
      else gfc.sv_qnt.sfb21_extra = cfg.samplerate_out > 44000 ? 1 : 0;

      break;
    }
    case vbr_rh: {
      apply_preset(gfp, 500 - gfp.VBR_q * 10, 0);

      /*  sfb21 extra only with MPEG-1 at higher sampling rates
       */
      if (gfp.experimentalY) gfc.sv_qnt.sfb21_extra = 0;
      else gfc.sv_qnt.sfb21_extra = cfg.samplerate_out > 44000 ? 1 : 0;

      /*  VBR needs at least the output of GPSYCHO,
       *  so we have to garantee that by setting a minimum
       *  quality level, actually level 6 does it.
       *  down to level 6
       */
      if (gfp.quality > 6) gfp.quality = 6;

      if (gfp.quality < 0) gfp.quality = LAME_DEFAULT_QUALITY;

      break;
    }

    default: /* cbr/abr */ {
      /*  no sfb21 extra with CBR code
       */
      gfc.sv_qnt.sfb21_extra = 0;

      if (gfp.quality < 0) gfp.quality = LAME_DEFAULT_QUALITY;

      if (cfg.vbr === vbr_off) gfp.VBR_mean_bitrate_kbps = gfp.brate;
      /* second, set parameters depending on bitrate */
      apply_preset(gfp, gfp.VBR_mean_bitrate_kbps, 0);
      gfp.VBR = cfg.vbr;

      break;
    }
  }

  /*initialize default values common for all modes */

  gfc.sv_qnt.mask_adjust = gfp.maskingadjust;
  gfc.sv_qnt.mask_adjust_short = gfp.maskingadjust_short;

  /*  just another daily changing developer switch  */
  if (gfp.tune) {
    gfc.sv_qnt.mask_adjust = f(gfc.sv_qnt.mask_adjust + gfp.tune_value_a);
    gfc.sv_qnt.mask_adjust_short = f(gfc.sv_qnt.mask_adjust_short + gfp.tune_value_a);
  }

  if (cfg.vbr !== vbr_off) {
    /* choose a min/max bitrate for VBR */
    /* if the user didn't specify VBR_max_bitrate: */
    cfg.vbr_min_bitrate_index = 1; /* default: allow   8 kbps (MPEG-2) or  32 kbps (MPEG-1) */
    cfg.vbr_max_bitrate_index = 14; /* default: allow 160 kbps (MPEG-2) or 320 kbps (MPEG-1) */
    if (cfg.samplerate_out < 16000) cfg.vbr_max_bitrate_index = 8; /* default: allow 64 kbps (MPEG-2.5) */
    if (gfp.VBR_min_bitrate_kbps) {
      gfp.VBR_min_bitrate_kbps = FindNearestBitrate(gfp.VBR_min_bitrate_kbps, cfg.version, cfg.samplerate_out);
      cfg.vbr_min_bitrate_index = BitrateIndex(gfp.VBR_min_bitrate_kbps, cfg.version, cfg.samplerate_out);
      if (cfg.vbr_min_bitrate_index < 0) {
        cfg.vbr_min_bitrate_index = 1;
      }
    }
    if (gfp.VBR_max_bitrate_kbps) {
      gfp.VBR_max_bitrate_kbps = FindNearestBitrate(gfp.VBR_max_bitrate_kbps, cfg.version, cfg.samplerate_out);
      cfg.vbr_max_bitrate_index = BitrateIndex(gfp.VBR_max_bitrate_kbps, cfg.version, cfg.samplerate_out);
      if (cfg.vbr_max_bitrate_index < 0) {
        cfg.vbr_max_bitrate_index = cfg.samplerate_out < 16000 ? 8 : 14;
      }
    }
    gfp.VBR_min_bitrate_kbps = bitrate_table[cfg.version][cfg.vbr_min_bitrate_index];
    gfp.VBR_max_bitrate_kbps = bitrate_table[cfg.version][cfg.vbr_max_bitrate_index];
    gfp.VBR_mean_bitrate_kbps = Math.min(
      bitrate_table[cfg.version][cfg.vbr_max_bitrate_index],
      gfp.VBR_mean_bitrate_kbps,
    );
    gfp.VBR_mean_bitrate_kbps = Math.max(
      bitrate_table[cfg.version][cfg.vbr_min_bitrate_index],
      gfp.VBR_mean_bitrate_kbps,
    );
  }

  cfg.preset = gfp.preset;
  cfg.write_lame_tag = gfp.write_lame_tag;
  gfc.sv_qnt.substep_shaping = gfp.substep_shaping;
  cfg.noise_shaping = gfp.noise_shaping;
  cfg.subblock_gain = gfp.subblock_gain;
  cfg.use_best_huffman = gfp.use_best_huffman;
  cfg.avg_bitrate = gfp.brate;
  cfg.vbr_avg_bitrate_kbps = gfp.VBR_mean_bitrate_kbps;
  cfg.compression_ratio = gfp.compression_ratio;

  /* initialize internal qval settings */
  lame_init_qval(gfp);

  /*  automatic ATH adjustment on
   */
  if (gfp.athaa_type < 0) gfc.ATH.use_adjust = 3;
  else gfc.ATH.use_adjust = gfp.athaa_type;

  /* initialize internal adaptive ATH settings  -jd */
  gfc.ATH.aa_sensitivity_p = f(Math.pow(10.0, gfp.athaa_sensitivity / -10.0));

  if (gfp.short_blocks === short_block_not_set) {
    gfp.short_blocks = short_block_allowed;
  }

  /*Note Jan/2003: Many hardware decoders cannot handle short blocks in regular
     stereo mode unless they are coupled (same type in both channels)
     it is a rare event (1 frame per min. or so) that LAME would use
     uncoupled short blocks, so lets turn them off until we decide
     how to handle this.  No other encoders allow uncoupled short blocks,
     even though it is in the standard.  */
  /* rh 20040217: coupling makes no sense for mono and dual-mono streams
   */
  if (gfp.short_blocks === short_block_allowed && (cfg.mode === JOINT_STEREO || cfg.mode === STEREO)) {
    gfp.short_blocks = short_block_coupled;
  }

  cfg.short_blocks = gfp.short_blocks;

  if (gfp.quant_comp < 0) gfp.quant_comp = 1;
  if (gfp.quant_comp_short < 0) gfp.quant_comp_short = 0;

  if (gfp.msfix < 0) gfp.msfix = 0;

  /* select psychoacoustic model */
  gfp.exp_nspsytune = gfp.exp_nspsytune | 1;

  if (gfp.ATHtype < 0) gfp.ATHtype = 4;

  if (gfp.ATHcurve < 0) gfp.ATHcurve = 4;

  if (gfp.interChRatio < 0) gfp.interChRatio = 0;

  if (gfp.useTemporal < 0) gfp.useTemporal = 1; /* on by default */

  cfg.interChRatio = gfp.interChRatio;
  cfg.msfix = gfp.msfix;
  cfg.ATH_offset_db = f(0 - gfp.ATH_lower_db);
  cfg.ATH_offset_factor = powf(10, f(cfg.ATH_offset_db * f(0.1)));
  cfg.ATHcurve = gfp.ATHcurve;
  cfg.ATHtype = gfp.ATHtype;
  cfg.ATHonly = gfp.ATHonly;
  cfg.ATHshort = gfp.ATHshort;
  cfg.noATH = gfp.noATH;

  cfg.quant_comp = gfp.quant_comp;
  cfg.quant_comp_short = gfp.quant_comp_short;

  cfg.use_temporal_masking_effect = gfp.useTemporal;
  if (cfg.mode === JOINT_STEREO) {
    cfg.use_safe_joint_stereo = gfp.exp_nspsytune & 2;
  } else {
    cfg.use_safe_joint_stereo = 0;
  }
  {
    const adj = (shift: number): number => {
      let v = (gfp.exp_nspsytune >> shift) & 63;
      if (v >= 32) v -= 64;
      return v * 0.25;
    };
    cfg.adjust_bass_db = adj(2);
    cfg.adjust_alto_db = adj(8);
    cfg.adjust_treble_db = adj(14);

    /*  to be compatible with Naoki's original code, the next 6 bits
     *  define only the amount of changing treble for sfb21 */
    cfg.adjust_sfb21_db = adj(20) + cfg.adjust_treble_db;
  }

  /* Setting up the PCM input data transform matrix, to apply
   * user defined re-scaling, and or two-to-one channel downmix.
   */
  {
    const scale = f(gfp.scale),
      sl = f(gfp.scale_left),
      sr = f(gfp.scale_right);
    let m00 = 1,
      m01 = 0,
      m10 = 0,
      m11 = 1;

    /* user selected scaling of the samples */
    m00 = f(m00 * scale);
    m01 = f(m01 * scale);
    m10 = f(m10 * scale);
    m11 = f(m11 * scale);
    /* user selected scaling of the channel 0 (left) samples */
    m00 = f(m00 * sl);
    m01 = f(m01 * sl);
    /* user selected scaling of the channel 1 (right) samples */
    m10 = f(m10 * sr);
    m11 = f(m11 * sr);
    /* Downsample to Mono if 2 channels in and 1 channel out */
    if (cfg.channels_in === 2 && cfg.channels_out === 1) {
      m00 = f(0.5 * f(m00 + m10));
      m01 = f(0.5 * f(m01 + m11));
      m10 = 0;
      m11 = 0;
    }
    cfg.pcm_transform[0] = m00;
    cfg.pcm_transform[1] = m01;
    cfg.pcm_transform[2] = m10;
    cfg.pcm_transform[3] = m11;
  }

  /* padding method as described in
   * "MPEG-Layer3 / Bitstream Syntax and Decoding"
   * by Martin Sieler, Ralph Sperschneider
   *
   * note: there is no padding for the very first frame
   *
   * Robert Hegemann 2000-06-22
   */
  gfc.sv_enc.slot_lag = gfc.sv_enc.frac_SpF = 0;
  if (cfg.vbr === vbr_off)
    gfc.sv_enc.slot_lag = gfc.sv_enc.frac_SpF = ((cfg.version + 1) * 72000 * cfg.avg_bitrate) % cfg.samplerate_out;

  lame_init_bitstream(gfp);

  iteration_init(gfc);
  psymodel_init(gfp);

  cfg.buffer_constraint = get_max_frame_buffer_size_by_constraint(cfg, gfp.strict_ISO);

  cfg.findReplayGain = gfp.findReplayGain;
  cfg.decode_on_the_fly = 0; /* decoding is not part of this port */

  if (cfg.findReplayGain) {
    if (gfc.rgdata === null) gfc.rgdata = new ReplayGain();
    if (InitGainAnalysis(gfc.rgdata, cfg.samplerate_out) === INIT_GAIN_ANALYSIS_ERROR) {
      /* Actually this never happens, our samplerates are the ones RG accepts!
       * But just in case, turn RG off
       */
      cfg.findReplayGain = 0;
    }
  }

  /* updating lame internal flags finished successful */
  gfc.lame_init_params_successful = 1;
  return 0;
}

function save_gain_values(gfc: LameInternalFlags): void {
  const cfg = gfc.cfg;
  const rov = gfc.ov_rpg;
  /* save the ReplayGain value */
  if (cfg.findReplayGain) {
    const RadioGain = GetTitleGain(gfc.rgdata!);
    if (NEQ(RadioGain, GAIN_NOT_ENOUGH_SAMPLES)) {
      rov.RadioGain = Math.floor(RadioGain * 10.0 + 0.5); /* round to nearest */
    } else {
      rov.RadioGain = 0;
    }
  }

  /* find the gain and scale change required for no clipping */
  if (cfg.findPeakSample) {
    rov.noclipGainChange = Math.ceil(Math.log10(rov.PeakSample / 32767.0) * 20.0 * 10.0); /* round up */

    if (rov.noclipGainChange > 0) {
      /* clipping occurs */
      rov.noclipScale = f(Math.floor(f(f(32767.0 / rov.PeakSample) * 100.0)) / 100.0); /* round down */
    } /* no clipping */ else rov.noclipScale = -1.0;
  }
}

function update_inbuffer_size(gfc: LameInternalFlags, nsamples: number): void {
  const esv = gfc.sv_enc;
  if (esv.in_buffer_nsamples === 0 || esv.in_buffer_nsamples < nsamples) {
    esv.in_buffer_0 = new Float32Array(nsamples);
    esv.in_buffer_1 = new Float32Array(nsamples);
    esv.in_buffer_nsamples = nsamples;
  }
}

function calcNeeded(cfg: SessionConfig): number {
  const pcm_samples_per_frame = 576 * cfg.mode_gr;

  let mf_needed = BLKSIZE + pcm_samples_per_frame - FFTOFFSET; /* amount needed for FFT */
  mf_needed = Math.max(mf_needed, 512 + pcm_samples_per_frame - 32);

  return mf_needed;
}

/*
 * THE MAIN LAME ENCODING INTERFACE
 * mt 3/00
 *
 * input pcm data (already copied to esv.in_buffer_*), output (maybe) mp3 frames.
 * This routine handles all buffering, resampling and filtering for you.
 * The required mp3buffer_size can be computed from num_samples,
 * samplerate and encoding rate, but here is a worst case estimate:
 *
 * mp3buffer_size in bytes = 1.25*num_samples + 7200
 *
 * return code = number of bytes output in mp3buffer.  can be 0
 */
function lame_encode_buffer_sample_t(
  gfc: LameInternalFlags,
  nsamples: number,
  mp3buf: Uint8Array,
  bo: number,
  mp3buf_size: number,
): number {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  const pcm_samples_per_frame = 576 * cfg.mode_gr;
  let mp3size = 0,
    ret: number,
    i: number,
    ch: number;

  if (nsamples === 0) return 0;

  /* copy out any tags that may have been written into bitstream */
  {
    /* if user specifed buffer size = 0, dont check size */
    const buf_size = mp3buf_size === 0 ? INT_MAX : mp3buf_size;
    const mp3out = copy_buffer(gfc, mp3buf, bo, buf_size, 0);
    if (mp3out < 0) return mp3out; /* not enough buffer space */
    bo += mp3out;
    mp3size += mp3out;
  }

  const in_buffer = [esv.in_buffer_0, esv.in_buffer_1];
  let ino = 0;

  const mf_needed = calcNeeded(cfg);

  const mfbuf = esv.mfbuf;

  while (nsamples > 0) {
    /* copy in new samples into mfbuf, with resampling */
    /* n_in <> n_out if we are resampling */
    const r = fill_buffer(gfc, mfbuf, in_buffer, ino, nsamples);
    const n_in = r[0]; /* number of input samples processed with fill_buffer */
    const n_out = r[1]; /* number of samples output with fill_buffer */

    /* compute ReplayGain of resampled input if requested */
    if (cfg.findReplayGain && !cfg.decode_on_the_fly)
      if (
        AnalyzeSamples(gfc.rgdata!, mfbuf[0], esv.mf_size, mfbuf[1], esv.mf_size, n_out, cfg.channels_out) ===
        GAIN_ANALYSIS_ERROR
      )
        return -6;

    /* update in_buffer counters */
    nsamples -= n_in;
    ino += n_in;

    /* update mfbuf[] counters */
    esv.mf_size += n_out;

    /* lame_encode_flush may have set gfc->mf_sample_to_encode to 0
     * so we have to reinitialize it here when that happened.
     */
    if (esv.mf_samples_to_encode < 1) {
      esv.mf_samples_to_encode = ENCDELAY + POSTDELAY;
    }
    esv.mf_samples_to_encode += n_out;

    if (esv.mf_size >= mf_needed) {
      /* encode the frame.  */
      /* mp3buf_size-mp3size = amount of space avalable  */

      let buf_size = mp3buf_size - mp3size;
      if (mp3buf_size === 0) buf_size = INT_MAX;

      ret = lame_encode_mp3_frame(gfc, mfbuf[0], mfbuf[1], mp3buf, bo, buf_size);

      if (ret < 0) return ret;
      bo += ret;
      mp3size += ret;

      /* shift out old samples */
      esv.mf_size -= pcm_samples_per_frame;
      esv.mf_samples_to_encode -= pcm_samples_per_frame;
      for (ch = 0; ch < cfg.channels_out; ch++) {
        const b = mfbuf[ch];
        for (i = 0; i < esv.mf_size; i++) b[i] = b[i + pcm_samples_per_frame];
      }
    }
  }

  return mp3size;
}

/** Any indexable PCM container (Int16Array, Int32Array, Float32Array, Float64Array, number[]). */
export type PcmArray = ArrayLike<number>;

/**
 * lame_encode_buffer_template(): converts `nsamples` samples (read from l[lo + i * jump] and
 * r[ro + i * jump]) to the internal sample type, scaled by `norm`, and encodes them.
 * Samples are converted to `float` first, exactly like the C code does.
 */
export function lame_encode_buffer_template(
  gfp: LameGlobalFlags,
  buffer_l: PcmArray,
  lo: number,
  buffer_r: PcmArray | null,
  ro: number,
  nsamples: number,
  mp3buf: Uint8Array,
  bo: number,
  mp3buf_size: number,
  jump: number,
  norm: number,
): number {
  const gfc = gfp.internal_flags;
  if (gfc.lame_init_params_successful <= 0) return -3;
  const cfg = gfc.cfg;

  if (nsamples === 0) return 0;

  update_inbuffer_size(gfc, nsamples);

  /* make a copy of input buffer, changing type to sample_t */
  let l = buffer_l,
    r = buffer_r;
  if (cfg.channels_in > 1) {
    if (r === null) return 0;
  } else {
    r = l;
    ro = lo;
  }

  {
    const esv = gfc.sv_enc;
    const ib0 = esv.in_buffer_0;
    const ib1 = esv.in_buffer_1;
    const s = f(norm);

    /* Apply user defined re-scaling */
    const m00 = f(s * cfg.pcm_transform[0]);
    const m01 = f(s * cfg.pcm_transform[1]);
    const m10 = f(s * cfg.pcm_transform[2]);
    const m11 = f(s * cfg.pcm_transform[3]);

    for (let i = 0; i < nsamples; i++) {
      const xl = f(l[lo]);
      const xr = f(r[ro]);
      ib0[i] = f(xl * m00) + f(xr * m01);
      ib1[i] = f(xl * m10) + f(xr * m11);
      lo += jump;
      ro += jump;
    }
  }

  return lame_encode_buffer_sample_t(gfc, nsamples, mp3buf, bo, mp3buf_size);
}

/*****************************************************************
 Flush mp3 buffer, pad with ancillary data so last frame is complete.
 Reset reservoir size to 0
 but keep all PCM samples and MDCT data in memory
 This option is used to break a large file into several mp3 files
 that when concatenated together will decode with no gaps
 Because we set the reservoir=0, they will also decode seperately
 with no errors.
*********************************************************************/
export function lame_encode_flush_nogap(
  gfp: LameGlobalFlags,
  mp3buffer: Uint8Array,
  bo: number,
  mp3buffer_size: number,
): number {
  const gfc = gfp.internal_flags;
  if (gfc.lame_init_params_successful <= 0) return -3;
  flush_bitstream(gfc);
  /* if user specifed buffer size = 0, dont check size */
  if (mp3buffer_size === 0) mp3buffer_size = INT_MAX;
  const rc = copy_buffer(gfc, mp3buffer, bo, mp3buffer_size, 1);
  save_gain_values(gfc);
  return rc;
}

/* called by lame_init_params.  You can also call this after flush_nogap
   if you want to write new id3v2 and Xing VBR tags into the bitstream */
export function lame_init_bitstream(gfp: LameGlobalFlags): number {
  const gfc = gfp.internal_flags;
  gfc.ov_enc.frame_number = 0;

  /* (no ID3v2 tag: id3tag.c is not part of this port) */

  /* initialize histogram data optionally used by frontend */
  for (const h of gfc.ov_enc.bitrate_channelmode_hist) h.fill(0);
  for (const h of gfc.ov_enc.bitrate_blocktype_hist) h.fill(0);

  gfc.ov_rpg.PeakSample = 0.0;

  /* Write initial VBR Header to bitstream and init VBR data */
  if (gfc.cfg.write_lame_tag) InitVbrTag(gfp);

  return 0;
}

const flush_zero = new Int16Array(1152);

/*****************************************************************/
/* flush internal PCM sample buffers, then mp3 buffers           */
/*****************************************************************/
export function lame_encode_flush(
  gfp: LameGlobalFlags,
  mp3buffer: Uint8Array,
  bo: number,
  mp3buffer_size: number,
): number {
  const gfc = gfp.internal_flags;
  if (gfc.lame_init_params_successful <= 0) return -3;
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;

  let imp3 = 0,
    mp3count: number,
    mp3buffer_size_remaining: number;

  /* we always add POSTDELAY=288 padding to make sure granule with real
   * data can be complety decoded (because of 50% overlap with next granule */
  let end_padding: number;
  let frames_left: number;
  let samples_to_encode: number;
  let resample_ratio = 1;

  /* Was flush already called? */
  if (esv.mf_samples_to_encode < 1) {
    return 0;
  }
  const pcm_samples_per_frame = 576 * cfg.mode_gr;
  const mf_needed = calcNeeded(cfg);

  samples_to_encode = esv.mf_samples_to_encode - POSTDELAY;

  mp3count = 0;

  if (isResamplingNecessary(cfg)) {
    resample_ratio = cfg.samplerate_in / cfg.samplerate_out;
    /* delay due to resampling; needs to be fixed, if resampling code gets changed */
    samples_to_encode = Math.trunc(samples_to_encode + 16 / resample_ratio);
  }
  end_padding = pcm_samples_per_frame - (samples_to_encode % pcm_samples_per_frame);
  if (end_padding < 576) end_padding += pcm_samples_per_frame;
  gfc.ov_enc.encoder_padding = end_padding;

  frames_left = ((samples_to_encode + end_padding) / pcm_samples_per_frame) | 0;
  while (frames_left > 0 && imp3 >= 0) {
    const frame_num = gfc.ov_enc.frame_number;
    let bunch = mf_needed - esv.mf_size;

    bunch = Math.trunc(bunch * resample_ratio);

    if (bunch > 1152) bunch = 1152;
    if (bunch < 1) bunch = 1;

    mp3buffer_size_remaining = mp3buffer_size - mp3count;

    /* if user specifed buffer size = 0, dont check size */
    if (mp3buffer_size === 0) mp3buffer_size_remaining = 0;

    /* send in a frame of 0 padding until all internal sample buffers
     * are flushed
     */
    imp3 = lame_encode_buffer_template(
      gfp,
      flush_zero,
      0,
      flush_zero,
      0,
      bunch,
      mp3buffer,
      bo,
      mp3buffer_size_remaining,
      1,
      1.0,
    );

    bo += imp3;
    mp3count += imp3;
    {
      /* even a single pcm sample can produce several frames!
       * for example: 1 Hz input file resampled to 8 kHz mpeg2.5
       */
      const new_frames = gfc.ov_enc.frame_number - frame_num;
      if (new_frames > 0) frames_left -= new_frames;
    }
  }
  /* Set esv->mf_samples_to_encode to 0, so we may detect
   * and break loops calling it more than once in a row.
   */
  esv.mf_samples_to_encode = 0;

  if (imp3 < 0) {
    /* some type of fatal error */
    return imp3;
  }

  mp3buffer_size_remaining = mp3buffer_size - mp3count;
  /* if user specifed buffer size = 0, dont check size */
  if (mp3buffer_size === 0) mp3buffer_size_remaining = INT_MAX;

  /* mp3 related stuff.  bit buffer might still contain some mp3 data */
  flush_bitstream(gfc);
  imp3 = copy_buffer(gfc, mp3buffer, bo, mp3buffer_size_remaining, 1);
  save_gain_values(gfc);
  if (imp3 < 0) {
    /* some type of fatal error */
    return imp3;
  }
  mp3count += imp3;

  return mp3count;
}
