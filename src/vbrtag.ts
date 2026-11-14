// Port of libmp3lame/VbrTag.c - the Xing / "Info" / LAME tag frame (writer side only).

import { add_dummy_byte, CRC_writeheader } from './bitstream.ts';
import {
  DUAL_CHANNEL,
  f,
  JOINT_STEREO,
  MONO,
  short_block_dispensed,
  short_block_forced,
  STEREO,
  vbr_abr,
  vbr_off,
} from './constants.ts';
import { bitrate_table, crc16_lookup } from './tables.ts';
import type { LameGlobalFlags, LameInternalFlags, VBR_seek_info } from './types.ts';
import { BitrateIndex } from './util.ts';
import { get_lame_tag_encoder_short_version } from './version.ts';

const FRAMES_FLAG = 0x0001;
const BYTES_FLAG = 0x0002;
const TOC_FLAG = 0x0004;
const VBR_SCALE_FLAG = 0x0008;

const NUMTOCENTRIES = 100;

/*
 *    4 bytes for Header Tag
 *    4 bytes for Header Flags
 *  100 bytes for entry (NUMTOCENTRIES)
 *    4 bytes for FRAME SIZE
 *    4 bytes for STREAM_SIZE
 *    4 bytes for VBR SCALE. a VBR quality indicator: 0=best 100=worst
 *   20 bytes for LAME tag.  for example, "LAME3.12 (beta 6)"
 * ___________
 *  140 bytes
 */
const VBRHEADERSIZE = NUMTOCENTRIES + 4 + 4 + 4 + 4 + 4;

const LAMEHEADERSIZE = VBRHEADERSIZE + 9 + 1 + 1 + 8 + 1 + 1 + 3 + 1 + 1 + 2 + 4 + 2 + 2;

/* the size of the Xing header (MPEG1 and MPEG2) in kbps */
const XING_BITRATE1 = 128;
const XING_BITRATE2 = 64;
const XING_BITRATE25 = 32;

const MAXFRAMESIZE = 2880; /* or 0xB40, the max freeformat 640 32kHz framesize */

/***********************************************************************
 *  Robert Hegemann 2001-01-17
 ***********************************************************************/

function addVbr(v: VBR_seek_info, bitrate: number): void {
  const bag = v.bag!;

  v.nVbrNumFrames++;
  v.sum += bitrate;
  v.seen++;

  if (v.seen < v.want) {
    return;
  }

  if (v.pos < v.size) {
    bag[v.pos] = v.sum;
    v.pos++;
    v.seen = 0;
  }
  if (v.pos === v.size) {
    for (let i = 1; i < v.size; i += 2) {
      bag[(i / 2) | 0] = bag[i];
    }
    v.want *= 2;
    v.pos = (v.pos / 2) | 0;
  }
}

function Xing_seek_table(v: VBR_seek_info, t: Uint8Array): void {
  if (v.pos <= 0) return;
  const bag = v.bag!;

  for (let i = 1; i < NUMTOCENTRIES; ++i) {
    const j = f(i / NUMTOCENTRIES);
    let indx = Math.floor(f(j * v.pos));
    if (indx > v.pos - 1) indx = v.pos - 1;
    const act = f(bag[indx]);
    const sum = f(v.sum);
    let seek_point = Math.trunc((256 * act) / sum);
    if (seek_point > 255) seek_point = 255;
    t[i] = seek_point;
  }
}

/****************************************************************************
 * AddVbrFrame: Add VBR entry, used to fill the VBR the TOC entries
 ****************************************************************************
 */
export function AddVbrFrame(gfc: LameInternalFlags): void {
  const kbps = bitrate_table[gfc.cfg.version][gfc.ov_enc.bitrate_index];
  addVbr(gfc.VBR_seek_table, kbps);
}

function CreateI4(buf: Uint8Array, o: number, nValue: number): void {
  /* big endian create */
  buf[o] = (nValue >>> 24) & 0xff;
  buf[o + 1] = (nValue >>> 16) & 0xff;
  buf[o + 2] = (nValue >>> 8) & 0xff;
  buf[o + 3] = nValue & 0xff;
}

function CreateI2(buf: Uint8Array, o: number, nValue: number): void {
  /* big endian create */
  buf[o] = (nValue >> 8) & 0xff;
  buf[o + 1] = nValue & 0xff;
}

function xingBitrate(gfc: LameInternalFlags): number {
  const cfg = gfc.cfg;
  let bitrate: number;
  if (1 === cfg.version) {
    bitrate = XING_BITRATE1;
  } else {
    if (cfg.samplerate_out < 16000) bitrate = XING_BITRATE25;
    else bitrate = XING_BITRATE2;
  }

  if (cfg.vbr === vbr_off) bitrate = cfg.avg_bitrate;
  return bitrate;
}

/** `buffer` must be zeroed (at least its first four bytes). */
function setLameTagFrameHeader(gfc: LameInternalFlags, buffer: Uint8Array): void {
  const cfg = gfc.cfg;
  const eov = gfc.ov_enc;
  let abyte: number, bbyte: number;

  buffer[0] = 0xff;
  buffer[1] =
    (7 << 5) |
    ((cfg.samplerate_out < 16000 ? 0 : 1) << 4) |
    ((cfg.version & 1) << 3) |
    ((4 - 3) << 1) |
    (!cfg.error_protection ? 1 : 0);
  buffer[2] = ((eov.bitrate_index & 15) << 4) | ((cfg.samplerate_index & 3) << 2) | (cfg.extension & 1);
  buffer[3] =
    ((cfg.mode & 3) << 6) |
    ((eov.mode_ext & 3) << 4) |
    ((cfg.copyright & 1) << 3) |
    ((cfg.original & 1) << 2) |
    (cfg.emphasis & 3);

  /* the default VBR header. 48 kbps layer III, no padding, no crc */
  /* but sampling freq, mode andy copyright/copy protection taken */
  /* from first valid frame */
  abyte = buffer[1] & 0xf1;
  {
    const bitrate = xingBitrate(gfc);

    if (cfg.free_format) bbyte = 0x00;
    else bbyte = (16 * BitrateIndex(bitrate, cfg.version, cfg.samplerate_out)) & 0xff;
  }

  /* Use as much of the info from the real frames in the
   * Xing header:  samplerate, channels, crc, etc...
   */
  if (cfg.version === 1) {
    /* MPEG1 */
    buffer[1] = abyte | 0x0a; /* was 0x0b; */
    abyte = buffer[2] & 0x0d; /* AF keep also private bit */
    buffer[2] = bbyte | abyte; /* 64kbs MPEG1 frame */
  } else {
    /* MPEG2 */
    buffer[1] = abyte | 0x02; /* was 0x03; */
    abyte = buffer[2] & 0x0d; /* AF keep also private bit */
    buffer[2] = bbyte | abyte; /* 64kbs MPEG2 frame */
  }
}

/****************************************************************************
 * InitVbrTag: Initializes the header, and write empty frame to stream
 ****************************************************************************
 */
export function InitVbrTag(gfp: LameGlobalFlags): number {
  const gfc = gfp.internal_flags!;
  const cfg = gfc.cfg;

  /*
   * Xing VBR pretends to be a 48kbs layer III frame.  (at 44.1kHz).
   * (at 48kHz they use 56kbs since 48kbs frame not big enough for
   * table of contents)
   * let's always embed Xing header inside a 64kbs layer III frame.
   * this gives us enough room for a LAME version string too.
   * size determined by sampling frequency (MPEG1)
   * 32kHz:    216 bytes@48kbs    288bytes@ 64kbs
   * 44.1kHz:  156 bytes          208bytes@64kbs     (+1 if padding = 1)
   * 48kHz:    144 bytes          192
   *
   * MPEG 2 values are the same since the framesize and samplerate
   * are each reduced by a factor of 2.
   */
  const kbps_header = xingBitrate(gfc);

  /** make sure LAME Header fits into Frame
   */
  {
    const total_frame_size = (((cfg.version + 1) * 72000 * kbps_header) / cfg.samplerate_out) | 0;
    const header_size = cfg.sideinfo_len + LAMEHEADERSIZE;
    gfc.VBR_seek_table.TotalFrameSize = total_frame_size;
    if (total_frame_size < header_size || total_frame_size > MAXFRAMESIZE) {
      /* disable tag, it wont fit */
      gfc.cfg.write_lame_tag = 0;
      return 0;
    }
  }

  gfc.VBR_seek_table.nVbrNumFrames = 0;
  gfc.VBR_seek_table.nBytesWritten = 0;
  gfc.VBR_seek_table.sum = 0;

  gfc.VBR_seek_table.seen = 0;
  gfc.VBR_seek_table.want = 1;
  gfc.VBR_seek_table.pos = 0;

  if (gfc.VBR_seek_table.bag === null) {
    gfc.VBR_seek_table.bag = new Int32Array(400);
    gfc.VBR_seek_table.size = 400;
  }

  /* write dummy VBR tag of all 0's into bitstream */
  {
    const buffer = new Uint8Array(MAXFRAMESIZE);

    setLameTagFrameHeader(gfc, buffer);
    const n = gfc.VBR_seek_table.TotalFrameSize;
    for (let i = 0; i < n; ++i) {
      add_dummy_byte(gfc, buffer[i], 1);
    }
  }
  /* Success */
  return 0;
}

/* fast CRC-16 computation - uses table crc16_lookup 8*/
function CRC_update_lookup(value: number, crc: number): number {
  const tmp = crc ^ value;
  return ((crc >> 8) ^ crc16_lookup[tmp & 0xff]) & 0xffff;
}

/** Returns the updated CRC. */
export function UpdateMusicCRC(crc: number, buffer: Uint8Array, bo: number, size: number): number {
  for (let i = 0; i < size; ++i) crc = CRC_update_lookup(buffer[bo + i], crc);
  return crc;
}

const vbr_type_translator = [1, 5, 3, 2, 4, 0, 3]; /*numbering different in vbr_mode vs. Lame tag */

/****************************************************************************
 * Jonathan Dee 2001/08/31
 *
 * PutLameVBR: Write LAME info: mini version + info on various switches used
 * Paramters:
 *                              pbtStreamBuffer : pointer to output buffer
 *                              crc                             : computation of crc-16 of Lame Tag so far (starting at frame sync)
 *
 ****************************************************************************
 */
function PutLameVBR(
  gfp: LameGlobalFlags,
  nMusicLength: number,
  pbtStreamBuffer: Uint8Array,
  o: number,
  crc: number,
): number {
  const gfc = gfp.internal_flags!;
  const cfg = gfc.cfg;

  let nBytesWritten = 0;

  const enc_delay = gfc.ov_enc.encoder_delay; /* encoder delay */
  const enc_padding = gfc.ov_enc.encoder_padding; /* encoder padding  */

  /*recall: cfg->vbr_q is for example set by the switch -V  */
  /*   gfp->quality by -q, -h, -f, etc */

  let nQuality = 100 - 10 * gfp.VBR_q - gfp.quality;

  const szVersion = get_lame_tag_encoder_short_version();

  let nVBR: number;
  const nRevision = 0x00;
  const lp = cfg.lowpassfreq / 100.0 + 0.5;
  const nLowpass = Math.trunc(lp > 255 ? 255 : lp) & 0xff;

  let nPeakSignalAmplitude = 0;

  let nRadioReplayGain = 0;
  const nAudiophileReplayGain = 0;

  const nNoiseShaping = cfg.noise_shaping & 0xff;
  let nStereoMode = 0;
  let bNonOptimal = 0;
  let nSourceFreq = 0;

  /*psy model type: Gpsycho or NsPsytune */
  const bExpNPsyTune = 1; /* only NsPsytune */
  const bSafeJoint = cfg.use_safe_joint_stereo !== 0 ? 1 : 0;
  let bNoGapMore = 0;
  let bNoGapPrevious = 0;

  const nNoGapCount = gfp.nogap_total;
  const nNoGapCurr = gfp.nogap_current;

  const nAthType = cfg.ATHtype & 0xff; /*4 bits. */

  /* if ABR, {store bitrate <=255} else { store "-b"} */
  let nABRBitrate: number;
  switch (cfg.vbr) {
    case vbr_abr: {
      nABRBitrate = cfg.vbr_avg_bitrate_kbps;
      break;
    }
    case vbr_off: {
      nABRBitrate = cfg.avg_bitrate;
      break;
    }
    default: {
      /*vbr modes */
      nABRBitrate = bitrate_table[cfg.version][cfg.vbr_min_bitrate_index];
    }
  }

  /*revision and vbr method */
  if (cfg.vbr >= 0 && cfg.vbr < vbr_type_translator.length) nVBR = vbr_type_translator[cfg.vbr];
  else nVBR = 0x00; /*unknown. */

  const nRevMethod = 0x10 * nRevision + nVBR;

  /* ReplayGain */
  if (cfg.findReplayGain) {
    let RadioGain = gfc.ov_rpg.RadioGain;
    if (RadioGain > 0x1fe) RadioGain = 0x1fe;
    if (RadioGain < -0x1fe) RadioGain = -0x1fe;

    nRadioReplayGain = 0x2000; /* set name code */
    nRadioReplayGain |= 0xc00; /* set originator code to `determined automatically' */

    if (RadioGain >= 0) nRadioReplayGain |= RadioGain; /* set gain adjustment */
    else {
      nRadioReplayGain |= 0x200; /* set the sign bit */
      nRadioReplayGain |= -RadioGain; /* set gain adjustment */
    }
  }

  /* peak sample */
  if (cfg.findPeakSample)
    nPeakSignalAmplitude = Math.abs(Math.trunc((f(gfc.ov_rpg.PeakSample) / 32767.0) * Math.pow(2, 23) + 0.5));

  /*nogap */
  if (nNoGapCount !== -1) {
    if (nNoGapCurr > 0) bNoGapPrevious = 1;

    if (nNoGapCurr < nNoGapCount - 1) bNoGapMore = 1;
  }

  /*flags */

  const nFlags = (nAthType + (bExpNPsyTune << 4) + (bSafeJoint << 5) + (bNoGapMore << 6) + (bNoGapPrevious << 7)) & 0xff;

  if (nQuality < 0) nQuality = 0;

  /*stereo mode field... a bit ugly. */

  switch (cfg.mode) {
    case MONO:
      nStereoMode = 0;
      break;
    case STEREO:
      nStereoMode = 1;
      break;
    case DUAL_CHANNEL:
      nStereoMode = 2;
      break;
    case JOINT_STEREO:
      if (cfg.force_ms) nStereoMode = 4;
      else nStereoMode = 3;
      break;
    default:
      nStereoMode = 7;
      break;
  }

  /*Intensity stereo : nStereoMode = 6. IS is not implemented */

  if (cfg.samplerate_in <= 32000) nSourceFreq = 0x00;
  else if (cfg.samplerate_in === 48000) nSourceFreq = 0x02;
  else if (cfg.samplerate_in > 48000) nSourceFreq = 0x03;
  else nSourceFreq = 0x01; /*default is 44100Hz. */

  /*Check if the user overrided the default LAME behaviour with some nasty options */

  if (
    cfg.short_blocks === short_block_forced ||
    cfg.short_blocks === short_block_dispensed ||
    (cfg.lowpassfreq === -1 && cfg.highpassfreq === -1) /* "-k" */ ||
    (cfg.disable_reservoir && cfg.avg_bitrate < 320) ||
    cfg.noATH ||
    cfg.ATHonly ||
    nAthType === 0 ||
    cfg.samplerate_in <= 32000
  )
    bNonOptimal = 1;

  const nMisc = (nNoiseShaping + (nStereoMode << 2) + (bNonOptimal << 5) + (nSourceFreq << 6)) & 0xff;

  const nMusicCRC = gfc.nMusicCRC;

  /*Write all this information into the stream */
  CreateI4(pbtStreamBuffer, o + nBytesWritten, nQuality);
  nBytesWritten += 4;

  for (let i = 0; i < 9; i++) pbtStreamBuffer[o + nBytesWritten + i] = i < szVersion.length ? szVersion.charCodeAt(i) : 0;
  nBytesWritten += 9;

  pbtStreamBuffer[o + nBytesWritten] = nRevMethod;
  nBytesWritten++;

  pbtStreamBuffer[o + nBytesWritten] = nLowpass;
  nBytesWritten++;

  CreateI4(pbtStreamBuffer, o + nBytesWritten, nPeakSignalAmplitude);
  nBytesWritten += 4;

  CreateI2(pbtStreamBuffer, o + nBytesWritten, nRadioReplayGain);
  nBytesWritten += 2;

  CreateI2(pbtStreamBuffer, o + nBytesWritten, nAudiophileReplayGain);
  nBytesWritten += 2;

  pbtStreamBuffer[o + nBytesWritten] = nFlags;
  nBytesWritten++;

  if (nABRBitrate >= 255) pbtStreamBuffer[o + nBytesWritten] = 0xff;
  else pbtStreamBuffer[o + nBytesWritten] = nABRBitrate;
  nBytesWritten++;

  pbtStreamBuffer[o + nBytesWritten] = enc_delay >> 4; /* works for win32, does it for unix? */
  pbtStreamBuffer[o + nBytesWritten + 1] = (enc_delay << 4) + (enc_padding >> 8);
  pbtStreamBuffer[o + nBytesWritten + 2] = enc_padding;

  nBytesWritten += 3;

  pbtStreamBuffer[o + nBytesWritten] = nMisc;
  nBytesWritten++;

  pbtStreamBuffer[o + nBytesWritten++] = 0; /*unused in rev0 */

  CreateI2(pbtStreamBuffer, o + nBytesWritten, cfg.preset);
  nBytesWritten += 2;

  CreateI4(pbtStreamBuffer, o + nBytesWritten, nMusicLength);
  nBytesWritten += 4;

  CreateI2(pbtStreamBuffer, o + nBytesWritten, nMusicCRC);
  nBytesWritten += 2;

  /*Calculate tag CRC.... must be done here, since it includes
   *previous information*/

  for (let i = 0; i < nBytesWritten; i++) crc = CRC_update_lookup(pbtStreamBuffer[o + i], crc);

  CreateI2(pbtStreamBuffer, o + nBytesWritten, crc);
  nBytesWritten += 2;

  return nBytesWritten;
}

/**
 * Builds the final Xing/LAME tag frame, which replaces the placeholder frame written at the
 * start of the stream. Returns the frame, or null when no tag is to be written.
 */
export function lame_get_lametag_frame(gfp: LameGlobalFlags): Uint8Array | null {
  const gfc = gfp.internal_flags;
  if (!gfc) return null;
  const cfg = gfc.cfg;
  if (cfg.write_lame_tag === 0) {
    return null;
  }
  if (gfc.VBR_seek_table.pos <= 0) {
    return null;
  }
  const buffer = new Uint8Array(gfc.VBR_seek_table.TotalFrameSize);
  const btToc = new Uint8Array(NUMTOCENTRIES);

  /* 4 bytes frame header */

  setLameTagFrameHeader(gfc, buffer);

  /* Clear all TOC entries */

  if (cfg.free_format) {
    for (let i = 1; i < NUMTOCENTRIES; ++i) btToc[i] = ((255 * i) / 100) | 0;
  } else {
    Xing_seek_table(gfc.VBR_seek_table, btToc);
  }

  /* Start writing the tag after the zero frame */
  let nStreamIndex = cfg.sideinfo_len;
  /* note! Xing header specifies that Xing data goes in the
   * ancillary data with NO ERROR PROTECTION.  If error protecton
   * in enabled, the Xing data still starts at the same offset,
   * and now it is in sideinfo data block, and thus will not
   * decode correctly by non-Xing tag aware players */
  if (cfg.error_protection) nStreamIndex -= 2;

  /* Put Vbr tag */
  const tag = cfg.vbr === vbr_off ? 'Info' : 'Xing';
  for (let i = 0; i < 4; i++) buffer[nStreamIndex++] = tag.charCodeAt(i);

  /* Put header flags */
  CreateI4(buffer, nStreamIndex, FRAMES_FLAG + BYTES_FLAG + TOC_FLAG + VBR_SCALE_FLAG);
  nStreamIndex += 4;

  /* Put Total Number of frames */
  CreateI4(buffer, nStreamIndex, gfc.VBR_seek_table.nVbrNumFrames);
  nStreamIndex += 4;

  /* Put total audio stream size, including Xing/LAME Header */
  const stream_size = gfc.VBR_seek_table.nBytesWritten + gfc.VBR_seek_table.TotalFrameSize;
  CreateI4(buffer, nStreamIndex, stream_size);
  nStreamIndex += 4;

  /* Put TOC */
  buffer.set(btToc, nStreamIndex);
  nStreamIndex += NUMTOCENTRIES;

  if (cfg.error_protection) {
    /* (jo) error_protection: add crc16 information to header */
    CRC_writeheader(gfc, buffer);
  }
  {
    /*work out CRC so far: initially crc = 0 */
    let crc = 0x00;
    for (let i = 0; i < nStreamIndex; i++) crc = CRC_update_lookup(buffer[i], crc);
    /*Put LAME VBR info */
    nStreamIndex += PutLameVBR(gfp, stream_size, buffer, nStreamIndex, crc);
  }

  return buffer;
}
