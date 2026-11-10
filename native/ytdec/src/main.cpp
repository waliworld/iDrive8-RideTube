/* ytdec: the video half of RideTube.
 *
 *   ytdec --dir <folder> --rect <W>x<H> [--fill] [--log <file>]
 *
 * Reads <folder>/index.bin + video.h264 (yt/proxy), decodes on the GPU
 * (Intel Media SDK, decoder_msdk.cpp from waze-on-cluster), fits (or with
 * --fill crops) each picture into W x H (default 1280x720) and writes it to
 * /dev/shm/mgu-video-ridetube for mgu-render, paced by the audio clock from stdin.
 * stdin, one command a line: clock <elapsed_ms> <mono_ms> | pause | resume |
 * seek <ms> | video 0|1 | quit (EOF = quit). stdout: JSON lines, ready,
 * stats every 2 s, eof, error. player.h has the rules.
 *
 * A core dump reboots the head unit: dumping is off before anything else,
 * and every fatal signal writes one log line and _exit(70)s. */
#include "decoder_msdk.h"
#include "mgvf.h"
#include "player.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

#include <exception>
#include <string>

#ifndef YTDEC_VERSION
#define YTDEC_VERSION "dev"
#endif

namespace {

int g_log = 2;   /* log fd; stderr until --log opens */

const char kShmPath[] = "/dev/shm/mgu-video-ridetube";

int64_t mono_ms()
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

void log_line(const std::string &msg)
{
    char ts[40];
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);
    struct tm tm;
    localtime_r(&t.tv_sec, &tm);
    size_t n = strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", &tm);
    snprintf(ts + n, sizeof ts - n, ".%03ld ", t.tv_nsec / 1000000);
    std::string l = ts + msg + "\n";
    if (write(g_log, l.data(), l.size()) < 0) {
    }
}

void emit(const std::string &json)
{
    std::string l = json + "\n";
    /* stdout is a pipe to ytd.js: one write per line, never buffered. */
    if (write(1, l.data(), l.size()) < 0 && errno == EPIPE)
        _exit(0);
}

/* async-signal-safe: one line, then out, never a core */
void on_fatal(int sig)
{
    char b[64] = "ytdec: fatal signal ";
    size_t n = strlen(b);
    if (sig >= 10) b[n++] = (char)('0' + sig / 10);
    b[n++] = (char)('0' + sig % 10);
    b[n++] = '\n';
    if (write(g_log, b, n) < 0) {
    }
    if (g_log != 2 && write(2, b, n) < 0) {
    }
    _exit(70);
}

void crash_hygiene()
{
#ifdef __linux__
    prctl(PR_SET_DUMPABLE, 0);
#endif
    struct rlimit no_core = {0, 0};
    setrlimit(RLIMIT_CORE, &no_core);
    static char altstack[64 * 1024];
    stack_t ss;
    memset(&ss, 0, sizeof ss);
    ss.ss_sp = altstack;
    ss.ss_size = sizeof altstack;
    sigaltstack(&ss, nullptr);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_fatal;
    sa.sa_flags = SA_ONSTACK | SA_RESETHAND;
    sigemptyset(&sa.sa_mask);
    const int sigs[] = {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT, SIGQUIT, SIGTRAP, SIGSYS};
    for (int s : sigs)
        sigaction(s, &sa, nullptr);
    std::set_terminate([] {
        static const char m[] = "ytdec: std::terminate\n";
        if (write(g_log, m, sizeof m - 1) < 0) {
        }
        _exit(70);
    });
    signal(SIGPIPE, SIG_IGN);
}

class MsdkDecoder : public ytdec::VideoDecoder {
public:
    woc::Decoder d;
    bool feed(const uint8_t *au, size_t len, int64_t pts_ms, bool picture, const Sink &cb, std::string *err) override
    {
        return d.feed(au, len, cb, err, true, picture, pts_ms);
    }
    void flush(const Sink &cb) override { d.flush(cb); }
};

/* this process's CPU since the last call, % of one core */
double cpu_pct()
{
    static int64_t last_wall = 0;
    static double last_cpu = 0;
    struct rusage ru;
    getrusage(RUSAGE_SELF, &ru);
    const double cpu = ru.ru_utime.tv_sec + ru.ru_utime.tv_usec / 1e6 + ru.ru_stime.tv_sec + ru.ru_stime.tv_usec / 1e6;
    const int64_t wall = mono_ms();
    double pct = last_wall && wall > last_wall ? 100.0 * (cpu - last_cpu) * 1000.0 / (wall - last_wall) : 0.0;
    last_wall = wall, last_cpu = cpu;
    return pct;
}

int fail(const std::string &msg, int code)
{
    std::string m = msg;
    for (auto &c : m)
        if (c == '"' || c == '\\') c = '\'';
    emit("{\"ev\":\"error\",\"msg\":\"" + m + "\"}");
    log_line("error: " + msg);
    return code;
}

int run(int argc, char **argv)
{
    std::string dir, logpath;
    unsigned w = 1280, h = 720;
    bool fill = false;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--dir" && i + 1 < argc)
            dir = argv[++i];
        else if (a == "--rect" && i + 1 < argc) {
            if (sscanf(argv[++i], "%ux%u", &w, &h) != 2)
                return fail("--rect wants WxH", 2);
        } else if (a == "--fill")
            fill = true;
        else if (a == "--log" && i + 1 < argc)
            logpath = argv[++i];
        else
            return fail("usage: ytdec --dir <folder> --rect <W>x<H> [--fill] [--log <file>]", 2);
    }
    if (dir.empty())
        return fail("usage: ytdec --dir <folder> --rect <W>x<H> [--fill] [--log <file>]", 2);
    if (!logpath.empty()) {
        int fd = open(logpath.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
        if (fd >= 0)
            g_log = fd;
    }
    log_line(std::string("ytdec ") + YTDEC_VERSION + " dir=" + dir + " rect=" + std::to_string(w) + "x" +
             std::to_string(h) + (fill ? " fill" : " fit"));

    ytdec::Mgvf out;
    std::string err, warn;
    if (!out.open(kShmPath, w, h, 3, &err, &warn))
        return fail(err, 2);
    if (!warn.empty())
        log_line(warn);

    MsdkDecoder dec;
    if (!dec.d.init("/dev/dri/renderD128", w, h, fill, &err))
        return fail("decoder: " + err, 1);

    ytdec::Player player(dir, &dec, &out, emit, log_line, cpu_pct);
    cpu_pct();
    fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
    std::string inbuf;
    for (;;) {
        const int wait = player.step(mono_ms());
        struct pollfd p = {0, POLLIN, 0};
        if (poll(&p, 1, wait) < 0 && errno != EINTR)
            return fail(std::string("poll: ") + strerror(errno), 1);
        if (!(p.revents & (POLLIN | POLLHUP | POLLERR)))
            continue;
        char b[4096];
        const ssize_t n = read(0, b, sizeof b);
        if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
            log_line("stdin closed: quit");
            break;
        }
        if (n < 0)
            continue;
        inbuf.append(b, (size_t)n);
        size_t nl;
        bool quit = false;
        while (!quit && (nl = inbuf.find('\n')) != std::string::npos) {
            std::string line = inbuf.substr(0, nl);
            inbuf.erase(0, nl + 1);
            if (!line.empty() && line.back() == '\r')
                line.pop_back();
            quit = !player.command(line, mono_ms());
        }
        if (quit) {
            log_line("quit");
            break;
        }
        if (inbuf.size() > 65536)
            inbuf.clear();   /* no newline in 64 KiB: not ours */
    }
    out.close();
    dec.d.shutdown();
    return 0;
}

}  // namespace

int main(int argc, char **argv)
{
    crash_hygiene();
    try {
        return run(argc, argv);
    } catch (const std::exception &e) {
        log_line(std::string("exception: ") + e.what());
    } catch (...) {
        log_line("unknown exception");
    }
    _exit(70);
}
