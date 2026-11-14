// Deterministic test signals. Only integer arithmetic and exactly rounded IEEE operations are
// used (no Math.sin & co), so every JavaScript engine produces the very same samples.

export interface SignalSpec {
  sampleRate: number;
  channels: 1 | 2;
  seconds: number;
  seed: number;
}

/** Returns interleaved 16-bit PCM: a few detuned triangle voices, noise bursts and a pause. */
export function makeSignal(spec: SignalSpec): Int16Array {
  const { sampleRate: sr, channels: ch, seconds, seed } = spec;
  const n = Math.floor(sr * seconds);
  const out = new Int16Array(n * ch);

  let lcg = seed >>> 0;
  const rnd = (): number => {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    return lcg;
  };
  /* triangle wave in [-1, 1] from a 32 bit phase */
  const tri = (phase: number): number => {
    const p = (phase >>> 0) / 4294967296;
    return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
  };

  const NOTES = [110, 147, 165, 196, 220, 262, 330, 392, 440, 523, 659, 784, 1047, 1568, 2093, 3136];
  const noteLen = Math.floor(sr / 4);
  const burstLen = Math.floor(sr / 2);
  const phase = [0, 0, 0];
  const inc = [0, 0, 0];
  let burst = 0;
  let lp = 0;

  for (let i = 0; i < n; i++) {
    if (i % noteLen === 0) {
      for (let v = 0; v < 3; v++) {
        const f = NOTES[rnd() >>> 28] * (v + 1);
        inc[v] = Math.floor((Math.min(f, sr * 0.45) / sr) * 4294967296);
      }
    }
    if (i % burstLen === Math.floor(burstLen / 3)) burst = 1;
    const t = i / n;
    const pause = t > 0.55 && t < 0.6;

    let tone = 0;
    for (let v = 0; v < 3; v++) {
      phase[v] = (phase[v] + inc[v]) >>> 0;
      tone += tri(phase[v]) / (v + 1);
    }
    const white = rnd() / 2147483648 - 1;
    lp += (white - lp) * 0.25;
    const noise = burst * white + 0.02 * lp;
    burst *= 0.9985;

    const env = pause ? 0 : 1;
    const l = env * (0.3 * tone + 0.35 * noise);
    if (ch === 2) {
      const white2 = rnd() / 2147483648 - 1;
      const r = env * (0.26 * tone * (t < 0.5 ? 1 : -0.5) + 0.3 * burst * white2 + 0.05 * tri(phase[0] * 3));
      out[2 * i] = Math.round(l * 32000);
      out[2 * i + 1] = Math.round(r * 32000);
    } else {
      out[i] = Math.round(l * 32000);
    }
  }
  return out;
}

/** Wraps interleaved 16-bit PCM into a canonical 44 byte header WAV file. */
export function makeWav(pcm: Int16Array, sampleRate: number, channels: number): Uint8Array {
  const data = pcm.length * 2;
  const buf = new Uint8Array(44 + data);
  const dv = new DataView(buf.buffer);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + data, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  tag(36, 'data');
  dv.setUint32(40, data, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + 2 * i, pcm[i], true);
  return buf;
}
