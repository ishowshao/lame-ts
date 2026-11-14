// Port of libmp3lame/encoder.c - encodes one frame of PCM into one MP3 frame.

import { copy_buffer, format_bitstream } from './bitstream.ts';
import {
  f,
  FFTOFFSET,
  JOINT_STEREO,
  MPG_MD_LR_LR,
  MPG_MD_MS_LR,
  SHORT_TYPE,
  vbr_abr,
  vbr_mt,
  vbr_mtrh,
  vbr_off,
  vbr_rh,
} from './constants.ts';
import { mdct_sub48 } from './newmdct.ts';
import { L3psycho_anal_vbr } from './psymodel.ts';
import {
  ABR_iteration_loop,
  CBR_iteration_loop,
  VBR_new_iteration_loop,
  VBR_old_iteration_loop,
} from './quantize.ts';
import { III_psy_ratio } from './types.ts';
import type { LameInternalFlags } from './types.ts';
import { AddVbrFrame } from './vbrtag.ts';

/*
 * auto-adjust of ATH, useful for low volume
 * Gabriel Bouvigne 3 feb 2001
 *
 * modifies some values in
 *   gfp->internal_flags->ATH
 *   (gfc->ATH)
 */
function adjust_ATH(gfc: LameInternalFlags): void {
  const cfg = gfc.cfg;
  const ATH = gfc.ATH;
  let gr2_max: number, max_pow: number;

  if (ATH.use_adjust === 0) {
    ATH.adjust_factor = 1.0; /* no adjustment */
    return;
  }

  /* jd - 2001 mar 12, 27, jun 30 */
  /* loudness based on equal loudness curve; */
  /* use granule with maximum combined loudness */
  const lq = gfc.ov_psy.loudness_sq;
  max_pow = lq[0][0];
  gr2_max = lq[1][0];
  if (cfg.channels_out === 2) {
    max_pow = f(max_pow + lq[0][1]);
    gr2_max = f(gr2_max + lq[1][1]);
  } else {
    max_pow = f(max_pow + max_pow);
    gr2_max = f(gr2_max + gr2_max);
  }
  if (cfg.mode_gr === 2) {
    max_pow = max_pow > gr2_max ? max_pow : gr2_max;
  }
  max_pow = f(max_pow * 0.5); /* max_pow approaches 1.0 for full band noise */

  /* jd - 2001 mar 31, jun 30 */
  /* user tuning of ATH adjustment region */
  max_pow = f(max_pow * ATH.aa_sensitivity_p);

  /*  adjust ATH depending on range of maximum value
   */

  /* jd - 2001 feb27, mar12,20, jun30, jul22 */
  /* continuous curves based on approximation */
  /* to GB's original values. */
  /* For an increase in approximate loudness, */
  /* set ATH adjust to adjust_limit immediately */
  /* after a delay of one frame. */
  /* For a loudness decrease, reduce ATH adjust */
  /* towards adjust_limit gradually. */
  /* max_pow is a loudness squared or a power. */
  if (max_pow > 0.03125) {
    /* ((1 - 0.000625)/ 31.98) from curve below */
    if (ATH.adjust_factor >= 1.0) {
      ATH.adjust_factor = 1.0;
    } else {
      /* preceding frame has lower ATH adjust; */
      /* ascend only to the preceding adjust_limit */
      /* in case there is leading low volume */
      if (ATH.adjust_factor < ATH.adjust_limit) {
        ATH.adjust_factor = ATH.adjust_limit;
      }
    }
    ATH.adjust_limit = 1.0;
  } else {
    /* adjustment curve */
    /* about 32 dB maximum adjust (0.000625) */
    const adj_lim_new = f(31.98 * max_pow + 0.000625);
    if (ATH.adjust_factor >= adj_lim_new) {
      /* descend gradually */
      ATH.adjust_factor = f(ATH.adjust_factor * (adj_lim_new * 0.075 + 0.925));
      if (ATH.adjust_factor < adj_lim_new) {
        /* stop descent */
        ATH.adjust_factor = adj_lim_new;
      }
    } else {
      /* ascend */
      if (ATH.adjust_limit >= adj_lim_new) {
        ATH.adjust_factor = adj_lim_new;
      } else {
        /* preceding frame has lower ATH adjust; */
        /* ascend only to the preceding adjust_limit */
        if (ATH.adjust_factor < ATH.adjust_limit) {
          ATH.adjust_factor = ATH.adjust_limit;
        }
      }
    }
    ATH.adjust_limit = adj_lim_new;
  }
}

/***********************************************************************
 *
 *  some simple statistics
 *
 *  bitrate index 0: free bitrate -> not allowed in VBR mode
 *  : bitrates, kbps depending on MPEG version
 *  bitrate index 15: forbidden
 *
 *  mode_ext:
 *  0:  LR
 *  1:  LR-i
 *  2:  MS
 *  3:  MS-i
 *
 ***********************************************************************/

function updateStats(gfc: LameInternalFlags): void {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;

  /* count bitrate indices */
  eov.bitrate_channelmode_hist[eov.bitrate_index][4]++;
  eov.bitrate_channelmode_hist[15][4]++;

  /* count 'em for every mode extension in case of 2 channel encoding */
  if (cfg.channels_out === 2) {
    eov.bitrate_channelmode_hist[eov.bitrate_index][eov.mode_ext]++;
    eov.bitrate_channelmode_hist[15][eov.mode_ext]++;
  }
  for (let gr = 0; gr < cfg.mode_gr; ++gr) {
    for (let ch = 0; ch < cfg.channels_out; ++ch) {
      let bt = gfc.l3_side.tt[gr][ch].block_type;
      if (gfc.l3_side.tt[gr][ch].mixed_block_flag) bt = 4;
      eov.bitrate_blocktype_hist[eov.bitrate_index][bt]++;
      eov.bitrate_blocktype_hist[eov.bitrate_index][5]++;
      eov.bitrate_blocktype_hist[15][bt]++;
      eov.bitrate_blocktype_hist[15][5]++;
    }
  }
}

function lame_encode_frame_init(gfc: LameInternalFlags, inbuf: Float32Array[]): void {
  const cfg = gfc.cfg;

  if (gfc.lame_encode_frame_init === 0) {
    /* prime the MDCT/polyphase filterbank with a short block */
    const primebuff0 = new Float32Array(286 + 1152 + 576);
    const primebuff1 = new Float32Array(286 + 1152 + 576);
    const framesize = 576 * cfg.mode_gr;
    gfc.lame_encode_frame_init = 1;
    for (let i = 0, j = 0; i < 286 + 576 * (1 + cfg.mode_gr); ++i) {
      if (i < framesize) {
        primebuff0[i] = 0;
        if (cfg.channels_out === 2) primebuff1[i] = 0;
      } else {
        primebuff0[i] = inbuf[0][j];
        if (cfg.channels_out === 2) primebuff1[i] = inbuf[1][j];
        ++j;
      }
    }
    /* polyphase filtering / mdct */
    for (let gr = 0; gr < cfg.mode_gr; gr++) {
      for (let ch = 0; ch < cfg.channels_out; ch++) {
        gfc.l3_side.tt[gr][ch].block_type = SHORT_TYPE;
      }
    }
    mdct_sub48(gfc, primebuff0, primebuff1);
  }
}

const fircoef = new Float32Array([
  -0.0207887 * 5,
  -0.0378413 * 5,
  -0.0432472 * 5,
  -0.031183 * 5,
  7.79609e-18 * 5,
  0.0467745 * 5,
  0.10091 * 5,
  0.151365 * 5,
  0.187098 * 5,
]);

function mk2x2<T>(fn: () => T): T[][] {
  return [
    [fn(), fn()],
    [fn(), fn()],
  ];
}

const masking_LR = mk2x2(() => new III_psy_ratio()); /*LR masking & energy */
const masking_MS = mk2x2(() => new III_psy_ratio()); /*MS masking & energy */
const tot_ener = [new Float32Array(4), new Float32Array(4)];
const ms_ener_ratio = new Float32Array(2);
const pe = [new Float32Array(2), new Float32Array(2)];
const pe_MS = [new Float32Array(2), new Float32Array(2)];
const blocktype = new Int32Array(2);

/**
 * Encodes one frame (576 * mode_gr samples per channel taken from inbuf_l / inbuf_r, which
 * must hold the look-ahead described in encoder.c) and copies the finished bytes of the
 * bitstream to `mp3buf` at `bo`. Returns the number of bytes written (or a negative error).
 */
export function lame_encode_mp3_frame(
  gfc: LameInternalFlags,
  inbuf_l: Float32Array,
  inbuf_r: Float32Array,
  mp3buf: Uint8Array,
  bo: number,
  mp3buf_size: number,
): number {
  const cfg = gfc.cfg;
  let masking: III_psy_ratio[][]; /*pointer to selected maskings */
  const inbuf = [inbuf_l, inbuf_r];
  let pe_use: Float32Array[];
  let ch: number, gr: number;

  ms_ener_ratio[0] = ms_ener_ratio[1] = 0.5;
  pe[0].fill(0);
  pe[1].fill(0);
  pe_MS[0].fill(0);
  pe_MS[1].fill(0);

  if (gfc.lame_encode_frame_init === 0) {
    /*first run? */
    lame_encode_frame_init(gfc, inbuf);
  }

  /********************** padding *****************************/
  /* padding method as described in
   * "MPEG-Layer3 / Bitstream Syntax and Decoding"
   * by Martin Sieler, Ralph Sperschneider
   *
   * note: there is no padding for the very first frame
   *
   * Robert Hegemann 2000-06-22
   */
  gfc.ov_enc.padding = 0;
  if ((gfc.sv_enc.slot_lag -= gfc.sv_enc.frac_SpF) < 0) {
    gfc.sv_enc.slot_lag += cfg.samplerate_out;
    gfc.ov_enc.padding = 1;
  }

  /****************************************
   *   Stage 1: psychoacoustic model       *
   ****************************************/

  {
    /* psychoacoustic model
     * psy model has a 1 granule (576) delay that we must compensate for
     * (mt 6/99).
     */
    for (gr = 0; gr < cfg.mode_gr; gr++) {
      const ret = L3psycho_anal_vbr(
        gfc,
        inbuf,
        576 + gr * 576 - FFTOFFSET,
        gr,
        masking_LR,
        masking_MS,
        pe[gr],
        pe_MS[gr],
        tot_ener[gr],
        blocktype,
      );
      if (ret !== 0) return -4;

      if (cfg.mode === JOINT_STEREO) {
        ms_ener_ratio[gr] = tot_ener[gr][2] + tot_ener[gr][3];
        if (ms_ener_ratio[gr] > 0) ms_ener_ratio[gr] = tot_ener[gr][3] / ms_ener_ratio[gr];
      }

      /* block type flags */
      for (ch = 0; ch < cfg.channels_out; ch++) {
        const cod_info = gfc.l3_side.tt[gr][ch];
        cod_info.block_type = blocktype[ch];
        cod_info.mixed_block_flag = 0;
      }
    }
  }

  /* auto-adjust of ATH, useful for low volume */
  adjust_ATH(gfc);

  /****************************************
   *   Stage 2: MDCT                       *
   ****************************************/

  /* polyphase filtering / mdct */
  mdct_sub48(gfc, inbuf[0], inbuf[1]);

  /****************************************
   *   Stage 3: MS/LR decision             *
   ****************************************/

  /* Here will be selected MS or LR coding of the 2 stereo channels */
  gfc.ov_enc.mode_ext = MPG_MD_LR_LR;

  if (cfg.force_ms) {
    gfc.ov_enc.mode_ext = MPG_MD_MS_LR;
  } else if (cfg.mode === JOINT_STEREO) {
    /* ms_ratio = is scaled, for historical reasons, to look like
       a ratio of side_channel / total.
       0 = signal is 100% mono
       .5 = L & R uncorrelated
     */

    /* [0] and [1] are the results for the two granules in MPEG-1,
     * in MPEG-2 it's only a faked averaging of the same value
     * _prev is the value of the last granule of the previous frame
     * _next is the value of the first granule of the next frame
     */

    let sum_pe_MS = 0;
    let sum_pe_LR = 0;
    for (gr = 0; gr < cfg.mode_gr; gr++) {
      for (ch = 0; ch < cfg.channels_out; ch++) {
        sum_pe_MS = f(sum_pe_MS + pe_MS[gr][ch]);
        sum_pe_LR = f(sum_pe_LR + pe[gr][ch]);
      }
    }

    /* based on PE: M/S coding would not use much more bits than L/R */
    if (sum_pe_MS <= 1.0 * sum_pe_LR) {
      const gi0 = gfc.l3_side.tt[0];
      const gi1 = gfc.l3_side.tt[cfg.mode_gr - 1];

      if (gi0[0].block_type === gi0[1].block_type && gi1[0].block_type === gi1[1].block_type) {
        gfc.ov_enc.mode_ext = MPG_MD_MS_LR;
      }
    }
  }

  /* bit and noise allocation */
  if (gfc.ov_enc.mode_ext === MPG_MD_MS_LR) {
    masking = masking_MS; /* use MS masking */
    pe_use = pe_MS;
  } else {
    masking = masking_LR; /* use LR masking */
    pe_use = pe;
  }

  /****************************************
   *   Stage 4: quantization loop          *
   ****************************************/

  if (cfg.vbr === vbr_off || cfg.vbr === vbr_abr) {
    const pefirbuf = gfc.sv_enc.pefirbuf;
    let i: number;
    let v: number;

    for (i = 0; i < 18; i++) pefirbuf[i] = pefirbuf[i + 1];

    v = 0.0;
    for (gr = 0; gr < cfg.mode_gr; gr++)
      for (ch = 0; ch < cfg.channels_out; ch++) v = f(v + pe_use[gr][ch]);
    pefirbuf[18] = v;

    v = pefirbuf[9];
    for (i = 0; i < 9; i++) v = f(v + f(f(pefirbuf[i] + pefirbuf[18 - i]) * fircoef[i]));

    v = f((670 * 5 * cfg.mode_gr * cfg.channels_out) / v);
    for (gr = 0; gr < cfg.mode_gr; gr++) {
      for (ch = 0; ch < cfg.channels_out; ch++) {
        pe_use[gr][ch] = pe_use[gr][ch] * v;
      }
    }
  }
  switch (cfg.vbr) {
    default:
    case vbr_off:
      CBR_iteration_loop(gfc, pe_use, ms_ener_ratio, masking);
      break;
    case vbr_abr:
      ABR_iteration_loop(gfc, pe_use, ms_ener_ratio, masking);
      break;
    case vbr_rh:
      VBR_old_iteration_loop(gfc, pe_use, ms_ener_ratio, masking);
      break;
    case vbr_mt:
    case vbr_mtrh:
      VBR_new_iteration_loop(gfc, pe_use, ms_ener_ratio, masking);
      break;
  }

  /****************************************
   *   Stage 5: bitstream formatting       *
   ****************************************/

  /*  write the frame to the bitstream  */
  format_bitstream(gfc);

  /* copy mp3 bit buffer into array */
  const mp3count = copy_buffer(gfc, mp3buf, bo, mp3buf_size, 1);

  if (cfg.write_lame_tag) {
    AddVbrFrame(gfc);
  }

  ++gfc.ov_enc.frame_number;

  updateStats(gfc);

  return mp3count;
}
