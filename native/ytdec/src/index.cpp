#include "index.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

namespace ytdec {

namespace {

const size_t kHead = 32, kRec = 17;

uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
uint64_t le64(const uint8_t *p) { return le32(p) | (uint64_t)le32(p + 4) << 32; }

}  // namespace

Index::~Index()
{
    if (fd_ >= 0)
        close(fd_);
}

bool Index::open(const std::string &path, std::string *err)
{
    int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        if (errno != ENOENT)
            *err = "open " + path + ": " + strerror(errno);
        return false;
    }
    uint8_t h[kHead];
    if (pread(fd, h, kHead, 0) != (ssize_t)kHead) {
        close(fd);
        return false;   /* header not written yet */
    }
    if (memcmp(h, "MGYI", 4) != 0 || le16(h + 4) != 1) {
        close(fd);
        *err = path + ": not an MGYI version 1 index";
        return false;
    }
    w = le16(h + 6), this->h = le16(h + 8), fps_num = le16(h + 10), fps_den = le16(h + 12);
    fd_ = fd;
    refresh();
    return true;
}

bool Index::refresh()
{
    uint8_t c[4];
    if (fd_ < 0 || pread(fd_, c, 4, 16) != 4)
        return false;
    const uint32_t n = le32(c);
    if (n <= recs.size())
        return false;
    /* Only records fully on disk; the count may run ahead of them. */
    std::vector<uint8_t> buf((n - recs.size()) * kRec);
    const ssize_t got = pread(fd_, buf.data(), buf.size(), (off_t)(kHead + recs.size() * kRec));
    if (got <= 0)
        return false;
    const size_t whole = (size_t)got / kRec;
    for (size_t i = 0; i < whole; i++) {
        const uint8_t *p = &buf[i * kRec];
        recs.push_back(IndexRec{le32(p), le64(p + 4), le32(p + 12), p[16]});
    }
    clean_.resize(recs.size(), -1);
    return whole > 0;
}

uint32_t nal_types(const uint8_t *p, size_t n)
{
    uint32_t mask = 0;
    for (size_t i = 0; i + 3 < n; i++) {
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1) {
            mask |= 1u << (p[i + 3] & 0x1f);
            i += 2;
        }
    }
    return mask;
}

size_t Index::seek_point(uint32_t ms, int video_fd)
{
    for (size_t i = recs.size(); i-- > 0;) {
        const IndexRec &r = recs[i];
        if (!r.key || r.pts_ms > ms)
            continue;
        if (clean_[i] < 0) {
            /* SPS/PPS/SEI come first in the access unit; 64 KiB covers them. */
            std::vector<uint8_t> b(r.size < 65536 ? r.size : 65536);
            const ssize_t got = pread(video_fd, b.data(), b.size(), (off_t)r.pos);
            clean_[i] = got > 0 && (nal_types(b.data(), (size_t)got) & (1u << 7)) ? 1 : 0;
        }
        if (clean_[i] == 1)
            return i;
    }
    return 0;
}

}  // namespace ytdec
