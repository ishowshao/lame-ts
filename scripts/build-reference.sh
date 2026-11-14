#!/bin/sh
# Downloads LAME 3.100 and builds the reference encoder that lame-ts is compared against:
# the portable C code path, strict IEEE-754 arithmetic (no FMA contraction), see README.md.
#
#   usage: scripts/build-reference.sh [dir]        (default: .reference)
#   result: <dir>/lame-3.100/frontend/lame
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-$HERE/../.reference}"
mkdir -p "$DIR"; DIR="$(cd "$DIR" && pwd)"
cd "$DIR"
if [ ! -d lame-3.100 ]; then
  curl -fL -o lame-3.100.tar.gz https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
  echo "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e  lame-3.100.tar.gz" | shasum -a 256 -c -
  tar xzf lame-3.100.tar.gz
fi
cd lame-3.100
./configure --disable-shared --enable-static --disable-decoder \
  CFLAGS="-O2 -ffp-contract=off -include $HERE/shim.h" >/dev/null
make -j4 >/dev/null
echo "$DIR/lame-3.100/frontend/lame"
