#!/bin/sh
# Regenerates src/tables.ts from an unpacked, configured and built (static) LAME 3.100 source tree.
#   usage: scripts/gen-tables/gen.sh /path/to/lame-3.100 > src/tables.ts
set -e
LAME="$1"; HERE="$(cd "$(dirname "$0")" && pwd)"; TMP="$(mktemp -d)"
echo "// GENERATED FILE - do not edit. Produced by scripts/gen-tables/gen.sh from LAME 3.100."
echo "// Constant tables of libmp3lame (tables.c, newmdct.c, fft.c, quantize_pvt.c, VbrTag.c, gain_analysis.c)."
echo
for t in tables newmdct fft qpvt vbrtag gain; do
  cc -w -O0 -ffp-contract=off -DHAVE_CONFIG_H -I"$LAME" -I"$LAME/include" -I"$LAME/libmp3lame" -I"$LAME/mpglib" -I"$HERE" \
     "$HERE/dump_$t.c" "$LAME/libmp3lame/.libs/libmp3lame.a" -o "$TMP/dump_$t" -lm
  "$TMP/dump_$t"
done
rm -rf "$TMP"
