# jap-ridetube-d

The car-side daemon of RideTube (`ytd.js`, Node 8, root, `jap-ridetube-d.service`), packaged as an
mgu-deploy tool with the video decoder `ytdec` (built in `../ytdec`). yt-dlp, search and thumbnails all
run on the car; nothing is downloaded for keeps: the cache holds the last few videos played.

- audio: BMW MediaPlayer over SOME/IP (`/usr/lib/someip.node`), source 1046 → sink 1024,
  `playFile` on `cache/<id>/audio.m4a`. The interface descriptions come from the first of
  `/usr/lib/oap-mainapp/src-gen{,/someip}` (iDrive 7) and `/usr/lib/oap-mainapp21/src-gen{/someip,}` (iDrive 8)
  that has them. At start the log lists the audio manager's sources and sinks
  (`audio sources <id>:<name> ...; sinks ...; using source 1046, sink 1024`). Where 1046 is not listed and exactly
  one source is named like `OapGenericMedia`, that one is used. Another route (a head unit that is not the
  measured iDrive 7) goes in `/var/opt/jap-ridetube-d/state/audio.json`, read at each start of the service:
  `{"sourceID": n, "sinkID": n, "instance": "OapGenericMedia"}` (any of them). A MediaPlayer without the instance
  says which ones it has.
  0.4.1, for head units that keep things elsewhere (iDrive 8): a description that is not in MainApp's folders is
  taken from an installed app's `someipInterfaces/` (the app manager writes one there for every interface an app's
  manifest names), then from a file with a numbered name (`...commandinterface2_CommandControl2.json`), then made
  from the interface catalog (`/etc/oap/someip/someip-interfaces.json`) by the app manager's own generator (a module
  of `<MainApp>/src/AppManagement/AppManagement.js`, loaded without the bundle's entry). CommandControl without an
  instance `1` and with only one: that one. A player without `OapGenericMedia` and with one instance named like it:
  that one. Sink 1024 not listed: the only sink, or the only one the unit's own connections use; among several
  nothing is picked. The start is tried every 5 s until it succeeds, each proxy given 8 s a try; a play meanwhile
  gets `error` with the reason, and `diag` has the rest.
  0.4.2, for a head unit that does not offer `OapGenericMedia` (an iDrive 8 car: `Service unavailable for call
  playFile()`): when the player does not answer at the start, every instance of every MediaPlayer description on
  the unit is asked; the same instance under another description, else the only offered instance named like the
  generic OAP media player (with the audio source named like it), is used. Other players (USB, Bluetooth) are never
  played through. At a play a player that does not answer is given 4 s once its source is connected. `diag` then
  also says who the unit's SOME/IP security (`/etc/vsomeip`) lets ask for and offer the two services, and what the
  installed apps' code uses to play media.
- video: `ytdec --dir cache/<id> --rect WxH [--fill] --log /var/opt/jap-ridetube-d/log/ytdec.log`, which
  writes `/dev/shm/mgu-video-ridetube` for mgu-render; paced by `clock <elapsed_ms> <mono_ms>` lines.
- media: `/var/opt/jap-ridetube-d/cache/<id>/` {meta.json, thumb.rgba, audio.m4a, index.bin, video.h264, and
  `audio.head.m4a` while the rest of the audio downloads}, written on the car by the fetcher (below).

## Architecture

Every internet request runs as the daemon's fetch uid (below, "Internet: the fetch uid"), never root:

- `ytfetch.py` in mgu-python (`/var/opt/mgu-python/current/bin/python3 -I`), with yt-dlp from
  `ytdlp.pyz` on its `sys.path`, fetches the playing video straight into its cache dir
  (`cache/<id>/`); yt-dlp's own cache is `/var/opt/jap-ridetube-d/cache/ytdlp`.
- Playable gate: a play starts once enough of the files is on disk to play, not when the download
  ends; until then the state is `preparing` and `pct` is the download progress towards playable.
- Audio (0.2.1): `playFile` needs a complete file, so the fetcher downloads the audio format yt-dlp picked
  itself, 4 parallel `Range` requests (1 MB, then 2 MB chunks, handed out in file order; googlevideo
  paces each connection), into `audio.src.m4a`; yt-dlp's own download is the fallback (no `filesize`,
  not https, or a range failing 3 times). Once the gap-free prefix holds max(60 s, 1.5 x the rest's
  estimated download time) of samples, it writes `audio.head.m4a`, a plain MP4 of just those, and says
  `audio_head {ms}`. The daemon starts on `audio_head` (or `audio_ready`) + 10 s of video, playing the head.
- Head -> full: on `audio_ready` the daemon calls `playFile(audio.m4a)` on the live connection, then
  `setTime` at the clock (extrapolated from the last tick: ytdec keeps running) and deletes the head; the
  player's times and states between the two are ignored, and its times below the target for 3 s after.
  Paused at that moment: `resume` does it (as after a STOP mid-file). Within 1.5 s of the head's end, or a
  seek past it, before `audio_ready`: the player and ytdec pause there, the state is `playing` with
  `buffering: true` (never `ended`), and `audio_ready` resumes there. The fetcher dying with only the
  head: `error`. A cached video (audio.m4a there) plays it at once, as before. The switch itself
  (a restart of the file, then the seek) may be audible: not measured on the car yet.
- Buffering: if playback catches up with the download, the `state` event says `buffering: true`
  until enough data is there again.
- Search: InnerTube (`/youtubei/v1/search`) from the daemon, through the same fetch helper.
- Thumbnails: `thumb.js` in jap-node22 fetches `i.ytimg.com/vi/<id>/mqdefault.jpg` (8 s, no
  redirects, ≤ 2 MB, any status but 200 fails: private videos get a 404 placeholder), decodes it
  with the vendored jpeg-js decoder (baseline and progressive; the car has no image library),
  resamples to 320x180 if needed and writes 230400 bytes RGBA on stdout. DNS: the uplink lease's
  servers (`--lease`, default `/run/mgu-uplink/lease.json`), else the system resolver.

## Updating yt-dlp

`ytdlp.pyz` is built from the official yt-dlp zipapp of a pinned GitHub release
(`https://github.com/yt-dlp/yt-dlp/releases`, Unlicense), checked by sha256; no yt-dlp code is kept here.

1. Set `YTDLP_VERSION` and `YTDLP_SHA256` in `tools/build_pyz.sh` (the release's `SHA2-256SUMS`, file `yt-dlp`).
2. `./build.sh` (rebuilds `build/ytdlp.pyz`, runs the tests, packs).
3. Bump `version` in `component.json`.
4. Install the new artifact through the Store; its `check` (`check.sh`) rolls back a pyz that does not load.

## Self-check on the car (root)

    /var/opt/mgu-python/current/bin/python3 -I /var/opt/jap-ridetube-d/current/ytfetch.py check --cache-dir /var/opt/jap-ridetube-d/cache/ytdlp
    U=$(sed 's/.*"fetch":\([0-9]*\).*/\1/' /var/opt/jap-ridetube-d/state/uids.json); /var/opt/mgu-python/current/bin/python3 -I -c "import os,sys;u=int(sys.argv[1]);os.setgroups([]);os.setgid(u);os.setuid(u);os.execv('/var/opt/jap-node22/current/bin/node',['node','/var/opt/jap-ridetube-d/current/thumb.js','dQw4w9WgXcQ'])" $U | wc -c    # 230400
    sh /var/opt/jap-ridetube-d/current/check.sh    # offline; exit 0

The first two need the internet, which the uplink gives the fetch uid, never root: `ytfetch.py check`
drops to that uid itself (from `state/uids.json`); `thumb.js` does not, so the second line runs it
as that uid. `check.sh` is the install `check`: yt-dlp (and `yt_dlp_ejs`) import from
`ytdlp.pyz` in mgu-python, and node22 loads the JPEG decoder and `thumb.js`.

## Control socket `/run/jap-ridetube-d/ctl.sock` (0660 root:tm_oap_app), JSON lines

The audio head is internal: `time.total` is the video's length, not the head's.

App → daemon:

| cmd | |
|---|---|
| `{"cmd":"status"}` | → `state` (and `time` when known) |
| `{"cmd":"search","q":".."}` | → `results` (InnerTube), or `error` `search offline` |
| `{"cmd":"thumb","id":".."}` | → `thumb` (cache `thumb.rgba` first, else `thumb.js` on the car; nothing if neither works, or if the length is neither 57600 nor 230400) |
| `{"cmd":"play","id":"..","rect":"WxH","fill":bool}` | cached and ready: plays; else fetches with `ytfetch.py` (`preparing` + pct), plays once playable |
| `{"cmd":"pause"}` / `{"cmd":"resume"}` | `sendButtonEvent PAUSE/PLAY` + ytdec `pause`/`resume` |
| `{"cmd":"seek","ms":N}` | absolute; `setTime` + ytdec `seek N` |
| `{"cmd":"video","on":bool}` | ytdec `video 1/0` (audio unaffected) |
| `{"cmd":"stop"}` | STOP, disconnect, ytdec `quit` (SIGKILL after 1 s) |
| `{"cmd":"auth_status"}` | → `auth` |
| `{"cmd":"auth"}` | signed in, or a code still valid: → that `auth` again; else a new device code → `auth` `code`, then polled until `signed_in`, `signed_out` (expired, denied) or `error` |
| `{"cmd":"sign_out"}` | deletes the account → `auth` `signed_out` |
| `{"cmd":"feed","which":"home\|subs\|wl"}` | → `feed` (items, or error `signed out` / `feed offline` / `unknown feed`) |
| `{"cmd":"diag"}` | → `diag`: `{"ev":"diag","version","ready","lines":[..]}`, the app's Settings > Diagnostics page (lines of text, `# ` starts a section: the sound's start and what the car answered, the files, the picture, the log's last lines) |

Daemon → app: `{"ev":"state","state":"idle|preparing|playing|paused|ended|error","pct","id","title","buffering"}`,
`{"ev":"time","elapsed","total"}` (ms, ≤ 4/s), `{"ev":"results","q","items":[{id,title,channel,duration_s,meta?}]}` (`meta: ["12K views"]` when there is a view count),
`{"ev":"thumb","id","w","h","rgba":"<base64 w*h*4 bytes>"}` (320x180; 160x90 from caches older than 0.1.6; the size comes from the length; a 320x180 line is ~307 kB), `{"ev":"error","msg"}`,
`{"ev":"auth","state":"signed_out|code|signed_in|error","code","url","expires" (s left, with code),"msg" (with error)}`,
`{"ev":"feed","which","items":[item],"shelves":[{title,items:[item]}]}` or `{"ev":"feed","which","error"}` (feed thumbs: `thumb`).
An item is `{id,title,channel,duration_s,meta}`; `meta` = the texts of the tile's second line as YouTube writes them, without
the `•` and the badges (`["125K views","1 day ago"]`, `[]` when none). `items`: every video tile once, page order, ≤ 50.
`shelves`: YouTube's rows in page order (≤ 8, ≤ 12 tiles each, video tiles only, deduped per row, empty rows such as Shorts
dropped); `title` is the row header, else the channel when all its tiles share one (Subscriptions' per-channel rows), else `""`.
Watch later is a playlist with no rows: `shelves: []`, use `items`.

`state` carries `buffering` (bool; true while playback waits for the fetch), and `preparing`'s `pct`
is the fetch's progress to playable (0-100).

One client at a time; a new connection replaces the old one. The client going away stops
playback at once.

## Account

The car signs in itself with the TV device sign-in: the client id and secret are scraped from `https://www.youtube.com/tv` (Tizen user agent) at run time, never shipped
(once a process; again once when the device-code request is refused);
`/o/oauth2/device/code` gives the code the user enters at google.com/device; `/o/oauth2/token`
is polled, then refreshes the token when less than 5 min is left (`invalid_grant` = signed out).
Feeds: `POST /youtubei/v1/browse` as `TVHTML5`, `FEwhat_to_watch` (home), `FEsubscriptions`
(subs), `VLWL` (wl); their video tiles, each id once (no shorts, channels, playlists), at most 50.
The account (tokens and the scraped secret) is `/var/opt/jap-ridetube-d/state/account.json`, 0600 in the
0700 state dir, written atomically; nothing secret goes on the socket or into the log. `sign_out` wins
over work in flight: a refresh, device-code request or poll started before it saves, shows and
re-arms nothing. Asks for a feed while its browse is in flight share that browse.

### Internet: the fetch uid

`mgu-uplink` lets out only the uids it lists, never root. Every youtube.com request runs in a child,
`node --max-http-header-size=65536 ytd.js --fetch`, spawned as the daemon's own fetch uid (gid the same
number, empty env, cwd `/`). The request, with the secret, tokens and body, goes on the child's stdin
(never argv or env: `ps` shows those); `{status, body}` or `{error}` comes back on its stdout. 10 s
timeout (the child is killed 1 s after), 8 MiB body. The child never touches the account file.

The uid is picked as mgu-updater's `js/uids.js` picks its own, at start and on first need:

- kept from `state/uids.json` (`{"fetch": N}`) while nothing else holds it (running processes do not
  count: they may be our own helpers);
- else the lowest number above MainApp's app uid ranges (`usableUidsAndGids` and
  `usableUidsAndGidsRse` in the `config/base.json` of `/usr/lib/oap-mainapp` or `oap-mainapp21`;
  both there: the one whose HMI, `HmiMain3D` or `Hmi8`, runs), at most 60000, inside none of them and
  not taken: a uid or gid in `/etc/passwd` or `/etc/group`, an `oap_<uid>` folder, MainApp's app
  registry and `uids.txt`, `mainAppUids`, another component's `mgu-uplink/uids.d` entry,
  mgu-updater's `state/uids.json`, a running process's uid or gid;
- no readable MainApp config and no kept uid: none. The log says why; `auth` and `feed` answer with
  the error `no internet uid on the car (see the log)`.

It is written to `state/internet-uids` (component.json `"internet": true, "uids":
"state/internet-uids"`: the deploy tool copies it into `/var/opt/mgu-uplink/uids.d/jap-ridetube-d`) and,
while the uplink is installed, straight into that drop-in (the uplink rescans every 5 s). The unit
starts node with `--max-http-header-size=65536`: the TV page's headers pass 8 kB.

## Rules

- Every exit path releases audio (STOP + `disconnect`): stop, end of file, playback error, app
  gone, SIGTERM, uncaught exception. At start it disconnects every connection with sourceID 1046
  left over (no other) before any play.
- ytdec dies while playing → restarted once at the current clock; a second death → `error`
  `video failed, audio only`, the state stays `playing` and audio continues. No change in
  `stats.decoded` for 5 s while playing with video on → the child is killed (counts as a death).
- Cache: `keep` played ids by dir mtime (default 0: a video is deleted once played), never the
  playing or preparing one. ytfetch stops a download when less than 256 MiB is left free.
- Never exits on its own; uncaught errors → log, release audio, idle.
- Unit: `Restart=on-failure`, `RestartSec=3`, `TimeoutStopSec=5`, `LimitCORE=1`; `recmgr`
  and `crashNames` in `component.json` (recmgr's list counts from the next boot; the unit is
  safe before that: it starts idle and stays active).

## Security notes

- The daemon runs as root: it talks SOME/IP to BMW's MediaPlayer. Every internet request runs as the fetch uid
  instead (above).
- ytdec also runs as root (accepted risk, not verified otherwise on the car). It opens the GPU's render node
  `/dev/dri/renderD128` for the Intel Media SDK and writes the frames to `/dev/shm/mgu-video-ridetube` for
  mgu-render, and running it under another uid was not tested on a head unit. It reads only the video folder
  the daemon names (`--dir`) and takes commands only from the daemon's pipe. It opens no socket and fetches
  nothing.
- `/run/jap-ridetube-d/ctl.sock` is 0660 root:`tm_oap_app`. Every app on the head unit shares that group, so any
  installed app (not only RideTube) can drive the daemon: play, search, read the feeds and the watch history, or
  sign the account in or out. Install only apps you trust.
- The cache (`/var/opt/jap-ridetube-d/cache`) is 0711: the fetch uid reaches its own folders, and nobody else can
  list what was watched. Each video's folder is 0711: BMW's media engine (its own uid) opens the audio in it by
  name, and nobody can list it. The thumbnail folder is 0700 and `positions.json` (where each video was left, the
  watch history) 0600. The account tokens live in `state/` (0700).

## Build and test

    node test/test_ytd.js           # fake someip, fake ytdec, fake fetcher, fake youtube.com
    node test/test_thumb.js         # Node 22+: ffmpeg-made JPEGs (baseline, resampled, progressive via jpegtran); online part skipped offline
    python3.12 -I test/test_ytfetch.py   # ffmpeg fixtures, local Range server (head MP4, ranged == one stream); online part skipped offline
    MGU_STORE=... ./build.sh [path/to/ytdec]   # → dist/jap-ridetube-d@<version>.tgz (default ../ytdec/build/target/ytdec)

`build.sh`: checks ytdec is an x86-64 ELF, runs `tools/build_pyz.sh` (→ `build/ytdlp.pyz`),
`tools/vendor_jpeg.sh` when `vendor/jpeg-js/` is missing, the three tests, copies ytdec into `build/`,
then packs with the MGU Store's `deploy/hu artifact` (`MGU_STORE`; `SOURCE_DATE_EPOCH`: the last commit).
`tools/vendor_jpeg.sh` fetches the pinned jpeg-js tarball (BSD-3-Clause) from the npm registry,
checks its sha512 and keeps only `lib/decoder.js` and `LICENSE`.

Requires (catalog `requires`, installed first): mgu-deploy 0.7.0, mgu-python 1.0.2, jap-node22 22.23.4,
mgu-render 0.6.11 (the video layer).

Overrides (tests): `MGU_YT_SOMEIP`, `MGU_YT_SRCGEN`, `MGU_YT_YTDEC`, `MGU_YT_CACHE`,
`MGU_YT_LOGDIR`, `MGU_YT_SOCK`, `MGU_YT_STATE`, `MGU_YT_ACCOUNT`, or the `Daemon` constructor options.
