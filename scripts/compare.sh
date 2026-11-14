#!/bin/bash
# Encodes one WAV file with the reference `lame` and with lame-ts and compares the results.
#
#   usage: LAME_REF=/path/to/reference/lame scripts/compare.sh <input.wav> [lame options...]
#   e.g.   scripts/compare.sh song.wav -V 2
#          for q in 0 2 4 6 9; do scripts/compare.sh song.wav -V $q; done
#
# Prints "OK ..." when both outputs are byte-identical, "DIFF ..." otherwise.
HERE="$(cd "$(dirname "$0")" && pwd)"
REF="${LAME_REF:-$HERE/../.reference/lame-3.100/frontend/lame}"
[ -x "$REF" ] || { echo "reference encoder not found: $REF (run scripts/build-reference.sh)" >&2; exit 2; }
[ $# -ge 1 ] && [ -f "$1" ] || { echo "usage: $0 <input.wav> [lame options...]" >&2; exit 2; }
wav="$1"; shift
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
c="$tmp/ref.mp3"; t="$tmp/ts.mp3"
"$REF" --quiet "$@" "$wav" "$c" 2>/dev/null; rc=$?
node "$HERE/../src/cli.ts" "$@" "$wav" "$t" 2>"$tmp/err.txt"; rt=$?
if [ $rc -ne 0 ] || [ $rt -ne 0 ]; then
  echo "ERR  $(basename "$wav") $* (lame=$rc lame-ts=$rt) $(head -c 200 "$tmp/err.txt" | tr '\n' ' ')"; exit 2
elif cmp -s "$c" "$t"; then
  echo "OK   $(basename "$wav") $*"
else
  echo "DIFF $(basename "$wav") $* :: first at $(cmp "$c" "$t" 2>&1 | sed 's/.*differ: //'), $(cmp -l "$c" "$t" 2>/dev/null | wc -l | tr -d ' ') bytes differ"; exit 1
fi
