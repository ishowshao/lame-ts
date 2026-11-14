// Port of libmp3lame/version.c - version strings of the LAME release this port tracks.

export const LAME_MAJOR_VERSION = 3;
export const LAME_MINOR_VERSION = 100;
export const LAME_PATCH_VERSION = 0;
export const LAME_URL = 'http://lame.sf.net';

/** The LAME version string. */
export function get_lame_version(): string {
  return '3.100';
}

/** The short LAME version string; it is embedded into the MP3 stream (ancillary data). */
export function get_lame_short_version(): string {
  return '3.100';
}

/** The very short LAME version string. */
export function get_lame_very_short_version(): string {
  return 'LAME3.100 ';
}

/** Used in the LAME VBR tag only, limited to 9 characters max. */
export function get_lame_tag_encoder_short_version(): string {
  return 'LAME3.100 ';
}

export function get_psy_version(): string {
  return '1.0';
}

export function get_lame_url(): string {
  return LAME_URL;
}
