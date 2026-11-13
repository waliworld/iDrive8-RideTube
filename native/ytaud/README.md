# ytaud

The sound of RideTube's audio file as samples, for a head unit that offers no media player to us (iDrive 8; see
`../jap-ridetube-d/sound.js`). It reads the plain MP4 the service's fetcher writes (`audio.m4a`,
`audio.head.m4a`: AAC, `ftyp` + `moov` + `mdat`), decodes it with [FAAD2](https://github.com/knik0/faad2) and
writes signed 16-bit interleaved samples to stdout, after one line of JSON:

```
ytaud --file <audio.m4a> [--start-ms N] [--max-ms N]
{"rate":44100,"channels":2,"total_ms":213000,"start_ms":42000}
<samples...>
```

`--start-ms` starts at that very sample (the decoder is run in from two frames earlier). The clock is the
output's own: FAAD2 gives nothing for the first frame it is handed, which is the encoder's lead-in, so sample 0
is the video's time 0. Exit codes: 0 the end (or the reader went away), 2 not such a file, 3 the decoder gave up.

`../jap-ridetube-d/ytalsa.py` runs it as `nobody` and writes its samples to the car's audio router.

## Build and test

```sh
sh build.sh [out]            # build/ytaud: fetches FAAD2 at the commit pinned in build.sh, links static
python3 test_ytaud.py        # against ffmpeg's decoder: the samples, the seek, the head file, refusals
```

Static (glibc), x86-64, so the head unit's own libraries do not matter. Needs git, gcc with a static libc
(Ubuntu: `gcc libc6-dev`), ffmpeg for the test. `tools/release_id8.sh` builds it into the service's kit.

## Licences

`ytaud.c` is GPL-3.0-or-later. FAAD2 is GPL-2.0-or-later (Copyright (C) 2003-2005 M. Bakker, Nero AG,
http://www.nero.com; "Code from FAAD2 is copyright (c) Nero AG, www.nero.com"), so the program as a whole is
under the GPL, version 3 or later. It is linked with the GNU C Library (LGPL-2.1-or-later); this folder and
FAAD2's repository at the pinned commit are everything needed to build it again. AAC is covered by patents in
some countries; whoever distributes or uses the decoder there is responsible for the licences that takes.
