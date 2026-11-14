// Port of libmp3lame/reservoir.c - bit reservoir bookkeeping.

import { getframebits } from './bitstream.ts';
import type { GrInfo, LameInternalFlags } from './types.ts';

/**
 * Called (repeatedly) at the beginning of a frame. Updates the maximum
 * size of the reservoir, and checks to make sure main_data_begin
 * was set properly by the formatter.
 *
 * Returns [fullFrameBits, mean_bits].
 */
export function ResvFrameBegin(gfc: LameInternalFlags): [number, number] {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  const l3_side = gfc.l3_side;

  const frameLength = getframebits(gfc);
  const meanBits = ((frameLength - cfg.sideinfo_len * 8) / cfg.mode_gr) | 0;

  /*
   *  Meaning of the variables:
   *      resvLimit: (0, 8, ..., 8*255 (MPEG-2), 8*511 (MPEG-1))
   *          Number of bits can be stored in previous frame(s) due to
   *          counter size constaints
   *      maxmp3buf: ( ??? ... 8*1951 (MPEG-1 and 2), 8*2047 (MPEG-2.5))
   *          Number of bits allowed to encode one frame (you can take 8*511 bit
   *          from the bit reservoir and at most 8*1440 bit from the current
   *          frame (320 kbps, 32 kHz), so 8*1951 bit is the largest possible
   *          value for MPEG-1 and -2)
   */

  /* main_data_begin has 9 bits in MPEG-1, 8 bits MPEG-2 */
  const resvLimit = 8 * 256 * cfg.mode_gr - 8;

  /* maximum allowed frame size.  dont use more than this number of
     bits, even if the frame has the space for them: */
  const maxmp3buf = cfg.buffer_constraint;
  esv.ResvMax = maxmp3buf - frameLength;
  if (esv.ResvMax > resvLimit) esv.ResvMax = resvLimit;
  if (esv.ResvMax < 0 || cfg.disable_reservoir) esv.ResvMax = 0;

  let fullFrameBits = meanBits * cfg.mode_gr + Math.min(esv.ResvSize, esv.ResvMax);

  if (fullFrameBits > maxmp3buf) fullFrameBits = maxmp3buf;

  l3_side.resvDrain_pre = 0;

  return [fullFrameBits, meanBits];
}

/**
 * Returns [targ_bits, extra_bits]:
 *   targ_bits:  target number of bits to use for 1 granule
 *   extra_bits: amount extra available from reservoir
 */
export function ResvMaxBits(gfc: LameInternalFlags, mean_bits: number, cbr: number): [number, number] {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  let add_bits: number, targBits: number, extraBits: number;
  let ResvSize = esv.ResvSize,
    ResvMax = esv.ResvMax;

  /* conpensate the saved bits used in the 1st granule */
  if (cbr) ResvSize += mean_bits;

  if (gfc.sv_qnt.substep_shaping & 1) ResvMax = Math.trunc(ResvMax * 0.9);

  targBits = mean_bits;

  /* extra bits if the reservoir is almost full */
  if (ResvSize * 10 > ResvMax * 9) {
    add_bits = ResvSize - (((ResvMax * 9) / 10) | 0);
    targBits += add_bits;
    gfc.sv_qnt.substep_shaping |= 0x80;
  } else {
    add_bits = 0;
    gfc.sv_qnt.substep_shaping &= 0x7f;
    /* build up reservoir.  this builds the reservoir a little slower
     * than FhG.  It could simple be mean_bits/15, but this was rigged
     * to always produce 100 (the old value) at 128kbs */
    if (!cfg.disable_reservoir && !(gfc.sv_qnt.substep_shaping & 1)) targBits = Math.trunc(targBits - 0.1 * mean_bits);
  }

  /* amount from the reservoir we are allowed to use. ISO says 6/10 */
  const lim = ((esv.ResvMax * 6) / 10) | 0;
  extraBits = ResvSize < lim ? ResvSize : lim;
  extraBits -= add_bits;

  if (extraBits < 0) extraBits = 0;

  return [targBits, extraBits];
}

/**
 * Called after a granule's bit allocation. Readjusts the size of
 * the reservoir to reflect the granule's usage.
 */
export function ResvAdjust(gfc: LameInternalFlags, gi: GrInfo): void {
  gfc.sv_enc.ResvSize -= gi.part2_3_length + gi.part2_length;
}

/**
 * Called after all granules in a frame have been allocated. Makes sure
 * that the reservoir size is within limits, possibly by adding stuffing
 * bits.
 */
export function ResvFrameEnd(gfc: LameInternalFlags, mean_bits: number): void {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  const l3_side = gfc.l3_side;
  let stuffingBits: number;
  let over_bits: number;

  esv.ResvSize += mean_bits * cfg.mode_gr;
  stuffingBits = 0;
  l3_side.resvDrain_post = 0;
  l3_side.resvDrain_pre = 0;

  /* we must be byte aligned */
  if ((over_bits = esv.ResvSize % 8) !== 0) stuffingBits += over_bits;

  over_bits = esv.ResvSize - stuffingBits - esv.ResvMax;
  if (over_bits > 0) {
    stuffingBits += over_bits;
  }

  /* drain as many bits as possible into previous frame ancillary data
   * In particular, in VBR mode ResvMax may have changed, and we have
   * to make sure main_data_begin does not create a reservoir bigger
   * than ResvMax  mt 4/00*/
  {
    const mdb_bytes = (Math.min(l3_side.main_data_begin * 8, stuffingBits) / 8) | 0;
    l3_side.resvDrain_pre += 8 * mdb_bytes;
    stuffingBits -= 8 * mdb_bytes;
    esv.ResvSize -= 8 * mdb_bytes;
    l3_side.main_data_begin -= mdb_bytes;
  }
  /* drain the rest into this frames ancillary data */
  l3_side.resvDrain_post += stuffingBits;
  esv.ResvSize -= stuffingBits;
}
