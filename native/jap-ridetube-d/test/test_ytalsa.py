#!/usr/bin/env python3
"""Host test of ytalsa.py against a stand-in libasound (fake_asound.c, built here with the C compiler) and a
stand-in decoder that writes samples numbered by their place, so what reaches the device can be checked.
    python3 test/test_ytalsa.py
Standard library only; needs cc."""
import array
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

here = os.path.dirname(os.path.abspath(__file__))
ytalsa = os.path.join(here, '..', 'ytalsa.py')
fails = []


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else ' :: ' + str(detail)[:900]))
    if not ok:
        fails.append(name)


tmp = tempfile.mkdtemp(prefix='ytalsa-')
lib = os.path.join(tmp, 'libfakeasound.so')
subprocess.run([os.environ.get('CC', 'cc'), '-O1', '-shared', '-fPIC', '-o', lib, os.path.join(here, 'fake_asound.c')], check=True)
# the stand-in decoder: 8000 Hz mono, 4 s; sample i's value is i % 30000; --start-ms as ytaud
dec = os.path.join(tmp, 'fakedec.py')
open(dec, 'w').write('''#!%s
import sys, json, array, os
a = sys.argv
ms = int(a[a.index('--start-ms') + 1]) if '--start-ms' in a else 0
f = a[a.index('--file') + 1]
if 'refuse' in f:
    sys.stderr.write('ytaud: not a file of ours: no sound track\\n'); sys.exit(2)
total = 1500 if 'short' in f else 4000
ms = min(ms, total)
hi = 'hi48' in f                      # 48 kHz stereo, as the car's devices run
first, last = ms * (48 if hi else 8), total * (48 if hi else 8)
x = array.array('h', [(i %% 30000) for i in range(first, last) for _ in range(2 if hi else 1)])
try:
    # (the header and the first samples in one write, as a program's buffered stdout sends them)
    b = (json.dumps({'rate': 48000 if hi else 8000, 'channels': 2 if hi else 1, 'total_ms': total, 'start_ms': ms}) + '\\n').encode() + x.tobytes()
    while b:
        b = b[os.write(1, b):]
except OSError:
    pass
''' % sys.executable)
os.chmod(dec, 0o755)
out_base = os.path.join(tmp, 'out')
log = os.path.join(tmp, 'alsa.log')


class Run:
    def __init__(self, device, file='a.m4a', start=0, env=None, alsa=None):
        e = dict(os.environ, FAKE_ASOUND_OUT=out_base, FAKE_ASOUND_LOG=log)
        e.update(env or {})
        self.p = subprocess.Popen([sys.executable, '-I', ytalsa, 'play', '--device', device, '--decoder', dec, '--file', os.path.join(tmp, file),
                                   '--start-ms', str(start), '--no-setuid', '--alsa-lib', alsa or lib], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=e, bufsize=0)
        self.evs = []
        self.t = threading.Thread(target=self.read, daemon=True)
        self.t.start()

    def read(self):
        for line in self.p.stdout:
            try:
                self.evs.append(json.loads(line))
            except ValueError:
                self.evs.append({'ev': 'garbage', 'line': line})

    def wait(self, pred, secs=6):
        end = time.time() + secs
        while time.time() < end:
            for e in list(self.evs):
                if pred(e):
                    return e
            time.sleep(0.02)
        return None

    def send(self, line):
        self.p.stdin.write((line + '\n').encode())
        self.p.stdin.flush()

    def end(self):
        try:
            self.send('quit')
        except OSError:
            pass
        try:
            return self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.p.kill()
            return 'killed'

    def times(self):
        return [e['elapsed'] for e in self.evs if e.get('ev') == 'time']


def written(device):
    try:
        a = array.array('h')
        a.frombytes(open(out_base + '.' + device.replace(':', '_'), 'rb').read())
        return a
    except OSError:
        return array.array('h')


# ---- play on a device that plays
r = Run('plug:smartx:OAPMedia_clocked')
o = r.wait(lambda e: e['ev'] == 'open')
f = r.wait(lambda e: e['ev'] == 'flow')
check('a device that takes the samples as time passes: open, then "flows" a second in', o == {'ev': 'open', 'device': 'plug:smartx:OAPMedia_clocked', 'rate': 8000, 'channels': 1, 'buffer': 1600, 'period': 400}
      and f and f['verdict'] == 'flows' and 0.6 <= f['ratio'] <= 1.6, (o, f, r.evs[:6], r.p.stderr.read1(500) if not o else ''))
w0 = written('plug:smartx:OAPMedia_clocked')
calls0 = open(log).read().split('\n')
check('opened blocking (a non-blocking open tells the router not to read it), written to without blocking, and started with the first samples',
      calls0[:2] == ['open plug:smartx:OAPMedia_clocked', 'nonblock plug:smartx:OAPMedia_clocked'] and calls0[2].startswith('start') and calls0[2].endswith(' plug:smartx:OAPMedia_clocked'), calls0[:4])
check('the device gets the decoder\'s samples from the very first one', len(w0) > 8000 and list(w0[:5]) == [0, 1, 2, 3, 4] and all(w0[i] == i % 30000 for i in range(0, len(w0), 97)), list(w0[:8]))
check('then it says it plays, and the time four times a second, on the file\'s clock', r.wait(lambda e: e == {'ev': 'state', 'state': 'PLAYER_STATE_PLAY'}) is not None and r.wait(lambda e: e['ev'] == 'time' and e['total'] == 4000 and e['elapsed'] > 1500))
t0 = time.time()
r.send('pause')
check('pause: said, the place kept', r.wait(lambda e: e == {'ev': 'state', 'state': 'PLAYER_STATE_STOP'}) is not None)
at = r.times()[-1]
n_before = len(written('plug:smartx:OAPMedia_clocked'))
time.sleep(0.5)
check('while paused nothing more goes to the device', len(written('plug:smartx:OAPMedia_clocked')) == n_before and 1400 < at < 2600, (at, n_before))
r.evs.clear()
r.send('resume')
check('resume: it plays on from there', r.wait(lambda e: e == {'ev': 'state', 'state': 'PLAYER_STATE_PLAY'}) is not None and r.wait(lambda e: e['ev'] == 'time' and at - 50 <= e['elapsed'] <= at + 900) is not None, (at, r.evs[:5]))
check('  ... and says that the device takes the samples again', r.wait(lambda e: e == {'ev': 'resumed', 'ok': True}, 4) is not None, r.evs[:8])
w = written('plug:smartx:OAPMedia_clocked')
# what the device held at the pause played out: the samples after it are the very next ones (to the millisecond)
nxt = w[n_before]
check('the samples after the pause are the very next ones: nothing lost, nothing twice', 0 <= n_before - nxt < 8, (nxt, n_before))
r.evs.clear()
r.send('seek 3000')
check('seek: the time jumps there and goes on', r.wait(lambda e: e['ev'] == 'time' and 3000 <= e['elapsed'] < 3400) is not None, r.evs[:4])
e = r.wait(lambda e: e['ev'] == 'eof', 5)
check('the end of the file: played out, then eof and the stop', e is not None and r.wait(lambda e: e == {'ev': 'state', 'state': 'PLAYER_STATE_STOP'}) is not None and r.times()[-1] == 4000, r.evs[-4:])
r.evs.clear()
r.send('file ' + json.dumps(os.path.join(tmp, 'b short.m4a')))
check('another file: from its start, with its own length', r.wait(lambda e: e == {'ev': 'state', 'state': 'PLAYER_STATE_PLAY'}) is not None and r.wait(lambda e: e['ev'] == 'time' and e['total'] == 1500 and e['elapsed'] < 600) is not None, r.evs[:5])
n0 = len(written('plug:smartx:OAPMedia_clocked'))
r.evs.clear()
r.send('file ' + json.dumps(os.path.join(tmp, 'c whole.m4a')) + ' 2000')
check('another file from a place in it (the whole file after the first seconds): it goes on there, not at its start',
      r.wait(lambda e: e['ev'] == 'time' and e['total'] == 4000 and 2000 <= e['elapsed'] < 2500) is not None and written('plug:smartx:OAPMedia_clocked')[n0] == 16000, (r.evs[:4], list(written('plug:smartx:OAPMedia_clocked')[n0:n0 + 3])))
r.send('seek 99999')
check('a seek past the end ends it', r.wait(lambda e: e['ev'] == 'eof', 4) is not None)
check('quit: gone, the stream stopped and the device closed', r.end() == 0 and open(log).read().strip().split('\n')[-2:] == ['drop plug:smartx:OAPMedia_clocked', 'close plug:smartx:OAPMedia_clocked'], open(log).read()[-200:])
check('pause, resume, seek, the end and another file on one stream: the device was opened once and never prepared again', open(log).read().count('open ') == 1 and 'prepare' not in open(log).read(), open(log).read())

# ---- devices nothing plays
for dev, verdict in (('plug:smartx:Dyn_stall', 'stalls'), ('plug:smartx:Dyn_fast', 'fast')):
    r = Run(dev)
    f = r.wait(lambda e: e['ev'] == 'flow', 6)
    code = r.p.wait(timeout=5)
    check('a device that ' + ('takes no samples once its buffer is full' if verdict == 'stalls' else 'swallows the samples faster than time') + ': "' + verdict + '", and it ends',
          f and f['verdict'] == verdict and code == 0 and not any(e.get('ev') == 'state' for e in r.evs), (f, code, r.evs))
    n = len(written(dev))
    check('  ... having sent no more than a moment of sound', n <= 8000 * 3.5, n)

# ---- a device whose connection is taken away after it flowed
r = Run('plug:smartx:OAPMedia_clocked_lose', env={'FAKE_ASOUND_LOSE_AFTER': '2.2'})
check('a device that stops taking samples after it flowed: held like a pause (a resume starts again)', r.wait(lambda e: e['ev'] == 'flow' and e['verdict'] == 'flows') is not None
      and r.wait(lambda e: e == {'ev': 'state', 'state': 'PLAYER_STATE_STOP'}, 9) is not None and r.p.poll() is None, r.evs[-5:])
r.evs.clear()
r.send('resume')
check('  ... a resume while the car still gives its sound to another source: said within seconds ("resumed", not ok), so its way can be asked for anew',
      r.wait(lambda e: e == {'ev': 'resumed', 'ok': False}, 5) is not None, r.evs[:8])
r.end()

# ---- failures
r = Run('plug:smartx:Nothing')
e = r.wait(lambda e: e['ev'] == 'error')
check('a device that does not exist: said, exit 3', e and 'cannot open plug:smartx:Nothing: No such file or directory' in e['msg'] and r.p.wait(timeout=5) == 3, (e, r.evs))
r = Run('plug:smartx:X_busy')
e = r.wait(lambda e: e['ev'] == 'error')
check('a device in use: said', e and 'busy' in e['msg'].lower(), e)
r.p.wait(timeout=5)
r = Run('plug:smartx:X_nofmt')
e = r.wait(lambda e: e['ev'] == 'error')
check('a device that takes no such sound: said', e and 'takes no 8000 Hz 1-channel sound' in e['msg'], e)
r.p.wait(timeout=5)
r = Run('plug:smartx:X_hang')
t0 = time.time()
e = r.wait(lambda e: e['ev'] == 'error', 12)
check('a device the router never answers for: said within seconds, and it ends (the plugin itself would wait for ever)', e and 'the car\'s audio router did not answer (setting up plug:smartx:X_hang)' in e['msg']
      and r.p.wait(timeout=5) == 3 and time.time() - t0 < 10, (e, time.time() - t0))
r = Run('plug:smartx:Left_stopread_clocked')
f = r.wait(lambda e: e['ev'] == 'flow', 8)
check('a device another program left "not read until started": our start makes the router read it', f and f['verdict'] == 'flows', (f, r.evs))
r.end()
# the router's own devices hold a few periods only (16 ms at 48 kHz): the samples must follow as fast as it reads them
open(log, 'w').close()
r = Run('plug:smartx:Small_tiny_clocked', file='hi48.m4a')
o = r.wait(lambda e: e['ev'] == 'open')
f = r.wait(lambda e: e['ev'] == 'flow', 8)
r.wait(lambda e: e['ev'] == 'time' and e['elapsed'] > 3000, 8)
r.end()
starved = [int(l.split()[1]) for l in open(log).read().split('\n') if l.startswith('starved ')]
print('     (a 16 ms buffer at 48 kHz stereo: the router waited for %s frames in 3 s)' % (starved[0] if starved else '?'))
# (a machine busy with other work may leave it waiting a moment; a player that cannot keep up would for seconds)
check('a device with the router\'s small buffer (4 periods of 192 frames, 16 ms): flows, and the samples follow as fast as the router reads them',
      o and o['buffer'] == 768 and o['rate'] == 48000 and f and f['verdict'] == 'flows' and starved and starved[0] < 48000 * 0.5, (o, f, starved))
late = os.path.join(tmp, 'late-connected')
r = Run('plug:smartx:Late_onconnect', env={'FAKE_ASOUND_CONNECT': late})
r.wait(lambda e: e['ev'] == 'open')
time.sleep(1.6)
open(late, 'w').write('Late\n')
f = r.wait(lambda e: e['ev'] == 'flow', 6)
check('the player on a device the car connects 1.6 s late: it waits for it and says "flows" (4 s in it would have said "stalls")', f and f['verdict'] == 'flows' and 0.6 <= f['ratio'] <= 1.6, (f, r.evs))
wl = written('plug:smartx:Late_onconnect')
check('  ... and nothing of the file was skipped while it waited', len(wl) > 1600 and all(wl[i] == i % 30000 for i in range(0, len(wl), 53)), len(wl))
r.end()
flag = os.path.join(tmp, 'epipe.flag')
open(log, 'w').close()
r = Run('plug:smartx:Brk_clocked', env={'FAKE_ASOUND_EPIPE_AFTER': '12000', 'FAKE_ASOUND_EPIPE_FLAG': flag})
r.wait(lambda e: e['ev'] == 'time' and e['elapsed'] > 2600, 8)
r.end()
wb = written('plug:smartx:Brk_clocked')
check('a stream that breaks: the device is opened anew and the play goes on with the very next samples', open(log).read().count('open plug:smartx:Brk_clocked') == 2 and 'epipe' in open(log).read()
      and len(wb) > 20000 and all(wb[i] == i % 30000 for i in range(0, len(wb), 89)) and not any(e['ev'] == 'error' for e in r.evs), (open(log).read(), len(wb), r.evs[-3:]))
r = Run('plug:smartx:OAPMedia_clocked', file='refuse.m4a')
e = r.wait(lambda e: e['ev'] == 'error')
check('a file the decoder refuses: its own words', e and 'the decoder refused the file: ytaud: not a file of ours: no sound track' in e['msg'] and r.p.wait(timeout=5) == 3, e)
r = Run('plug:smartx:OAPMedia_clocked')
r.wait(lambda e: e['ev'] == 'open')
r.p.stdin.close()
check('the service gone (stdin closed): it ends by itself', r.p.wait(timeout=5) == 0)

# ---- probe: the router's devices from the car's files; nothing is opened
shm, run, conf, am = (os.path.join(tmp, n) for n in ('shm', 'run', 'conf', 'am'))
for d in (shm, run, conf, am):
    os.mkdir(d)
for n in ('smartx_OAPMedia_clocked_p_ringbuffer', 'smartx_Dynamic_stall_p', 'smartx_Mic_c_ringbuffer', 'smartx_Entertainment_clocked_p_ringbuffer', 'smartx_TelRing_Outband_CF_24_MONO_p_ringbuffer', 'other',
          'smartx_Out3_CF_48_STEREO_p_ringbuffer', 'smartx_CarPlayMain_CF_48_STEREO_p_ringbuffer', 'smartx_PDC_Front_p_ringbuffer', 'smartx_Zone1_p_ringbuffer', 'smartx_Zone1_c_ringbuffer',
          # (as on the car: other sources' media devices, and the call and speech devices - none of them ours, none to be touched)
          'smartx_CarLifeMedia_CF_48_STEREO_p_ringbuffer', 'smartx_AndroidAutoMedia_CF_48_STEREO_p_ringbuffer', 'smartx_Voip_Physical_Source_CF_24_MONO_p_ringbuffer',
          'smartx_eSimCallSource_CF_24_MONO_p_ringbuffer', 'smartx_Nuance_physical_Source_CF_24_MONO_p_ringbuffer', 'avb_Amp_Front_p_ringbuffer'):
    open(os.path.join(shm, n), 'w').close()
for n in ('smartx_OAPMedia_clocked_p.lock', 'smartx_Entertainment_clocked_p.lock', 'smartx_Mic_c.lock'):
    open(os.path.join(run, n), 'w').close()
# (another program has the entertainment's device open: it holds the lock, as the router's plugin does)
other = subprocess.Popen([sys.executable, '-c', 'import fcntl,sys,time\nf=open(sys.argv[1],"r+")\nfcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint("held",flush=True)\ntime.sleep(60)',
                          os.path.join(run, 'smartx_Entertainment_clocked_p.lock')], stdout=subprocess.PIPE)
other.stdout.readline()
open(os.path.join(conf, 'mediaengine_config_hu.xml'), 'w').write('<player name="OnlineEntertainmentComponent_1"><p dev="plug:smartx:OnlineX_busy"/></player><p dev="smartx:OAPMedia_RSE_L"/>'
                                                              '<player name="OapGenericMedia"><sink rate="48000"><p dev="plug:smartx:Out7_clocked"/></sink></player>')
open(os.path.join(am, 'DOMAIN_MGU.bin'), 'wb').write(b'\x00\x01OAPGenericMedia\x00\x10VOL_OAP_INTERRUPT_MAX\x00DynamicInterrupt\x00Dyn_nofmtDynamic\x00')
proc, asound = os.path.join(tmp, 'proc'), os.path.join(tmp, 'proc', 'asound')
os.makedirs(os.path.join(asound, 'card0', 'pcm3p', 'sub0'))
os.makedirs(os.path.join(asound, 'card0', 'pcm3p', 'sub1'))
os.makedirs(os.path.join(proc, '4103', 'fd'))
open(os.path.join(asound, 'cards'), 'w').write(' 0 [aplmgu         ]: aplmgu - aplmgu\n')
open(os.path.join(asound, 'pcm'), 'w').write('00-03: Media : Media : playback 1\n')
open(os.path.join(asound, 'card0', 'pcm3p', 'sub0', 'status'), 'w').write('state: RUNNING\nowner_pid   : %d\ntrigger_time: 1.2\n' % other.pid)
open(os.path.join(asound, 'card0', 'pcm3p', 'sub0', 'hw_params'), 'w').write('access: RW_INTERLEAVED\nformat: S16_LE\nchannels: 2\nrate: 48000 (48000/1)\n')
open(os.path.join(asound, 'card0', 'pcm3p', 'sub1', 'status'), 'w').write('closed\n')
open(os.path.join(proc, '4103', 'comm'), 'w').write('mediaengine\n')
open(os.path.join(proc, '4103', 'cmdline'), 'w').write('mediaengine\0-c\0/etc/mediaconfig/mediaengine_config_hu.xml\0')
open(os.path.join(proc, '4103', 'maps'), 'w').write('7f00-7f01 rw-s 0 00:13 5 /dev/shm/smartx_Entertainment_clocked_p_ringbuffer\n7f02-7f03 r-xp 0 08:01 9 /usr/lib/libasound.so.2.0.0\n'
                                                       '7f04-7f05 r-xp 0 08:01 9 /usr/lib/alsa-lib/libasound_module_pcm_smartx.so\n7f06-7f07 r-xp 0 08:01 9 /lib/libc.so.6\n')
os.symlink('/dev/snd/pcmC0D3p', os.path.join(proc, '4103', 'fd', '7'))
os.symlink('/dev/snd/timer', os.path.join(proc, '4103', 'fd', '8'))
mc = os.path.join(tmp, 'etc', 'mediaconfig')
os.makedirs(mc)
os.rename(os.path.join(conf, 'mediaengine_config_hu.xml'), os.path.join(mc, 'mediaengine_config_hu.xml'))
ac = os.path.join(tmp, 'etc', 'asound.conf')
open(ac, 'w').write('pcm.entertainment_main {\n  type hw\n  card aplmgu\n  device 3\n}\npcm.dmix { type dmix }\n')
open(log, 'w').close()
p = subprocess.run([sys.executable, '-I', ytalsa, 'probe', '--shm', shm, '--run', run, '--conf', conf, '--conf', mc, '--conf', ac, '--am', am, '--proc', proc, '--asound', asound, '--alsa-lib', lib], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, FAKE_ASOUND_LOG=log))
res = json.loads(p.stdout)
names = [(d['name'], d['sure']) for d in res['devices']]
comm = open('/proc/%d/comm' % other.pid).read().strip()
check('probe: the devices named like ours, those the router surely has first, then the likeliest; the telephone\'s, the microphone\'s, the rear seats\' are not among them',
      names == [('plug:smartx:OAPMedia_clocked', 2), ('plug:smartx:Dynamic_stall', 2), ('plug:smartx:Entertainment_clocked', 2), ('plug:smartx:OnlineX_busy', 1), ('plug:smartx:Out7_clocked', 1)]
      and res['shm'] == sorted(n for n in os.listdir(shm) if n.startswith('smartx')), names)
ent = [d for d in res['devices'] if d['name'] == 'plug:smartx:Entertainment_clocked'][0]
check('  ... who has a device open now is read from the router\'s lock on it (never taken)', ent.get('held') == '%s (%d)' % (comm, other.pid) and not any('held' in d for d in res['devices'] if d is not ent)
      and res['run'] == ['Entertainment_clocked: %s (%d)' % (comm, other.pid), 'OAPMedia_clocked'], (ent, res['run']))
check('  ... which player a configuration gives a device to is read with it: a device with a name that says nothing is found by its player\'s',
      res['map'] == ['OAPMedia_RSE_L: OnlineEntertainmentComponent_1', 'OnlineX_busy: OnlineEntertainmentComponent_1', 'Out7_clocked: OnlineEntertainmentComponent_1, OapGenericMedia'], res['map'])
check('  ... the router\'s other devices - names that say nothing, free, not the telephone\'s, a warning\'s or another source\'s - are listed apart: listened to only when none of ours plays',
      res['others'] == ['plug:smartx:Out3_CF_48_STEREO', 'plug:smartx:Zone1'] and not any(re.search('CarLife|AndroidAuto|Voip|eSim|Nuance', d['name']) for d in res['devices']), (res['others'], res['devices']))
check('  ... and nothing was opened', open(log).read() == '', open(log).read())
# the plumbing: who has what, read from /proc and the configuration
pl = res.get('plumbing') or {}
check('the plumbing: every buffer there is (the amplifier\'s too), the program that has one mapped or a kernel device open, the streams in use, the configuration\'s devices and the media engine\'s words',
      'avb_Amp_Front_p' in pl.get('shm', []) and 'smartx_OAPMedia_clocked_p' in pl['shm']
      and pl['cards'] == ['0 [aplmgu ]: aplmgu - aplmgu'] and pl['pcm'] == ['00-03: Media : Media : playback 1']
      and pl['used'] == ['card0/pcm3p/sub0 RUNNING by %s (%d), 48000 Hz 2 ch' % (comm, other.pid)]
      and pl['snd'] == ['mediaengine (4103): pcmC0D3p'] and pl['maps'] == ['mediaengine (4103): smartx_Entertainment_clocked_p']
      and pl['pcms'] == ['entertainment_main=hw card aplmgu device 3'] and any(w.startswith('plug:smartx:Out7_clocked <- ') and w.endswith('OapGenericMedia') for w in pl['words'])
      and any(w.startswith('[OapGenericMedia in mediaengine_config_hu.xml] OapGenericMedia"><sink rate="48000">') for w in pl['words'])
      and pl['libs'] == ['mediaengine (4103) [mediaengine -c /etc/mediaconfig/mediaengine_config_hu.xml]: libasound, libasound_module_pcm_smartx']
      and pl['files'][0].startswith('mediaengine_config_hu.xml ('), pl)
other.kill()

# ---- scan: silence to every device at once, which of them take it as time passes
connect = os.path.join(tmp, 'connected')
devs = ['plug:smartx:OAPMedia_onconnect', 'plug:smartx:Dynamic_stall', 'plug:smartx:Any_clocked', 'plug:smartx:Left_stopread_clocked', 'plug:smartx:Null_fast',
        'plug:smartx:X_busy', 'plug:smartx:Nothing', 'plug:smartx:X_nofmt', 'plug:smartx:X_hang', 'plug:smartx:X_abort']


def scan(ms=1200, after=None):
    open(log, 'w').close()
    t = time.time()
    q = subprocess.Popen([sys.executable, '-I', ytalsa, 'scan', '--devices', json.dumps(devs), '--ms', str(ms), '--alsa-lib', lib], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=dict(os.environ, FAKE_ASOUND_LOG=log, FAKE_ASOUND_CONNECT=connect))
    if after:
        after()
    q.stdout, q.stderr = q.communicate()
    try:
        return {d['name'].split(':')[-1]: d for d in json.loads(q.stdout)['devices']}, time.time() - t, q
    except ValueError:
        return {}, time.time() - t, q


got, took, q = scan()
verd = {n: (d.get('verdict') if d.get('open') else 'no: ' + str(d.get('error'))) for n, d in got.items()}
check('scan: every device in a process of its own, all at once - what flows, what stalls, what swallows, what does not open', verd == {
    'OAPMedia_onconnect': 'stalls', 'Dynamic_stall': 'stalls', 'Any_clocked': 'flows', 'Left_stopread_clocked': 'flows', 'Null_fast': 'fast',
    'X_busy': 'no: Device or resource busy', 'Nothing': 'no: No such file or directory', 'X_nofmt': 'no: takes no 48000 Hz 2-channel sound: Invalid argument',
    'X_hang': 'no: the car\'s audio router did not answer (setting up plug:smartx:X_hang)', 'X_abort': 'no: the router\'s plugin ended this process (signal 6) at "open"'}, (verd, q.stderr[-300:]))
check('  ... a device the router never answers for costs seconds, not the scan; one whose plugin ends the process costs only itself', took < 9.5 and q.returncode == 0, took)
check('  ... flowing is measured: about real time for one, nothing beyond its buffer for the other', 0.6 <= got['Any_clocked']['ratio'] <= 1.6 and got['Dynamic_stall']['ratio'] == 0
      and got['Dynamic_stall']['took'] == got['Dynamic_stall']['buffer'] == 9600, (got['Any_clocked'], got['Dynamic_stall']))
calls = open(log).read().split('\n')
check('  ... each was stopped and closed again, none prepared twice', all(('drop plug:smartx:' + n) in calls and ('close plug:smartx:' + n) in calls for n in ('OAPMedia_onconnect', 'Dynamic_stall', 'Any_clocked', 'Null_fast'))
      and not any(c.startswith('prepare') for c in calls), calls)
open(connect, 'w').write('OAPMedia\n')
got, took, q = scan()
check('scan again once the car connects our source: its device now flows - that is how ours is told from the others', got['OAPMedia_onconnect'].get('verdict') == 'flows' and got['Dynamic_stall'].get('verdict') == 'stalls', got)
os.unlink(connect)


def late_connect():
    time.sleep(1.9)
    open(connect, 'w').write('OAPMedia\n')


devs = devs[:3]
got, took, q = scan(3000, late_connect)
d = got['OAPMedia_onconnect']
check('a source the car connects a moment after it is asked to: what counts is that its device takes samples at the end of the listening, not on average',
      d.get('verdict') == 'flows' and d['ratio'] < d['late'] and 0.6 <= d['late'] <= 1.6 and got['Dynamic_stall']['verdict'] == 'stalls' and got['Any_clocked']['verdict'] == 'flows', got)
os.unlink(connect)
p = subprocess.run([sys.executable, '-I', ytalsa, 'scan', '--devices', json.dumps(devs[:2]), '--alsa-lib', os.path.join(tmp, 'nolib.so')], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
check('scan without libasound: said in its answer', 'libasound could not be loaded' in json.loads(p.stdout).get('error', ''), p.stdout)

# ---- the real libasound, where this machine has one: its "null" device swallows everything
try:
    import ctypes
    ctypes.CDLL('libasound.so.2')
    r = Run('null', alsa='libasound.so.2')
    f = r.wait(lambda e: e['ev'] == 'flow', 8)
    check('the real libasound\'s "null" device: opened through ctypes, judged "fast"', any(e['ev'] == 'open' for e in r.evs) and f and f['verdict'] == 'fast', r.evs)
    r.end()
except OSError:
    print('skip the real libasound (none here)')

# ---- the whole chain where the real decoder is built (../ytaud/build/ytaud) and ffmpeg is here: a real AAC file, the
# real ytaud, this player, the stand-in device - what reaches the device is what ytaud decodes
real = os.path.join(here, '..', '..', 'ytaud', 'build', 'ytaud')
if os.path.exists(real) and subprocess.run(['sh', '-c', 'command -v ffmpeg'], stdout=subprocess.DEVNULL).returncode == 0:
    import importlib.util
    spec = importlib.util.spec_from_file_location('ytfetch', os.path.join(here, '..', 'ytfetch.py'))
    ytfetch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ytfetch)
    frag, m4a = os.path.join(tmp, 'frag.m4a'), os.path.join(tmp, 'real.m4a')
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6', '-ac', '2', '-c:a', 'aac', '-b:a', '128k',
                    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', frag], check=True)
    ytfetch.flatten_m4a(frag, m4a)
    want = array.array('h')
    want.frombytes(subprocess.run([real, '--file', m4a], stdout=subprocess.PIPE).stdout.split(b'\n', 1)[1])
    dec = real
    r = Run('plug:smartx:Real_clocked', file='real.m4a')
    o = r.wait(lambda e: e['ev'] == 'open')
    f = r.wait(lambda e: e['ev'] == 'flow', 8)
    r.wait(lambda e: e['ev'] == 'time' and e['elapsed'] > 2500, 8)
    r.end()
    got = written('plug:smartx:Real_clocked')
    check('the real decoder through this player: 44100 Hz stereo, flows, and the device gets ytaud\'s very samples',
          o and o['rate'] == 44100 and o['channels'] == 2 and f and f['verdict'] == 'flows' and len(got) > 2 * 44100 * 2 and got == want[:len(got)], (o, f, len(got)))
else:
    print('skip the whole chain (no ../ytaud/build/ytaud or no ffmpeg here)')

print('ytalsa: ' + ('%d FAILED' % len(fails) if fails else 'all ok'))
sys.exit(1 if fails else 0)
