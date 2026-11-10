#!/bin/sh
# Packs dist/jap-ridetube-d@<version>.tgz: ytdlp.pyz from the pinned yt-dlp release (tools/build_pyz.sh),
# the jpeg-js decoder (tools/vendor_jpeg.sh, if missing), the tests, ytdec, then the MGU Store's packer.
# Usage: MGU_STORE=<a clone of the MGU Store> ./build.sh [path/to/ytdec]   (default ../ytdec/build/target/ytdec)
# Needs curl, openssl, shasum or sha256sum, Node 22+, Python 3.12 (PYTHON=...), ffmpeg for the fetcher tests.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ytdec=${1:-$here/../ytdec/build/target/ytdec}
: "${MGU_STORE:?set MGU_STORE to a clone of github.com/robertnisipeanu/mgu-store (its deploy/hu packs the tool kit)}"
py=${PYTHON:-python3.12}
file "$ytdec" | grep -q 'ELF 64-bit.*x86-64' || { echo "build.sh: $ytdec is not an x86-64 ELF (cd ../ytdec && make target)" >&2; exit 1; }
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$here" log -1 --format=%ct 2>/dev/null || echo 0)}
export SOURCE_DATE_EPOCH   # ytdlp.pyz entries and the tool kit share one timestamp
sh "$here/tools/build_pyz.sh" "$py"
[ -f "$here/vendor/jpeg-js/decoder.js" ] || sh "$here/tools/vendor_jpeg.sh"
node "$here/test/test_ytd.js" >/dev/null
node "$here/test/test_thumb.js" >/dev/null
"$py" -I "$here/test/test_ytfetch.py"
cp "$ytdec" "$here/build/ytdec"
node "$MGU_STORE/deploy/hu" artifact "$here" --out "$here/dist"
