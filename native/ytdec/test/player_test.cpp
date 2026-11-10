/* Host test of the index reader, MGVF writer and the player's pacing, seek,
 * tailing and end of file, on a synthetic stream with B frames and a fake
 * decoder that reorders like a DPB. Fake time: every step gets `now`. */
#undef NDEBUG
#include "../src/index.h"
#include "../src/mgvf.h"
#include "../src/player.h"

#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <string>
#include <vector>

using namespace ytdec;

namespace {

const uint32_t W = 64, H = 36;   /* output */
const int DUR = 33;

/* Decoding order of a GOP of 12 with B pairs: I0 P3 B1 B2 P6 B4 B5 ... */
std::vector<int> decode_order(int n)
{
    std::vector<int> o;
    for (int g = 0; g < n; g += 12) {
        o.push_back(g);
        for (int k = g + 3; k < g + 12; k += 3) {
            o.push_back(k);
            o.push_back(k - 2);
            o.push_back(k - 1);
        }
        o.push_back(g + 10);
        o.push_back(g + 11);
    }
    o.erase(std::remove_if(o.begin(), o.end(), [n](int f) { return f >= n; }), o.end());
    return o;
}

struct Stream {
    std::vector<uint8_t> video;
    std::vector<IndexRec> recs;
};

/* frame f's access unit: [SPS PPS] slice, the frame number in the payload. A
 * key without SPS (every 24th frame from 12): an open-GOP I frame. */
Stream make_stream(int n)
{
    Stream s;
    for (int f : decode_order(n)) {
        IndexRec r;
        r.pts_ms = (uint32_t)(f * DUR);
        r.pos = s.video.size();
        const bool key = f % 12 == 0, sps = f % 24 == 0;
        auto nal = [&](uint8_t t) {
            const uint8_t sc[] = {0, 0, 0, 1, t, (uint8_t)(f >> 8), (uint8_t)f, 0x80};
            s.video.insert(s.video.end(), sc, sc + sizeof sc);
        };
        if (sps) {
            nal(0x67);
            nal(0x68);
        }
        nal(key ? (sps ? 0x65 : 0x61) : 0x41);
        r.size = (uint32_t)(s.video.size() - r.pos);
        r.key = key;
        s.recs.push_back(r);
    }
    return s;
}

void put16(std::vector<uint8_t> &b, uint16_t v) { b.push_back((uint8_t)v), b.push_back((uint8_t)(v >> 8)); }
void put32(std::vector<uint8_t> &b, uint32_t v) { put16(b, (uint16_t)v), put16(b, (uint16_t)(v >> 16)); }

void write_file(const std::string &p, const std::vector<uint8_t> &b)
{
    FILE *f = fopen(p.c_str(), "wb");
    assert(f);
    fwrite(b.data(), 1, b.size(), f);
    fclose(f);
}

std::vector<uint8_t> index_bytes(const Stream &s, size_t n)
{
    std::vector<uint8_t> b = {'M', 'G', 'Y', 'I'};
    put16(b, 1), put16(b, 640), put16(b, 360), put16(b, 30), put16(b, 1);
    put16(b, 0);
    put32(b, (uint32_t)n);
    b.resize(32, 0);
    for (size_t i = 0; i < n; i++) {
        const IndexRec &r = s.recs[i];
        put32(b, r.pts_ms);
        put32(b, (uint32_t)r.pos), put32(b, (uint32_t)(r.pos >> 32));
        put32(b, r.size);
        b.push_back(r.key);
    }
    return b;
}

/* Feeds back what it is given, in display order after a DPB of 2. */
class FakeDecoder : public VideoDecoder {
public:
    std::vector<int64_t> held;
    std::vector<uint8_t> y = std::vector<uint8_t>(W * H), uv = std::vector<uint8_t>(W * H / 2, 128);
    bool started = false;
    int fed = 0, pictures = 0;

    void out(const Sink &cb, bool picture)
    {
        std::sort(held.begin(), held.end());
        const int64_t pts = held.front();
        held.erase(held.begin());
        memset(y.data(), 16 + (int)(pts / DUR) % 200, y.size());
        woc::VideoFrame f = {W, H, 0, pts, picture ? y.data() : nullptr, picture ? uv.data() : nullptr, W};
        if (picture) pictures++;
        cb(f);
    }
    bool feed(const uint8_t *au, size_t len, int64_t pts, bool picture, const Sink &cb, std::string *) override
    {
        fed++;
        if (!started) {
            if (!(nal_types(au, len) & (1u << 7)))
                return true;   /* waits for an SPS, as MSDK's decoder does */
            started = true;
        }
        held.push_back(pts);
        if (held.size() > 2)
            out(cb, picture);
        return true;
    }
    void flush(const Sink &cb) override
    {
        while (!held.empty())
            out(cb, true);
        started = false;
    }
};

struct Rig {
    std::string dir;
    Mgvf out;
    FakeDecoder dec;
    std::vector<std::string> events;
    Player *p = nullptr;
    int64_t now = 1000000;
    std::vector<int64_t> shown_pts;

    explicit Rig(const std::string &d) : dir(d)
    {
        std::string err, warn;
        bool ok = out.open((d + "/shm").c_str(), W, H, 3, &err, &warn);
        assert(ok);
        p = new Player(d, &dec, &out, [this](const std::string &j) { events.push_back(j); },
                       [](const std::string &) {}, [] { return 0.0; });
    }
    ~Rig() { delete p; }
    /* runs fake time forward by ms, calling step as main would */
    void run(int ms)
    {
        const int64_t end = now + ms;
        while (now < end) {
            const uint64_t before = p->shown;
            int w = p->step(now);
            if (p->shown != before)
                shown_pts.push_back(p->last_shown_pts);
            now += w < 1 ? 1 : w;
        }
    }
    int count(const char *ev)
    {
        int n = 0;
        for (auto &e : events)
            n += e.find(std::string("\"ev\":\"") + ev + "\"") != std::string::npos;
        return n;
    }
    void cmd(const std::string &c) { p->command(c, now); }
    void clock(int64_t elapsed) { cmd("clock " + std::to_string(elapsed) + " " + std::to_string(now)); }
};

std::string tmpdir()
{
    char t[] = "/tmp/ytdec_test.XXXXXX";
    assert(mkdtemp(t));
    return t;
}

void test_nv12_and_mgvf(const std::string &d)
{
    Mgvf m;
    std::string err, warn;
    assert(!m.open((d + "/bad").c_str(), 15, 16, 3, &err, &warn));
    assert(!m.open((d + "/bad").c_str(), 2048, 2048 + 2, 3, &err, &warn));
    assert(m.open((d + "/m").c_str(), 16, 16, 3, &err, &warn));
    struct stat st;
    assert(stat((d + "/m").c_str(), &st) == 0 && (st.st_mode & 0777) == 0600);
    assert((size_t)st.st_size == 64 + 3 * 16 * 16 * 3 / 2);
    uint8_t y[16 * 2 * 16], uv[16 * 2 * 8];
    for (int i = 0; i < (int)sizeof y; i++) y[i] = (uint8_t)i;
    for (int i = 0; i < (int)sizeof uv; i++) uv[i] = (uint8_t)(i % 2 ? 200 : 100);
    uint8_t *dst = m.begin();
    nv12_to_i420(y, uv, 32, 16, 16, dst);   /* pitch 32: half of each row is padding */
    assert(dst[0] == 0 && dst[16] == 32 && dst[16 * 16] == 100 && dst[16 * 16 + 64] == 200);
    m.commit();
    m.close();
    int fd = open((d + "/m").c_str(), O_RDONLY);
    MgvfHead h;
    assert(pread(fd, &h, sizeof h, 0) == (ssize_t)sizeof h);
    close(fd);
    assert(h.magic == kMgvfMagic && h.version == 1 && h.w == 16 && h.h == 16 && h.nslot == 3);
    assert(h.seq == 1 && h.slot == 1 && h.matrix == 1 && h.full == 0);
    printf("  mgvf + nv12_to_i420 ok\n");
}

void test_index(const std::string &d, const Stream &s)
{
    write_file(d + "/video.h264", s.video);
    std::vector<uint8_t> b = index_bytes(s, s.recs.size());
    b.resize(b.size() - 5);   /* the last record half written */
    write_file(d + "/index.bin", b);
    Index idx;
    std::string err;
    assert(idx.open(d + "/index.bin", &err));
    assert(idx.w == 640 && idx.h == 360 && idx.fps_num == 30 && idx.recs.size() == s.recs.size() - 1);
    write_file(d + "/index.bin", index_bytes(s, s.recs.size()));
    assert(idx.refresh() && idx.recs.size() == s.recs.size());
    for (size_t i = 0; i < s.recs.size(); i++)
        assert(idx.recs[i].pts_ms == s.recs[i].pts_ms && idx.recs[i].pos == s.recs[i].pos && idx.recs[i].key == s.recs[i].key);
    int vfd = open((d + "/video.h264").c_str(), O_RDONLY);
    /* frame 12 is a key without SPS: a seek to 13 frames lands on frame 0 */
    assert(idx.recs[idx.seek_point(13 * DUR, vfd)].pts_ms == 0);
    assert(idx.recs[idx.seek_point(30 * DUR, vfd)].pts_ms == 24 * DUR);
    assert(idx.seek_point(0, vfd) == 0);
    close(vfd);
    printf("  index ok (%zu records)\n", idx.recs.size());
}

void test_playback(const std::string &d)
{
    Rig r(d);
    /* no clock: frame 0 and hold */
    r.run(500);
    assert(r.count("ready") == 1 && r.p->shown == 1 && r.p->last_shown_pts == 0 && r.out.seq() == 1);
    /* clock from 0: real time, no drops, pts in order */
    r.clock(0);
    r.run(1000);
    assert(r.p->dropped == 0);
    assert(r.p->shown >= 30 && r.p->shown <= 32);
    for (size_t i = 1; i < r.shown_pts.size(); i++)
        assert(r.shown_pts[i] == r.shown_pts[i - 1] + DUR);
    const int64_t at = r.p->last_shown_pts;
    assert(at >= 1000 - DUR && at <= 1000 + DUR);
    /* the audio jumps 500 ms ahead: the late frames are dropped, then on time */
    r.clock(at + 500);
    r.run(1000);
    assert(r.p->dropped >= 10);
    assert(std::abs((long)(r.p->last_shown_pts - (at + 1500))) <= 2 * DUR);
    /* pause: nothing more */
    r.cmd("pause");
    uint64_t n = r.p->shown;
    r.run(1000);
    assert(r.p->shown == n);
    /* seek while paused: the target frame, then hold */
    r.cmd("seek 3000");
    r.run(300);
    assert(r.p->shown == n + 1);
    assert(r.p->last_shown_pts >= 3000 && r.p->last_shown_pts < 3000 + DUR);
    r.cmd("resume");
    r.run(500);
    assert(r.p->last_shown_pts >= 3500 - DUR && r.p->last_shown_pts <= 3500 + DUR);
    /* video 0: nothing written, the clock runs on; video 1 picks up at the clock */
    r.cmd("video 0");
    n = r.p->shown;
    uint32_t seq = r.out.seq();
    r.run(1000);
    assert(r.p->shown == n && r.out.seq() == seq);
    r.cmd("video 1");
    r.run(200);
    assert(r.p->last_shown_pts >= 4700 - DUR && r.p->last_shown_pts <= 4700 + DUR);
    /* stats every 2 s */
    assert(r.count("stats") >= 2);
    /* to the end: eof once, then a seek back plays again */
    r.run(10000);
    assert(r.count("eof") == 1);
    assert(r.p->last_shown_pts == 299 * DUR);
    r.cmd("seek 0");
    r.run(200);
    assert(r.p->eof_sent == false && r.p->last_shown_pts <= 200 + DUR);
    printf("  playback ok: shown %llu dropped %llu decoded %llu\n", (unsigned long long)r.p->shown,
           (unsigned long long)r.p->dropped, (unsigned long long)r.p->decoded);
}

/* the fetcher's writes: index first, then video.h264.part growing, then renamed */
void test_tail(const std::string &d, const Stream &s)
{
    const size_t half = s.recs.size() / 2;
    write_file(d + "/index.bin", index_bytes(s, half));
    Rig r(d);
    r.run(300);
    assert(r.count("ready") == 0);   /* no video yet */
    std::vector<uint8_t> v(s.video.begin(), s.video.begin() + (long)s.recs[half / 2].pos);
    write_file(d + "/video.h264.part", v);
    r.clock(0);
    r.run(2000);
    assert(r.count("ready") == 1 && r.p->shown > 0 && r.count("eof") == 0);
    write_file(d + "/video.h264.part", s.video);   /* same path: our descriptor sees the new bytes */
    write_file(d + "/index.bin", index_bytes(s, s.recs.size()));
    r.run(2500);
    assert(r.count("eof") == 0);   /* still .part and growing a moment ago */
    rename((d + "/video.h264.part").c_str(), (d + "/video.h264").c_str());
    r.run(10000);
    assert(r.count("eof") == 1 && r.p->last_shown_pts == 299 * DUR);
    printf("  tail ok: shown %llu dropped %llu\n", (unsigned long long)r.p->shown, (unsigned long long)r.p->dropped);
}

/* .part never renamed (the fetcher stalled or died): no eof, however long; eof once renamed */
void test_eof_no_rename(const std::string &d, const Stream &s)
{
    write_file(d + "/index.bin", index_bytes(s, s.recs.size()));
    write_file(d + "/video.h264.part", s.video);
    Rig r(d);
    r.cmd("seek 9000");
    r.clock(9000);
    r.run(8000);
    assert(r.count("eof") == 0);
    rename((d + "/video.h264.part").c_str(), (d + "/video.h264").c_str());
    r.run(500);
    assert(r.count("eof") == 1);
    printf("  no eof while .part, eof after the rename ok\n");
}

}  // namespace

int main()
{
    const Stream s = make_stream(300);
    test_nv12_and_mgvf(tmpdir());
    test_index(tmpdir(), s);
    {
        std::string d = tmpdir();
        write_file(d + "/video.h264", s.video);
        write_file(d + "/index.bin", index_bytes(s, s.recs.size()));
        test_playback(d);
    }
    test_tail(tmpdir(), s);
    test_eof_no_rename(tmpdir(), s);
    printf("player_test: all passed\n");
    return 0;
}
