// Regenerates test/fixtures.json: runs the reference `lame` binary over every conformance case
// and records the SHA-256 of what it writes.
//
//   LAME_REF=/path/to/reference/lame node scripts/gen-fixtures.ts
//
// See scripts/build-reference.sh for how the reference binary has to be built.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASES, caseName } from '../test/cases.ts';
import { makeSignal, makeWav } from '../test/signals.ts';

const ref = process.env.LAME_REF;
if (!ref) throw new Error('set LAME_REF to the reference lame binary');

const dir = mkdtempSync(join(tmpdir(), 'lame-ts-fixtures-'));
const out: Record<string, { bytes: number; sha256: string }> = {};
try {
  const wav = join(dir, 'in.wav');
  const mp3 = join(dir, 'out.mp3');
  for (const c of CASES) {
    const s = c.signal;
    writeFileSync(wav, makeWav(makeSignal(s), s.sampleRate, s.channels));
    execFileSync(ref, ['--quiet', ...c.args.split(' ').filter(Boolean), wav, mp3]);
    const data = readFileSync(mp3);
    out[caseName(c)] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
writeFileSync(new URL('../test/fixtures.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${Object.keys(out).length} fixtures`);
