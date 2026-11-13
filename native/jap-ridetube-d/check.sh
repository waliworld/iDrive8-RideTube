#!/bin/sh
# mgu-deploy "check": yt-dlp loads from ytdlp.pyz in mgu-python and node22 loads the JPEG decoder; the unit's own
# Node (8, the one the service runs on) loads the service's files and mgu-python parses ytalsa.py - a construct one
# of them does not take refuses the update here instead of stopping the service later. Offline on purpose.
set -eu
d=$(cd "$(dirname "$0")" && pwd)
/var/opt/mgu-python/current/bin/python3 -I -c "import sys;sys.path.insert(0,'$d/ytdlp.pyz');import yt_dlp,yt_dlp_ejs;import ast;ast.parse(open('$d/ytalsa.py').read())"
/usr/bin/node -e "require('$d/ytd.js');require('$d/sound.js');require('$d/sdkread.js')"
exec /var/opt/jap-node22/current/bin/node -e "require('$d/vendor/jpeg-js/decoder.js');require('$d/thumb.js')"
