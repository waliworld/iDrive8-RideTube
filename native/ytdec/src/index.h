/* MGYI frame index (yt/proxy/mgyi.py): a 32-byte header ("MGYI", u16
 * version 1, u16 w, h, fps_num, fps_den, u32 frame count at offset 16), then
 * 17-byte little-endian records in decoding order: u32 pts_ms, u64 pos,
 * u32 size, u8 key. The file may grow while it is read (refresh()). */
#ifndef YTDEC_INDEX_H
#define YTDEC_INDEX_H

#include <stddef.h>
#include <stdint.h>
#include <string>
#include <vector>

namespace ytdec {

struct IndexRec {
    uint32_t pts_ms;
    uint64_t pos;
    uint32_t size;
    uint8_t key;   /* ffprobe's keyframe flag: IDR, or an open-GOP recovery-point I-frame */
};

class Index {
public:
    ~Index();
    /* Opens the index; false (no error) while it does not exist yet. */
    bool open(const std::string &path, std::string *err);
    /* Reads records appended since the last call; true when the count grew. */
    bool refresh();
    bool is_open() const { return fd_ >= 0; }

    uint16_t w = 0, h = 0, fps_num = 0, fps_den = 0;
    std::vector<IndexRec> recs;

    /* The last record in decoding order with pts <= ms that a decoder can
     * start from after a reset: a keyframe whose access unit carries an SPS
     * (h264_mp4toannexb puts SPS/PPS before every IDR). video_fd: the
     * Annex-B file, to look at the access unit's NAL types. 0 if none. */
    size_t seek_point(uint32_t ms, int video_fd);

private:
    int fd_ = -1;
    std::vector<int8_t> clean_;   /* per record: -1 unknown, 0 no, 1 has SPS */
};

/* NAL unit types present in an Annex-B buffer, as a bit mask (1 << type). */
uint32_t nal_types(const uint8_t *p, size_t n);

}  // namespace ytdec

#endif
