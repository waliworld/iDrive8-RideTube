#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds build/ytaud (or $1): ytaud.c with FAAD2 (github.com/knik0/faad2, GPL-2.0-or-later, the commit pinned
# below - git checks what it fetches against that hash), linked static so it runs on the head unit whatever its
# libraries are (x86-64, any Linux since 3.2).
# Needs git, a C compiler with a static libc (Ubuntu: gcc, libc6-dev), file.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/build/ytaud}
FAAD_COMMIT=a335040022e14ff9b6c54bbd459590d4c7edffe8      # 2.11.4+ (2026-10-23)
src=$here/build/faad2
if [ ! -f "$src/.at-$FAAD_COMMIT" ]; then
    rm -rf "$src"
    mkdir -p "$src"
    git -C "$src" init -q
    git -C "$src" remote add origin https://github.com/knik0/faad2
    git -C "$src" -c advice.detachedHead=false fetch -q --depth 1 origin "$FAAD_COMMIT"
    git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD
    [ "$(git -C "$src" rev-parse HEAD)" = "$FAAD_COMMIT" ] || { echo "ytaud/build.sh: faad2 is not at the pinned commit" >&2; exit 1; }
    touch "$src/.at-$FAAD_COMMIT"
fi
ver=$(sed -n 's/.*"PACKAGE_VERSION"[^"]*"\([^"]*\)".*/\1/p' "$src/properties.json")
mkdir -p "$(dirname "$out")"
# FAAD2's own build (CMakeLists.txt): these definitions, -ffloat-store with GCC, the float decoder
objs=$here/build/obj
rm -rf "$objs"
mkdir -p "$objs/faad"
for c in "$src"/libfaad/*.c; do
    ${CC:-gcc} -O2 -ffloat-store -w \
        -DHAVE_INTTYPES_H=1 -DHAVE_MEMCPY=1 -DHAVE_STRING_H=1 -DHAVE_STRINGS_H=1 -DHAVE_SYS_STAT_H=1 -DHAVE_SYS_TYPES_H=1 \
        -DHAVE_LRINTF=1 -DAPPLY_DRC "-DPACKAGE_VERSION=\"$ver\"" \
        -I"$src/include" -I"$src/libfaad" -c "$c" -o "$objs/faad/$(basename "$c" .c).o"
done
${CC:-gcc} -std=gnu11 -O2 -Wall -Wextra -Werror -D_FILE_OFFSET_BITS=64 -I"$src/include" -c "$here/ytaud.c" -o "$objs/ytaud.o"
${CC:-gcc} -static -s -o "$out" "$objs/ytaud.o" "$objs"/faad/*.o -lm
file "$out" | grep -q 'ELF 64-bit.*x86-64.*statically linked' || { echo "ytaud/build.sh: $out is not a static x86-64 program" >&2; exit 1; }
echo "ytaud/build.sh: $out (FAAD2 $ver at $FAAD_COMMIT)"
