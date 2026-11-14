// Compile-time constants of libmp3lame (encoder.h, l3side.h, util.h, quantize_pvt.h, lame.h).

/** `Math.fround` - every single-precision operation of the C code is rounded through this. */
export const f: (x: number) => number = Math.fround;

export const ENCDELAY = 576;
export const POSTDELAY = 1152;
export const MDCTDELAY = 48;
export const FFTOFFSET = 224 + MDCTDELAY;
export const DECDELAY = 528;

export const SBLIMIT = 32;
export const CBANDS = 64;

export const SBPSY_l = 21;
export const SBPSY_s = 12;
export const SBMAX_l = 22;
export const SBMAX_s = 13;
export const PSFB21 = 6;
export const PSFB12 = 6;

export const BLKSIZE = 1024;
export const HBLKSIZE = BLKSIZE / 2 + 1;
export const BLKSIZE_s = 256;
export const HBLKSIZE_s = BLKSIZE_s / 2 + 1;

export const NORM_TYPE = 0;
export const START_TYPE = 1;
export const SHORT_TYPE = 2;
export const STOP_TYPE = 3;

export const MPG_MD_LR_LR = 0;
export const MPG_MD_LR_I = 1;
export const MPG_MD_MS_LR = 2;
export const MPG_MD_MS_I = 3;

/** max scalefactor band, max(SBMAX_l, SBMAX_s*3, (SBMAX_s-3)*3+8) */
export const SFBMAX = SBMAX_s * 3;

export const MAX_BITS_PER_CHANNEL = 4095;
export const MAX_BITS_PER_GRANULE = 7680;

export const LAME_MAXALBUMART = 128 * 1024;
export const LAME_MAXMP3BUFFER = 16384 + LAME_MAXALBUMART;
export const BUFFER_SIZE = LAME_MAXMP3BUFFER;

export const MAX_HEADER_BUF = 256;
export const MAX_HEADER_LEN = 40;

export const MFSIZE = 3 * 1152 + ENCDELAY - MDCTDELAY;
export const BPC = 320;

export const IXMAX_VAL = 8206;
export const PRECALC_SIZE = IXMAX_VAL + 2;
export const Q_MAX = 256 + 1;
export const Q_MAX2 = 116;
export const LARGE_BITS = 100000;

export const PI = 3.14159265358979323846;
export const LOG2 = 0.69314718055994530942;
export const LOG10 = 2.30258509299404568402;
export const SQRT2 = 1.41421356237309504880;

export const FLT_EPSILON = 1.1920928955078125e-7;
export const FLT_MAX = 3.4028234663852886e38;
export const INT_MAX = 2147483647;

export const CRC16_POLYNOMIAL = 0x8005;

// vbr_mode
export const vbr_off = 0;
export const vbr_mt = 1;
export const vbr_rh = 2;
export const vbr_abr = 3;
export const vbr_mtrh = 4;
export const vbr_default = vbr_mtrh;

// MPEG_mode
export const STEREO = 0;
export const JOINT_STEREO = 1;
export const DUAL_CHANNEL = 2;
export const MONO = 3;
export const NOT_SET = 4;

// short_block_t
export const short_block_not_set = -1;
export const short_block_allowed = 0;
export const short_block_coupled = 1;
export const short_block_dispensed = 2;
export const short_block_forced = 3;

// buffer constraint (strict_ISO)
export const MDB_DEFAULT = 0;
export const MDB_STRICT_ISO = 1;
export const MDB_MAXIMUM = 2;

// preset_mode
export const V9 = 410;
export const V8 = 420;
export const V7 = 430;
export const V6 = 440;
export const V5 = 450;
export const V4 = 460;
export const V3 = 470;
export const V2 = 480;
export const V1 = 490;
export const V0 = 500;
export const R3MIX = 1000;
export const STANDARD = 1001;
export const EXTREME = 1002;
export const INSANE = 1003;
export const STANDARD_FAST = 1004;
export const EXTREME_FAST = 1005;
export const MEDIUM = 1006;
export const MEDIUM_FAST = 1007;

const EQ_EPS = Math.fround(1e-6);

/**
 * C's EQ() macro from machine.h. Both operands are FLOATs at every call site, so the
 * difference is a single precision operation; the rest is evaluated in double.
 */
export function EQ(a: number, b: number): boolean {
  const d = Math.abs(Math.fround(a - b));
  return Math.abs(a) > Math.abs(b) ? d <= Math.abs(a) * EQ_EPS : d <= Math.abs(b) * EQ_EPS;
}

export function NEQ(a: number, b: number): boolean {
  return !EQ(a, b);
}
