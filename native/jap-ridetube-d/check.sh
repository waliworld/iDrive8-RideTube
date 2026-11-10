#!/bin/sh
# mgu-deploy "check": yt-dlp loads from ytdlp.pyz in mgu-python and node22 loads the JPEG decoder; offline on purpose.
set -eu
d=$(cd "$(dirname "$0")" && pwd)
/var/opt/mgu-python/current/bin/python3 -I -c "import sys;sys.path.insert(0,'$d/ytdlp.pyz');import yt_dlp,yt_dlp_ejs"
exec /var/opt/jap-node22/current/bin/node -e "require('$d/vendor/jpeg-js/decoder.js');require('$d/thumb.js')"
