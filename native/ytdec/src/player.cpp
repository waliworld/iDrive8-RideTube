#include "player.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <limits>

namespace ytdec {

Player::Player(const std::string &dir, VideoDecoder *dec, Mgvf *out, Emit emit, Log log,
               std::function<double()> cpu_pct)
    : dir_(dir), dec_(dec), out_(out), emit_(emit), log_(log), cpu_(cpu_pct)
{
}

Player::~Player()
{
    if (video_fd_ >= 0)
        close(video_fd_);
}

bool Player::open_inputs(int64_t now)
{
    if (ready_)
        return true;
    if (!idx_.is_open()) {
        std::string err;
        if (!idx_.open(dir_ + "/index.bin", &err)) {
            if (!err.empty() && err != last_err_) {
                emit_("{\"ev\":\"error\",\"msg\":\"" + err + "\"}");
                last_err_ = err;
            }
            return false;
        }
    }
    if (video_fd_ < 0) {
        /* The fetcher writes video.h264.part and renames it when complete: the
         * inode, and this descriptor, stay the same. */
        video_fd_ = open((dir_ + "/video.h264").c_str(), O_RDONLY | O_CLOEXEC);
        if (video_fd_ < 0)
            video_fd_ = open((dir_ + "/video.h264.part").c_str(), O_RDONLY | O_CLOEXEC);
        if (video_fd_ < 0)
            return false;
    }
    if (idx_.fps_num && idx_.fps_den)
        dur_ = (int64_t)(1000.0 * idx_.fps_den / idx_.fps_num + 0.5);
    char b[200];
    snprintf(b, sizeof b, "{\"ev\":\"ready\",\"w\":%u,\"h\":%u,\"fps\":%.3f,\"src_w\":%u,\"src_h\":%u}", out_->w(),
             out_->h(), idx_.fps_den ? (double)idx_.fps_num / idx_.fps_den : 0.0, idx_.w, idx_.h);
    emit_(b);
    log_(std::string("ready: ") + b);
    ready_ = true;
    if (target_ >= 0)
        seek(target_, now);   /* a seek that came before the files */
    return true;
}

void Player::seek(int64_t ms, int64_t now)
{
    if (ms < 0)
        ms = 0;
    frozen_ = ms;
    if (has_clock_)
        elapsed_ = ms, mono_ = now;   /* until the next clock line: the audio jumps there too */
    target_ = ms;
    if (!ready_)
        return;
    dec_->flush([](const woc::VideoFrame &) {});
    for (auto &s : queue_)
        pool_.push_back(std::move(s.i420));
    queue_.clear();
    next_ = idx_.seek_point((uint32_t)ms, video_fd_);
    max_fed_ = -1;
    last_out_pts_ = -1;
    still_ = true;
    flushed_ = false;
    eof_sent = false;
    end_since_ = -1;
    char b[96];
    snprintf(b, sizeof b, "seek %lld: from record %zu (pts %u)", (long long)ms, next_,
             idx_.recs.empty() ? 0u : idx_.recs[next_].pts_ms);
    log_(b);
}

void Player::on_frame(const woc::VideoFrame &f, int64_t now)
{
    decoded++;
    const int64_t pts = f.pts_ms >= 0 ? f.pts_ms : last_out_pts_ + dur_;
    last_out_pts_ = pts;
    if (target_ >= 0) {
        if (pts < target_)
            return;   /* before the seek target: not shown, not a drop */
        target_ = -1;
    }
    if (!f.y || !video_on_ || (running() && !still_ && pts < pos(now) - 2 * dur_)) {
        dropped++;
        return;
    }
    if (f.w != out_->w() || f.h != out_->h()) {
        log_("decoder frame size differs from the output: dropped");
        dropped++;
        return;
    }
    Staged s;
    s.pts = pts;
    if (!pool_.empty()) {
        s.i420 = std::move(pool_.back());
        pool_.pop_back();
    }
    s.i420.resize(out_->frame_size());
    nv12_to_i420(f.y, f.uv, f.pitch, f.w, f.h, s.i420.data());
    queue_.push_back(std::move(s));
}

void Player::show(Staged &s, int64_t now)
{
    memcpy(out_->begin(), s.i420.data(), s.i420.size());
    out_->commit();
    shown++;
    last_shown_pts = s.pts;
    if (running()) {
        late_sum_ += (double)(pos(now) - s.pts);
        late_n_++;
    }
    pool_.push_back(std::move(s.i420));
}

bool Player::feed_one(int64_t now)
{
    if (next_ >= idx_.recs.size()) {
        if (end_since_ < 0 || now - last_poll_ >= 250) {
            last_poll_ = now;
            idx_.refresh();
        }
        if (next_ >= idx_.recs.size()) {
            if (end_since_ < 0)
                end_since_ = now;
            return false;
        }
    }
    end_since_ = -1;
    const IndexRec &r = idx_.recs[next_];
    struct stat st;
    if (fstat(video_fd_, &st) != 0 || (uint64_t)st.st_size < r.pos + r.size)
        return false;   /* the index has it, the video is still coming */
    au_.resize(r.size);
    if (pread(video_fd_, au_.data(), r.size, (off_t)r.pos) != (ssize_t)r.size)
        return false;
    const int64_t pts = r.pts_ms;
    max_fed_ = pts > max_fed_ ? pts : max_fed_;
    /* Every frame this feed can put out has pts <= max_fed_ (display order),
     * so when that is already before the target or too late, skip VPP. */
    int64_t limit = std::numeric_limits<int64_t>::min();
    if (target_ >= 0)
        limit = target_;
    else if (running() && !still_)
        limit = pos(now) - 2 * dur_;
    const bool picture = max_fed_ >= limit;
    next_++;
    std::string err;
    if (!dec_->feed(au_.data(), au_.size(), pts, picture, [&](const woc::VideoFrame &f) { on_frame(f, now); },
                    &err)) {
        if (err != last_err_)
            log_("decode: record " + std::to_string(next_ - 1) + ": " + err);
        last_err_ = err;
    }
    return true;
}

void Player::stats(int64_t now)
{
    const double secs = (now - stats_at_) / 1000.0;
    char b[256];
    snprintf(b, sizeof b,
             "{\"ev\":\"stats\",\"decoded\":%llu,\"shown\":%llu,\"dropped\":%llu,\"late_ms\":%.1f,\"cpu_pct\":%.1f,"
             "\"fps\":%.1f,\"pos_ms\":%lld}",
             (unsigned long long)decoded, (unsigned long long)shown, (unsigned long long)dropped,
             late_n_ ? late_sum_ / late_n_ : 0.0, cpu_ ? cpu_() : 0.0, secs > 0 ? (shown - s_shown_) / secs : 0.0,
             (long long)pos(now));
    emit_(b);
    stats_at_ = now;
    s_shown_ = shown;
    late_sum_ = 0, late_n_ = 0;
}

int Player::step(int64_t now)
{
    if (stats_at_ < 0)
        stats_at_ = now;
    if (now - stats_at_ >= kStatsMs)
        stats(now);
    if (!open_inputs(now))
        return 100;
    if (!video_on_)
        return 100;

    while (!queue_.empty()) {
        Staged &s = queue_.front();
        if (running()) {
            const int64_t p = pos(now);
            if (!still_ && s.pts < p - 2 * dur_) {
                dropped++;
                pool_.push_back(std::move(s.i420));
            } else if (still_ || s.pts <= p + kLead) {
                show(s, now);
                still_ = false;
            } else {
                break;
            }
        } else {
            if (!still_)
                break;
            show(s, now);
            still_ = false;
        }
        queue_.pop_front();
    }

    const bool fed = queue_.size() < kQueue && feed_one(now);
    if (!fed && end_since_ >= 0 && next_ >= idx_.recs.size()) {
        /* No end marker: video.h264 under its final name (renamed from .part)
         * is the end. A .part that stops growing is a stall, never the end. */
        const bool complete = access((dir_ + "/video.h264").c_str(), F_OK) == 0;
        if (complete && !flushed_) {
            dec_->flush([&](const woc::VideoFrame &f) { on_frame(f, now); });
            flushed_ = true;
        }
        if (flushed_ && queue_.empty() && !eof_sent) {
            emit_("{\"ev\":\"eof\"}");
            log_("eof");
            eof_sent = true;
        }
    }
    if (fed)
        return 0;
    if (!queue_.empty() && running()) {
        const int64_t w = queue_.front().pts - kLead - pos(now);
        return w < 1 ? 1 : w > 20 ? 20 : (int)w;
    }
    return queue_.empty() && !flushed_ ? 20 : 100;
}

bool Player::command(const std::string &line, int64_t now)
{
    long long a = 0, b = 0;
    char word[16] = {0};
    if (sscanf(line.c_str(), "%15s", word) != 1)
        return true;
    const std::string cmd = word;
    if (cmd == "clock" && sscanf(line.c_str(), "%*s %lld %lld", &a, &b) == 2) {
        has_clock_ = true;
        elapsed_ = a, mono_ = b;
        if (paused_)
            frozen_ = a;
    } else if (cmd == "pause") {
        frozen_ = pos(now);
        paused_ = true;
    } else if (cmd == "resume") {
        if (paused_) {
            paused_ = false;
            elapsed_ = frozen_, mono_ = now;
        }
    } else if (cmd == "seek" && sscanf(line.c_str(), "%*s %lld", &a) == 1) {
        seek(a, now);
    } else if (cmd == "video" && sscanf(line.c_str(), "%*s %lld", &a) == 1) {
        if (!a && video_on_) {
            video_on_ = false;
            for (auto &s : queue_)
                pool_.push_back(std::move(s.i420));
            queue_.clear();
        } else if (a && !video_on_) {
            video_on_ = true;
            seek(has_clock_ ? pos(now) : last_shown_pts >= 0 ? last_shown_pts : frozen_, now);
        }
    } else if (cmd == "quit") {
        return false;
    } else {
        log_("unknown command: " + line);
    }
    return true;
}

}  // namespace ytdec
