#!/bin/sh
# Packs dist/jap-node22@<version>.tgz: downloads the pinned Node.js tarball, checks its sha256,
# keeps bin/node (loader set to /lib/ld-linux-x86-64.so.2) and LICENSE, then runs the MGU Store's
# packer (deploy/hu artifact). Usage: MGU_STORE=<a clone of the MGU Store> ./build.sh
# Needs curl, tar with xz, shasum, node.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# pinned build: https://unofficial-builds.nodejs.org/download/release/v22.23.4/SHASUMS256.txt
NODE_VERSION=v22.23.4
NAME=node-$NODE_VERSION-linux-x64-glibc-217
URL=https://unofficial-builds.nodejs.org/download/release/$NODE_VERSION/$NAME.tar.xz
SHA256=021b9ef3861926d32d0323c24a554c29f26d95895bfc56f5fdc3c2be7d062aa5
: "${MGU_STORE:?set MGU_STORE to a clone of github.com/robertnisipeanu/mgu-store (its deploy/hu packs the tool kit)}"

dl=$here/build/download
tarball=$dl/$NAME.tar.xz
mkdir -p "$dl"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
if [ ! -f "$tarball" ] || [ "$(sha "$tarball")" != "$SHA256" ]; then
    curl -fL --retry 3 -o "$tarball.part" "$URL"
    mv "$tarball.part" "$tarball"
fi
[ "$(sha "$tarball")" = "$SHA256" ] || { echo "build.sh: sha256 mismatch for $tarball" >&2; exit 1; }

rm -rf "$here/build/x" && mkdir -p "$here/build/x"
tar -xJf "$tarball" -C "$here/build/x" "$NAME/bin/node" "$NAME/LICENSE"
cp "$here/build/x/$NAME/bin/node" "$here/build/node"
cp "$here/build/x/$NAME/LICENSE" "$here/build/LICENSE"
rm -rf "$here/build/x"
node "$here/set-loader.js" "$here/build/node" /lib/ld-linux-x86-64.so.2
file "$here/build/node" | grep -q 'ELF 64-bit.*x86-64.*interpreter /lib/ld-linux-x86-64.so.2' ||
    { echo "build.sh: build/node is not an x86-64 ELF with the unit's loader" >&2; exit 1; }

SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$here" log -1 --format=%ct 2>/dev/null || echo 0)} \
    node "$MGU_STORE/deploy/hu" artifact "$here" --out "$here/../../dist"
