/* The player: reads access units by the index from a (possibly growing)
 * Annex-B file, feeds a decoder, paces its frames against the audio clock
 * and writes them to the MGVF file. Single-threaded: main() calls command()
 * for each stdin line and step() whenever it returns; nothing blocks.
 *
 * Clock: `clock <elapsed_ms> <mono_ms>` says media position elapsed_ms was
 * true at CLOCK_MONOTONIC mono_ms; pos(now) = elapsed + (now - mono). Before
 * the first clock line, and while paused, the player shows one frame (the
 * first, or the one a seek landed on) and holds. A frame is shown once
 * pts <= pos + kLead, dropped when more than 2 frame durations late. */
#ifndef YTDEC_PLAYER_H
#define YTDEC_PLAYER_H

#include "decoder_msdk.h"
#include "index.h"
#include "mgvf.h"

#include <stdint.h>
#include <deque>
#include <functional>
#include <string>
#include <vector>

namespace ytdec {

/* What the player needs from a decoder (MSDK on the car, a fake in tests). */
class VideoDecoder {
public:
    using Sink = woc::Decoder::FrameSink;
    virtual ~VideoDecoder() {}
    /* One whole access unit with its pts; picture false: frames out of this
     * call need no pixels (they are skipped). */
    virtual bool feed(const uint8_t *au, size_t len, int64_t pts_ms, bool picture, const Sink &cb, std::string *err) = 0;
    /* End of stream: every frame still held comes out; the next feed starts
     * a new stream at its first SPS. */
    virtual void flush(const Sink &cb) = 0;
};

class Player {
public:
    using Emit = std::function<void(const std::string &json)>;
    using Log = std::function<void(const std::string &line)>;
    static const int kLead = 8;            /* ms a frame may be shown early */
    static const size_t kQueue = 3;        /* decoded frames held ahead */
    static const int kStatsMs = 2000;

    Player(const std::string &dir, VideoDecoder *dec, Mgvf *out, Emit emit, Log log,
           std::function<double()> cpu_pct);
    ~Player();

    /* One stdin line. Returns false for quit. */
    bool command(const std::string &line, int64_t now);
    /* Does what is due at now (ms, CLOCK_MONOTONIC); returns how long main
     * may wait for stdin before calling again. */
    int step(int64_t now);

    /* counters, for stats and tests */
    uint64_t decoded = 0, shown = 0, dropped = 0;
    int64_t last_shown_pts = -1;
    bool eof_sent = false;

private:
    struct Staged {
        int64_t pts;
        std::vector<uint8_t> i420;
    };

    int64_t pos(int64_t now) const { return paused_ || !has_clock_ ? frozen_ : elapsed_ + (now - mono_); }
    bool running() const { return has_clock_ && !paused_; }
    void seek(int64_t ms, int64_t now);
    void on_frame(const woc::VideoFrame &f, int64_t now);
    void show(Staged &s, int64_t now);
    bool open_inputs(int64_t now);
    bool feed_one(int64_t now);
    void stats(int64_t now);

    std::string dir_;
    VideoDecoder *dec_;
    Mgvf *out_;
    Emit emit_;
    Log log_;
    std::function<double()> cpu_;

    Index idx_;
    int video_fd_ = -1;
    bool ready_ = false;
    int64_t dur_ = 33;               /* one frame, ms */
    size_t next_ = 0;                /* next record to feed */
    int64_t max_fed_ = -1;           /* largest pts fed since the last seek */
    int64_t target_ = -1;            /* seek: frames before it are skipped */
    int64_t last_out_pts_ = -1;      /* the decoder's last frame, for unknown timestamps */
    bool still_ = true;              /* show the next frame even while held */
    bool video_on_ = true;
    bool flushed_ = false;
    int64_t last_poll_ = -1000000;
    int64_t end_since_ = -1;         /* every known record fed since then */

    bool has_clock_ = false, paused_ = false;
    int64_t elapsed_ = 0, mono_ = 0, frozen_ = 0;

    std::deque<Staged> queue_;
    std::vector<std::vector<uint8_t>> pool_;   /* spare frame buffers */
    std::vector<uint8_t> au_;

    int64_t stats_at_ = -1;
    uint64_t s_shown_ = 0;
    double late_sum_ = 0;
    uint64_t late_n_ = 0;
    std::string last_err_;
};

}  // namespace ytdec

#endif
