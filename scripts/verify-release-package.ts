// Verify the archive users will install, not the source checkout's imports.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, caseName } from '../test/cases.ts';
import { makeSignal, makeWav } from '../test/signals.ts';

interface PackResult {
  name: string;
  version: string;
  filename: string;
  integrity: string;
  files: { path: string }[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(join(root, 'test/fixtures.json'), 'utf8'));
let destination: string | undefined;
let packageSpec: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  const value = process.argv[++i];
  assert.ok(value && !value.startsWith('--'), `missing value for ${flag}`);
  if (flag === '--pack-destination') destination = resolve(value);
  else if (flag === '--package') packageSpec = value;
  else throw new Error(`unknown argument ${flag}`);
}

const temporary = mkdtempSync(join(tmpdir(), 'lame-ts-release-'));
const runtime = process.env.LAME_TS_RUNTIME_NODE ?? process.execPath;
function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
}

try {
  const packArgs = ['pack', '--json', '--pack-destination', temporary];
  if (packageSpec) packArgs.push(packageSpec, '--registry=https://registry.npmjs.org/', '--prefer-online');
  const [packed] = JSON.parse(run('npm', packArgs)) as PackResult[];
  assert.ok(packed);
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  const paths = packed.files.map((file) => file.path);
  for (const required of ['package.json', 'LICENSE', 'README.md', 'CHANGELOG.md', 'src/index.ts', 'dist/index.js', 'dist/index.d.ts', 'dist/cli.js']) {
    assert.ok(paths.includes(required), `package is missing ${required}`);
  }
  for (const path of paths) {
    assert.match(path, /^(?:dist\/|src\/|package\.json$|LICENSE$|README\.md$|CHANGELOG\.md$)/, `unexpected packed file: ${path}`);
    assert.doesNotMatch(path, /(?:^|\/)\.(?:env|npmrc|git)/);
  }

  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'lame-ts-release-check', private: true, type: 'module' }));
  const tarball = join(temporary, packed.filename);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/lame-ts/package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.license, 'LGPL-2.0-or-later');
  assert.equal(installed.type, 'module');
  assert.deepEqual(installed.dependencies ?? {}, {});
  assert.deepEqual(installed.bin, { 'lame-ts': 'dist/cli.js' });
  const executable = join(consumer, 'node_modules/.bin/lame-ts');
  assert.ok(existsSync(executable), 'installation did not expose the lame-ts command');
  assert.equal(run(runtime, [executable, '--version'], consumer), 'lame-ts (LAME 3.100)');
  assert.match(run(runtime, [executable, '--help'], consumer), /usage: lame-ts/);

  const cases = [CASES[1], CASES[16], CASES[29]].map((c, index) => {
    writeFileSync(join(consumer, `${index}.wav`), makeWav(makeSignal(c.signal), c.signal.sampleRate, c.signal.channels));
    return { index, args: c.args.split(' ').filter(Boolean), options: { replayGain: true, ...c.options, sampleRate: c.signal.sampleRate, channels: c.signal.channels }, expected: fixtures[caseName(c)] };
  });
  writeFileSync(join(consumer, 'cases.json'), JSON.stringify(cases));
  writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { encodeMp3, Mp3Encoder, parseWav } from 'lame-ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const c of JSON.parse(readFileSync('cases.json', 'utf8'))) {
  const wav = parseWav(readFileSync(c.index + '.wav'));
  const oneShot = encodeMp3(wav.samples, c.options);
  assert.equal(oneShot.length, c.expected.bytes);
  assert.equal(hash(oneShot), c.expected.sha256);
  const encoder = new Mp3Encoder(c.options);
  const chunks = [];
  for (let p = 0; p < wav.samples.length; p += 1994) chunks.push(encoder.encodeInterleaved(wav.samples.subarray(p, p + 1994)));
  chunks.push(encoder.flush());
  const stream = Buffer.concat(chunks);
  const tag = encoder.getLameTagFrame();
  if (tag) stream.set(tag, 0);
  assert.equal(hash(stream), c.expected.sha256);
  execFileSync(process.execPath, ['node_modules/.bin/lame-ts', ...c.args, c.index + '.wav', c.index + '.mp3'], { stdio: 'pipe' });
  assert.equal(hash(readFileSync(c.index + '.mp3')), c.expected.sha256);
}
console.log('Installed API, streaming, and CLI match 3 reference hashes on ' + process.version);
`);
  console.log(run(runtime, ['smoke.mjs'], consumer));
  writeFileSync(join(consumer, 'consumer.ts'), `import { encodeMp3, Mp3Encoder } from 'lame-ts';
import type { Mp3EncoderOptions } from 'lame-ts';
const options: Mp3EncoderOptions = { sampleRate: 44100, channels: 1 };
const bytes: Uint8Array = encodeMp3(new Int16Array(16), options);
const encoder: Mp3Encoder = new Mp3Encoder(options);
void [bytes, encoder];
`);
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], consumer);

  if (destination) {
    mkdirSync(destination, { recursive: true });
    copyFileSync(tarball, join(destination, packed.filename));
  }
  console.log(`Verified ${packed.name}@${packed.version}: ${paths.length} files, declarations, ${packed.integrity}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
