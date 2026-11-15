# lame-ts

A zero-dependency, pure TypeScript port of the **libmp3lame 3.100** MP3 encoder.

It is not WebAssembly and not a wrapper: the encoder core of LAME (psychoacoustic model, MDCT,
quantization loops, Huffman coding, bit reservoir, Xing/LAME tag, ReplayGain analysis; about
18,000 lines of C) has been translated line by line, and its output is **byte-identical** to the
C library's. It runs anywhere JavaScript runs: Node.js, Bun, Deno, browsers, workers.

> 纯 TypeScript 实现的 libmp3lame 3.100 MP3 编码器移植版：零依赖、非 wasm，输出与 C 版 libmp3lame
> 逐字节一致（对照条件见下文 “Bit-exactness”）。

## Install

```sh
npm install lame-ts
```

## Usage

```ts
import { encodeMp3, Mp3Encoder } from 'lame-ts';

// One shot: PCM in, complete MP3 file out (the same bytes `lame -V 2 in.wav` would write).
const mp3 = encodeMp3([left, right], { sampleRate: 44100, channels: 2, vbrQuality: 2 });

// Streaming
const enc = new Mp3Encoder({ sampleRate: 48000, channels: 2, bitrate: 192 });
const chunks = [];
for (const [l, r] of blocks) chunks.push(enc.encode(l, r)); // any block size
chunks.push(enc.flush());
// Optional: the first frame of the stream is a placeholder for the Xing/Info ("LAME") tag.
// For a seekable VBR file with exact length, overwrite it once encoding has finished:
const tag = enc.getLameTagFrame(); // write at byte offset 0
```

PCM can be `Int16Array` (16-bit), `Int32Array` (full scale ±2³¹) or `Float32Array` /
`Float64Array` (full scale ±1.0), planar (`encode(left, right)`) or interleaved
(`encodeInterleaved(pcm)`).

Planar channels must use the same full-scale convention (`Float32Array` and `Float64Array`
can be mixed). An optional `nsamples` argument to `encode()` / `encodeInterleaved()` counts
samples per channel and must be a non-negative integer that fits in the supplied buffers.
Without an explicit count, interleaved input must contain complete channel frames. Mismatched
channel scales and invalid sample counts throw before encoding. Returned chunks own their
output bytes and can be retained without retaining oversized working buffers.

### Options

| option | `lame` flag | |
| --- | --- | --- |
| `sampleRate` | | input sample rate in Hz (required) |
| `channels` | | `1` or `2` (default `2`) |
| `bitrate` | `-b` | CBR bitrate in kbps (default mode, 128); minimum bitrate for VBR/ABR |
| `vbrQuality` | `-V` | VBR quality `0` (best) … `9.999`; selects VBR |
| `vbrOld` | `--vbr-old` | use the older VBR algorithm |
| `abr` | `--abr` | average bitrate in kbps; selects ABR |
| `minBitrate`, `maxBitrate` | `-b`, `-B` | bitrate limits for VBR/ABR |
| `quality` | `-q` | algorithm quality `0` (slowest) … `9` (fastest), default `3` |
| `mode` | `-m` | `'joint'`, `'stereo'`, `'forced-ms'`, `'dual'`, `'mono'` |
| `outSampleRate` | `--resample` | output sample rate in Hz (default: chosen by the encoder) |
| `lowpass`, `highpass` | `--lowpass`, `--highpass` | filter frequencies in Hz, `-1` = off |
| `scale` | `--scale` | input gain factor |
| `writeTag` | `-t` (to disable) | emit the Xing/Info/LAME tag frame (default `true`) |
| `replayGain` | `--noreplaygain` (to disable) | run the ReplayGain analysis (default `false`, as in libmp3lame; the `lame` program turns it on) |
| `errorProtection`, `copyright`, `original` | `-p`, `-c`, `-o` | frame header flags / CRC |
| `disableReservoir` | `--nores` | disable the bit reservoir |
| `enforceMinBitrate` | `-F` | strictly enforce the minimum bitrate |
| `configure` | | callback that receives the raw `lame_global_flags` before `lame_init_params()` |

Also exported: `parseWav()` (a small RIFF/WAVE reader that unpacks samples like the `lame`
frontend does), `LAME_VERSION`, and for gapless albums `flushNoGap()` / `startNextTrack()`.

### Command line

```sh
npx lame-ts -V 2 input.wav output.mp3
```

`lame-ts` understands the common subset of the `lame` options listed above (`--help` prints
them) and produces the file the `lame` program would produce for the same options.

## Bit-exactness

"Byte-identical to libmp3lame" needs a precise definition, because the C library itself does
not produce the same bytes on every platform. lame-ts matches LAME 3.100 built as follows
(`scripts/build-reference.sh` does exactly this):

- **the portable C code path**: what `./configure && make` selects on arm64 and other
  non-x86 targets. The x86 builds of LAME enable different algorithms
  (`TAKEHIRO_IEEE754_HACK`, `USE_FAST_LOG`, SSE/3DNow routines) that are faster but round
  differently; that profile is not what lame-ts reproduces.
- **strict IEEE-754 arithmetic**, `-ffp-contract=off`. Compilers that fuse `a * b + c` into
  FMA instructions (clang does on arm64 by default, so e.g. the Homebrew `lame` on Apple
  Silicon) change the rounding of intermediate results and with it the output.
- **`powf` / `log10f` rounded from double precision** (`scripts/shim.h`). These two libm
  functions are not exactly specified and differ between C libraries in the last bit;
  lame-ts uses `Math.fround(Math.pow(x, y))` and `Math.fround(Math.log10(x))`.

Against that reference every comparison made so far is byte-identical:

- 800 encodes of 18 clips of real music and synthetic material (8, 11.025, 12, 16, 22.05, 24,
  32, 44.1, 48 and 96 kHz; mono and stereo; 8/16/24-bit) covering CBR at every bitrate from
  8 to 320 kbps, ABR, both VBR algorithms from `-V 0` to `-V 9.9` including fractional
  qualities, `-q 0` … `-q 9`, all channel modes, resampling, lowpass/highpass, `--scale`,
  CRC, `--nores`, `-t`, `-F`, min/max bitrates and ReplayGain on/off; plus spot checks with
  32-bit integer and 32-bit float WAV input.
- `npm test` re-checks 46 of these configurations on deterministic signals against SHA-256
  hashes recorded from the reference encoder, so it runs without a C toolchain.

Caveats, honestly stated:

- The comparison ran on macOS/arm64 with Node.js 24 (V8) and Bun (JavaScriptCore). The
  encoder also calls `exp`, `log`, `pow`, `cos`, `sin`, `atan`… in double precision, where
  neither C nor ECMAScript guarantees the last bit. No difference showed up in any test, but
  a different libm or JavaScript engine could in principle disagree somewhere.
- To reproduce the comparison on your own material: `scripts/build-reference.sh`, then
  `scripts/compare.sh song.wav -V 2`.

## What is not included

- the MP3 **decoder** (mpglib) and everything that depends on it (`--decode`,
  `--replaygain-accurate`, peak sample detection)
- **ID3 tags** (`id3tag.c`): write them yourself in front of / behind the stream if needed
- free-format bitstreams and the `--preset` aliases on the command line (the settings behind
  the presets are available through `vbrQuality` / `abr` / `bitrate`)
- the frame analyzer hooks (`gtkanal`)

## Performance

Roughly 30× real time for 44.1 kHz stereo on an Apple M-series core under Node.js 24, which
is about 4–5 times slower than the native C library.

An encoder instance keeps all of its state to itself, so any number of them can be used
side by side.

## Development

```sh
npm install
npm test            # node --test, runs the TypeScript sources directly (Node.js >= 22.18)
npm run build       # emits dist/
npm run check       # typecheck, all tests, and build
npm run release:verify # pack, install, and verify the package consumers receive
scripts/build-reference.sh                       # builds the reference lame into .reference/
LAME_REF=.reference/lame-3.100/frontend/lame node scripts/gen-fixtures.ts
scripts/compare.sh some.wav --abr 128
```

`src/` mirrors the layout of `libmp3lame/` (`psymodel.ts` ↔ `psymodel.c`, `quantize.ts` ↔
`quantize.c`, …) and keeps the original function and variable names, so the port can be
audited side by side with the C sources. `src/tables.ts` is generated from the C tables by
`scripts/gen-tables/gen.sh`.

Official releases use GitHub Actions and npm Trusted Publishing. See
[the release guide](docs/releasing.md) for the version/tag workflow and first-release setup.

## License

LAME is the work of Mike Cheng, Mark Taylor, Robert Hegemann, Takehiro Tominaga, Naoki
Shibata, Gabriel Bouvigne, Alexander Leidinger and the other LAME developers
(<https://lame.sourceforge.io>). lame-ts is a derivative work of LAME and is distributed
under the same terms, the GNU Library General Public License version 2 or later; see
[LICENSE](LICENSE).

MP3 patents have expired worldwide (2017), but check the situation that applies to you.
