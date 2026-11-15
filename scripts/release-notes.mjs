import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.argv[2];
assert.match(tag ?? '', /^v\d+\.\d+\.\d+(?:-[a-z][a-z0-9-]*\.\d+)?$/);
assert.equal(tag, `v${manifest.version}`, 'release tag must match package.json version');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${manifest.version}]`));
assert.ok(start >= 0, `CHANGELOG.md is missing ${manifest.version}`);
let end = lines.findIndex((line, index) => index > start && (line.startsWith('## [') || line.startsWith('[Unreleased]:')));
if (end < 0) end = lines.length;
const notes = lines.slice(start + 1, end).join('\n').trim();
assert.ok(notes, 'release notes must not be empty');
process.stdout.write(`${notes}\n`);
