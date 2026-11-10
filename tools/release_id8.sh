#!/bin/sh
# Builds this repository's MGU Store release in dist/release/ (catalog.json and its assets), for the GitHub release
# tagged "catalog" of waliworld/iDrive8-RideTube:
#   jap_ridetube8    RideTube for iDrive 8, as a source package the head unit builds (kit/tools/build.py --hmi ID8)
#   jap-ridetube-d   its service (packed here; ytdec and ytdlp.pyz as in JustAnotherPU's release 0.3.9, checked below)
#   jap-node22       Node.js 22 for the service (packed here from tools/jap-node22; the binary as in JustAnotherPU/mgu-apps)
# Usage: MGU_STORE=<a clone of github.com/robertnisipeanu/mgu-store> tools/release_id8.sh
# The prebuilt binaries are taken from JustAnotherPU's published releases and checked against the sha256 pinned here
# (to build them yourself instead: native/ytdec "make target" with Docker, native/jap-ridetube-d/tools/build_pyz.sh,
# tools/jap-node22/build.sh). Needs curl, tar, node, python3.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
: "${MGU_STORE:?set MGU_STORE to a clone of github.com/robertnisipeanu/mgu-store (its deploy/hu packs the tool kits)}"
UP=https://github.com/JustAnotherPU
dl=$root/build/upstream
mkdir -p "$dl"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fetch() {    # url sha256 file
    if [ ! -f "$3" ] || [ "$(sha "$3")" != "$2" ]; then curl -fsSL --retry 3 -o "$3.part" "$1" && mv "$3.part" "$3"; fi
    [ "$(sha "$3")" = "$2" ] || { echo "release_id8.sh: sha256 mismatch for $1" >&2; exit 1; }
}
take() {     # tgz member sha256 out
    tar -xzf "$1" -O "$2" > "$4"
    [ "$(sha "$4")" = "$3" ] || { echo "release_id8.sh: $2 in $1 is not the pinned one" >&2; exit 1; }
}
fetch "$UP/ridetube/releases/download/catalog/jap-ridetube-d@0.3.9.tgz" 63dc4d7deb18849662d7d90efb41017483db5f835e6124fb90e6f5cd45300f5d "$dl/jap-ridetube-d@0.3.9.tgz"
fetch "$UP/mgu-apps/releases/download/catalog/jap-node22@22.23.4.tgz" c62a8e2a3803b858b4d1020cb19746c8bd9ae8b753145f80c5adf7d781692743 "$dl/jap-node22@22.23.4.tgz"

# the service: this repository's files, the decoder and yt-dlp (2026.10.26) as released upstream
d=$root/native/jap-ridetube-d
mkdir -p "$d/build"
take "$dl/jap-ridetube-d@0.3.9.tgz" files/ytdec 15a9c75d2a19e3cafda3f5a8d0f7eb706a12c90ca90f5b60f1253d25749dd2eb "$d/build/ytdec"
take "$dl/jap-ridetube-d@0.3.9.tgz" files/ytdlp.pyz 9e4e1be29d4f2cfef2ed34f63445be6c8d26d7e3452559eaf7b0cf62b65cbddc "$d/build/ytdlp.pyz"
chmod 755 "$d/build/ytdec"
# Node.js 22 (unofficial-builds linux-x64-glibc-217, loader /lib/ld-linux-x86-64.so.2) and its licence
n=$root/tools/jap-node22
mkdir -p "$n/build"
take "$dl/jap-node22@22.23.4.tgz" files/bin/node 8aacb15e7d149fdbfa73f6ec91641dcd1c479eb62dca4a5db9cd8f70bd6df02e "$n/build/node"
take "$dl/jap-node22@22.23.4.tgz" files/LICENSE c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4 "$n/build/LICENSE"
chmod 755 "$n/build/node"

# the app: its iDrive 8 source package (dist/src/). BMW's oap-sdk is in no file of it: the head unit links the app's
# entry module against the SDK of an app on the car. (kit/tools/build.py copies two files of an oap-sdk folder into the
# stage the tests run on a computer; a placeholder stands in when there is none.)
if [ ! -f "$root/oap-sdk/index.js" ]; then
    mkdir -p "$root/oap-sdk"
    echo "module.exports = {}; // placeholder: no package of this repository's release holds an oap-sdk" > "$root/oap-sdk/index.js"
    echo '{"name":"oap-sdk","version":"0.0.0-placeholder"}' > "$root/oap-sdk/package.json"
fi
cd "$root"
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct 2>/dev/null || echo 0)}
export SOURCE_DATE_EPOCH
python3 kit/tools/build.py --hmi ID8 jap_ridetube
node kit/tools/test_node8.js >/dev/null
node kit/tools/test_runtime.js >/dev/null && node kit/tools/test_keyboard.js >/dev/null
node kit/tools/test_ridetube8.js >/dev/null
# the source package built with the Store's own linker, as on the head unit, and started against a fake iDrive 8
MGU_STORE="$MGU_STORE" node kit/tools/test_mgu8.js | tail -1 | grep -q '^mgu8: all ok$' || { echo "release_id8.sh: kit/tools/test_mgu8.js did not pass (or was skipped)" >&2; exit 1; }
(cd "$d" && node test/test_ytd.js >/dev/null && node test/test_thumb.js >/dev/null)

node "$MGU_STORE/deploy/hu" artifact "$d" --out "$d/dist"
node "$MGU_STORE/deploy/hu" artifact "$n" --out "$root/dist"
python3 tools/release.py --hmi ID8 --tool "$root/dist/jap-node22@22.23.4.tgz"
echo "release_id8.sh: upload every file of dist/release/ to the GitHub release tagged \"catalog\""
