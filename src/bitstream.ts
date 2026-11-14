// Port of libmp3lame/bitstream.c - MP3 bitstream output.

import {
  BUFFER_SIZE,
  CRC16_POLYNOMIAL,
  MAX_HEADER_BUF,
  MDB_DEFAULT,
  MDB_MAXIMUM,
  MDB_STRICT_ISO,
  NORM_TYPE,
  SHORT_TYPE,
} from './constants.ts';
import { bitrate_table, ht, nr_of_sfb_block } from './tables.ts';
import { slen1_tab, slen2_tab } from './takehiro.ts';
import type { GrInfo, LameInternalFlags, SessionConfig } from './types.ts';
import { UpdateMusicCRC } from './vbrtag.ts';
import { get_lame_short_version } from './version.ts';

function calcFrameLength(cfg: SessionConfig, kbps: number, pad: number): number {
  return 8 * ((((cfg.version + 1) * 72000 * kbps) / cfg.samplerate_out + pad) | 0);
}

/***********************************************************************
 * compute bitsperframe and mean_bits for a layer III frame
 **********************************************************************/
export function getframebits(gfc: LameInternalFlags): number {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;
  let bit_rate: number;

  /* get bitrate in kbps [?] */
  if (eov.bitrate_index) bit_rate = bitrate_table[cfg.version][eov.bitrate_index];
  else bit_rate = cfg.avg_bitrate;

  /* main encoding routine toggles padding on and off */
  /* one Layer3 Slot consists of 8 bits */
  return calcFrameLength(cfg, bit_rate, eov.padding);
}

export function get_max_frame_buffer_size_by_constraint(cfg: SessionConfig, constraint: number): number {
  let maxmp3buf = 0;
  if (cfg.avg_bitrate > 320) {
    /* in freeformat the buffer is constant */
    if (constraint === MDB_STRICT_ISO) {
      maxmp3buf = calcFrameLength(cfg, cfg.avg_bitrate, 0);
    } else {
      /* maximum allowed bits per granule are 7680 */
      maxmp3buf = 7680 * (cfg.version + 1);
    }
  } else {
    let max_kbps: number;
    if (cfg.samplerate_out < 16000) {
      max_kbps = bitrate_table[cfg.version][8]; /* default: allow 64 kbps (MPEG-2.5) */
    } else {
      max_kbps = bitrate_table[cfg.version][14];
    }
    switch (constraint) {
      default:
      case MDB_DEFAULT:
        /* Bouvigne suggests this more lax interpretation of the ISO doc instead of using 8*960. */
        /* All mp3 decoders should have enough buffer to handle this value: size of a 320kbps 32kHz frame */
        maxmp3buf = 8 * 1440;
        break;
      case MDB_STRICT_ISO:
        maxmp3buf = calcFrameLength(cfg, max_kbps, 0);
        break;
      case MDB_MAXIMUM:
        maxmp3buf = 7680 * (cfg.version + 1);
        break;
    }
  }
  return maxmp3buf;
}

function putheader_bits(gfc: LameInternalFlags): void {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  const bs = gfc.bs;
  const hb = esv.header[esv.w_ptr].buf;
  for (let i = 0; i < cfg.sideinfo_len; i++) bs.buf[bs.buf_byte_idx + i] = hb[i];
  bs.buf_byte_idx += cfg.sideinfo_len;
  bs.totbit += cfg.sideinfo_len * 8;
  esv.w_ptr = (esv.w_ptr + 1) & (MAX_HEADER_BUF - 1);
}

/*write j bits into the bit stream */
function putbits2(gfc: LameInternalFlags, val: number, j: number): void {
  const esv = gfc.sv_enc;
  const bs = gfc.bs;

  while (j > 0) {
    if (bs.buf_bit_idx === 0) {
      bs.buf_bit_idx = 8;
      bs.buf_byte_idx++;
      if (esv.header[esv.w_ptr].write_timing === bs.totbit) {
        putheader_bits(gfc);
      }
      bs.buf[bs.buf_byte_idx] = 0;
    }

    const k = j < bs.buf_bit_idx ? j : bs.buf_bit_idx;
    j -= k;

    bs.buf_bit_idx -= k;

    bs.buf[bs.buf_byte_idx] |= (val >> j) << bs.buf_bit_idx;
    bs.totbit += k;
  }
}

/*write j bits into the bit stream, ignoring frame headers */
function putbits_noheaders(gfc: LameInternalFlags, val: number, j: number): void {
  const bs = gfc.bs;

  while (j > 0) {
    if (bs.buf_bit_idx === 0) {
      bs.buf_bit_idx = 8;
      bs.buf_byte_idx++;
      bs.buf[bs.buf_byte_idx] = 0;
    }

    const k = j < bs.buf_bit_idx ? j : bs.buf_bit_idx;
    j -= k;

    bs.buf_bit_idx -= k;

    bs.buf[bs.buf_byte_idx] |= (val >> j) << bs.buf_bit_idx;
    bs.totbit += k;
  }
}

/*
  Some combinations of bitrate, Fs, and stereo make it impossible to stuff
  out a frame using just main_data, due to the limited number of bits to
  indicate main_data_length. In these situations, we put stuffing bits into
  the ancillary data...
*/
function drain_into_ancillary(gfc: LameInternalFlags, remainingBits: number): void {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;

  if (remainingBits >= 8) {
    putbits2(gfc, 0x4c, 8);
    remainingBits -= 8;
  }
  if (remainingBits >= 8) {
    putbits2(gfc, 0x41, 8);
    remainingBits -= 8;
  }
  if (remainingBits >= 8) {
    putbits2(gfc, 0x4d, 8);
    remainingBits -= 8;
  }
  if (remainingBits >= 8) {
    putbits2(gfc, 0x45, 8);
    remainingBits -= 8;
  }

  if (remainingBits >= 32) {
    const version = get_lame_short_version();
    for (let i = 0; i < version.length && remainingBits >= 8; ++i) {
      remainingBits -= 8;
      putbits2(gfc, version.charCodeAt(i), 8);
    }
  }

  for (; remainingBits >= 1; remainingBits -= 1) {
    putbits2(gfc, esv.ancillary_flag, 1);
    esv.ancillary_flag ^= cfg.disable_reservoir ? 0 : 1;
  }
}

/*write N bits into the header */
function writeheader(gfc: LameInternalFlags, val: number, j: number): void {
  const esv = gfc.sv_enc;
  const h = esv.header[esv.h_ptr];
  let ptr = h.ptr;

  while (j > 0) {
    const r = 8 - (ptr & 7);
    const k = j < r ? j : r;
    j -= k;
    h.buf[ptr >> 3] |= (val >> j) << (8 - (ptr & 7) - k);
    ptr += k;
  }
  h.ptr = ptr;
}

function CRC_update(value: number, crc: number): number {
  value <<= 8;
  for (let i = 0; i < 8; i++) {
    value <<= 1;
    crc <<= 1;

    if ((crc ^ value) & 0x10000) crc ^= CRC16_POLYNOMIAL;
  }
  return crc;
}

export function CRC_writeheader(gfc: LameInternalFlags, header: Uint8Array): void {
  const cfg = gfc.cfg;
  let crc = 0xffff; /* (jo) init crc16 for error_protection */

  crc = CRC_update(header[2], crc);
  crc = CRC_update(header[3], crc);
  for (let i = 6; i < cfg.sideinfo_len; i++) {
    crc = CRC_update(header[i], crc);
  }

  header[4] = crc >> 8;
  header[5] = crc & 255;
}

function writeTableSelect(gfc: LameInternalFlags, gi: GrInfo, n: number): void {
  for (let i = 0; i < n; i++) {
    if (gi.table_select[i] === 14) gi.table_select[i] = 16;
    writeheader(gfc, gi.table_select[i], 5);
  }
}

function writeGranuleBlockInfo(gfc: LameInternalFlags, gi: GrInfo): void {
  if (gi.block_type !== NORM_TYPE) {
    writeheader(gfc, 1, 1); /* window_switching_flag */
    writeheader(gfc, gi.block_type, 2);
    writeheader(gfc, gi.mixed_block_flag, 1);

    writeTableSelect(gfc, gi, 2);

    writeheader(gfc, gi.subblock_gain[0], 3);
    writeheader(gfc, gi.subblock_gain[1], 3);
    writeheader(gfc, gi.subblock_gain[2], 3);
  } else {
    writeheader(gfc, 0, 1); /* window_switching_flag */
    writeTableSelect(gfc, gi, 3);
    writeheader(gfc, gi.region0_count, 4);
    writeheader(gfc, gi.region1_count, 3);
  }
}

function encodeSideInfo2(gfc: LameInternalFlags, bitsPerFrame: number): void {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;
  const esv = gfc.sv_enc;
  const l3_side = gfc.l3_side;
  let gr: number, ch: number;

  esv.header[esv.h_ptr].ptr = 0;
  esv.header[esv.h_ptr].buf.fill(0, 0, cfg.sideinfo_len);
  if (cfg.samplerate_out < 16000) writeheader(gfc, 0xffe, 12);
  else writeheader(gfc, 0xfff, 12);
  writeheader(gfc, cfg.version, 1);
  writeheader(gfc, 4 - 3, 2);
  writeheader(gfc, cfg.error_protection ? 0 : 1, 1);
  writeheader(gfc, eov.bitrate_index, 4);
  writeheader(gfc, cfg.samplerate_index, 2);
  writeheader(gfc, eov.padding, 1);
  writeheader(gfc, cfg.extension, 1);
  writeheader(gfc, cfg.mode, 2);
  writeheader(gfc, eov.mode_ext, 2);
  writeheader(gfc, cfg.copyright, 1);
  writeheader(gfc, cfg.original, 1);
  writeheader(gfc, cfg.emphasis, 2);
  if (cfg.error_protection) {
    writeheader(gfc, 0, 16); /* dummy */
  }

  if (cfg.version === 1) {
    /* MPEG1 */
    writeheader(gfc, l3_side.main_data_begin, 9);

    if (cfg.channels_out === 2) writeheader(gfc, l3_side.private_bits, 3);
    else writeheader(gfc, l3_side.private_bits, 5);

    for (ch = 0; ch < cfg.channels_out; ch++) {
      for (let band = 0; band < 4; band++) {
        writeheader(gfc, l3_side.scfsi[ch][band], 1);
      }
    }

    for (gr = 0; gr < 2; gr++) {
      for (ch = 0; ch < cfg.channels_out; ch++) {
        const gi = l3_side.tt[gr][ch];
        writeheader(gfc, gi.part2_3_length + gi.part2_length, 12);
        writeheader(gfc, (gi.big_values / 2) | 0, 9);
        writeheader(gfc, gi.global_gain, 8);
        writeheader(gfc, gi.scalefac_compress, 4);

        writeGranuleBlockInfo(gfc, gi);
        writeheader(gfc, gi.preflag, 1);
        writeheader(gfc, gi.scalefac_scale, 1);
        writeheader(gfc, gi.count1table_select, 1);
      }
    }
  } else {
    /* MPEG2 */
    writeheader(gfc, l3_side.main_data_begin, 8);
    writeheader(gfc, l3_side.private_bits, cfg.channels_out);

    gr = 0;
    for (ch = 0; ch < cfg.channels_out; ch++) {
      const gi = l3_side.tt[gr][ch];
      writeheader(gfc, gi.part2_3_length + gi.part2_length, 12);
      writeheader(gfc, (gi.big_values / 2) | 0, 9);
      writeheader(gfc, gi.global_gain, 8);
      writeheader(gfc, gi.scalefac_compress, 9);

      writeGranuleBlockInfo(gfc, gi);

      writeheader(gfc, gi.scalefac_scale, 1);
      writeheader(gfc, gi.count1table_select, 1);
    }
  }

  if (cfg.error_protection) {
    /* (jo) error_protection: add crc16 information to header */
    CRC_writeheader(gfc, esv.header[esv.h_ptr].buf);
  }

  {
    const old = esv.h_ptr;

    esv.h_ptr = (old + 1) & (MAX_HEADER_BUF - 1);
    esv.header[esv.h_ptr].write_timing = esv.header[old].write_timing + bitsPerFrame;

    if (esv.h_ptr === esv.w_ptr) {
      /* yikes! we are out of header buffer space */
      throw new Error('lame-ts: MAX_HEADER_BUF too small in bitstream');
    }
  }
}

function huffman_coder_count1(gfc: LameInternalFlags, gi: GrInfo): number {
  /* Write count1 area */
  const h = ht[gi.count1table_select + 32];
  const table = h.table!;
  const hlen = h.hlen!;
  let bits = 0;

  const ix = gi.l3_enc;
  const xr = gi.xr;
  let o = gi.big_values;

  for (let i = ((gi.count1 - gi.big_values) / 4) | 0; i > 0; --i) {
    let huffbits = 0;
    let p = 0;

    if (ix[o]) {
      p += 8;
      if (xr[o] < 0) huffbits++;
    }

    if (ix[o + 1]) {
      p += 4;
      huffbits *= 2;
      if (xr[o + 1] < 0) huffbits++;
    }

    if (ix[o + 2]) {
      p += 2;
      huffbits *= 2;
      if (xr[o + 2] < 0) huffbits++;
    }

    if (ix[o + 3]) {
      p++;
      huffbits *= 2;
      if (xr[o + 3] < 0) huffbits++;
    }

    o += 4;
    putbits2(gfc, huffbits + table[p], hlen[p]);
    bits += hlen[p];
  }
  return bits;
}

/*
  Implements the pseudocode of page 98 of the IS
  */
function Huffmancode(gfc: LameInternalFlags, tableindex: number, start: number, end: number, gi: GrInfo): number {
  const h = ht[tableindex];
  const linbits = h.xlen;
  let bits = 0;

  if (!tableindex) return bits;

  const table = h.table!;
  const hlen = h.hlen!;
  const l3_enc = gi.l3_enc;
  const xr = gi.xr;

  for (let i = start; i < end; i += 2) {
    let cbits = 0;
    let xbits = 0;
    let xlen = h.xlen;
    let ext = 0;
    let x1 = l3_enc[i];
    let x2 = l3_enc[i + 1];

    if (x1 !== 0) {
      if (xr[i] < 0) ext++;
      cbits--;
    }

    if (tableindex > 15) {
      /* use ESC-words */
      if (x1 >= 15) {
        const linbits_x1 = x1 - 15;
        ext |= linbits_x1 << 1;
        xbits = linbits;
        x1 = 15;
      }

      if (x2 >= 15) {
        const linbits_x2 = x2 - 15;
        ext <<= linbits;
        ext |= linbits_x2;
        xbits += linbits;
        x2 = 15;
      }
      xlen = 16;
    }

    if (x2 !== 0) {
      ext <<= 1;
      if (xr[i + 1] < 0) ext++;
      cbits--;
    }

    x1 = x1 * xlen + x2;
    xbits -= cbits;
    cbits += hlen[x1];

    putbits2(gfc, table[x1], cbits);
    putbits2(gfc, ext, xbits);
    bits += cbits + xbits;
  }
  return bits;
}

/*
  Note the discussion of huffmancodebits() on pages 28
  and 29 of the IS, as well as the definitions of the side
  information on pages 26 and 27.
  */
function ShortHuffmancodebits(gfc: LameInternalFlags, gi: GrInfo): number {
  let region1Start = 3 * gfc.scalefac_band.s[3];
  if (region1Start > gi.big_values) region1Start = gi.big_values;

  /* short blocks do not have a region2 */
  let bits = Huffmancode(gfc, gi.table_select[0], 0, region1Start, gi);
  bits += Huffmancode(gfc, gi.table_select[1], region1Start, gi.big_values, gi);
  return bits;
}

function LongHuffmancodebits(gfc: LameInternalFlags, gi: GrInfo): number {
  const bigvalues = gi.big_values;

  let i = gi.region0_count + 1;
  let region1Start = gfc.scalefac_band.l[i];
  i += gi.region1_count + 1;
  let region2Start = gfc.scalefac_band.l[i];

  if (region1Start > bigvalues) region1Start = bigvalues;

  if (region2Start > bigvalues) region2Start = bigvalues;

  let bits = Huffmancode(gfc, gi.table_select[0], 0, region1Start, gi);
  bits += Huffmancode(gfc, gi.table_select[1], region1Start, region2Start, gi);
  bits += Huffmancode(gfc, gi.table_select[2], region2Start, bigvalues, gi);
  return bits;
}

function writeMainData(gfc: LameInternalFlags): number {
  const cfg = gfc.cfg;
  const l3_side = gfc.l3_side;
  let gr: number,
    ch: number,
    sfb: number,
    data_bits: number,
    tot_bits = 0;

  if (cfg.version === 1) {
    /* MPEG 1 */
    for (gr = 0; gr < 2; gr++) {
      for (ch = 0; ch < cfg.channels_out; ch++) {
        const gi = l3_side.tt[gr][ch];
        const slen1 = slen1_tab[gi.scalefac_compress];
        const slen2 = slen2_tab[gi.scalefac_compress];
        data_bits = 0;
        for (sfb = 0; sfb < gi.sfbdivide; sfb++) {
          if (gi.scalefac[sfb] === -1) continue; /* scfsi is used */
          putbits2(gfc, gi.scalefac[sfb], slen1);
          data_bits += slen1;
        }
        for (; sfb < gi.sfbmax; sfb++) {
          if (gi.scalefac[sfb] === -1) continue; /* scfsi is used */
          putbits2(gfc, gi.scalefac[sfb], slen2);
          data_bits += slen2;
        }

        if (gi.block_type === SHORT_TYPE) {
          data_bits += ShortHuffmancodebits(gfc, gi);
        } else {
          data_bits += LongHuffmancodebits(gfc, gi);
        }
        data_bits += huffman_coder_count1(gfc, gi);
        tot_bits += data_bits;
      } /* for ch */
    } /* for gr */
  } else {
    /* MPEG 2 */
    gr = 0;
    for (ch = 0; ch < cfg.channels_out; ch++) {
      const gi = l3_side.tt[gr][ch];
      let i: number,
        sfb_partition: number,
        scale_bits = 0;
      data_bits = 0;
      sfb = 0;
      sfb_partition = 0;

      if (gi.block_type === SHORT_TYPE) {
        for (; sfb_partition < 4; sfb_partition++) {
          const sfbs = (nr_of_sfb_block[gi.sfb_partition_table + sfb_partition] / 3) | 0;
          const slen = gi.slen[sfb_partition];
          for (i = 0; i < sfbs; i++, sfb++) {
            putbits2(gfc, Math.max(gi.scalefac[sfb * 3 + 0], 0), slen);
            putbits2(gfc, Math.max(gi.scalefac[sfb * 3 + 1], 0), slen);
            putbits2(gfc, Math.max(gi.scalefac[sfb * 3 + 2], 0), slen);
            scale_bits += 3 * slen;
          }
        }
        data_bits += ShortHuffmancodebits(gfc, gi);
      } else {
        for (; sfb_partition < 4; sfb_partition++) {
          const sfbs = nr_of_sfb_block[gi.sfb_partition_table + sfb_partition];
          const slen = gi.slen[sfb_partition];
          for (i = 0; i < sfbs; i++, sfb++) {
            putbits2(gfc, Math.max(gi.scalefac[sfb], 0), slen);
            scale_bits += slen;
          }
        }
        data_bits += LongHuffmancodebits(gfc, gi);
      }
      data_bits += huffman_coder_count1(gfc, gi);
      tot_bits += scale_bits + data_bits;
    } /* for ch */
  } /* for gf */
  return tot_bits;
} /* main_data */

/* compute the number of bits required to flush all mp3 frames
   currently in the buffer.  This should be the same as the
   reservoir size.  Only call this routine between frames - i.e.
   only after all headers and data have been added to the buffer
   by format_bitstream().

   Also compute total_bits_output =
       size of mp3 buffer (including frame headers which may not
       have yet been send to the mp3 buffer) +
       number of bits needed to flush all mp3 frames.

   total_bytes_output is the size of the mp3 output buffer if
   lame_encode_flush_nogap() was called right now.

   Returns [flushbits, total_bytes_output].
 */
export function compute_flushbits(gfc: LameInternalFlags): [number, number] {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  let flushbits: number, remaining_headers: number;
  let total_bytes_output: number;
  const first_ptr = esv.w_ptr; /* first header to add to bitstream */
  let last_ptr = esv.h_ptr - 1; /* last header to add to bitstream */
  if (last_ptr === -1) last_ptr = MAX_HEADER_BUF - 1;

  /* add this many bits to bitstream so we can flush all headers */
  flushbits = esv.header[last_ptr].write_timing - gfc.bs.totbit;
  total_bytes_output = flushbits;

  if (flushbits >= 0) {
    /* if flushbits >= 0, some headers have not yet been written */
    /* reduce flushbits by the size of the headers */
    remaining_headers = 1 + last_ptr - first_ptr;
    if (last_ptr < first_ptr) remaining_headers = 1 + last_ptr - first_ptr + MAX_HEADER_BUF;
    flushbits -= remaining_headers * 8 * cfg.sideinfo_len;
  }

  /* finally, add some bits so that the last frame is complete
   * these bits are not necessary to decode the last frame, but
   * some decoders will ignore last frame if these bits are missing
   */
  const bitsPerFrame = getframebits(gfc);
  flushbits += bitsPerFrame;
  total_bytes_output += bitsPerFrame;
  /* round up:   */
  if (total_bytes_output % 8) total_bytes_output = 1 + ((total_bytes_output / 8) | 0);
  else total_bytes_output = (total_bytes_output / 8) | 0;
  total_bytes_output += gfc.bs.buf_byte_idx + 1;

  return [flushbits, total_bytes_output];
}

export function flush_bitstream(gfc: LameInternalFlags): void {
  const esv = gfc.sv_enc;
  const l3_side = gfc.l3_side;

  const flushbits = compute_flushbits(gfc)[0];
  if (flushbits < 0) return;
  drain_into_ancillary(gfc, flushbits);

  /* we have padded out all frames with ancillary data, which is the
     same as filling the bitreservoir with ancillary data, so : */
  esv.ResvSize = 0;
  l3_side.main_data_begin = 0;
}

export function add_dummy_byte(gfc: LameInternalFlags, val: number, n: number): void {
  const esv = gfc.sv_enc;

  while (n-- > 0) {
    putbits_noheaders(gfc, val, 8);

    for (let i = 0; i < MAX_HEADER_BUF; ++i) esv.header[i].write_timing += 8;
  }
}

/*
  format_bitstream()

  This is called after a frame of audio has been quantized and coded.
  It will write the encoded audio to the bitstream. Note that
  from a layer3 encoder's perspective the bit stream is primarily
  a series of main_data() blocks, with header and side information
  inserted at the proper locations to maintain framing. (See Figure A.7
  in the IS).
  */
export function format_bitstream(gfc: LameInternalFlags): number {
  const cfg = gfc.cfg;
  const esv = gfc.sv_enc;
  let bits: number;
  const l3_side = gfc.l3_side;

  const bitsPerFrame = getframebits(gfc);
  drain_into_ancillary(gfc, l3_side.resvDrain_pre);

  encodeSideInfo2(gfc, bitsPerFrame);
  bits = 8 * cfg.sideinfo_len;
  bits += writeMainData(gfc);
  drain_into_ancillary(gfc, l3_side.resvDrain_post);
  bits += l3_side.resvDrain_post;

  l3_side.main_data_begin += ((bitsPerFrame - bits) / 8) | 0;

  /* compare number of bits needed to clear all buffered mp3 frames
   * with what we think the resvsize is: */
  if (compute_flushbits(gfc)[0] !== esv.ResvSize) {
    throw new Error('lame-ts: internal buffer inconsistency. flushbits <> ResvSize');
  }

  /* compare main_data_begin for the next frame with what we
   * think the resvsize is: */
  if (l3_side.main_data_begin * 8 !== esv.ResvSize) {
    throw new Error(
      `lame-ts: bit reservoir error: main_data_begin=${8 * l3_side.main_data_begin} ResvSize=${esv.ResvSize} ` +
        `drain_post=${l3_side.resvDrain_post} drain_pre=${l3_side.resvDrain_pre} bits=${bits} bitsPerFrame=${bitsPerFrame}`,
    );
  }

  if (gfc.bs.totbit > 1000000000) {
    /* to avoid totbit overflow, (at 8h encoding at 128kbs) lets reset bit counter */
    for (let i = 0; i < MAX_HEADER_BUF; ++i) esv.header[i].write_timing -= gfc.bs.totbit;
    gfc.bs.totbit = 0;
  }

  return 0;
}

function do_copy_buffer(gfc: LameInternalFlags, buffer: Uint8Array, bo: number, size: number): number {
  const bs = gfc.bs;
  const minimum = bs.buf_byte_idx + 1;
  if (minimum <= 0) return 0;
  if (minimum > size) return -1; /* buffer is too small */
  buffer.set(bs.buf.subarray(0, minimum), bo);
  bs.buf_byte_idx = -1;
  bs.buf_bit_idx = 0;
  return minimum;
}

/* copy data out of the internal MP3 bit buffer into a user supplied
   unsigned char buffer.

   mp3data=0      indicates data in buffer is an id3tags and VBR tags
   mp3data=1      data is real mp3 frame data.
*/
export function copy_buffer(
  gfc: LameInternalFlags,
  buffer: Uint8Array,
  bo: number,
  size: number,
  mp3data: number,
): number {
  const minimum = do_copy_buffer(gfc, buffer, bo, size);
  if (minimum > 0 && mp3data) {
    gfc.nMusicCRC = UpdateMusicCRC(gfc.nMusicCRC, buffer, bo, minimum);

    /** sum number of bytes belonging to the mp3 stream
     *  this info will be written into the Xing/LAME header for seeking
     */
    gfc.VBR_seek_table.nBytesWritten += minimum;

    /* (decode-on-the-fly gain analysis is not part of this port) */
  } /* if (mp3data) */
  return minimum;
}

export function init_bit_stream_w(gfc: LameInternalFlags): void {
  const esv = gfc.sv_enc;

  esv.h_ptr = esv.w_ptr = 0;
  esv.header[esv.h_ptr].write_timing = 0;

  gfc.bs.buf = new Uint8Array(BUFFER_SIZE);
  gfc.bs.buf_size = BUFFER_SIZE;
  gfc.bs.buf_byte_idx = -1;
  gfc.bs.buf_bit_idx = 0;
  gfc.bs.totbit = 0;
}
