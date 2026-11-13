#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""ytalsa.py - RideTube's own player for a head unit whose media player is not offered to us (iDrive 8): the samples
ytaud decodes go straight to the car's audio router through ALSA (libasound, loaded with ctypes: the Python on the
unit, mgu-python, has no ALSA module and needs none).

The router is Intel's SmartXbar; its devices are "smartx:<name>" (ALSA plugin of AVB-AudioModules, both public). What
this file relies on, from that source:
  - a device is a ring buffer in shared memory (/dev/shm/smartx_<name>_p_ringbuffer, a wake-up pipe and a lock file
    in /run/smartx) that the router reads at the pace of time ONLY while the audio manager has its source connected
    to a sink; otherwise it fills and takes no more. So "does it take samples as time passes" tells whether sound
    comes out of it;
  - one program at a time has a device (EBUSY for the next);
  - opened non-blocking it is not read until the stream is started; opened blocking it is read at once. It is opened
    blocking here, switched to non-blocking writes, and started by hand after the first samples;
  - its position (what snd_pcm_delay rests on) is reset by snd_pcm_set_params only, not by snd_pcm_prepare: a stream
    that has played is never prepared again here - a pause stops feeding it, a seek feeds it from the new place, and
    a broken stream is closed and opened anew.

    ytalsa.py probe [--shm DIR] [--run DIR] [--conf PATH ...] [--am DIR]
        One JSON object: the router's devices worth a try, the likeliest first, found in the car's files (nothing
        is opened): {"devices": [{"name": "plug:smartx:OAPMedia", "sure": 2, "held": "mediaengine (4103)"}, ...],
        "others": ["plug:smartx:..."], "shm": [...], "run": [...], "conf": [...], "map": ["OAPMedia: OapGenericMedia,
        ..."], "notes": [...]}. "map": the names a configuration file has just before it names a device (which
        player writes to it). "others": devices the router has whose names say nothing, free now, none of them the
        telephone's, the navigation's, a warning's or another source's by its name: listened to only when none of
        "devices" plays.

    ytalsa.py scan --devices JSON [--ms 1500] [--alsa-lib LIB]
        Opens every device named (a JSON list), writes silence to all of them for --ms and says which take it as time
        passes at the end of that ("late": its pace over the last half second against real time; "ratio": over the
        whole of it): {"devices": [{"name":.., "open": true, "buffer":.., "took": frames, "ratio": r, "late": r,
        "verdict": "flows"|"stalls"|"fast"} | {"name":.., "open": false, "error":..}], "ms": n}. Nothing is heard.

    ytalsa.py play --device NAME --decoder YTAUD --file AUDIO.m4a [--start-ms N] [--no-setuid] [--alsa-lib LIB]
        Plays the file on the device. stdout, one JSON object a line:
          {"ev":"open","device":..,"rate":..,"channels":..,"buffer":..,"period":..}
          {"ev":"flow","verdict":"flows"|"stalls"|"fast","ratio":r}   once: whether the device takes the samples
              as time passes (something plays them; said as soon as it has for half a second, a second in at the
              earliest), takes none once its buffer is full (nothing is connected to it; said 4 s in) or swallows
              them faster than time (they go nowhere). Not "flows": it ends.
          {"ev":"state","state":"PLAYER_STATE_PLAY"|"PLAYER_STATE_STOP"}
          {"ev":"resumed","ok":true|false}                              after a resume: whether the device takes
              the samples again (said within 2.5 s; false: the car gave its sound to another source meanwhile)
          {"ev":"time","elapsed":ms,"total":ms}                          four times a second while it plays
          {"ev":"eof"}                                                   the file's end was played
          {"ev":"error","msg":..}                                        then exit 3
        stdin, one command a line: pause | resume | seek MS | file "PATH" [MS] (a JSON string; from its start,
        or from MS) | quit.
        A pause keeps the place; seek, resume and file start the decoder again there (ytaud --start-ms).

The decoder runs as nobody (it parses a file from the internet); this process stays root for the device.
Python 3.9+, standard library only.
"""
import ctypes
import errno
import fcntl
import json
import os
import re
import select
import signal
import struct
import subprocess
import sys
import threading
import time

PLAYBACK = 0
S16_LE, RW_INTERLEAVED = 2, 3
PREPARED = 2


def say(o):
    sys.stdout.write(json.dumps(o, separators=(',', ':')) + '\n')
    sys.stdout.flush()


class Guard:
    """A call into libasound that asks the router and waits for its answer for ever (open, set_params, start, drop,
    close - the plugin has no timeout there) gets a time limit: past it this process says so and ends. A thread
    does that: the main one is inside the C call."""

    def __init__(self, dead):
        self.dead = dead           # what to do with the reason; it does not return
        self.until = None
        self.what = ''
        self.thread = None

    def __call__(self, what, seconds):
        if self.thread is None:
            self.thread = threading.Thread(target=self.watch, daemon=True)
            self.thread.start()
        self.what, self.until = what, time.monotonic() + seconds
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.until = None
        return False

    def watch(self):
        while True:
            time.sleep(0.2)
            u = self.until
            if u is not None and time.monotonic() > u:
                self.dead('the car\'s audio router did not answer (%s)' % self.what)
                os._exit(3)


class Alsa:
    """The few calls of libasound this needs."""

    def __init__(self, lib):
        a = self.a = ctypes.CDLL(lib or 'libasound.so.2', use_errno=True)
        vp, ci, cu, cl, cul = ctypes.c_void_p, ctypes.c_int, ctypes.c_uint, ctypes.c_long, ctypes.c_ulong
        a.snd_pcm_open.argtypes = [ctypes.POINTER(vp), ctypes.c_char_p, ci, ci]
        a.snd_pcm_open.restype = ci
        a.snd_pcm_set_params.argtypes = [vp, ci, ci, cu, cu, ci, cu]
        a.snd_pcm_set_params.restype = ci
        a.snd_pcm_get_params.argtypes = [vp, ctypes.POINTER(cul), ctypes.POINTER(cul)]
        a.snd_pcm_get_params.restype = ci
        a.snd_pcm_writei.argtypes = [vp, vp, cul]
        a.snd_pcm_writei.restype = cl
        a.snd_pcm_avail_update.argtypes = [vp]
        a.snd_pcm_avail_update.restype = cl
        a.snd_pcm_nonblock.argtypes = [vp, ci]
        a.snd_pcm_nonblock.restype = ci
        a.snd_pcm_wait.argtypes = [vp, ci]
        a.snd_pcm_wait.restype = ci
        for n in ('snd_pcm_close', 'snd_pcm_start', 'snd_pcm_drop', 'snd_pcm_state'):
            getattr(a, n).argtypes = [vp]
            getattr(a, n).restype = ci
        a.snd_strerror.argtypes = [ci]
        a.snd_strerror.restype = ctypes.c_char_p
        # libasound prints its own errors to stderr (a device that does not exist is three lines): kept quiet,
        # what failed is said in our own lines
        self.said = ''             # the last of them: which step of a call failed (its text, the numbers not filled in)
        try:
            self._quiet = ctypes.CFUNCTYPE(None, ctypes.c_char_p, ci, ctypes.c_char_p, ci, ctypes.c_char_p)(self.heard)
            a.snd_lib_error_set_handler(self._quiet)
        except Exception:  # an ALSA without it: its lines go to stderr
            pass

    def heard(self, file, line, function, err, fmt):
        try:
            self.said = ('%s: %s' % ((function or b'?').decode('ascii', 'replace'), (fmt or b'').decode('ascii', 'replace')))[:160]
        except Exception:
            pass

    def err(self, code):
        try:
            return (self.a.snd_strerror(int(code)) or b'?').decode('utf8', 'replace')
        except Exception:
            return 'error %d' % code

    def open(self, name, guard, rate, channels):
        """The device open for our writes, set to signed 16 bit at this rate (ALSA's "plug" converts to what the
        router's device takes): (pcm, buffer, period), the two in frames. Opened blocking - a non-blocking open
        tells the router not to read the device until the stream is started - then switched to non-blocking writes:
        a blocking write to a device nothing reads breaks the stream."""
        pcm = ctypes.c_void_p()
        with guard('opening ' + name, 6):
            r = self.a.snd_pcm_open(ctypes.byref(pcm), name.encode('utf8'), PLAYBACK, 0)
        if r < 0:
            raise OSError(-r, self.err(r))
        try:
            last = 0
            self.said = ''
            with guard('setting up ' + name, 6):
                for latency in (200000, 500000, 100000, 50000, 1000000):
                    last = self.a.snd_pcm_set_params(pcm, S16_LE, RW_INTERLEAVED, channels, rate, 1, latency)
                    if last >= 0:
                        break
            if last < 0:
                raise OSError(-last, 'takes no %d Hz %d-channel sound: %s%s' % (rate, channels, self.err(last), ' [%s]' % self.said if self.said else ''))
            buf, per = ctypes.c_ulong(0), ctypes.c_ulong(0)
            if self.a.snd_pcm_get_params(pcm, ctypes.byref(buf), ctypes.byref(per)) < 0:
                buf.value, per.value = rate // 5, rate // 20
            self.a.snd_pcm_nonblock(pcm, 1)
        except Exception:
            self.close(pcm, guard, False)
            raise
        return pcm, int(buf.value) or rate // 5, int(per.value) or rate // 20

    def started(self, pcm, guard, name):
        """After the first samples: the stream started by hand (ALSA starts it by itself only once the buffer is
        full, which never happens on a device the router empties as fast as we fill it)."""
        if self.a.snd_pcm_state(pcm) == PREPARED:
            with guard('starting ' + name, 5):
                return self.a.snd_pcm_start(pcm)
        return 0

    def fill(self, pcm, buffer):
        """The frames the device still holds (the buffer less what may be written), without asking the router."""
        av = self.a.snd_pcm_avail_update(pcm)
        if av < 0:
            return None
        return max(0, buffer - min(int(av), buffer))

    def close(self, pcm, guard, drop=True):
        try:
            if drop:
                with guard('stopping the stream', 4):
                    self.a.snd_pcm_drop(pcm)        # (tells the router the stream stopped: it empties the device)
            with guard('closing the device', 4):
                self.a.snd_pcm_close(pcm)
        except Exception:
            pass


# ---------------------------------------------------------------- probe

OURS = re.compile(r'oap|generic|dynamic|online|media|entertain|browser|video|stream|music|player', re.I)
NOT_OURS = re.compile(r'rse|rear|interrupt|overlay|vol_|ratio|sink|capture|_c$|(?:^|_)mic(?:_|$)|microphone|'
                      r'tel|ring|phone|hfp|nav|tts|sds|speech|voice|pdc|park|gong|chime|warn|ecall|emergency|alert|service|'
                      r'voip|call|sim|nuance|dictat|physical', re.I)
# the devices of other sources of the car, by their names: never among "the router's other devices" either
THEIRS = re.compile(r'click|beep|haptic|welcome|asd|ecnr|siri|alexa|carplay|carlife|android|aap|a2dp|bluetooth|(?:^|_)bt|usb|tuner|radio|dab|sxm|sdars|'
                    r'(?:^|_)cd(?:_|$)|dvd|aux|optical|ipod|mirror|record|loopback|test|diag', re.I)


def score(name):
    """How likely a device of the router is the one our source plays through."""
    s = 20
    if re.search(r'oap', name, re.I):
        s = 100 + (10 if re.search(r'media', name, re.I) else 0)
    elif re.search(r'generic', name, re.I):
        s = 90
    elif re.search(r'dynamic', name, re.I):
        s = 80 + (5 if re.search(r'media', name, re.I) else 0) - (10 if re.search(r'temp', name, re.I) else 0)
    elif re.search(r'online', name, re.I):
        s = 60
    elif re.search(r'entertain|media', name, re.I):
        s = 40
    return s - len(name) / 100.0


def small(path, limit):
    try:
        st = os.stat(path)
        if not os.path.isfile(path) or st.st_size > limit:
            return b''
        with open(path, 'rb') as f:
            return f.read()
    except OSError:
        return b''


def listing(d):
    try:
        return sorted(os.listdir(d))
    except OSError:
        return []


def who(pid):
    try:
        with open('/proc/%d/comm' % pid, 'rb') as f:
            return '%s (%d)' % (f.read(64).decode('utf8', 'replace').strip(), pid)
    except OSError:
        return 'process %d' % pid


def holder(lock):
    """Who has a device open: the plugin keeps a lock on /run/smartx/<device>.lock while it has. None: nobody."""
    try:
        fd = os.open(lock, os.O_RDONLY)
    except OSError:
        return None
    try:
        # struct flock { short l_type, l_whence; off_t l_start, l_len; pid_t l_pid; } - asked, never taken
        got = fcntl.fcntl(fd, fcntl.F_GETLK, struct.pack('hhqqi4x', fcntl.F_WRLCK, 0, 0, 0, 0))
        kind, _, _, _, pid = struct.unpack('hhqqi4x', got)
        return who(pid) if kind != fcntl.F_UNLCK and pid > 0 else None
    except (OSError, struct.error):
        return None
    finally:
        os.close(fd)


def options(argv, opt, flags=(), many=()):
    """--name value pairs into opt; the flags given; those of `many` gathered into lists. The rest is returned."""
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in flags:
            opt[a] = True
            i += 1
        elif a in many and i + 1 < len(argv):
            opt.setdefault(a, []).append(argv[i + 1])
            i += 2
        elif a in opt and i + 1 < len(argv):
            opt[a] = argv[i + 1]
            i += 2
        else:
            rest.append(a)
            i += 1
    return rest


STOCK_PCM = re.compile(r'^(cards|default|sysdefault|front|rear|center_lfe|side|surround\d+|iec958|spdif|hdmi|modem|phoneline|dmix|dsnoop|hw|plughw|plug|shm|tee|file|null|'
                       r'pulse|dpl|dca|lfloat|oss|jack|usbstream|upmix|vdownmix|speex|speexrate|samplerate|a52|rate|route|multi|asym|softvol|hook|copy|linear|adpcm|alaw|mulaw|meter|ladspa|iec958)$')


def read_text(path, limit=1 << 16):
    try:
        with open(path, 'rb') as f:
            return f.read(limit).decode('utf8', 'replace')
    except OSError:
        return ''


def plumbing(shm, proc, conf, asound):
    """How the car's programs are wired to its sound, read from /proc and the configuration (nothing is opened):
    which program has which sound device or buffer, the kernel's sound cards and their streams in use, the devices
    the ALSA configuration defines, and what the media engine's configuration says of its sound output."""
    out = {}
    # the kernel's cards and devices; the streams in use, by whom, in which format
    out['cards'] = [' '.join(l.split()) for l in read_text(os.path.join(asound, 'cards')).split('\n') if l.strip()][:16]
    out['pcm'] = [' '.join(l.split()) for l in read_text(os.path.join(asound, 'pcm')).split('\n') if l.strip()][:60]
    used = []
    for card in listing(asound):
        if not re.match(r'^card\d+$', card):
            continue
        for pcm in listing(os.path.join(asound, card)):
            if not re.match(r'^pcm\d+[pc]$', pcm):
                continue
            for sub in listing(os.path.join(asound, card, pcm)):
                if not sub.startswith('sub'):
                    continue
                d = os.path.join(asound, card, pcm, sub)
                st = read_text(os.path.join(d, 'status'), 2000)
                if not st.strip() or st.strip() == 'closed':
                    continue
                state = (re.search(r'state:\s*(\w+)', st) or [None, '?'])[1]
                owner = re.search(r'owner_pid\s*:\s*(\d+)', st)
                hw = read_text(os.path.join(d, 'hw_params'), 2000)
                fmt = ' '.join(x for x in ((re.search(r'rate:\s*(\d+)', hw) or [None, ''])[1] and (re.search(r'rate:\s*(\d+)', hw)[1] + ' Hz'),
                                           (re.search(r'channels:\s*(\d+)', hw) or [None, ''])[1] and (re.search(r'channels:\s*(\d+)', hw)[1] + ' ch')) if x)
                if len(used) < 80:
                    used.append('%s/%s/%s %s%s%s' % (card, pcm, sub, state, ' by ' + who(int(owner.group(1))) if owner else '', ', ' + fmt if fmt else ''))
    out['used'] = used
    # which program has which device of the kernel's open and which buffer in shared memory mapped
    maps, snd = {}, {}
    for pid in listing(proc):
        if not pid.isdigit():
            continue
        names = set()
        try:
            with open(os.path.join(proc, pid, 'maps'), 'rb') as f:
                for m in re.finditer(rb'/dev/shm/([^\s]+)', f.read(8 << 20)):
                    names.add(m.group(1).decode('utf8', 'replace'))
        except OSError:
            pass
        devs = set()
        for fd in listing(os.path.join(proc, pid, 'fd')):
            try:
                t = os.readlink(os.path.join(proc, pid, 'fd', fd))
            except OSError:
                continue
            if t.startswith('/dev/snd/') and not t.endswith(('timer', 'seq')):
                devs.add(t[9:])
            elif t.startswith('/dev/shm/'):
                names.add(t[9:])
        if names or devs:
            comm = read_text(os.path.join(proc, pid, 'comm'), 64).strip() or '?'
            if names:
                maps['%s (%s)' % (comm, pid)] = names
            if devs:
                snd['%s (%s)' % (comm, pid)] = sorted(devs)
    out['snd'] = ['%s: %s' % (k, ', '.join(v[:24])) for k, v in sorted(snd.items())][:30]
    # (the program with the most buffers is the router itself: only its count; the others' buffers by name)
    short = lambda n: re.sub(r'_ringbuffer$', '', n)
    big = max(maps, key=lambda k: len(maps[k])) if maps else None
    have = []
    for k in sorted(maps):
        v = sorted(set(short(n) for n in maps[k]))
        if k == big and len(v) > 12:
            have.append('%s: %d buffers (the router)' % (k, len(v)))
        else:
            have.append('%s: %s' % (k, ', '.join(v[:30]) + (' +%d more' % (len(v) - 30) if len(v) > 30 else '')))
    out['maps'] = have[:40]
    # every buffer there is (smartx_<device>_p: a program plays into the router; _c: it records; avb_: to and from the amplifier)
    out['shm'] = sorted(set(short(n) for n in listing(shm)))[:260]
    # the devices the ALSA configuration defines beyond ALSA's own, and the media engine's words about its output
    pcms, words, files = [], [], []
    for c in conf:
        alsa = bool(re.search(r'(asound\.conf|alsa\.conf\.d|alsa/conf\.d)$', c.rstrip('/')))      # ALSA's own files: devices, no players
        for f in [c] + [os.path.join(c, n) for n in listing(c)]:
            raw = small(f, 4 << 20)
            if not raw:
                continue
            text = raw.decode('utf8', 'replace')
            if not alsa:
                files.append('%s (%d)' % (os.path.basename(f), len(raw)))
            for m in re.finditer(r'(?m)^\s*pcm\.([A-Za-z0-9_]+)\s*\{', text):
                name = m.group(1)
                if STOCK_PCM.match(name) or len(pcms) >= 90:
                    continue
                body = text[m.end():m.end() + 500]
                d = [(re.search(r'\btype\s+"?(\w+)', body) or [None, '?'])[1]]
                for key in ('card', 'device', 'subdevice', 'pcm', 'name'):
                    x = re.search(r'\b' + key + r'\s+"?([^\s"{}]+)', body)
                    if x and not x.group(1).startswith('$'):
                        d.append(key + ' ' + x.group(1))
                pcms.append(name + '=' + ' '.join(d[:5]))
            # a device named the ALSA way, with the names just before it
            for m in re.finditer(r'["\'>]((?:plug|plughw|hw|smartx|avb|dmix|sysdefault|default|front|surround\d+)(?::[^"\'<\s]{0,80})?)["\'<]', text):
                before = [w for w in re.findall(r'["\'>]([A-Za-z][A-Za-z0-9_.-]{3,48})["\'<]', text[max(0, m.start() - 400):m.start()])][-3:]
                w = '%s <- %s' % (m.group(1), ', '.join(before))
                if w not in words and len(words) < 40:
                    words.append(w)
            # what follows the names of our players in it
            if not alsa:
                for key in ('OapGenericMedia', 'DynamicMediaPlayerMedia', 'DynamicMedia', 'OnlineEntertainment'):
                    for m in list(re.finditer(re.escape(key) + r'\b', text))[:2]:
                        w = '[%s in %s] %s' % (key, os.path.basename(f), ' '.join(text[m.start():m.start() + 420].split()))
                        if len(words) < 52:
                            words.append(w)
                # and its lines about the sound output, whatever they are called
                for m in re.finditer(r'(?i)[^\n<>]{0,60}(alsa|audio[_-]?(?:sink|device|out)|pcm[_-]?(?:name|device))[^\n<>]{0,140}', text):
                    w = '[%s] %s' % (os.path.basename(f), ' '.join(m.group(0).split()))
                    if w not in words and len(words) < 70:
                        words.append(w)
    out['pcms'] = pcms
    out['words'] = words
    out['files'] = files[:40]
    # the sound programs' libraries: what the media engine plays with
    libs = []
    for pid in listing(proc):
        if not pid.isdigit():
            continue
        comm = read_text(os.path.join(proc, pid, 'comm'), 64).strip()
        if not re.search(r'mediaengine|mediaapp|waveplayer|AudioManager|AlsaRouting|avb|smartx', comm, re.I):
            continue
        cmd = read_text(os.path.join(proc, pid, 'cmdline'), 600).replace('\x00', ' ').strip()
        found = set()
        try:
            with open(os.path.join(proc, pid, 'maps'), 'rb') as f:
                for m in re.finditer(rb'/([^/\s]+\.so[.\d]*)', f.read(8 << 20)):
                    n = m.group(1).decode('ascii', 'replace')
                    if re.search(r'asound|smartx|avb|ias|audio|pulse|cinemo|nme|gst|pcm|snd|sink', n, re.I):
                        found.add(re.sub(r'\.so[.\d]*$', '', n))
        except OSError:
            pass
        if len(libs) < 14:
            libs.append('%s (%s) [%s]: %s' % (comm, pid, cmd[:200], ', '.join(sorted(found)[:40])))
    out['libs'] = libs
    return out


def probe(argv):
    opt = {'--shm': '/dev/shm', '--run': '/run/smartx', '--am': '/usr/share/audiomanager', '--alsa-lib': None, '--proc': '/proc', '--asound': '/proc/asound'}
    options(argv, opt, many=('--conf',))
    conf = opt.get('--conf') or ['/etc/asound.conf', '/usr/share/alsa/alsa.conf.d', '/etc/alsa/conf.d', '/etc/mediaconfig', '/etc/audiomanager', '/etc/mediaapp', '/etc/smartx']
    # (and the configuration files the media programs were started with)
    for pid in listing(opt['--proc']):
        if pid.isdigit() and re.search(r'mediaengine|mediaapp', read_text(os.path.join(opt['--proc'], pid, 'comm'), 64)):
            for a in read_text(os.path.join(opt['--proc'], pid, 'cmdline'), 2000).split('\x00'):
                if re.search(r'^/[\w./-]+\.(xml|json|conf|cfg|ini)$', a) and a not in conf and not any(a.startswith(c.rstrip('/') + '/') for c in conf):
                    conf.append(a)
    res = {'devices': [], 'others': [], 'shm': [], 'run': [], 'conf': [], 'map': [], 'notes': []}
    names = {}       # a device's name -> how sure it exists: 2 the router has its buffer, 1 a configuration names it, 0 a name of the audio manager's
    held = {}
    near = {}        # a device's name -> the names a configuration has just before it (the player that writes to it)

    def add(n, sure):
        if n and names.get(n, -1) < sure:
            names[n] = sure
    # the router's buffers: one per device that exists now (smartx_<device>_p...: the side a player writes)
    for n in listing(opt['--shm']):
        if not n.startswith('smartx'):
            continue
        if len(res['shm']) < 240:
            res['shm'].append(n)
        m = re.match(r'^smartx_(.+?)_p(?:_ringbuffer)?$', n)
        if m:
            add(m.group(1), 2)
    # its locks: who has which device open now
    for n in listing(opt['--run']):
        m = re.match(r'^smartx_(.+)_p\.lock$', n)
        if not m:
            continue
        h = holder(os.path.join(opt['--run'], n))
        if h:
            held[m.group(1)] = h
        if len(res['run']) < 240:
            res['run'].append(m.group(1) + (': ' + h if h else ''))
    # devices the car's configuration names (smartx:<device>), and the audio manager's names of our kind
    for c in conf:
        for f in [c] + [os.path.join(c, n) for n in listing(c)]:
            text = small(f, 4 << 20)
            for m in re.finditer(rb'smartx:([A-Za-z0-9_]{2,64})', text):
                dev = m.group(1).decode('ascii')
                add(dev, 1)
                words = [w.decode('ascii') for w in re.findall(rb'["\'>]([A-Za-z][A-Za-z0-9_.-]{3,48})["\'<]', text[max(0, m.start() - 600):m.start()])]
                got = near.setdefault(dev, [])
                for w in words[-5:]:
                    if w not in got and w != dev and not re.match(r'^(plug|smartx|true|false|alsa|default)$', w, re.I) and len(got) < 8:
                        got.append(w)
    # (the audio manager's names are not devices: on the car none of them opened)
    res['conf'] = sorted(names, key=lambda n: (-names[n], n))[:160]
    res['map'] = ['%s: %s' % (n, ', '.join(near[n])) for n in sorted(near) if near[n]][:60]

    def ours(n):
        # (a device whose name says nothing but which the configuration gives to a player of ours counts too)
        return (OURS.search(n) or any(re.search(r'oap|dynamic|online', w, re.I) for w in near.get(n, []))) and not NOT_OURS.search(n) and not THEIRS.search(n)

    def rank(n):
        return score(n) + (30 if any(re.search(r'oap.?generic|dynamic', w, re.I) for w in near.get(n, [])) else 0)
    # those the router surely has first, then by how much the name is ours
    cands = sorted([n for n in names if ours(n)], key=lambda n: (-names[n], -rank(n)))[:24]
    for n in cands:
        d = {'name': 'plug:smartx:' + n, 'sure': names[n]}
        if n in held:
            d['held'] = held[n]
        res['devices'].append(d)
    res['others'] = ['plug:smartx:' + n for n in sorted(names) if names[n] == 2 and n not in cands and n not in held
                     and not NOT_OURS.search(n) and not THEIRS.search(n)][:32]
    if not cands:
        res['notes'].append('no device of the router is named like ours (oap, generic, dynamic, online, media)')
    if not res['shm']:
        res['notes'].append('no buffer of the router in ' + opt['--shm'])
    try:
        res['plumbing'] = plumbing(opt['--shm'], opt['--proc'], conf, opt['--asound'])
    except Exception as e:            # (never the probe's end)
        res['notes'].append('the plumbing could not be read: %r' % (e,))
    sys.stdout.write(json.dumps(res))
    return 0


# ---------------------------------------------------------------- does a device take samples as time passes

class Flow:
    """What a device has taken, noted ten times a second: its pace lately (the last 0.6 s or so) against real time.
    The car connects a source a moment after it is asked to, so the pace at the end counts, not the average."""

    def __init__(self, rate):
        self.rate = rate
        self.marks = []            # (when, frames gone from the device)

    def note(self, now, gone):
        if not self.marks or now - self.marks[-1][0] >= 0.1:
            self.marks.append((now, gone))
            if len(self.marks) > 200:
                del self.marks[:100]

    def late(self, now, gone):
        """Frames gone per frame of real time over the last 0.5 to 0.7 s; None before that much is known."""
        for t, g in self.marks:
            if now - t <= 0.7:
                return (gone - g) / (self.rate * (now - t)) if now - t >= 0.5 else None
        return None


# ---------------------------------------------------------------- scan

def scan_one(alsa, name, ms, out):
    """In a process of its own: silence to one device for ms, what it took. Each step is said to `out` first, so a
    step the router never answers is known."""
    def tell(o):
        os.write(out, (json.dumps(o, separators=(',', ':')) + '\n').encode('utf8'))
    guard = Guard(lambda why: tell({'error': why}))
    rate, ch = 48000, 2
    tell({'step': 'open'})
    try:
        pcm, buf, per = alsa.open(name, guard, rate, ch)
    except OSError as e:
        tell({'done': True, 'open': False, 'error': e.strerror or str(e)})
        return
    tell({'step': 'write', 'buffer': buf})
    zero = bytes(1024 * 2 * ch)
    took, t0, t_first, fast, err = 0, time.monotonic(), None, 0, None
    flow = Flow(rate)

    def gone():
        fill = alsa.fill(pcm, buf)
        return max(0, took - (fill if fill is not None else min(took, buf)))
    while time.monotonic() - t0 < ms / 1000.0:
        now = time.monotonic()
        flow.note(now, gone())
        if t_first is not None and took - (now - t_first) * rate > buf + rate * 0.25:
            fast += 1                       # it swallows them: no further ahead of time than that
            time.sleep(0.02)
            continue
        n = alsa.a.snd_pcm_writei(pcm, zero, 1024)
        if n > 0:
            took += n
            if t_first is None:
                t_first = now
                tell({'step': 'start'})
                alsa.started(pcm, guard, name)
                tell({'step': 'write'})
            continue
        if n == -errno.EAGAIN or n == 0:
            alsa.a.snd_pcm_wait(pcm, 20)
            time.sleep(0.004)
            continue
        err = alsa.err(n)
        break
    now = time.monotonic()
    t = max(0.2, now - (t_first if t_first is not None else t0))
    g = gone()
    late = flow.late(now, g)
    ratio = round(g / (rate * t), 2)
    res = {'done': True, 'open': True, 'buffer': buf, 'period': per, 'took': took, 'ratio': ratio, 'late': round(late, 2) if late is not None else ratio,
           'verdict': 'fast' if fast >= 3 else 'flows' if (late if late is not None else ratio) >= 0.6 else 'stalls'}
    if err:
        res['error'] = 'writing failed: ' + err
        res['verdict'] = 'stalls'
    tell({'step': 'close'})
    alsa.close(pcm, guard)
    tell(res)


def scan(argv):
    opt = {'--devices': '[]', '--ms': '1500', '--alsa-lib': None}
    options(argv, opt)
    try:
        names = [str(n) for n in json.loads(opt['--devices'])][:48]
        ms = max(300, min(10000, int(float(opt['--ms']))))
    except ValueError:
        sys.stdout.write(json.dumps({'error': 'bad arguments'}))
        return 2
    try:
        alsa = Alsa(opt['--alsa-lib'])
    except OSError as e:
        sys.stdout.write(json.dumps({'error': 'libasound could not be loaded: %s' % e}))
        return 0
    kids = []
    sys.stdout.flush()
    for name in names:
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:
            code = 0
            try:
                os.close(r)
                for k in kids:
                    os.close(k['r'])
                scan_one(alsa, name, ms, w)
            except BaseException as e:    # whatever it is, it is this device's answer
                try:
                    os.write(w, (json.dumps({'error': 'the scan failed: %r' % (e,)}) + '\n').encode('utf8'))
                except OSError:
                    pass
                code = 1
            os._exit(code)
        os.close(w)
        kids.append({'name': name, 'pid': pid, 'r': r, 'buf': b'', 'last': {}, 'res': None, 'err': None, 'alive': True})
    end = time.monotonic() + ms / 1000.0 + 9
    while any(k['alive'] for k in kids):
        left = end - time.monotonic()
        live = [k for k in kids if k['alive']]
        if left <= 0:
            for k in live:                       # the router never answered this one's step
                try:
                    os.kill(k['pid'], signal.SIGKILL)
                except OSError:
                    pass
                k['err'] = k['err'] or 'the car\'s audio router did not answer (%s)' % k['last'].get('step', 'start')
                k['alive'] = False
            break
        ready, _, _ = select.select([k['r'] for k in live], [], [], min(left, 0.5))
        for k in live:
            if k['r'] not in ready:
                continue
            data = os.read(k['r'], 65536)
            if not data:
                k['alive'] = False
                continue
            k['buf'] += data
            while b'\n' in k['buf']:
                line, k['buf'] = k['buf'].split(b'\n', 1)
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get('done'):
                    k['res'] = o
                elif 'error' in o:
                    k['err'] = o['error']
                else:
                    k['last'] = o
    out = []
    for k in kids:
        try:
            os.close(k['r'])
        except OSError:
            pass
        try:
            _, status = os.waitpid(k['pid'], 0)
        except OSError:
            status = 0
        d = {'name': k['name']}
        if k['res']:
            d.update({x: k['res'][x] for x in k['res'] if x != 'done'})
        else:
            d['open'] = False
            sig = os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0
            d['error'] = k['err'] or ('the router\'s plugin ended this process (signal %d) at "%s"' % (sig, k['last'].get('step', 'start')) if sig
                                      else 'no answer at "%s"' % k['last'].get('step', 'start'))
        out.append(d)
    sys.stdout.write(json.dumps({'devices': out, 'ms': ms}))
    return 0


# ---------------------------------------------------------------- play

class Player:
    def __init__(self, alsa, device, decoder, setuid):
        self.alsa, self.device, self.decoder, self.setuid = alsa, device, decoder, setuid
        self.guard = Guard(lambda why: say({'ev': 'error', 'msg': why}))
        self.pcm = None
        self.fmt = None            # (rate, channels) the device is set to
        self.buffer = 0
        self.proc = None
        self.file = None
        self.playing = False
        self.base_ms = 0           # the decoder's start, on the file's clock
        self.written = 0           # frames handed to the device since
        self.total_ms = 0
        self.pos_ms = 0            # where a pause left it
        self.pending = b''
        self.eof = False
        self.judged = False
        self.t_first = None
        self.t_start = time.monotonic()
        self.last_ok = None
        self.fast = 0
        self.last_time = 0.0
        self.opens = 0
        self.spin = 0
        self.flow = None
        self.again = None          # after a resume: the measure of whether it flows again

    # -- the decoder
    def stop_decoder(self):
        p, self.proc = self.proc, None
        if p:
            try:
                p.kill()
            except OSError:
                pass
            try:
                p.stdout.close()
                p.stderr.close()
                p.wait(timeout=2)
            except Exception:
                pass
        self.pending = b''

    def open_device(self, rate, ch):
        self.close_device()
        try:
            self.pcm, self.buffer, period = self.alsa.open(self.device, self.guard, rate, ch)
        except OSError as e:
            raise RuntimeError('cannot open %s: %s' % (self.device, e.strerror or e))
        self.opens += 1
        first = self.fmt is None
        self.fmt = (rate, ch)
        if first:
            say({'ev': 'open', 'device': self.device, 'rate': rate, 'channels': ch, 'buffer': self.buffer, 'period': period})

    def close_device(self):
        pcm, self.pcm = self.pcm, None
        if pcm is not None:
            self.alsa.close(pcm, self.guard)

    def start(self, file, ms):
        """The decoder from ms of file, the device open for its format. A device that has played is not set up again
        (see the top of this file): the little it still holds plays out, then come the new samples."""
        self.stop_decoder()
        self.file = file
        kw = {}
        if self.setuid and os.geteuid() == 0:
            kw = {'user': 65534, 'group': 65534, 'extra_groups': []}
        try:
            # (unbuffered: the header line is read from the pipe itself, so no sample is left behind in a buffer)
            self.proc = subprocess.Popen([self.decoder, '--file', file, '--start-ms', str(int(ms))], stdin=subprocess.DEVNULL, bufsize=0,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True, cwd='/', env={}, **kw)
        except OSError as e:
            raise RuntimeError('the decoder could not be started: %s' % e)
        line = self.proc.stdout.readline()
        try:
            h = json.loads(line)
            rate, ch = int(h['rate']), int(h['channels'])
        except Exception:
            errs = b''
            try:
                self.proc.wait(timeout=2)
                errs = self.proc.stderr.read(400)
            except Exception:
                pass
            raise RuntimeError('the decoder refused the file: %s' % (errs.decode('utf8', 'replace').strip() or 'no header'))
        if not (8000 <= rate <= 192000 and 1 <= ch <= 8):
            raise RuntimeError('the decoder says %d Hz, %d channels' % (rate, ch))
        self.total_ms = int(h.get('total_ms') or 0)
        self.base_ms = int(h.get('start_ms') or 0)
        if self.pcm is None or self.fmt != (rate, ch):
            self.open_device(rate, ch)
        if not self.judged:
            self.flow = Flow(rate)
        self.written = 0
        self.eof = False
        self.pending = b''
        self.t_first = None if not self.judged else time.monotonic()
        self.t_start = time.monotonic()
        self.last_ok = time.monotonic()
        self.fast = 0
        self.playing = True

    # -- where it is
    def held(self):
        """Frames of ours the device has not played yet."""
        f = self.alsa.fill(self.pcm, self.buffer) if self.pcm is not None else 0
        return min(self.written, f or 0)

    def elapsed(self):
        if not self.playing or not self.fmt:
            return self.pos_ms
        return self.base_ms + max(0, self.written - self.held()) * 1000 // self.fmt[0]

    def tell(self, force=False):
        now = time.monotonic()
        if force or now - self.last_time >= 0.25:
            self.last_time = now
            say({'ev': 'time', 'elapsed': int(self.elapsed()), 'total': self.total_ms})

    # -- commands
    def pause(self):
        if not self.playing:
            return
        # (what the device still holds plays out: a fifth of a second at most)
        self.pos_ms = self.base_ms + self.written * 1000 // self.fmt[0]
        if self.total_ms:
            self.pos_ms = min(self.pos_ms, self.total_ms)
        self.playing = False
        self.stop_decoder()
        if self.again is not None:
            self.again = None
            say({'ev': 'resumed', 'ok': False})
        say({'ev': 'state', 'state': 'PLAYER_STATE_STOP'})

    def resume(self):
        if self.playing or self.file is None:
            say({'ev': 'resumed', 'ok': self.playing})
            return
        self.start(self.file, self.pos_ms)
        self.again = Flow(self.fmt[0])
        say({'ev': 'state', 'state': 'PLAYER_STATE_PLAY'})

    def rejudge(self):
        """After a resume: does the device take the samples again? Said once, within 2.5 s."""
        if self.again is None or not self.playing:
            return
        now = time.monotonic()
        t = now - self.t_start
        gone = max(0, self.written - self.held())
        self.again.note(now, gone)
        late = self.again.late(now, gone)
        ended = self.eof and not self.pending
        if (late is not None and late >= 0.6) or (ended and self.held() == 0):
            ok = True
        elif t >= 2.5 or ended:
            ok = False
        else:
            return
        self.again = None
        say({'ev': 'resumed', 'ok': ok})

    def seek(self, ms):
        ms = max(0, int(ms))
        if self.total_ms:
            ms = min(ms, self.total_ms)
        self.pos_ms = ms
        if self.playing:
            self.start(self.file, ms)
            self.tell(True)

    def command(self, line):
        m = re.match(r'^\s*(\w+)\s*(.*?)\s*$', line)
        if not m:
            return True
        c, arg = m.group(1), m.group(2)
        if c == 'quit':
            return False
        if c == 'pause':
            self.pause()
        elif c == 'resume':
            self.resume()
        elif c == 'seek':
            try:
                self.seek(int(float(arg)))
            except ValueError:
                pass
        elif c == 'file':
            at = 0
            m = re.match(r'^(".*")\s+(\d+)$', arg)
            if m:
                arg, at = m.group(1), int(m.group(2))
            try:
                path = json.loads(arg)
            except ValueError:
                path = arg
            self.pos_ms = at
            self.start(str(path), at)
            say({'ev': 'state', 'state': 'PLAYER_STATE_PLAY'})
        return True

    # -- the samples
    def pump(self):
        """One step: some samples from the decoder to the device. Returns how long the caller may sleep."""
        rate, ch = self.fmt
        fb = 2 * ch
        if len(self.pending) < fb and not self.eof:
            r, _, _ = select.select([self.proc.stdout], [], [], 0.05)
            if r:
                chunk = os.read(self.proc.stdout.fileno(), 16384)
                if chunk:
                    self.pending += chunk
                else:
                    self.eof = True
        frames = len(self.pending) // fb
        now = time.monotonic()
        if frames:
            # never further ahead of time than the buffer and half a second: a device that swallows everything
            # (nothing plays it) would otherwise get the whole file at once
            if self.t_first is not None:
                ahead = self.written - (now - self.t_first) * rate
                if ahead > self.buffer + rate * 0.5:
                    self.fast += 1
                    return 0.05
            n = self.alsa.a.snd_pcm_writei(self.pcm, self.pending, frames)
            if n > 0:
                if self.t_first is None:
                    self.t_first = now
                self.last_ok = now
                self.spin = 0
                self.written += n
                self.pending = self.pending[n * fb:]
                r = self.alsa.started(self.pcm, self.guard, self.device)
                if r < 0:
                    raise RuntimeError('%s did not start: %s' % (self.device, self.alsa.err(r)))
                return 0
            if n == -errno.EAGAIN or n == 0:
                # after it flowed, a device that takes nothing for 3 s lost its connection (another source took the
                # car's sound): held like a pause, for a resume to start again
                if self.judged and now - self.last_ok > 3:
                    self.pause()
                    return 0.1
                # the router wakes us when it has read (its devices hold little: a few periods, tens of milliseconds -
                # the next samples must follow at once). A wait that returns at once while nothing is taken would
                # turn in circles: then, and only then, a short sleep.
                t = time.monotonic()
                self.alsa.a.snd_pcm_wait(self.pcm, 50)
                self.spin = self.spin + 1 if time.monotonic() - t < 0.001 else 0
                return 0.003 if self.spin >= 3 else 0
            # the stream broke: the device is opened anew (a broken one is not mended in place), a few times at most
            if self.opens > 4:
                raise RuntimeError('writing to %s failed: %s' % (self.device, self.alsa.err(n)))
            self.open_device(rate, ch)
            return 0.05
        if self.eof:
            # the device plays out what it holds, then the end is said
            if self.held() > 0 and now - self.last_ok < 3:
                return 0.05
            self.pos_ms = self.total_ms or self.elapsed()
            self.playing = False
            self.stop_decoder()
            say({'ev': 'time', 'elapsed': int(self.pos_ms), 'total': self.total_ms})
            say({'ev': 'eof'})
            say({'ev': 'state', 'state': 'PLAYER_STATE_STOP'})
        return 0.02

    def judge(self):
        """Once: does the device take the samples as time passes? Said as soon as it has for half a second (a second
        in at the earliest: the car connects a source a moment after it is asked to); 4 s in, it does not."""
        if self.judged:
            return True
        now = time.monotonic()
        if self.t_first is None:
            if now - self.t_start > 4:        # (it took not one sample)
                self.judged = True
                say({'ev': 'flow', 'verdict': 'stalls', 'ratio': 0})
                return False
            return True
        t = now - self.t_first
        gone = max(0, self.written - self.held())
        self.flow.note(now, gone)
        late = self.flow.late(now, gone)
        ended = self.eof and not self.pending
        if t >= 1 and self.fast >= 3:
            verdict = 'fast'
        elif (t >= 1 and late is not None and late >= 0.6) or (ended and self.held() == 0):
            verdict = 'flows'
        elif t >= 4 or ended:
            verdict = 'stalls'
        else:
            return True
        self.judged = True
        say({'ev': 'flow', 'verdict': verdict, 'ratio': round(late if late is not None else gone / (self.fmt[0] * max(t, 0.2)), 2)})
        if verdict != 'flows':
            return False
        say({'ev': 'state', 'state': 'PLAYER_STATE_PLAY'})
        return True

    def close(self):
        self.stop_decoder()
        self.close_device()


def play(argv):
    opt = {'--device': None, '--decoder': None, '--file': None, '--start-ms': '0', '--alsa-lib': None, '--no-setuid': False}
    rest = options(argv, opt, flags=('--no-setuid',))
    if rest:
        say({'ev': 'error', 'msg': 'bad argument ' + rest[0]})
        return 2
    if not (opt['--device'] and opt['--decoder'] and opt['--file']):
        say({'ev': 'error', 'msg': 'usage: play --device NAME --decoder YTAUD --file AUDIO.m4a [--start-ms N]'})
        return 2
    try:
        alsa = Alsa(opt['--alsa-lib'])
    except OSError as e:
        say({'ev': 'error', 'msg': 'libasound could not be loaded: %s' % e})
        return 3
    # (the picture's decoder works beside us: the sound goes first)
    try:
        os.setpriority(os.PRIO_PROCESS, 0, -12)
    except (OSError, AttributeError):
        pass
    p = Player(alsa, opt['--device'], opt['--decoder'], not opt['--no-setuid'])
    buf = b''
    try:
        p.start(opt['--file'], int(float(opt['--start-ms'])))
        while True:
            wait = 0.2
            if p.playing:
                wait = p.pump()
                if not p.judge():
                    return 0
                p.rejudge()
                if p.playing:
                    p.tell()
            r, _, _ = select.select([0], [], [], wait)
            if r:
                data = os.read(0, 4096)
                if not data:
                    return 0                         # the service went away: so do we
                buf += data
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    if not p.command(line.decode('utf8', 'replace')):
                        return 0
    except RuntimeError as e:
        say({'ev': 'error', 'msg': str(e)})
        return 3
    finally:
        p.close()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    # no dump of this process's memory when the router's plugin ends it (it calls abort() on what it does not expect)
    try:
        ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)        # PR_SET_DUMPABLE, 0
    except Exception:
        pass
    if mode == 'probe':
        return probe(sys.argv[2:])
    if mode == 'scan':
        return scan(sys.argv[2:])
    if mode == 'play':
        return play(sys.argv[2:])
    sys.stderr.write('usage: ytalsa.py probe | scan --devices JSON [--ms N] | play --device NAME --decoder YTAUD --file AUDIO.m4a [--start-ms N]\n')
    return 2


if __name__ == '__main__':
    sys.exit(main())
