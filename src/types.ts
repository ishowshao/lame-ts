// Internal state structures of the encoder (util.h, l3side.h, lame_global_flags.h).
// Field names follow libmp3lame so the code can be read side by side with the C source.

import {
  BLKSIZE,
  BLKSIZE_s,
  BPC,
  CBANDS,
  ENCDELAY,
  MAX_HEADER_BUF,
  MAX_HEADER_LEN,
  MDB_MAXIMUM,
  MDCTDELAY,
  MFSIZE,
  NOT_SET,
  POSTDELAY,
  PSFB12,
  PSFB21,
  SBMAX_l,
  SBMAX_s,
  SFBMAX,
  short_block_not_set,
  vbr_off,
} from './constants.ts';
import type { ReplayGain } from './gain_analysis.ts';

const f32 = (n: number): Float32Array => new Float32Array(n);
const i32 = (n: number): Int32Array => new Int32Array(n);
const arr = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

export class ScalefacStruct {
  l = i32(1 + SBMAX_l);
  s = i32(1 + SBMAX_s);
  psfb21 = i32(1 + PSFB21);
  psfb12 = i32(1 + PSFB12);
}

export class III_psy_xmin {
  l = f32(SBMAX_l);
  /** [sfb * 3 + sblock] */
  s = f32(SBMAX_s * 3);

  assign(o: III_psy_xmin): void {
    this.l.set(o.l);
    this.s.set(o.s);
  }
}

export class III_psy_ratio {
  thm = new III_psy_xmin();
  en = new III_psy_xmin();
}

export class GrInfo {
  xr = f32(576);
  l3_enc = i32(576);
  scalefac = i32(SFBMAX);
  xrpow_max = 0;

  part2_3_length = 0;
  big_values = 0;
  count1 = 0;
  global_gain = 0;
  scalefac_compress = 0;
  block_type = 0;
  mixed_block_flag = 0;
  table_select = i32(3);
  subblock_gain = i32(3 + 1);
  region0_count = 0;
  region1_count = 0;
  preflag = 0;
  scalefac_scale = 0;
  count1table_select = 0;

  part2_length = 0;
  sfb_lmax = 0;
  sfb_smin = 0;
  psy_lmax = 0;
  sfbmax = 0;
  psymax = 0;
  sfbdivide = 0;
  width = i32(SFBMAX);
  window = i32(SFBMAX);
  count1bits = 0;
  /* added for LSF */
  /** Offset into `nr_of_sfb_block` (table_number * 12 + row * 4). */
  sfb_partition_table = 0;
  slen = i32(4);

  max_nonzero_coeff = 0;
  energy_above_cutoff = new Uint8Array(SFBMAX);

  /** Struct assignment (`*this = o`). */
  assign(o: GrInfo): void {
    this.xr.set(o.xr);
    this.l3_enc.set(o.l3_enc);
    this.scalefac.set(o.scalefac);
    this.xrpow_max = o.xrpow_max;
    this.part2_3_length = o.part2_3_length;
    this.big_values = o.big_values;
    this.count1 = o.count1;
    this.global_gain = o.global_gain;
    this.scalefac_compress = o.scalefac_compress;
    this.block_type = o.block_type;
    this.mixed_block_flag = o.mixed_block_flag;
    this.table_select.set(o.table_select);
    this.subblock_gain.set(o.subblock_gain);
    this.region0_count = o.region0_count;
    this.region1_count = o.region1_count;
    this.preflag = o.preflag;
    this.scalefac_scale = o.scalefac_scale;
    this.count1table_select = o.count1table_select;
    this.part2_length = o.part2_length;
    this.sfb_lmax = o.sfb_lmax;
    this.sfb_smin = o.sfb_smin;
    this.psy_lmax = o.psy_lmax;
    this.sfbmax = o.sfbmax;
    this.psymax = o.psymax;
    this.sfbdivide = o.sfbdivide;
    this.width.set(o.width);
    this.window.set(o.window);
    this.count1bits = o.count1bits;
    this.sfb_partition_table = o.sfb_partition_table;
    this.slen.set(o.slen);
    this.max_nonzero_coeff = o.max_nonzero_coeff;
    this.energy_above_cutoff.set(o.energy_above_cutoff);
  }
}

export class III_side_info {
  /** [gr][ch] */
  tt: GrInfo[][] = arr(2, () => arr(2, () => new GrInfo()));
  main_data_begin = 0;
  private_bits = 0;
  resvDrain_pre = 0;
  resvDrain_post = 0;
  /** [ch][band] */
  scfsi: Int32Array[] = arr(2, () => i32(4));
}

export class BitStream {
  buf: Uint8Array = new Uint8Array(0);
  buf_size = 0;
  totbit = 0;
  buf_byte_idx = 0;
  buf_bit_idx = 0;
}

export class VBR_seek_info {
  sum = 0;
  seen = 0;
  want = 0;
  pos = 0;
  size = 0;
  bag: Int32Array | null = null;
  nVbrNumFrames = 0;
  nBytesWritten = 0;
  TotalFrameSize = 0;
}

export class ATH {
  use_adjust = 0;
  aa_sensitivity_p = 0;
  adjust_factor = 0;
  adjust_limit = 0;
  decay = 0;
  floor = 0;
  l = f32(SBMAX_l);
  s = f32(SBMAX_s);
  psfb21 = f32(PSFB21);
  psfb12 = f32(PSFB12);
  cb_l = f32(CBANDS);
  cb_s = f32(CBANDS);
  eql_w = f32(BLKSIZE / 2);
}

export class PsyConst_CB2SB {
  masking_lower = f32(CBANDS);
  minval = f32(CBANDS);
  rnumlines = f32(CBANDS);
  mld_cb = f32(CBANDS);
  mld = f32(Math.max(SBMAX_l, SBMAX_s));
  bo_weight = f32(Math.max(SBMAX_l, SBMAX_s));
  attack_threshold = 0;
  /** [b * 2 + {0,1}] */
  s3ind = i32(CBANDS * 2);
  numlines = i32(CBANDS);
  bm = i32(Math.max(SBMAX_l, SBMAX_s));
  bo = i32(Math.max(SBMAX_l, SBMAX_s));
  npart = 0;
  n_sb = 0;
  s3: Float32Array = f32(0);

  assign(o: PsyConst_CB2SB): void {
    this.masking_lower.set(o.masking_lower);
    this.minval.set(o.minval);
    this.rnumlines.set(o.rnumlines);
    this.mld_cb.set(o.mld_cb);
    this.mld.set(o.mld);
    this.bo_weight.set(o.bo_weight);
    this.attack_threshold = o.attack_threshold;
    this.s3ind.set(o.s3ind);
    this.numlines.set(o.numlines);
    this.bm.set(o.bm);
    this.bo.set(o.bo);
    this.npart = o.npart;
    this.n_sb = o.n_sb;
    this.s3 = o.s3;
  }
}

export class PsyConst {
  window = f32(BLKSIZE);
  window_s = f32(BLKSIZE_s / 2);
  l = new PsyConst_CB2SB();
  s = new PsyConst_CB2SB();
  l_to_s = new PsyConst_CB2SB();
  attack_threshold = f32(4);
  decay = 0;
  force_short_block_calc = 0;
}

export class PsyStateVar {
  nb_l1: Float32Array[] = arr(4, () => f32(CBANDS));
  nb_l2: Float32Array[] = arr(4, () => f32(CBANDS));
  nb_s1: Float32Array[] = arr(4, () => f32(CBANDS));
  nb_s2: Float32Array[] = arr(4, () => f32(CBANDS));

  thm: III_psy_xmin[] = arr(4, () => new III_psy_xmin());
  en: III_psy_xmin[] = arr(4, () => new III_psy_xmin());

  /* loudness calculation (for adaptive threshold of hearing) */
  loudness_sq_save = f32(2);

  tot_ener = f32(4);

  last_en_subshort: Float32Array[] = arr(4, () => f32(9));
  last_attacks = i32(4);

  blocktype_old = i32(2);
}

export class PsyResult {
  /** loudness^2 approx. per granule and channel, [gr][ch] */
  loudness_sq: Float32Array[] = arr(2, () => f32(2));
}

export class HeaderBuf {
  write_timing = 0;
  ptr = 0;
  buf = new Uint8Array(MAX_HEADER_LEN);
}

export class EncStateVar {
  /* variables for newmdct.c */
  /** [ch][gr] -> 18 * 32 subband samples */
  sb_sample: Float32Array[][] = arr(2, () => arr(2, () => f32(18 * 32)));
  amp_filter = f32(32);

  /* variables used by util.c (resampling) */
  itime = new Float64Array(2);
  inbuf_old: Float32Array[] = [];
  blackfilt: Float32Array[] = new Array<Float32Array>(2 * BPC + 1);

  pefirbuf = f32(19);

  /* used for padding */
  frac_SpF = 0;
  slot_lag = 0;

  /* variables for bitstream.c */
  header: HeaderBuf[] = arr(MAX_HEADER_BUF, () => new HeaderBuf());
  h_ptr = 0;
  w_ptr = 0;
  ancillary_flag = 0;

  /* variables for reservoir.c */
  ResvSize = 0; /* in bits */
  ResvMax = 0; /* in bits */

  in_buffer_nsamples = 0;
  in_buffer_0: Float32Array = f32(0);
  in_buffer_1: Float32Array = f32(0);

  mfbuf: Float32Array[] = arr(2, () => f32(MFSIZE));

  mf_samples_to_encode = ENCDELAY + POSTDELAY;
  mf_size = ENCDELAY - MDCTDELAY; /* we pad input with this many 0's */
}

export class EncResult {
  /* simple statistics */
  bitrate_channelmode_hist: Int32Array[] = arr(16, () => i32(4 + 1));
  bitrate_blocktype_hist: Int32Array[] = arr(16, () => i32(4 + 1 + 1));

  bitrate_index = 0;
  frame_number = 0; /* number of frames encoded */
  padding = 0; /* padding for the current frame? */
  mode_ext = 0;
  encoder_delay = ENCDELAY;
  encoder_padding = 0; /* number of samples of padding appended to input */
}

export class QntStateVar {
  /* variables for nspsytune */
  longfact = f32(SBMAX_l);
  shortfact = f32(SBMAX_s);
  masking_lower = 1;
  mask_adjust = 0; /* the dbQ stuff */
  mask_adjust_short = 0; /* the dbQ stuff */
  OldValue = i32(2).fill(180);
  CurrentStep = i32(2).fill(4);
  pseudohalf = i32(SFBMAX);
  sfb21_extra = 0;
  substep_shaping = 0;

  bv_scf = new Int8Array(576);
}

export class RpgResult {
  noclipScale = -1.0;
  PeakSample = 0;
  RadioGain = 0;
  noclipGainChange = 0;
}

export class SessionConfig {
  version = 0; /* 0=MPEG-2/2.5  1=MPEG-1 */
  samplerate_index = 0;
  sideinfo_len = 0;

  noise_shaping = 0;
  subblock_gain = 0;
  use_best_huffman = 0;
  noise_shaping_amp = 0;
  noise_shaping_stop = 0;
  full_outer_loop = 0;

  lowpassfreq = 0;
  highpassfreq = 0;
  samplerate_in = 0;
  samplerate_out = 0;
  channels_in = 0;
  channels_out = 0;
  mode_gr = 0;
  force_ms = 0;

  quant_comp = 0;
  quant_comp_short = 0;

  use_temporal_masking_effect = 0;
  use_safe_joint_stereo = 0;

  preset = 0;

  vbr = vbr_off;
  vbr_avg_bitrate_kbps = 0;
  vbr_min_bitrate_index = 1;
  vbr_max_bitrate_index = 13;
  avg_bitrate = 0;
  enforce_min_bitrate = 0;

  findReplayGain = 0;
  findPeakSample = 0;
  decode_on_the_fly = 0;
  analysis = 0;
  disable_reservoir = 0;
  buffer_constraint = 0;
  free_format = 0;
  write_lame_tag = 0;

  error_protection = 0;
  copyright = 0;
  original = 0;
  extension = 0;
  emphasis = 0;

  mode = 0;
  short_blocks = 0;

  // The following are C `float`s: always store through Math.fround.
  interChRatio = 0;
  msfix = 0;
  ATH_offset_db = 0;
  ATH_offset_factor = 0;
  ATHcurve = 0;
  ATHtype = 0;
  ATHonly = 0;
  ATHshort = 0;
  noATH = 0;

  ATHfixpoint = 0;

  adjust_alto_db = 0;
  adjust_bass_db = 0;
  adjust_treble_db = 0;
  adjust_sfb21_db = 0;

  compression_ratio = 0;

  /* lowpass and highpass filter control */
  lowpass1 = 0;
  lowpass2 = 0;
  highpass1 = 0;
  highpass2 = 0;

  /** scale input by this amount before encoding, [row * 2 + col] */
  pcm_transform = f32(4);

  minval = 0;
}

/** The user-facing settings block (`lame_global_flags`). */
export class LameGlobalFlags {
  /* input description */
  num_samples = 0xffffffff;
  num_channels = 2;
  samplerate_in = 44100;
  samplerate_out = 0;
  scale = 1;
  scale_left = 1;
  scale_right = 1;

  /* general control params */
  analysis = 0;
  write_lame_tag = 1;
  decode_only = 0;
  quality = -1;
  mode = NOT_SET;
  force_ms = 0;
  free_format = 0;
  findReplayGain = 0;
  decode_on_the_fly = 0;
  write_id3tag_automatic = 1;

  nogap_total = 0;
  nogap_current = 0;

  substep_shaping = 0;
  noise_shaping = 0;
  subblock_gain = -1;
  use_best_huffman = 0;

  brate = 0;
  compression_ratio = 0;

  /* frame params */
  copyright = 0;
  original = 1;
  extension = 0;
  emphasis = 0;
  error_protection = 0;
  strict_ISO = MDB_MAXIMUM;

  disable_reservoir = 0;

  /* quantization/noise shaping */
  quant_comp = -1;
  quant_comp_short = -1;
  experimentalY = 0;
  experimentalZ = 0;
  exp_nspsytune = 0;

  preset = 0;

  /* VBR control */
  VBR = vbr_off;
  VBR_q_frac = 0;
  VBR_q = 4;
  VBR_mean_bitrate_kbps = 128;
  VBR_min_bitrate_kbps = 0;
  VBR_max_bitrate_kbps = 0;
  VBR_hard_min = 0;

  /* resampling and filtering */
  lowpassfreq = 0;
  highpassfreq = 0;
  lowpasswidth = -1;
  highpasswidth = -1;

  /* psycho acoustics */
  maskingadjust = 0;
  maskingadjust_short = 0;
  ATHonly = 0;
  ATHshort = 0;
  noATH = 0;
  ATHtype = -1;
  ATHcurve = -1;
  ATH_lower_db = 0;
  athaa_type = -1;
  athaa_sensitivity = 0.0;
  short_blocks = short_block_not_set;
  useTemporal = -1;
  interChRatio = -1;
  msfix = -1;

  tune = 0;
  tune_value_a = 0;

  attackthre = -1;
  attackthre_s = -1;

  internal_flags = new LameInternalFlags();
}

export class LameInternalFlags {
  lame_init_params_successful = 0;
  lame_encode_frame_init = 0;
  iteration_init_init = 0;
  fill_buffer_resample_init = 0;

  cfg = new SessionConfig();

  bs = new BitStream();
  l3_side = new III_side_info();

  scalefac_band = new ScalefacStruct();

  sv_psy = new PsyStateVar(); /* DATA FROM PSYMODEL.C */
  ov_psy = new PsyResult();
  sv_enc = new EncStateVar(); /* DATA FROM ENCODER.C */
  ov_enc = new EncResult();
  sv_qnt = new QntStateVar(); /* DATA FROM QUANTIZE.C */

  rgdata: ReplayGain | null = null;
  ov_rpg = new RpgResult();

  nMusicCRC = 0;

  VBR_seek_table = new VBR_seek_info(); /* used for Xing VBR header */

  ATH = new ATH(); /* all ATH related stuff */

  cd_psy: PsyConst | null = null;

  /** ID3v2 tag bytes queued for the start of the stream, ID3v1 for its end (see id3tag.ts). */
  id3v2: Uint8Array | null = null;
  id3v1: Uint8Array | null = null;
}
