#!/usr/bin/env python3
"""jap-ridetube-d on-car fetcher: yt-dlp (from ytdlp.pyz) + a streaming fMP4 -> Annex-B/MGYI demuxer.

  ytfetch.py fetch <id> <dir> --cache-dir <d> [--height 720] [--node P] [--lease P] [--pyz P]
  ytfetch.py extract <id> <info.json> --cache-dir <d> [...]
  ytfetch.py serve --cache-dir <d> [...]
  ytfetch.py check [<id>] --cache-dir <d> [--uid N] [--node P] [--lease P] [--pyz P]

fetch writes <dir>/meta.json, audio.m4a, video.h264 (+ .part while running) and index.bin, and prints
one JSON event per line on stdout: meta, audio, audio_head, audio_ready, video, done | error (then exit 1).
audio_head {ms, bytes}: <dir>/audio.head.m4a is a complete MP4 of the audio's first ms, before audio.m4a.
fetch --info <f>: the extraction extract wrote there (if fresh), not a new one: ~2.5 s less on the car.
serve: loads yt-dlp (~1.2 s on the car), prints {"ev":"warm"}, then runs the one argv list read from stdin.
check is the owner's self-test, run as root over ssh (it drops to the fetch uid itself).
"""
import argparse
import copy
import http.client
import io
import json
import os
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from fractions import Fraction

ID_RE = re.compile(r'^[A-Za-z0-9_-]{11}$')
HDR = struct.Struct('<4sHHHHHxxI12x')  # 32 bytes, record count at offset 16
REC = struct.Struct('<IQIB')            # 17 bytes: pts_ms, pos, size, key
CA = '/var/opt/mgu-python/current/ssl/cacert.pem'
NODE = '/var/opt/jap-node22/current/bin/node'
LEASE = '/run/mgu-uplink/lease.json'
DEFAULT_CHECK_ID = 'dQw4w9WgXcQ'  # 3:33, avc1 720p 25 fps, AAC-LC 140: public and long-lived
# the video's own language first where it has several tracks (no AI dub / translation): yt-dlp notes it "original"
AUDIO_FMT = 'ba[ext=m4a][acodec^=mp4a.40.2][format_note*=original]/ba[ext=m4a][acodec^=mp4a.40.2]/ba[ext=m4a]/ba'
# audio: parallel Range requests (googlevideo paces each connection), in file order so the prefix grows first
AUDIO_CONNS, AUDIO_FIRST, AUDIO_CHUNK = 4, 1 << 20, 2 << 20
HEAD_MIN_MS = 60000  # audio.head.m4a covers at least this, and 1.5x the rest's estimated download time


def video_fmt(h):
    lo = h * 9 // 10
    return (f'bv[vcodec^=avc1][height<={h}][height>={lo}][fps<=30]'
            f'/bv[vcodec^=avc1][height<={h}][fps<=30]/bv[vcodec^=avc1][height<={h}]')


# ---------------------------------------------------------------- events

_out = sys.stdout
_out_lock = threading.Lock()


def emit(**kw):
    with _out_lock:
        try:
            _out.write(json.dumps(kw) + '\n')
            _out.flush()
        except OSError:
            os._exit(1)  # the daemon is gone


def fail(msg):
    emit(ev='error', msg=str(msg)[-500:])
    os._exit(1)  # the other thread may sit in a socket read


MIN_FREE = 256 << 20  # bytes left free on the cache's file system while a video downloads


class Throttle:
    def __init__(self, per_s=2):
        self.gap, self.last = 1 / per_s, 0

    def __call__(self):
        now = time.monotonic()
        if now - self.last < self.gap:
            return False
        self.last = now
        return True


# ---------------------------------------------------------------- DNS through the uplink's lease

def _skip_name(b, i):
    while True:
        n = b[i]
        if n & 0xc0 == 0xc0:
            return i + 2
        if n == 0:
            return i + 1
        i += n + 1


def resolve_a(host, servers, timeout=3):
    qid = os.urandom(2)
    q = (qid + b'\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00'
         + b''.join(bytes([len(p)]) + p for p in host.rstrip('.').encode('idna').split(b'.'))
         + b'\x00\x00\x01\x00\x01')
    err = 'no server'
    for srv in servers:
        s = socket.socket(socket.AF_INET6 if ':' in srv else socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(timeout)
            s.sendto(q, (srv, 53))
            r = s.recv(4096)
            while r[:2] != qid:
                r = s.recv(4096)
            if r[3] & 15:
                err = f'{srv}: rcode {r[3] & 15}'
                continue
            i = _skip_name(r, 12) + 4
            ips = []
            for _ in range(struct.unpack_from('>H', r, 6)[0]):
                i = _skip_name(r, i)
                typ, cls, _ttl, ln = struct.unpack_from('>HHIH', r, i)
                i += 10
                if typ == 1 and cls == 1 and ln == 4:
                    ips.append(socket.inet_ntoa(r[i:i + 4]))
                i += ln
            if ips:
                return ips
            err = f'{srv}: no A record'
        except (OSError, IndexError, struct.error) as e:
            err = f'{srv}: {e}'
        finally:
            s.close()
    raise socket.gaierror(socket.EAI_NONAME, f'{host}: lease DNS: {err}')


def lease_servers(lease):
    try:
        with open(lease) as f:
            return [s for s in json.load(f).get('dns', []) if isinstance(s, str)]
    except (OSError, ValueError, AttributeError):
        return []


def _is_ip(h):
    for fam in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(fam, h)
            return True
        except OSError:
            pass
    return False


def install_dns(lease):
    """The system resolver answers no internet names on the car: ask the uplink's DNS servers."""
    if getattr(socket.getaddrinfo, '_lease', None) == lease:  # serve installed it
        return lease_servers(lease)
    servers = lease_servers(lease)
    if not servers:
        return []
    orig, cache = socket.getaddrinfo, {}

    def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        h = host.decode() if isinstance(host, bytes) else host
        if not h or h == 'localhost' or _is_ip(h) or family == socket.AF_INET6:
            return orig(host, port, family, type, proto, flags)
        if h not in cache:
            cache[h] = resolve_a(h, servers)
        p = int(port or 0)  # shortcut: service names ('https') unsupported, urllib/yt-dlp pass numbers
        return [(socket.AF_INET, type or socket.SOCK_STREAM, proto, '', (ip, p)) for ip in cache[h]]

    getaddrinfo._lease = lease
    socket.getaddrinfo = getaddrinfo
    return servers


# ---------------------------------------------------------------- MP4 boxes

def boxes(b, i=0, end=None):
    """Yield (type, payload_start, box_end) for the boxes in b[i:end]."""
    end = len(b) if end is None else end
    while i + 8 <= end:
        size, typ = struct.unpack_from('>I4s', b, i)
        hdr = 8
        if size == 1:
            size, hdr = struct.unpack_from('>Q', b, i + 8)[0], 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            raise ValueError(f'bad {typ!r} box')
        yield typ, i + hdr, i + size
        i += size


def kid(b, s, e, *path):
    for name in path:
        s, e = next(((s2, e2) for t, s2, e2 in boxes(b, s, e) if t == name), (None, None))
        if s is None:
            raise ValueError(f'no {name.decode()} box')
    return s, e


def trak_info(moov):
    """First track of a DASH moov: timescale, stsd box bytes, stsz count, trex defaults."""
    s, e = kid(moov, 8, len(moov), b'trak')
    ms, _ = kid(moov, s, e, b'mdia', b'mdhd')
    ts = struct.unpack_from('>I', moov, ms + (20 if moov[ms] else 12))[0]
    st, ste = kid(moov, s, e, b'mdia', b'minf', b'stbl')
    ds, de = kid(moov, st, ste, b'stsd')
    zs, _ = kid(moov, st, ste, b'stsz')
    trex = (0, 0, 0)
    try:
        xs, _ = kid(moov, 8, len(moov), b'mvex', b'trex')
        trex = struct.unpack_from('>III', moov, xs + 12)  # default duration, size, flags
    except ValueError:
        pass
    return dict(ts=ts, stsd=moov[ds - 8:de], stsd_at=(ds, de),
                samples=struct.unpack_from('>I', moov, zs + 8)[0], trex=trex)


def parse_moof(b, next_dts, trex):
    """Samples of moof box bytes b: [(offset from moof start, size, dts, cto, flags)], next dts."""
    out = []
    for t, s, e in boxes(b, 8):
        if t != b'traf':
            continue
        hs, _ = kid(b, s, e, b'tfhd')
        fl = struct.unpack_from('>I', b, hs)[0] & 0xffffff
        p, base = hs + 8, None
        if fl & 1:
            base, p = struct.unpack_from('>Q', b, p)[0], p + 8
        if fl & 2:
            p += 4
        dd, dsz, dfl = trex
        if fl & 8:
            dd, p = struct.unpack_from('>I', b, p)[0], p + 4
        if fl & 0x10:
            dsz, p = struct.unpack_from('>I', b, p)[0], p + 4
        if fl & 0x20:
            dfl = struct.unpack_from('>I', b, p)[0]
        if base is not None:
            raise ValueError('tfhd base_data_offset unsupported')
        try:
            ts_, _ = kid(b, s, e, b'tfdt')
            next_dts = struct.unpack_from('>Q' if b[ts_] else '>I', b, ts_ + 4)[0]
        except ValueError:
            pass
        pos = 0
        for t2, rs, _ in boxes(b, s, e):
            if t2 != b'trun':
                continue
            v, rfl = b[rs], struct.unpack_from('>I', b, rs)[0] & 0xffffff
            n = struct.unpack_from('>I', b, rs + 4)[0]
            p = rs + 8
            if rfl & 1:
                pos, p = struct.unpack_from('>i', b, p)[0], p + 4
            first = None
            if rfl & 4:
                first, p = struct.unpack_from('>I', b, p)[0], p + 4
            for k in range(n):
                d, sz, sf, cto = dd, dsz, (first if k == 0 and first is not None else dfl), 0
                if rfl & 0x100:
                    d, p = struct.unpack_from('>I', b, p)[0], p + 4
                if rfl & 0x200:
                    sz, p = struct.unpack_from('>I', b, p)[0], p + 4
                if rfl & 0x400:
                    sf, p = struct.unpack_from('>I', b, p)[0], p + 4
                if rfl & 0x800:
                    cto, p = struct.unpack_from('>i' if v else '>I', b, p)[0], p + 4
                out.append((pos, sz, next_dts, cto, sf))
                pos += sz
                next_dts += d
    return out, next_dts


def is_key(flags):
    return not flags & 0x01010000  # ffmpeg's rule: not non-sync and not depends-on-others


# ---------------------------------------------------------------- audio: DASH m4a -> plain MP4, moov first

def box(t, *parts):
    body = b''.join(parts)
    return struct.pack('>I4s', 8 + len(body), t) + body


def full(t, flags, *parts):
    return box(t, struct.pack('>I', flags), *parts)


MATRIX = struct.pack('>9I', 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)


def flat_moov(ts, stsd, durs, sizes, chunks, offsets):
    stts, run = [], None
    for d in durs:
        if run and run[1] == d:
            run[0] += 1
        else:
            run = [1, d]
            stts.append(run)
    stsc = []
    for i, (_, n) in enumerate(chunks):
        if not stsc or stsc[-1][1] != n:
            stsc.append((i + 1, n))
    total = sum(durs)
    stbl = box(b'stbl', stsd,
               full(b'stts', 0, struct.pack('>I', len(stts)), *(struct.pack('>II', *r) for r in stts)),
               full(b'stsc', 0, struct.pack('>I', len(stsc)), *(struct.pack('>III', c, n, 1) for c, n in stsc)),
               full(b'stsz', 0, struct.pack('>II', 0, len(sizes)), struct.pack(f'>{len(sizes)}I', *sizes)),
               full(b'stco', 0, struct.pack('>I', len(offsets)), struct.pack(f'>{len(offsets)}I', *offsets)))
    minf = box(b'minf', full(b'smhd', 0, b'\0' * 4),
               box(b'dinf', full(b'dref', 0, struct.pack('>I', 1), full(b'url ', 1))), stbl)
    mdia = box(b'mdia', full(b'mdhd', 0, struct.pack('>IIIIHH', 0, 0, ts, total, 0x55c4, 0)),
               full(b'hdlr', 0, b'\0' * 4, b'soun', b'\0' * 12, b'SoundHandler\0'), minf)
    tkhd = full(b'tkhd', 3, struct.pack('>IIIII', 0, 0, 1, 0, total), b'\0' * 8,
                struct.pack('>HHHH', 0, 0, 0x0100, 0), MATRIX, b'\0' * 8)
    mvhd = full(b'mvhd', 0, struct.pack('>IIIIIH', 0, 0, ts, total, 0x10000, 0x0100), b'\0' * 10,
                MATRIX, b'\0' * 24, struct.pack('>I', 2))
    return box(b'moov', mvhd, box(b'trak', tkhd, mdia))


def flatten_m4a(src, dst, limit=None):
    """Rewrite a fragmented (DASH) m4a as ftyp+moov+mdat; edit lists are dropped. Returns (dst size, ms).
    limit: only src[:limit] is written yet (the rest may be zeros): the samples entirely inside it; a plain
    MP4 then gives None (it cannot be cut)."""
    with open(src, 'rb') as f:
        top, limit_ = [], os.fstat(f.fileno()).st_size if limit is None else limit
        while True:
            at, h = f.tell(), f.read(16)
            if len(h) < 8 or at + 8 > limit_:
                break
            size, t = struct.unpack_from('>I4s', h)
            if size == 1:
                size = struct.unpack_from('>Q', h, 8)[0]
            elif size == 0:
                size = os.fstat(f.fileno()).st_size - at
            if size < 8 or (at + size > limit_ and t != b'mdat'):
                break  # a box not all written yet (an mdat is cut per sample below)
            if t in (b'moov', b'moof'):
                f.seek(at)
                top.append((t, at, f.read(size)))
            f.seek(at + size)
        moov = next((bx for t, _, bx in top if t == b'moov'), None)
        if moov is None:
            raise ValueError('audio: no moov')
        tk = trak_info(moov)
        if tk['samples']:  # already a plain MP4
            if limit is not None:
                return None
            shutil.copyfile(src, dst)
            return os.path.getsize(dst), 0
        end, durs, sizes, chunks, dts = None, [], [], [], 0  # chunks: (source offset, sample count), one per run
        cut = False
        for t, at, b in top:
            if t != b'moof' or cut:
                continue
            samples, nd = parse_moof(b, dts, tk['trex'])
            for i, (off, sz, sdts, _, _) in enumerate(samples):
                if at + off + sz > limit_:
                    cut = True
                    break
                if chunks and at + off == end:
                    chunks[-1][1] += 1
                else:
                    chunks.append([at + off, 1])
                end = at + off + sz
                sizes.append(sz)
                durs.append((samples[i + 1][2] if i + 1 < len(samples) else nd) - sdts)
            dts = nd
        if not sizes:
            raise ValueError('audio: no samples')
        ftyp = box(b'ftyp', b'M4A ', struct.pack('>I', 0x200), b'M4A isomiso2')
        n = len(chunks)
        head = len(ftyp) + len(flat_moov(tk['ts'], tk['stsd'], durs, sizes, chunks, [0] * n)) + 8
        offsets, o, i = [], head, 0
        for _, k in chunks:
            offsets.append(o)
            o += sum(sizes[i:i + k])
            i += k
        moov2 = flat_moov(tk['ts'], tk['stsd'], durs, sizes, chunks, offsets)
        if o - head + 8 > 0xffffffff:
            raise ValueError('audio: over 4 GB')
        with open(dst, 'wb') as g:
            g.write(ftyp + moov2 + struct.pack('>I4s', o - head + 8, b'mdat'))
            i = 0
            for at, k in chunks:
                nbytes = sum(sizes[i:i + k])
                i += k
                f.seek(at)
                g.write(f.read(nbytes))
    return os.path.getsize(dst), sum(durs) * 1000 // tk['ts']


def ranged_get(url, headers, dst, total, on_chunk=None, conns=AUDIO_CONNS, first=AUDIO_FIRST, chunk=AUDIO_CHUNK,
               ctx=None, timeout=15, gate=None):
    """total bytes of url into dst with conns parallel Range requests, handed out in file order; with gate (an Event)
    only the first connection runs until it is set.
    on_chunk(prefix, done): after each chunk, under a lock; prefix = the bytes written from 0 without a gap."""
    ranges = [(0, min(first, total))]
    while ranges[-1][1] < total:
        ranges.append((ranges[-1][1], min(ranges[-1][1] + chunk, total)))
    lock, st = threading.Lock(), {'next': 0, 'prefix': 0, 'done': 0, 'err': None}
    finished = [False] * len(ranges)
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)

    def get(s, e):
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers=dict(headers, Range=f'bytes={s}-{e - 1}'))
                with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                    if r.status != 206:
                        raise OSError(f'HTTP {r.status} to a Range request')
                    pos = s
                    while pos < e:
                        b = r.read(min(1 << 16, e - pos))
                        if not b:
                            raise OSError(f'short read at {pos} of {s}-{e}')
                        os.pwrite(fd, b, pos)
                        pos += len(b)
                return
            except (OSError, http.client.HTTPException) as ex:
                if attempt == 2 or st['err']:
                    raise
                time.sleep(0.5 * (attempt + 1))

    def worker(k):
        if k and gate is not None:
            gate.wait()
        while True:
            with lock:
                if st['err'] or st['next'] >= len(ranges):
                    return
                i = st['next']
                st['next'] += 1
            try:
                get(*ranges[i])
                with lock:
                    finished[i] = True
                    st['done'] += ranges[i][1] - ranges[i][0]
                    while st['prefix'] < len(ranges) and finished[st['prefix']]:
                        st['prefix'] += 1
                    if on_chunk:
                        on_chunk(ranges[st['prefix'] - 1][1] if st['prefix'] else 0, st['done'])
            except Exception as e:  # noqa: BLE001 - the first error ends every worker
                st['err'] = st['err'] or e
                if gate is not None:
                    gate.set()  # the gated workers see err and return
                return

    try:
        ts = [threading.Thread(target=worker, args=(k,), daemon=True) for k in range(min(conns, len(ranges)))]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
    finally:
        os.close(fd)
    if st['err']:
        raise st['err']
    if not all(finished):
        raise OSError('ranged_get: ranges left')
    return total


# ---------------------------------------------------------------- video: fMP4 stream -> Annex-B + MGYI

class AnnexB:
    """Length-prefixed NALs -> Annex-B, with SPS/PPS before IDRs: byte-for-byte ffmpeg's h264_mp4toannexb."""

    def __init__(self, avcc):
        self.ls = (avcc[4] & 3) + 1
        i, sps, pps = 6, [], []
        for _ in range(avcc[5] & 31):
            n = struct.unpack_from('>H', avcc, i)[0]
            sps.append(avcc[i + 2:i + 2 + n])
            i += 2 + n
        for _ in range(avcc[i]):
            n = struct.unpack_from('>H', avcc, i + 1)[0]
            pps.append(avcc[i + 3:i + 3 + n])
            i += 2 + n
        if not sps or not pps:
            raise ValueError('avcC without SPS/PPS')
        self.sps = b''.join(b'\0\0\0\1' + x for x in sps)
        self.pps = b''.join(b'\0\0\0\1' + x for x in pps)
        self.new_idr, self.sps_seen, self.pps_seen = True, False, False

    def convert(self, data):
        out, i, ls = bytearray(), 0, self.ls
        while i + ls <= len(data):
            n = int.from_bytes(data[i:i + ls], 'big')
            nal = data[i + ls:i + ls + n]
            i += ls + n
            if not nal:
                continue
            t = nal[0] & 31
            if t == 7:
                self.sps_seen = self.new_idr = True
            elif t == 8:
                self.pps_seen = self.new_idr = True
                if not self.sps_seen:
                    out += self.sps
                    self.sps_seen = True
            if not self.new_idr and t == 5 and len(nal) > 1 and nal[1] & 0x80:
                self.new_idr = True
            if self.new_idr and t == 5 and not self.sps_seen and not self.pps_seen:
                out += self.sps + self.pps
                self.new_idr = False
            elif self.new_idr and t == 5 and self.sps_seen and not self.pps_seen:
                out += self.pps
            out += (b'\0\0\0\1' if not out or t in (7, 8) else b'\0\0\1') + nal
            if not self.new_idr and t == 1:
                self.new_idr, self.sps_seen, self.pps_seen = True, False, False
        return bytes(out)


def read_box(f):
    """(type, whole box bytes) from a stream, None at a clean EOF."""
    h = f.read(8)
    if not h:
        return None
    if len(h) < 8:
        raise ValueError('video: truncated')
    size, t = struct.unpack('>I4s', h)
    if size == 1:
        x = f.read(8)
        h += x
        size = struct.unpack('>Q', x)[0]
    if size == 0:
        body = f.read()
    else:
        if size < len(h):
            raise ValueError(f'video: bad {t!r} box')
        body = f.read(size - len(h))
        if len(body) != size - len(h):
            raise ValueError('video: truncated')
    return t, h + body


def demux_video(f, d, duration_s, on_progress):
    """Stream fMP4 from f into d/video.h264.part + d/index.bin. Returns (frames, bytes, max_ms)."""
    vfd = os.open(os.path.join(d, 'video.h264.part'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    ifd = os.open(os.path.join(d, 'index.bin'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    at, conv, tk, base, pos, count, max_ms, dts, moof = 0, None, None, None, 0, 0, 0, 0, None
    try:
        while (bx := read_box(f)) is not None:
            t, b = bx
            if t == b'moov':
                tk = trak_info(b)
                if tk['samples']:
                    raise ValueError('video: not fragmented')
                ds, _ = tk['stsd_at']
                etype = b[ds + 12:ds + 16]  # first sample entry: stsd payload + 8, its payload + 16
                if etype not in (b'avc1', b'avc3'):
                    raise ValueError(f'video: {etype!r}, not avc1')
                es, ee = ds + 16, ds + 8 + struct.unpack_from('>I', b, ds + 8)[0]
                w, h = struct.unpack_from('>HH', b, es + 24)
                cs, _ = kid(b, es + 78, ee, b'avcC')
                conv = AnnexB(b[cs:])
            elif t == b'moof':
                if conv is None:
                    raise ValueError('video: moof before moov')
                moof = (at, b)
            elif t == b'mdat' and moof:
                m_at, mb = moof
                samples, dts = parse_moof(mb, dts, tk['trex'])
                if not samples:
                    moof = None
                    at += len(b)
                    continue
                data_at = at + (16 if struct.unpack_from('>I', b)[0] == 1 else 8)
                payload = memoryview(b)[data_at - at:]
                if base is None:
                    base = min(s[2] + s[3] for s in samples)
                    dur = (samples[1][2] - samples[0][2]) if len(samples) > 1 else (tk['trex'][0] or 1)
                    fps = Fraction(tk['ts'], dur).limit_denominator(1001)
                    os.write(ifd, HDR.pack(b'MGYI', 1, w, h, fps.numerator, fps.denominator, 0))
                vbuf, ibuf = [], []
                for off, sz, sdts, cto, sf in samples:
                    o = m_at + off - data_at
                    if o < 0 or o + sz > len(payload):
                        raise ValueError('video: sample outside mdat')
                    au = conv.convert(payload[o:o + sz])
                    key = is_key(sf)
                    if count == 0 and not key:
                        raise ValueError('video: first sample is not a keyframe')
                    ms = max(0, round((sdts + cto - base) * 1000 / tk['ts']))
                    max_ms = max(max_ms, ms)
                    vbuf.append(au)
                    ibuf.append(REC.pack(ms, pos, len(au), key))
                    pos += len(au)
                    count += 1
                # order matters to the reader: bytes, then their records, then the count
                os.write(vfd, b''.join(vbuf))
                os.write(ifd, b''.join(ibuf))
                os.pwrite(ifd, struct.pack('<I', count), 16)
                moof = None
                on_progress(max_ms, count, pos)
            at += len(b)
    finally:
        os.close(vfd)
        os.close(ifd)
    if not count:
        raise ValueError('video: no frames')
    os.replace(os.path.join(d, 'video.h264.part'), os.path.join(d, 'video.h264'))
    return count, pos, max_ms


# ---------------------------------------------------------------- fetch

class _Log:
    def __init__(self):
        self.last = ''

    def debug(self, msg):
        pass

    info = warning = debug

    def error(self, msg):
        self.last = msg


def load_ytdlp(pyz, cache_dir):
    if 'yt_dlp' in sys.modules:  # serve preloaded it
        return sys.modules['yt_dlp']
    sys.path.insert(0, pyz or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ytdlp.pyz'))
    if os.path.isfile(CA) and 'certifi' not in sys.modules:
        # yt-dlp uses certifi when it can import it: this one names the car's CA bundle (none is in ytdlp.pyz)
        import types
        certifi = types.ModuleType('certifi')
        certifi.where = lambda: CA
        certifi.contents = lambda: open(CA, encoding='ascii').read()
        sys.modules['certifi'] = certifi
    else:
        os.environ['TMPDIR'] = cache_dir
    import yt_dlp
    no_captions(yt_dlp)
    return yt_dlp


def no_captions(yt_dlp):
    """Drop the player responses' captions before yt-dlp lists them: it builds a URL per auto-caption language x
    format (~22k urlencode calls, ~30 s of the car's CPU on a long video) and we never use subtitles."""
    ie = getattr(getattr(getattr(yt_dlp.extractor, 'youtube', None), '_video', None), 'YoutubeIE', None)
    orig = getattr(ie, '_initial_extract', None)
    if orig is None or getattr(orig, '_no_captions', False):
        return

    def initial_extract(self, *args, **kw):
        r = orig(self, *args, **kw)
        for pr in (r[4] if isinstance(r, tuple) and len(r) > 4 and isinstance(r[4], list) else []):
            if isinstance(pr, dict):
                pr.pop('captions', None)
        return r
    initial_extract._no_captions = True
    ie._initial_extract = initial_extract


def ydl_params(a, fmt, hook=None):
    return {'format': fmt, 'cachedir': a.cache_dir, 'logger': _Log(), 'quiet': True, 'noprogress': True,
            'no_warnings': True, 'noplaylist': True, 'fixup': 'never', 'concurrent_fragment_downloads': 4,
            # the API's default is no retry: one 20 s stall (googlevideo pacing) ended the video; a retry resumes it
            'retries': 10, 'socket_timeout': 30,
            'js_runtimes': {'node': {'path': a.node}}, 'remote_components': [],
            'progress_hooks': [hook] if hook else []}


# visionos: avc1 https + AAC 140, no PO token, no JS solve, no tv_samsung ad wait (5 s); measured 2026-11-03
PLAYER_CLIENTS = ['visionos']


def usable(info):
    fs = info.get('formats') or []
    return (any((f.get('vcodec') or '').startswith('avc1') and f.get('protocol') in (None, 'https') for f in fs)
            and any(f.get('ext') == 'm4a' and f.get('vcodec') == 'none' for f in fs))


def extract(yt_dlp, a, url):
    """One extraction: PLAYER_CLIENTS first, then once more with yt-dlp's default clients."""
    if PLAYER_CLIENTS:
        p = dict(ydl_params(a, None), extractor_args={'youtube': {'player_client': PLAYER_CLIENTS}})
        try:
            info = yt_dlp.YoutubeDL(p).extract_info(url, download=False, process=False)
            if usable(info):
                return info
        except Exception:  # noqa: BLE001 - fall back to the default clients
            pass
    return yt_dlp.YoutubeDL(ydl_params(a, None)).extract_info(url, download=False, process=False)


INFO_MAX_S = 1800  # stream URLs last ~6 h; a prefetch older than this is redone


def load_info(path, vid):
    """extract's file for vid, if fresh; else None (fetch extracts itself)."""
    try:
        if path and time.time() - os.path.getmtime(path) < INFO_MAX_S:
            with open(path) as f:
                info = json.load(f)
            if info.get('id') == vid and usable(info):
                return info
    except (OSError, ValueError, AttributeError):
        pass
    return None


def extract_cmd(a):
    if not ID_RE.match(a.id):
        fail('bad id')
    install_dns(a.lease)
    yt_dlp = load_ytdlp(a.pyz, a.cache_dir)
    try:
        info = extract(yt_dlp, a, 'https://www.youtube.com/watch?v=' + a.id)
    except Exception as e:  # noqa: BLE001
        fail(f'extract: {e}')
    tmp = a.dir + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(yt_dlp.YoutubeDL.sanitize_info(info), f)
    os.replace(tmp, a.dir)
    emit(ev='info', id=a.id, title=info.get('title'), duration_s=info.get('duration'))
    return 0


def audio_ranged(a, ya, info, meta):
    """The audio format yt-dlp picks, fetched with ranged_get; audio.head.m4a + audio_head once the prefix
    covers max(HEAD_MIN_MS, 1.5x the rest's estimated time). None when the format is not plain https with a size."""
    f = ya.process_ie_result(copy.deepcopy(info), download=False)
    f = (f.get('requested_downloads') or [f])[0]
    total = f.get('filesize')
    if f.get('protocol') not in ('https', 'http') or not total or not f.get('url'):
        return None
    src = os.path.join(a.dir, 'audio.src.m4a')
    head, head_part = os.path.join(a.dir, 'audio.head.m4a'), os.path.join(a.dir, 'audio.head.m4a.part')
    dur_ms = (meta['duration_s'] or 0) * 1000
    t0, tick, st = time.monotonic(), Throttle(), {'head': None}
    # one connection until the head: four take the link from the video's start (measured: head 8 s, not 18 s)
    gate = threading.Event()

    def on_chunk(prefix, done):
        if prefix >= total:
            gate.set()
        if tick():
            emit(ev='audio', pct=min(100, round(done * 100 / total)))
        if st['head'] is not None or not prefix or prefix >= total:
            return
        rate = done / max(time.monotonic() - t0, 0.1)
        need = max(HEAD_MIN_MS, 1500 * (total - done) / rate)
        try:
            r = flatten_m4a(src, head_part, limit=prefix)
        except (ValueError, struct.error, OSError) as e:
            print(f'head at {prefix}: {e}', file=sys.stderr, flush=True)
            gate.set()
            return
        if r is None:
            st['head'] = 0  # a plain MP4: no head, audio_ready only
            gate.set()
            return
        if r[1] >= min(need, dur_ms or need):
            os.replace(head_part, head)
            st['head'] = r[1]
            gate.set()
            emit(ev='audio_head', ms=r[1], bytes=r[0])

    ctx = ssl.create_default_context(cafile=CA if os.path.isfile(CA) else None)
    try:
        ranged_get(f['url'], f.get('http_headers') or {}, src, total, on_chunk, conns=AUDIO_CONNS, first=AUDIO_FIRST,
                   chunk=AUDIO_CHUNK, ctx=ctx, gate=gate)
    except BaseException:
        os.remove(src)  # yt-dlp's fallback would take this holed file for a finished download (continuedl)
        raise
    finally:
        try:
            os.remove(head_part)
        except OSError:
            pass
    return src


def fetch(a):
    if not ID_RE.match(a.id):
        fail('bad id')
    os.umask(0o022)
    install_dns(a.lease)
    yt_dlp = load_ytdlp(a.pyz, a.cache_dir)
    url = 'https://www.youtube.com/watch?v=' + a.id
    tick_a, done_a = Throttle(), {}

    def audio_hook(st):
        if st.get('status') == 'downloading' and tick_a():
            total = st.get('total_bytes') or st.get('total_bytes_estimate')
            if total:
                emit(ev='audio', pct=min(100, round(st.get('downloaded_bytes', 0) * 100 / total)))

    ya = yt_dlp.YoutubeDL(dict(ydl_params(a, AUDIO_FMT, audio_hook),
                               outtmpl={'default': os.path.join(a.dir, 'audio.src.%(ext)s')}))
    yv = yt_dlp.YoutubeDL(dict(ydl_params(a, video_fmt(a.height)), outtmpl={'default': '-'}))
    info = load_info(a.info, a.id)
    try:
        info = info or extract(yt_dlp, a, url)
    except Exception as e:  # noqa: BLE001 - any yt-dlp failure is reported to the daemon
        fail(f'extract: {e}')
    meta = {'id': a.id, 'title': info.get('title'), 'channel': info.get('channel') or info.get('uploader'),
            'duration_s': info.get('duration'),
            'chapters': [[int((c.get('start_time') or 0) * 1000), str(c.get('title') or '')[:80]]
                         for c in (info.get('chapters') or [])[:100]]}
    with open(os.path.join(a.dir, 'meta.json.tmp'), 'w') as f:
        json.dump(meta, f)
    os.replace(os.path.join(a.dir, 'meta.json.tmp'), os.path.join(a.dir, 'meta.json'))
    emit(ev='meta', title=meta['title'], duration_s=meta['duration_s'], chapters=meta['chapters'])
    if not any((x.get('vcodec') or '').startswith('avc1') for x in info.get('formats') or []):
        fail('no avc1 video')

    def audio():
        try:
            src = None
            try:
                src = audio_ranged(a, ya, info, meta)
            except Exception as e:  # noqa: BLE001 - yt-dlp's own download, as before 0.2.1
                print(f'ranged audio failed, yt-dlp downloads it: {e}', file=sys.stderr, flush=True)
            if src is None:
                r = ya.process_ie_result(copy.deepcopy(info), download=True)
                src = r['requested_downloads'][0]['filepath']
            part = os.path.join(a.dir, 'audio.m4a.part')
            n, _ = flatten_m4a(src, part)
            os.replace(part, os.path.join(a.dir, 'audio.m4a'))
            os.remove(src)
            done_a['ok'] = True
            emit(ev='audio_ready', bytes=n)
        except BaseException as e:  # noqa: BLE001
            fail(f'audio: {ya.params["logger"].last or e}')

    rfd, wfd = os.pipe()
    sys.stdout = io.TextIOWrapper(os.fdopen(wfd, 'wb'))  # yt-dlp writes outtmpl '-' to sys.stdout.buffer

    def video():
        try:
            yv.process_ie_result(copy.deepcopy(info), download=True)
        except BaseException as e:  # noqa: BLE001
            fail(f'video: {yv.params["logger"].last or e}')
        sys.stdout.buffer.close()

    ta = threading.Thread(target=audio, daemon=True)
    tv = threading.Thread(target=video, daemon=True)
    ta.start()
    tv.start()
    tick_v, dur_ms = Throttle(), (meta['duration_s'] or 0) * 1000

    def vprog(ms, frames, nbytes):
        if tick_v():
            # the whole video lands on /var/opt, shared with the Store and the other tools: stop before it fills
            free = shutil.disk_usage(a.dir).free
            if free < MIN_FREE:
                fail(f'head unit storage almost full ({free >> 20} MiB free): video stopped')
            emit(ev='video', ms=ms, frames=frames, bytes=nbytes,
                 pct=min(100, round(ms * 100 / dur_ms)) if dur_ms else 0)

    try:
        with os.fdopen(rfd, 'rb') as f:
            frames, nbytes, ms = demux_video(f, a.dir, meta['duration_s'], vprog)
    except Exception as e:  # noqa: BLE001
        fail(f'video: {yv.params["logger"].last or e}')
    emit(ev='video', ms=ms, frames=frames, bytes=nbytes, pct=100)
    tv.join()
    ta.join()
    if not done_a:
        fail('audio: unfinished')
    emit(ev='done')
    sys.stdout = _out
    return 0


# ---------------------------------------------------------------- check (as root on the car)

def check(a):
    vid = a.id or DEFAULT_CHECK_ID
    if not ID_RE.match(vid):
        sys.exit('bad id')
    work = os.path.join(a.cache_dir, 'ytfetch-check')
    if os.geteuid() == 0:
        uid = a.uid
        if uid is None:
            with open('/var/opt/jap-ridetube-d/state/uids.json') as f:
                uid = int(json.load(f)['fetch'])
        os.makedirs(work, exist_ok=True)
        os.chown(work, uid, uid)
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
    os.makedirs(work, exist_ok=True)
    ok_all = []

    def line(name, ok, t0, info=''):
        ok_all.append(ok)
        print(f"{'PASS' if ok else 'FAIL'} {name:<22} {time.monotonic() - t0:7.2f}s  {info}", flush=True)

    t = time.monotonic()
    servers = install_dns(a.lease)
    try:
        ips = socket.getaddrinfo('www.youtube.com', 443)
        line('dns', bool(servers), t, f"{ips[0][4][0]} via {servers or 'system resolver (no lease)'}")
    except OSError as e:
        line('dns', False, t, e)
    t = time.monotonic()
    try:
        import ssl
        import urllib.request
        ctx = ssl.create_default_context(cafile=CA if os.path.isfile(CA) else None)
        with urllib.request.urlopen('https://www.youtube.com/robots.txt', context=ctx, timeout=10) as r:
            line('tls robots.txt', r.status == 200, t, f'HTTP {r.status} {len(r.read())} B')
    except Exception as e:  # noqa: BLE001
        line('tls robots.txt', False, t, e)
    t = time.monotonic()
    try:
        v = subprocess.run([a.node, '--version'], capture_output=True, text=True, timeout=10).stdout.strip()
        line('node', v.startswith('v') and int(v[1:].split('.')[0]) >= 22, t, f'{a.node} {v} (yt-dlp needs >= 22)')
    except (OSError, subprocess.SubprocessError) as e:
        line('node', False, t, e)
    cache = os.path.join(work, 'ytdlp-cache')
    shutil.rmtree(cache, ignore_errors=True)
    a.cache_dir = cache
    yt_dlp = load_ytdlp(a.pyz, cache)
    for name in ('extract cold', 'extract warm'):
        t = time.monotonic()
        try:
            info = extract(yt_dlp, a, 'https://www.youtube.com/watch?v=' + vid)
            line(name, bool(info.get('formats')), t, f"{len(info.get('formats') or [])} formats")
        except Exception as e:  # noqa: BLE001
            line(name, False, t, e)
    out = os.path.join(work, vid)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    cmd = [sys.executable, '-I', os.path.abspath(__file__), 'fetch', vid, out, '--cache-dir', cache,
           '--height', str(a.height), '--node', a.node, '--lease', a.lease] + (['--pyz', a.pyz] if a.pyz else [])
    t = time.monotonic()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, env={}, cwd='/')
    t_audio = t_head = t_lead = t_dl = None  # t_dl: first progress event, after yt-dlp's 'sleep as required by the site'
    rate20, last = 0, {}
    for raw in p.stdout:
        ev, now = json.loads(raw), time.monotonic() - t
        last = ev
        if ev['ev'] in ('audio', 'video') and t_dl is None:
            t_dl = now
        if ev['ev'] == 'video' and now - t_dl <= 20:
            rate20 = ev['bytes'] / max(now - t_dl, 0.01)
        if ev['ev'] == 'audio_head':
            t_head = now
            print(f"     audio_head at {now:.2f}s: {ev['ms']} ms, {ev['bytes']} B", flush=True)
        if ev['ev'] == 'audio_ready':
            t_audio = now
            print(f"     audio_ready at {now:.2f}s: {ev['bytes']} B, "
                  f"{ev['bytes'] / max(now - (t_dl or 0), 0.01) / 1e6:.2f} MB/s from the first byte", flush=True)
        if ev['ev'] == 'video' and ev['ms'] >= 10000 and t_lead is None:
            t_lead = now
            print(f"     10 s video lead at {now:.2f}s: {ev['bytes']} B", flush=True)
        if ev['ev'] == 'error':
            print('     error:', ev['msg'], flush=True)
    rc = p.wait()
    line('fetch', rc == 0 and last.get('ev') == 'done', t,
         f"head {t_head and round(t_head, 2)}s, audio {t_audio and round(t_audio, 2)}s, 10s-lead {t_lead and round(t_lead, 2)}s, "
         f"first byte {t_dl and round(t_dl, 2)}s, video first 20 s {rate20 / 1e6:.2f} MB/s")
    t = time.monotonic()
    try:
        n = validate(os.path.join(out, 'index.bin'), os.path.join(out, 'video.h264'))
        line('index', True, t, f'{n} records')
    except (OSError, AssertionError, ValueError, struct.error) as e:
        line('index', False, t, e)
    print('ALL PASS' if all(ok_all) else 'SOME FAILED', flush=True)
    return 0 if all(ok_all) else 1


def validate(index_path, h264_path):
    """mgyi.validate's rules; returns the record count."""
    with open(index_path, 'rb') as f:
        data = f.read()
    magic, ver, _w, _h, _fn, _fd, n = HDR.unpack_from(data)
    assert magic == b'MGYI' and ver == 1, 'bad header'
    assert len(data) == HDR.size + n * REC.size, 'bad length'
    recs = [REC.unpack_from(data, HDR.size + i * REC.size) for i in range(n)]
    assert recs and recs[0][1] == 0 and recs[0][3] == 1, 'first record must be key at pos 0'
    assert all(x[1] + x[2] == y[1] for x, y in zip(recs, recs[1:])), 'gap/overlap'
    assert sum(r[2] for r in recs) == os.path.getsize(h264_path), 'sizes != file size'
    return n


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('cmd', choices=('fetch', 'extract', 'serve', 'check'))
    ap.add_argument('id', nargs='?')
    ap.add_argument('dir', nargs='?')
    ap.add_argument('--cache-dir', required=True)
    ap.add_argument('--height', type=int, default=720)
    ap.add_argument('--node', default=NODE)
    ap.add_argument('--lease', default=LEASE)
    ap.add_argument('--pyz')
    ap.add_argument('--uid', type=int)
    ap.add_argument('--info')
    a = ap.parse_args(argv)
    if a.cmd == 'check':
        return check(a)
    if a.cmd == 'serve':
        install_dns(a.lease)
        load_ytdlp(a.pyz, a.cache_dir).YoutubeDL(ydl_params(a, None))  # the first YoutubeDL() costs ~0.35 s more on the car
        emit(ev='warm')
        try:
            job = json.loads(sys.stdin.readline())
        except ValueError:
            return 0  # the daemon closed us unused
        if not isinstance(job, list) or not job or job[0] not in ('fetch', 'extract'):
            fail('bad job')
        return main([str(x) for x in job])
    if not a.id or not a.dir:
        fail('usage: fetch|extract <id> <dir|info.json> --cache-dir <d>')
    return extract_cmd(a) if a.cmd == 'extract' else fetch(a)


if __name__ == '__main__':
    sys.exit(main())
