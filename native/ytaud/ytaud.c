/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ytaud - the sound of RideTube's audio file as samples: reads the plain MP4 (AAC) that jap-ridetube-d's fetcher
 * writes (audio.m4a, audio.head.m4a: ftyp + moov + mdat, one sound track), decodes it with FAAD2 and writes
 * signed 16-bit little-endian interleaved samples to stdout, after one line of JSON that says what follows:
 *
 *     {"rate":44100,"channels":2,"total_ms":213000,"start_ms":42000}\n<samples...>
 *
 *   ytaud --file <audio.m4a> [--start-ms N] [--max-ms N]
 *
 * --start-ms: the first sample written is the one at N (decoding starts two frames earlier: an AAC frame needs its
 * predecessor). Exit codes: 0 the end of the file (or --max-ms reached, or the reader went away), 2 bad arguments or
 * a file that is not such an MP4, 3 the decoder refused it.
 *
 * It is for a head unit that has no player of its own for us (iDrive 8, see ../jap-ridetube-d/sound.js): ytalsa.py
 * runs it as nobody and writes its samples to the car's audio router. Built static (README.md), so the unit's
 * libraries do not matter.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

#include <neaacdec.h>

#define MAX_MOOV (64u << 20)
#define MAX_SAMPLES (40u * 1000 * 1000)
#define MAX_FRAME (1u << 20)

static void die(int code, const char *fmt, const char *arg) {
    fputs("ytaud: ", stderr);
    fprintf(stderr, fmt, arg);
    fputc('\n', stderr);
    exit(code);
}

static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static uint64_t be64(const uint8_t *p) { return ((uint64_t)be32(p) << 32) | be32(p + 4); }

/* A box inside [p, end): its payload and type; 0 when there is none whole. */
typedef struct { const uint8_t *body; uint64_t len; char type[5]; const uint8_t *next; } box_t;
static int next_box(const uint8_t *p, const uint8_t *end, box_t *b) {
    if (end - p < 8) return 0;
    uint64_t size = be32(p);
    size_t head = 8;
    memcpy(b->type, p + 4, 4);
    b->type[4] = 0;
    if (size == 1) {
        if (end - p < 16) return 0;
        size = be64(p + 8);
        head = 16;
    } else if (size == 0) size = (uint64_t)(end - p);
    if (size < head || size > (uint64_t)(end - p)) return 0;
    b->body = p + head;
    b->len = size - head;
    b->next = p + size;
    return 1;
}
/* The first box of that type among the children in [p, end). */
static int find_box(const uint8_t *p, const uint8_t *end, const char *type, box_t *out) {
    box_t b;
    while (next_box(p, end, &b)) {
        if (!memcmp(b.type, type, 4)) { *out = b; return 1; }
        p = b.next;
    }
    return 0;
}

typedef struct {
    uint32_t timescale;
    uint64_t duration;          /* in timescale units */
    uint8_t asc[64];
    unsigned asc_len;
    uint32_t n;                 /* samples */
    uint64_t *off;              /* each sample's place in the file */
    uint32_t *size;
    uint32_t *dur;              /* each sample's duration (timescale units) */
} track_t;

/* An MPEG-4 descriptor's length (1 to 4 bytes, 7 bits each). */
static int desc_len(const uint8_t **p, const uint8_t *end, uint32_t *len) {
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        if (*p >= end) return 0;
        uint8_t c = *(*p)++;
        v = (v << 7) | (c & 0x7f);
        if (!(c & 0x80)) { *len = v; return 1; }
    }
    return 0;
}
/* esds: ES_Descriptor (3) > DecoderConfigDescriptor (4) > DecoderSpecificInfo (5) = the AudioSpecificConfig. */
static int parse_esds(const uint8_t *p, const uint8_t *end, track_t *t) {
    uint32_t len;
    if (end - p < 4) return 0;
    p += 4;                                             /* version, flags */
    if (p >= end || *p++ != 0x03 || !desc_len(&p, end, &len)) return 0;
    if (end - p < 3) return 0;
    uint8_t flags = p[2];
    p += 3;                                             /* ES_ID, flags */
    if (flags & 0x80) p += 2;                           /* dependsOn_ES_ID */
    if (flags & 0x40) { if (p >= end) return 0; p += 1 + *p; }  /* URL */
    if (flags & 0x20) p += 2;                           /* OCR_ES_ID */
    if (p >= end || *p++ != 0x04 || !desc_len(&p, end, &len)) return 0;
    if (end - p < 13) return 0;
    p += 13;                                            /* objectType, streamType, buffer size, bitrates */
    if (p >= end || *p++ != 0x05 || !desc_len(&p, end, &len)) return 0;
    if (len == 0 || len > sizeof t->asc || len > (uint32_t)(end - p)) return 0;
    memcpy(t->asc, p, len);
    t->asc_len = len;
    return 1;
}

/* The sound track's tables out of a moov. */
static const char *parse_moov(const uint8_t *moov, uint64_t moov_len, track_t *t) {
    const uint8_t *p = moov, *end = moov + moov_len;
    box_t trak;
    while (next_box(p, end, &trak)) {
        p = trak.next;
        if (memcmp(trak.type, "trak", 4)) continue;
        box_t mdia, hdlr, mdhd, minf, stbl, stsd, stts, stsc, stsz, stco;
        const uint8_t *te = trak.body + trak.len;
        if (!find_box(trak.body, te, "mdia", &mdia)) continue;
        const uint8_t *me = mdia.body + mdia.len;
        if (!find_box(mdia.body, me, "hdlr", &hdlr) || hdlr.len < 12 || memcmp(hdlr.body + 8, "soun", 4)) continue;
        if (!find_box(mdia.body, me, "mdhd", &mdhd) || mdhd.len < 24) return "no mdhd";
        if (mdhd.body[0] == 1) {
            if (mdhd.len < 36) return "short mdhd";
            t->timescale = be32(mdhd.body + 20);
            t->duration = be64(mdhd.body + 24);
        } else {
            t->timescale = be32(mdhd.body + 12);
            t->duration = be32(mdhd.body + 16);
        }
        if (!t->timescale) return "no timescale";
        if (!find_box(mdia.body, me, "minf", &minf) || !find_box(minf.body, minf.body + minf.len, "stbl", &stbl)) return "no sample table";
        const uint8_t *se = stbl.body + stbl.len;
        if (!find_box(stbl.body, se, "stsd", &stsd) || stsd.len < 8 + 8 + 28) return "no stsd";
        /* stsd: version/flags, count, then the entry: size, 'mp4a', 6 reserved, data ref, 20 bytes of sound, boxes */
        const uint8_t *e = stsd.body + 8, *ee = stsd.body + stsd.len;
        uint32_t esize = be32(e);
        if (esize < 36 || esize > (uint32_t)(ee - e)) return "bad stsd entry";
        if (memcmp(e + 4, "mp4a", 4)) return "the sound is not AAC (mp4a)";
        uint16_t version = (uint16_t)((e[16] << 8) | e[17]);
        const uint8_t *kids = e + 36 + (version == 1 ? 16 : version == 2 ? 36 : 0);
        box_t esds;
        if (kids > e + esize || !find_box(kids, e + esize, "esds", &esds) || !parse_esds(esds.body, esds.body + esds.len, t)) return "no AAC configuration (esds)";
        if (!find_box(stbl.body, se, "stts", &stts) || stts.len < 8) return "no stts";
        if (!find_box(stbl.body, se, "stsc", &stsc) || stsc.len < 8) return "no stsc";
        if (!find_box(stbl.body, se, "stsz", &stsz) || stsz.len < 12) return "no stsz";
        int co64 = 0;
        if (!find_box(stbl.body, se, "stco", &stco)) {
            if (!find_box(stbl.body, se, "co64", &stco)) return "no chunk offsets";
            co64 = 1;
        }
        if (stco.len < 8) return "short chunk offsets";
        uint32_t fixed = be32(stsz.body + 4), n = be32(stsz.body + 8);
        if (!n || n > MAX_SAMPLES) return "no samples (a fragmented file?)";
        if (!fixed && stsz.len < 12 + (uint64_t)n * 4) return "short stsz";
        t->n = n;
        t->off = calloc(n, sizeof *t->off);
        t->size = calloc(n, sizeof *t->size);
        t->dur = calloc(n, sizeof *t->dur);
        if (!t->off || !t->size || !t->dur) return "out of memory";
        for (uint32_t i = 0; i < n; i++) {
            t->size[i] = fixed ? fixed : be32(stsz.body + 12 + (uint64_t)i * 4);
            if (t->size[i] > MAX_FRAME) return "a sample too large";
        }
        /* stts: runs of (count, duration) */
        uint32_t runs = be32(stts.body + 4), k = 0;
        if (stts.len < 8 + (uint64_t)runs * 8) return "short stts";
        for (uint32_t r = 0; r < runs && k < n; r++) {
            uint32_t c = be32(stts.body + 8 + (uint64_t)r * 8), d = be32(stts.body + 12 + (uint64_t)r * 8);
            for (uint32_t j = 0; j < c && k < n; j++) t->dur[k++] = d;
        }
        for (; k < n; k++) t->dur[k] = k ? t->dur[k - 1] : 1024;
        /* stsc (first chunk, samples per chunk, description) over the chunk offsets: each sample's offset */
        uint32_t chunks = be32(stco.body + 4), entries = be32(stsc.body + 4);
        if (stco.len < 8 + (uint64_t)chunks * (co64 ? 8 : 4)) return "short chunk offsets";
        if (stsc.len < 8 + (uint64_t)entries * 12 || !entries) return "short stsc";
        uint32_t s = 0, ent = 0;
        for (uint32_t c = 0; c < chunks && s < n; c++) {
            while (ent + 1 < entries && be32(stsc.body + 8 + (uint64_t)(ent + 1) * 12) <= c + 1) ent++;
            uint32_t per = be32(stsc.body + 12 + (uint64_t)ent * 12);
            uint64_t o = co64 ? be64(stco.body + 8 + (uint64_t)c * 8) : be32(stco.body + 8 + (uint64_t)c * 4);
            for (uint32_t j = 0; j < per && s < n; j++) {
                t->off[s] = o;
                o += t->size[s];
                s++;
            }
        }
        if (s < n) t->n = s;       /* the table names more samples than its chunks hold: those there are */
        if (!t->n) return "no samples in the chunks";
        return NULL;
    }
    return "no sound track";
}

int main(int argc, char **argv) {
    const char *file = NULL;
    long long start_ms = 0, max_ms = -1;
    prctl(PR_SET_DUMPABLE, 0);
    struct rlimit no = { 0, 0 };
    setrlimit(RLIMIT_CORE, &no);
    signal(SIGPIPE, SIG_IGN);
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--file") && i + 1 < argc) file = argv[++i];
        else if (!strcmp(argv[i], "--start-ms") && i + 1 < argc) start_ms = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--max-ms") && i + 1 < argc) max_ms = atoll(argv[++i]);
        else die(2, "usage: ytaud --file <audio.m4a> [--start-ms N] [--max-ms N] (not: %s)", argv[i]);
    }
    if (!file) die(2, "usage: ytaud --file <audio.m4a> [--start-ms N] [--max-ms N]%s", "");
    if (start_ms < 0) start_ms = 0;
    FILE *f = fopen(file, "rb");
    if (!f) die(2, "cannot open the file: %s", strerror(errno));

    /* the moov, wherever it is among the top boxes */
    uint8_t *moov = NULL;
    uint64_t moov_len = 0, at = 0;
    for (;;) {
        uint8_t h[16];
        if (fseeko(f, (off_t)at, SEEK_SET) || fread(h, 1, 8, f) != 8) break;
        uint64_t size = be32(h), head = 8;
        if (size == 1) {
            if (fread(h + 8, 1, 8, f) != 8) break;
            size = be64(h + 8);
            head = 16;
        } else if (size == 0) break;                     /* to the end of the file: an mdat, the last box */
        if (size < head) break;
        if (!memcmp(h + 4, "moov", 4)) {
            moov_len = size - head;
            if (moov_len > MAX_MOOV) die(2, "the file's index is too large%s", "");
            moov = malloc(moov_len ? moov_len : 1);
            if (!moov || fread(moov, 1, moov_len, f) != moov_len) die(2, "the file's index is cut short%s", "");
            break;
        }
        at += size;
    }
    if (!moov) die(2, "not an MP4 with its index (moov)%s", "");
    track_t t;
    memset(&t, 0, sizeof t);
    const char *why = parse_moov(moov, moov_len, &t);
    if (why) die(2, "not a file of ours: %s", why);

    NeAACDecHandle dec = NeAACDecOpen();
    if (!dec) die(3, "the decoder did not start%s", "");
    NeAACDecConfigurationPtr cfg = NeAACDecGetCurrentConfiguration(dec);
    cfg->outputFormat = FAAD_FMT_16BIT;
    cfg->downMatrix = 1;                                 /* more than two channels: mixed down to two */
    NeAACDecSetConfiguration(dec, cfg);
    unsigned long rate = 0;
    unsigned char channels = 0;
    if (NeAACDecInit2(dec, t.asc, t.asc_len, &rate, &channels) < 0) die(3, "the decoder does not take this AAC configuration%s", "");

    /* Where to start. The decoder gives nothing for the first frame it is handed and from then on one frame's
     * samples per frame, so what it writes for frame i is the sound at (i - 1) frames: the output's own clock,
     * which is the video's (the file's first frame is the encoder's lead-in). start_ms on that clock: the frame
     * whose output holds it, decoding from two frames earlier, and the samples before it in that frame dropped. */
    uint64_t ts = 0, want = (uint64_t)start_ms * t.timescale / 1000;
    uint32_t k = 0;
    while (k < t.n && ts + t.dur[k] <= want) ts += t.dur[k++];
    uint32_t first = k < t.n ? k + 1 : t.n;              /* the frame whose output starts at ts */
    uint64_t skip_ts = k < t.n ? want - ts : 0;          /* ... and what of it lies before start_ms */
    uint32_t from = first >= 2 ? first - 2 : 0;
    uint64_t total = 0;
    for (uint32_t i = 0; i < t.n; i++) total += t.dur[i];
    if (!t.duration || t.duration > total) t.duration = total;

    uint8_t *buf = malloc(MAX_FRAME);
    if (!buf) die(2, "out of memory%s", "");
    int said = 0, bad = 0;
    unsigned long long written_frames = 0, max_frames = 0;
    for (uint32_t i = from; i < t.n; i++) {
        if (fseeko(f, (off_t)t.off[i], SEEK_SET) || fread(buf, 1, t.size[i], f) != t.size[i]) break;   /* the file ends here */
        NeAACDecFrameInfo info;
        void *pcm = NeAACDecDecode(dec, &info, buf, t.size[i]);
        if (info.error || !pcm) {
            if (++bad > 50) die(3, "the decoder gives up: %s", NeAACDecGetErrorMessage(info.error));
            continue;
        }
        bad = 0;
        if (i < first || !info.samples || !info.channels) continue;
        size_t frames = info.samples / info.channels, drop = 0;
        if (!said) {
            said = 1;
            if (max_ms >= 0) max_frames = (unsigned long long)max_ms * info.samplerate / 1000;
            drop = (size_t)(skip_ts * info.samplerate / t.timescale);
            if (drop > frames) drop = frames;
            printf("{\"rate\":%lu,\"channels\":%u,\"total_ms\":%llu,\"start_ms\":%llu}\n", (unsigned long)info.samplerate, (unsigned)info.channels,
                (unsigned long long)(t.duration * 1000 / t.timescale), (unsigned long long)((ts + skip_ts) * 1000 / t.timescale));
        }
        frames -= drop;
        pcm = (uint8_t *)pcm + drop * 2u * info.channels;
        if (max_ms >= 0 && written_frames + frames > max_frames) frames = (size_t)(max_frames - written_frames);
        if (frames && fwrite(pcm, 2u * info.channels, frames, stdout) != frames) return 0;          /* the reader went away */
        written_frames += frames;
        if (max_ms >= 0 && written_frames >= max_frames) break;
    }
    if (!said) printf("{\"rate\":%lu,\"channels\":%u,\"total_ms\":%llu,\"start_ms\":%llu}\n", rate, (unsigned)channels,
        (unsigned long long)(t.duration * 1000 / t.timescale), (unsigned long long)(t.duration * 1000 / t.timescale));
    fflush(stdout);
    return 0;
}
