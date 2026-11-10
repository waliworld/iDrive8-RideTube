"""Annex-B access-unit splitter + MGYI index writer/validator.

Reference implementation (ffprobe based) that test_ytfetch.py compares ytfetch.py against.
"""
import json
import os
import struct
import subprocess
import sys

HDR = struct.Struct('<4sHHHHHxxI12x')  # 32 bytes, frame count at offset 16
REC = struct.Struct('<IQIB')            # 17 bytes: pts_ms, pos, size, key
PREFIX = {6, 7, 8, 9}                   # SEI, SPS, PPS, AUD
SLICE = {1, 5}
FFPROBE = '/opt/homebrew/bin/ffprobe'


def nal_starts(buf):
    """Yield (start_code_offset, nal_type, first_mb_is_zero) for each NAL."""
    i = buf.find(b'\x00\x00\x01')
    while i != -1:
        s = i - 1 if i > 0 and buf[i - 1] == 0 else i
        h = i + 3
        if h >= len(buf):
            break
        t = buf[h] & 0x1f
        # first_mb_in_slice is the first ue(v): value 0 <=> first bit set
        mb0 = h + 1 < len(buf) and bool(buf[h + 1] & 0x80)
        yield s, t, mb0
        i = buf.find(b'\x00\x00\x01', h)


def split_aus(buf):
    """Return [(pos, size)] per access unit in decode order."""
    # vcl = current AU already has a slice; an end-of-sequence (10) or filler (12)
    # NAL after it must not hide that, or the next frame is merged into this one
    starts, vcl = [], None
    for s, t, mb0 in nal_starts(buf):
        if vcl is None:
            new = True
        elif t in PREFIX:
            new = vcl
        elif t in SLICE:
            new = vcl and mb0
        else:
            new = False
        if new:
            starts.append(s)
            vcl = False
        if t in SLICE:
            vcl = True
    ends = starts[1:] + [len(buf)]
    return [(a, b - a) for a, b in zip(starts, ends)]


def probe(mp4):
    """Stream info + [(pts_ms, key, size)] from the source mp4, decode order."""
    st = json.loads(subprocess.run(
        [FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'stream=width,height,r_frame_rate,time_base,start_pts', '-of', 'json', mp4],
        check=True, capture_output=True, text=True).stdout)['streams'][0]
    out = subprocess.run(
        [FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'packet=pts,dts,flags,size', '-of', 'csv=p=0', mp4],
        check=True, capture_output=True, text=True).stdout
    tb_n, tb_d = map(int, st['time_base'].split('/'))
    pk = []
    for line in out.splitlines():
        pts, dts, size, flags = line.split(',')[:4]
        if pts == 'N/A':
            pts = dts
        pk.append([int(pts), 'K' in flags, int(size)])
    base = int(st.get('start_pts') or 0)
    base = min(base, min(p[0] for p in pk)) if pk else 0
    for p in pk:
        p[0] = round((p[0] - base) * 1000 * tb_n / tb_d)
    return st, pk


def build_index(mp4, h264, out_path):
    """Write index.bin; raise ValueError if AU count != packet count."""
    st, pk = probe(mp4)
    with open(h264, 'rb') as f:
        buf = f.read()
    aus = split_aus(buf)
    if len(aus) != len(pk):
        raise ValueError(f'AU count {len(aus)} != packet count {len(pk)}')
    fn, fd = map(int, st['r_frame_rate'].split('/'))
    tmp = out_path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(HDR.pack(b'MGYI', 1, st['width'], st['height'], fn, fd, len(aus)))
        for (pos, size), (pts, key, _) in zip(aus, pk):
            f.write(REC.pack(pts, pos, size, key))
    os.replace(tmp, out_path)
    return st, pk, aus


def read_index(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, ver, w, h, fn, fd, n = HDR.unpack_from(data)
    recs = [REC.unpack_from(data, HDR.size + i * REC.size) for i in range(n)]
    assert magic == b'MGYI' and ver == 1, 'bad header'
    assert len(data) == HDR.size + n * REC.size, 'bad length'
    return dict(w=w, h=h, fps=(fn, fd), n=n), recs


def validate(index_path, h264_path, n_packets=None):
    hdr, recs = read_index(index_path)
    size = os.path.getsize(h264_path)
    assert recs, 'empty index'
    assert recs[0][1] == 0 and recs[0][3] == 1, 'first record must be key at pos 0'
    assert all(a[1] < b[1] for a, b in zip(recs, recs[1:])), 'pos not increasing'
    assert all(a[1] + a[2] == b[1] for a, b in zip(recs, recs[1:])), 'gap/overlap'
    assert sum(r[2] for r in recs) == size, 'sizes != file size'
    if n_packets is not None:
        assert hdr['n'] == n_packets, f"{hdr['n']} records != {n_packets} packets"
    return hdr, recs


