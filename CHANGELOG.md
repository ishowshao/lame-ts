# Changelog

## [Unreleased]

## [0.1.0] - 2026-11-15

### Added

- Pure TypeScript MP3 encoding based on the portable LAME 3.100 encoder, with no runtime dependencies.
- One-shot and streaming APIs for integer and floating-point PCM, plus a WAV-to-MP3 command line tool.
- CBR, ABR, both VBR algorithms, resampling, filters, ReplayGain, and Xing/LAME tags.
- Reference-output tests, Linux/macOS CI, installed-package verification, and tag-based npm releases.

### Fixed

- Large input blocks can be upsampled without exhausting the MP3 output buffer.
- Retained output chunks no longer retain oversized encoding buffers.
- One-shot and streaming APIs consistently validate PCM scales, buffer lengths, and sample counts.

## [0.1.0-rc.2] - 2026-11-15

- Initial release candidate with the complete encoder and installed-package checks.
- Bootstraps the npm package so the first stable release can use GitHub Trusted Publishing.

[Unreleased]: https://github.com/ishowshao/lame-ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ishowshao/lame-ts/releases/tag/v0.1.0
