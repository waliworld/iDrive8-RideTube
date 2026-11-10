#!/bin/sh
# Build build/ytdlp.pyz for the car's Python 3.12 (mgu-python, no lib-dynload) from the official yt-dlp
# zipapp of a pinned GitHub release (checked by sha256); nothing of yt-dlp is kept in this repository.
# The zipapp is pure Python: yt_dlp, yt_dlp_ejs and its __main__.py (python3 ytdlp.pyz runs yt-dlp). Its .py files are precompiled here (3.12 magic,
# unchecked-hash, legacy layout) so zipimport never compiles on the car. certifi is not needed:
# ytfetch.py points yt-dlp at the car's CA bundle.
#
# Update yt-dlp: 1. set YTDLP_VERSION and YTDLP_SHA256 below (the release's SHA2-256SUMS, file "yt-dlp")
#                2. rerun tools/build_pyz.sh  3. bump the component version (component.json) and ship.
# Usage: tools/build_pyz.sh [python3.12]      (or PYTHON=... ; needs curl and shasum or sha256sum)
set -eu
YTDLP_VERSION=2026.10.26
YTDLP_SHA256=e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3
URL=https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp

here=$(cd "$(dirname "$0")/.." && pwd)
py=${1:-${PYTHON:-python3.12}}
"$py" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

dl=$here/build/download/yt-dlp-$YTDLP_VERSION
mkdir -p "$here/build/download"
if [ ! -f "$dl" ] || [ "$(sha "$dl")" != "$YTDLP_SHA256" ]; then
    curl -fL --retry 3 -o "$dl.part" "$URL"
    mv "$dl.part" "$dl"
fi
[ "$(sha "$dl")" = "$YTDLP_SHA256" ] || { echo "build_pyz.sh: sha256 mismatch for $dl" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/pyz.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
"$py" - "$dl" "$tmp/tree" <<'PY'
import sys, zipfile
src, out = sys.argv[1:]
with zipfile.ZipFile(src) as z:          # the zipapp: a shebang line, then the zip
    names = [n for n in z.namelist() if (n == '__main__.py' or n.split('/')[0] in ('yt_dlp', 'yt_dlp_ejs')) and not n.endswith('/')]
    assert any(n.startswith('yt_dlp/') for n in names) and any(n.startswith('yt_dlp_ejs/') for n in names), 'unexpected zipapp layout'
    bad = [n for n in names if n.endswith(('.so', '.dylib', '.pyd'))]
    assert not bad, 'native code in the zipapp: %r' % bad
    for n in names:
        z.extract(n, out)
PY
# -s: co_filename relative to the tree (yt_dlp/...), so no build path ends up in the .pyc files
"$py" -m compileall -q -b -s "$tmp/tree" --invalidation-mode unchecked-hash "$tmp/tree" >/dev/null
"$py" - "$tmp/tree" "$here/build/ytdlp.pyz.tmp" <<'PY'
import os, sys, time, zipfile
root, out = sys.argv[1:]
# one fixed UTC time for every entry (SOURCE_DATE_EPOCH, zip's floor 1980), so the archive is reproducible
when = time.gmtime(max(int(os.environ.get('SOURCE_DATE_EPOCH', '0')), 315532800))[:6]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, dirs, files in os.walk(root):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(d, f)
            zi = zipfile.ZipInfo(os.path.relpath(p, root), when)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            with open(p, 'rb') as fh:
                z.writestr(zi, fh.read())
PY
mv "$here/build/ytdlp.pyz.tmp" "$here/build/ytdlp.pyz"
ls -l "$here/build/ytdlp.pyz"
