/* A stand-in for libasound in the tests of ytalsa.py, behaving as the car's audio router's devices do (the "smartx"
 * ALSA plugin of Intel's SmartXbar / AVB-AudioModules, whose source is public):
 *   - a device is a ring buffer the router reads at the pace of time, but only while something is connected to it;
 *     not connected, it takes its buffer full and then nothing (a non-blocking write: EAGAIN; a blocking one waits);
 *   - opened non-blocking, the router reads nothing until the stream is started (snd_pcm_start, or the buffer full);
 *     a device another program left that way stays so even for a blocking open, until a start;
 *   - one program at a time has a device (EBUSY for the next);
 *   - its position is reset by snd_pcm_set_params only: after a snd_pcm_prepare on a stream that has played, what
 *     ALSA says may be written is nonsense (the plugin's read pointer and ALSA's own no longer agree);
 *   - a write that fails breaks the stream for good (snd_pcm_recover does not mend it): it is opened anew.
 * A device's ways are in its name:
 *   ...clocked...    connected all the time                 ...stall...     never connected
 *   ...onconnect...  connected while $FAKE_ASOUND_CONNECT (a file) has a line that is part of its name
 *   ...stopread...   left "not read until started" by another program
 *   ...fast...       takes everything at once (as ALSA's null) ...busy...   open: EBUSY
 *   ...nofmt...      set_params: EINVAL                     ...hang...      set_params never returns (the router
 *   ...abort...      open: the plugin's assertion fails                          does not answer the plugin)
 *   ...tiny...       its buffer is 4 periods of 192 frames whatever is asked for (the router's own sizes): the
 *                    frames the router wanted and did not find are counted ("starved N" in the log at its close)
 *   anything else: open: ENOENT
 * $FAKE_ASOUND_LOSE_AFTER seconds after its first samples a device loses its connection; after
 * $FAKE_ASOUND_EPIPE_AFTER frames a write fails with EPIPE and the stream stays broken until it is opened anew.
 * What is written goes to $FAKE_ASOUND_OUT.<name> (raw), the calls to $FAKE_ASOUND_LOG. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

enum { ST_OPEN, ST_SETUP, ST_PREPARED, ST_RUNNING, ST_XRUN };
typedef struct {
    char name[128];
    int fast, nofmt, nonblock, state, stopread, stale, broke, lost;
    unsigned rate, ch;
    unsigned long bufsize;
    double level;                 /* frames in the ring */
    double last;                  /* when the router last read */
    double first;                 /* when the first samples came */
    unsigned long written, since; /* in all; since the last prepare */
    unsigned long read;           /* by the router since set_params */
    double starved;               /* frames the router wanted while the stream ran and did not find */
    FILE *out;
} pcm_t;

#define MAXOPEN 64
static char opened[MAXOPEN][128];

static double now(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec / 1e9; }
static void logf_(const char *what, const char *name) {
    const char *p = getenv("FAKE_ASOUND_LOG");
    if (!p) return;
    FILE *f = fopen(p, "a");
    if (f) { fprintf(f, "%s %s\n", what, name); fclose(f); }
}
static int connected(pcm_t *p) {
    if (p->lost) return 0;
    if (strstr(p->name, "clocked")) return 1;
    if (strstr(p->name, "onconnect")) {
        const char *path = getenv("FAKE_ASOUND_CONNECT");
        FILE *f = path ? fopen(path, "r") : NULL;
        char line[160];
        int yes = 0;
        if (!f) return 0;
        while (fgets(line, sizeof line, f)) {
            line[strcspn(line, "\r\n")] = 0;
            if (line[0] && strstr(p->name, line)) yes = 1;
        }
        fclose(f);
        return yes;
    }
    return 0;
}
/* The router's side: reads what is there, at the pace of time, while connected and allowed to. */
static void advance(pcm_t *p) {
    double t = now(), dt = t - p->last;
    p->last = t;
    if (p->fast || !p->rate) return;
    if (p->first > 0 && !p->lost && getenv("FAKE_ASOUND_LOSE_AFTER") && t - p->first > atof(getenv("FAKE_ASOUND_LOSE_AFTER"))) p->lost = 1;
    if (p->stopread || !connected(p)) return;
    double take = dt * p->rate;
    if (take > p->level) { if (p->state == ST_RUNNING && p->first > 0) p->starved += take - p->level; take = p->level; }
    p->level -= take;
    p->read += (unsigned long)take;
}
int snd_pcm_open(void **pp, const char *name, int stream, int mode) {
    (void)stream;
    logf_(mode & 1 ? "open-nonblock" : "open", name);
    if (strstr(name, "busy")) return -EBUSY;
    if (strstr(name, "abort")) abort();
    if (!(strstr(name, "hang") || strstr(name, "clocked") || strstr(name, "stall") || strstr(name, "onconnect") || strstr(name, "fast") || strstr(name, "nofmt"))) return -ENOENT;
    int slot = -1;
    for (int i = 0; i < MAXOPEN; i++) { if (!strcmp(opened[i], name)) return -EBUSY; if (slot < 0 && !opened[i][0]) slot = i; }
    if (slot < 0) return -ENOMEM;
    snprintf(opened[slot], sizeof opened[slot], "%s", name);
    pcm_t *p = calloc(1, sizeof *p);
    snprintf(p->name, sizeof p->name, "%s", name);
    p->fast = !!strstr(name, "fast");
    p->nofmt = !!strstr(name, "nofmt");
    p->nonblock = mode & 1;
    p->stopread = (mode & 1) || !!strstr(name, "stopread");
    p->state = ST_OPEN;
    p->last = now();
    *pp = p;
    return 0;
}
int snd_pcm_close(void *h) {
    pcm_t *p = h;
    if (strstr(p->name, "tiny")) { char b[200]; snprintf(b, sizeof b, "starved %ld", (long)p->starved); logf_(b, p->name); }
    logf_("close", p->name);
    for (int i = 0; i < MAXOPEN; i++) if (!strcmp(opened[i], p->name)) opened[i][0] = 0;
    if (p->out) fclose(p->out);
    free(p);
    return 0;
}
int snd_pcm_nonblock(void *h, int nb) { pcm_t *p = h; logf_(nb ? "nonblock" : "block", p->name); p->nonblock = nb; return 0; }
int snd_pcm_set_params(void *h, int fmt, int access, unsigned ch, unsigned rate, int soft, unsigned latency) {
    pcm_t *p = h; (void)soft;
    if (strstr(p->name, "hang")) for (;;) pause();
    if (p->nofmt || fmt != 2 || access != 3) return -EINVAL;
    p->rate = rate; p->ch = ch; p->bufsize = strstr(p->name, "tiny") ? 4 * 192 : (unsigned long)((double)rate * latency / 1e6);
    p->level = 0; p->written = 0; p->since = 0; p->read = 0; p->stale = 0; p->first = 0; p->last = now();
    p->state = ST_PREPARED;
    if (!p->out && getenv("FAKE_ASOUND_OUT")) {
        char path[512], clean[128]; size_t i;
        for (i = 0; p->name[i] && i < sizeof clean - 1; i++) clean[i] = (p->name[i] == ':' || p->name[i] == '/') ? '_' : p->name[i];
        clean[i] = 0;
        snprintf(path, sizeof path, "%s.%s", getenv("FAKE_ASOUND_OUT"), clean);
        p->out = fopen(path, "ab");
    }
    return 0;
}
int snd_pcm_get_params(void *h, unsigned long *buf, unsigned long *per) { pcm_t *p = h; *buf = p->bufsize; *per = p->bufsize / 4; return 0; }
/* (a drop does not count as starving: the stream is stopped) */
int snd_pcm_state(void *h) { pcm_t *p = h; return p->state; }
int snd_pcm_start(void *h) {
    pcm_t *p = h;
    logf_("start", p->name);
    if (p->state != ST_PREPARED) return -EBADFD;
    advance(p);
    p->state = ST_RUNNING;
    p->stopread = 0;
    return 0;
}
long snd_pcm_writei(void *h, const void *data, unsigned long frames) {
    pcm_t *p = h;
    if (p->state == ST_XRUN) return -EPIPE;
    if (p->state != ST_PREPARED && p->state != ST_RUNNING) return -EBADFD;
    if (getenv("FAKE_ASOUND_EPIPE_AFTER") && !p->broke && p->written >= strtoul(getenv("FAKE_ASOUND_EPIPE_AFTER"), NULL, 10)) {
        const char *once = getenv("FAKE_ASOUND_EPIPE_FLAG");      /* (once per test, not once per open) */
        if (!once || access(once, F_OK) != 0) {
            if (once) { FILE *f = fopen(once, "w"); if (f) fclose(f); }
            p->broke = 1; p->state = ST_XRUN; logf_("epipe", p->name);
            return -EPIPE;
        }
    }
    for (;;) {
        advance(p);
        long space = p->fast ? (long)frames : (long)p->bufsize - (long)(p->level + 0.999);
        if (space > 0) {
            unsigned long n = frames < (unsigned long)space ? frames : (unsigned long)space;
            if (p->out) { fwrite(data, 2 * p->ch, n, p->out); fflush(p->out); }
            if (!p->written) p->first = now();
            if (!p->fast) p->level += n;
            p->written += n; p->since += n;
            /* ALSA starts a stream once its buffer is full */
            if (p->state == ST_PREPARED && !p->stale && p->since >= p->bufsize) { p->state = ST_RUNNING; p->stopread = 0; logf_("start-by-threshold", p->name); }
            return (long)n;
        }
        if (p->nonblock) return -EAGAIN;
        usleep(2000);                    /* a blocking write waits for the router, for ever if it never reads */
    }
}
int snd_pcm_wait(void *h, int ms) {
    pcm_t *p = h;
    double end = now() + ms / 1000.0;
    for (;;) {
        advance(p);
        if (p->fast || (long)p->bufsize - (long)(p->level + 0.999) > 0) return 1;
        if (now() >= end) return 0;
        usleep(2000);
    }
}
int snd_pcm_recover(void *h, int err, int silent) { (void)h; (void)silent; return err; }
int snd_pcm_prepare(void *h) {
    pcm_t *p = h;
    logf_("prepare", p->name);
    advance(p);
    if (p->read > 0) p->stale = 1;       /* the plugin's read pointer is not reset by a prepare */
    p->since = 0;
    p->state = ST_PREPARED;
    return 0;
}
int snd_pcm_drop(void *h) {
    pcm_t *p = h;
    logf_("drop", p->name);
    if (p->state == ST_OPEN) return -EBADFD;
    advance(p);
    p->level = 0;                        /* the router empties the ring when it is told of the stop */
    p->state = ST_SETUP;
    return 0;
}
int snd_pcm_drain(void *h) { pcm_t *p = h; for (;;) { advance(p); if (p->level < 1 || p->stopread || !connected(p)) return 0; usleep(2000); } }
long snd_pcm_avail_update(void *h) {
    pcm_t *p = h;
    if (p->state == ST_XRUN) return -EPIPE;
    advance(p);
    if (p->fast) return (long)p->bufsize;
    if (p->stale) return (long)p->bufsize + (1L << 20);
    return (long)p->bufsize - (long)(p->level + 0.999);
}
const char *snd_strerror(int e) { return strerror(e < 0 ? -e : e); }
int snd_lib_error_set_handler(void *fn) { (void)fn; return 0; }
