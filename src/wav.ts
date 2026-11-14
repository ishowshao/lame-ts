// Minimal RIFF/WAVE reader. Samples are unpacked exactly like the lame frontend does
// (get_audio.c): every integer format is left-aligned into a 32-bit int.

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** true for IEEE float files (format tag 3). */
  float: boolean;
  /** Number of sample frames. */
  numSamples: number;
  /**
   * Interleaved samples: an Int32Array with left-aligned 32-bit samples (full scale +/- 2^31)
   * for integer PCM and for 32-bit float files, which are converted the way the lame frontend
   * converts them; a Float64Array (full scale +/- 1.0) for 64-bit float files.
   */
  samples: Int32Array | Float64Array;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function parseWav(file: Uint8Array): WavData {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (o: number): string => String.fromCharCode(file[o], file[o + 1], file[o + 2], file[o + 3]);

  if (file.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('lame-ts: not a RIFF/WAVE file');
  }

  let format = 0,
    channels = 0,
    sampleRate = 0,
    bits = 0,
    blockAlign = 0;
  let dataOff = -1,
    dataLen = 0;

  let p = 12;
  while (p + 8 <= file.length) {
    const id = tag(p);
    let len = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      format = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      blockAlign = dv.getUint16(body + 12, true);
      bits = dv.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && len >= 26) {
        format = dv.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOff = body;
      /* a streamed file may carry a bogus length: take what is there */
      if (len === 0 || len === 0xffffffff || body + len > file.length) len = file.length - body;
      dataLen = len;
      break;
    }
    p = body + len + (len & 1);
  }

  if (dataOff < 0 || channels === 0) throw new Error('lame-ts: WAVE file without fmt/data chunk');
  if (channels > 2) throw new Error('lame-ts: only mono and stereo input is supported');
  if (format !== WAVE_FORMAT_PCM && format !== WAVE_FORMAT_IEEE_FLOAT) {
    throw new Error(`lame-ts: unsupported WAVE format tag ${format}`);
  }

  const bytes = (bits + 7) >> 3;
  if (blockAlign === 0) blockAlign = bytes * channels;
  const numSamples = Math.floor(dataLen / (bytes * channels));
  const n = numSamples * channels;

  if (format === WAVE_FORMAT_IEEE_FLOAT) {
    if (bits === 32) {
      /* frontend/get_audio.c: floats are converted to 32-bit integers, in single precision */
      const s = new Int32Array(n);
      const f = Math.fround;
      for (let i = 0; i < n; i++) {
        const u = dv.getFloat32(dataOff + 4 * i, true);
        if (u >= 1) s[i] = 2147483647;
        else if (u <= -1) s[i] = -2147483648;
        else if (u >= 0) s[i] = Math.trunc(f(f(u * 2147483648) + 0.5));
        else s[i] = Math.trunc(f(f(u * 2147483648) - 0.5));
      }
      return { sampleRate, channels, bitsPerSample: bits, float: true, numSamples, samples: s };
    }
    if (bits === 64) {
      const s = new Float64Array(n);
      for (let i = 0; i < n; i++) s[i] = dv.getFloat64(dataOff + 8 * i, true);
      return { sampleRate, channels, bitsPerSample: bits, float: true, numSamples, samples: s };
    }
    throw new Error(`lame-ts: unsupported float sample size ${bits}`);
  }

  const s = new Int32Array(n);
  let o = dataOff;
  switch (bytes) {
    case 1:
      /* unsigned 8 bit */
      for (let i = 0; i < n; i++, o += 1) s[i] = ((file[o] ^ 0x80) << 24) | (0x7f << 16);
      break;
    case 2:
      for (let i = 0; i < n; i++, o += 2) s[i] = (file[o] << 16) | (file[o + 1] << 24);
      break;
    case 3:
      for (let i = 0; i < n; i++, o += 3) s[i] = (file[o] << 8) | (file[o + 1] << 16) | (file[o + 2] << 24);
      break;
    case 4:
      for (let i = 0; i < n; i++, o += 4) s[i] = dv.getInt32(o, true);
      break;
    default:
      throw new Error(`lame-ts: unsupported sample size ${bits}`);
  }
  return { sampleRate, channels, bitsPerSample: bits, float: false, numSamples, samples: s };
}
