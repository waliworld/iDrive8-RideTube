#!/usr/bin/env python3
"""Host test of ytaud: a tone encoded to AAC by ffmpeg as YouTube serves it (fragmented), rewritten by the
fetcher's own flatten_m4a (so the file is what the head unit has), decoded by ytaud and compared with ffmpeg's
decoder; its seek, its head file, its refusals.   python3 test_ytaud.py [path/to/ytaud]
Needs ffmpeg. Standard library only."""
import array
import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
ytaud = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'build', 'ytaud')
spec = importlib.util.spec_from_file_location('ytfetch', os.path.join(here, '..', 'jap-ridetube-d', 'ytfetch.py'))
ytfetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ytfetch)

fails = []


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else ' :: ' + str(detail)))
    if not ok:
        fails.append(name)


def run(*args):
    r = subprocess.run([ytaud] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out = r.stdout
    i = out.find(b'\n')
    head = json.loads(out[:i]) if i > 0 else None
    pcm = array.array('h')
    pcm.frombytes(out[i + 1:] if i >= 0 else b'')
    if sys.byteorder != 'little':
        pcm.byteswap()
    return r.returncode, head, pcm, r.stderr.decode('utf8', 'replace')


def rms(a, b):
    n = min(len(a), len(b))
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(n)) / max(1, n))


with tempfile.TemporaryDirectory() as d:
    frag, full, head, ref = (os.path.join(d, n) for n in ('frag.m4a', 'audio.m4a', 'audio.head.m4a', 'ref.raw'))
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=12',
                    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=12',
                    '-filter_complex', '[0:a][1:a]amerge=inputs=2,volume=0.5[a]', '-map', '[a]', '-c:a', 'aac', '-b:a', '128k',
                    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000', frag], check=True)
    size, ms = ytfetch.flatten_m4a(frag, full)
    hsize, hms = ytfetch.flatten_m4a(frag, head, limit=90000)
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', full, '-f', 's16le', '-acodec', 'pcm_s16le', ref], check=True)
    want = array.array('h')
    want.frombytes(open(ref, 'rb').read())

    code, h, pcm, err = run('--file', full)
    check('the whole file: its header, every frame but the decoder\'s first', code == 0 and h == {'rate': 44100, 'channels': 2, 'total_ms': ms, 'start_ms': 0}
          and abs(len(pcm) // 2 - ms * 44100 // 1000) <= 2048, (code, h, len(pcm), err))
    # ffmpeg writes the encoder's lead-in frame too: ours starts one frame (1024 samples) later
    lo, hi = 2 * 100000, 2 * 130000
    d0 = rms(pcm[lo:hi], want[lo + 2048:hi + 2048])
    check('the samples are the reference decoder\'s (within a step of rounding)', d0 < 1.5 and max(abs(x) for x in pcm[lo:hi]) > 1000, d0)

    for at in (5000, 3000, 11990):
        code, h, part, err = run('--file', full, '--start-ms', str(at))
        off = 2 * (at * 44100 // 1000)
        n = min(len(part), 2 * 20000)
        check('a start at %d ms begins at that very sample' % at, code == 0 and h['start_ms'] == at and len(part) > 0 and rms(part[:n], pcm[off:off + n]) < 8, (code, h, len(part), err))
    code, h, part, err = run('--file', full, '--start-ms', '99999')
    check('a start past the end: the header and nothing', code == 0 and h['start_ms'] == ms and len(part) == 0, (code, h, len(part)))
    code, h, part, err = run('--file', full, '--start-ms', '3000', '--max-ms', '1000')
    check('--max-ms: that much and no more', code == 0 and len(part) == 2 * 44100, (code, len(part)))
    code, h, part, err = run('--file', head)
    check('the head file: the same sound, its own length', code == 0 and h['total_ms'] == hms and part == pcm[:len(part)] and len(part) > 2 * 44100 * 4, (code, h, len(part)))

    code, h, part, err = run('--file', frag)
    check('a fragmented file (not rewritten) is refused, said why', code == 2 and 'fragmented' in err, (code, err))
    code, h, part, err = run('--file', os.path.join(d, 'none.m4a'))
    check('no file', code == 2 and 'cannot open' in err, (code, err))
    open(os.path.join(d, 'cut.m4a'), 'wb').write(open(full, 'rb').read()[:300])
    code, h, part, err = run('--file', os.path.join(d, 'cut.m4a'))
    check('a file cut in its index', code == 2, (code, err))
    # the sound cut short (a download that stopped): what is there is played, then the end
    open(os.path.join(d, 'short.m4a'), 'wb').write(open(full, 'rb').read()[:size // 2])
    code, h, part, err = run('--file', os.path.join(d, 'short.m4a'))
    check('a file cut in its sound: the part that is there', code == 0 and 2 * 44100 * 4 < len(part) < len(pcm) and part == pcm[:len(part)], (code, len(part)))
    # garbage where the sound is: the decoder's errors do not end in a crash
    raw = bytearray(open(full, 'rb').read())
    for i in range(size // 2, size // 2 + 4000):
        raw[i] = (i * 31) & 255
    open(os.path.join(d, 'bad.m4a'), 'wb').write(bytes(raw))
    code, h, part, err = run('--file', os.path.join(d, 'bad.m4a'))
    check('damaged frames are skipped or refused, never a crash', code in (0, 3) and len(part) > 2 * 44100 * 4, (code, len(part), err))
    code, h, part, err = run('--bogus')
    check('bad arguments', code == 2 and 'usage' in err, (code, err))
    r = subprocess.run(['file', ytaud], stdout=subprocess.PIPE)
    check('a static x86-64 program', b'statically linked' in r.stdout and b'x86-64' in r.stdout, r.stdout)

print('ytaud: ' + ('%d FAILED' % len(fails) if fails else 'all ok'))
sys.exit(1 if fails else 0)
