// mem-dump: writes the guest's physical memory to a raw dump file, for offline development.
//
// The output is a sparse file where file offset == physical address; holes in the physical memory
// map stay unallocated (they read as zeros). That's the plain "raw" format VMM/LeechCore open as a
// device: radar-backend --device <file>.
//
// Pause the VM first (e.g. `virsh suspend <vm>`) so the dump is consistent; QEMU's guest RAM stays
// readable while paused. Resume afterwards (`virsh resume <vm>`).

#include "core/log/Log.hpp"
#include "core/mem/VmmBackend.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

namespace {

void usage(const char* argv0) {
    std::fprintf(stderr,
                 "usage: %s --device <leechcore-device> --out <file> [options]\n"
                 "\n"
                 "  --device <str>     LeechCore device, e.g. \"qemu://hugepage-pid=<qemu pid>\"\n"
                 "  --out <file>       raw dump file to write (overwritten)\n"
                 "  --vmm-arg <arg>    extra argument passed to VMM (repeatable)\n"
                 "  --vmm-printf       show VMM's own output\n"
                 "  --chunk-mb <n>     read size per request (default 16)\n"
                 "  --verbose          debug logging\n",
                 argv0);
}

}  // namespace

int main(int argc, char** argv) {
    using namespace radar;
    mem::VmmConfig config;
    std::string out;
    std::size_t chunk = 16u << 20;
    for (int i = 1; i < argc; ++i) {
        const std::string_view a = argv[i];
        auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : nullptr; };
        if (a == "--device" && i + 1 < argc) config.device = next();
        else if (a == "--out" && i + 1 < argc) out = next();
        else if (a == "--vmm-arg" && i + 1 < argc) config.extraArgs.emplace_back(next());
        else if (a == "--vmm-printf") config.vmmPrintf = true;
        else if (a == "--chunk-mb" && i + 1 < argc) chunk = std::max<std::size_t>(1, std::stoul(next())) << 20;
        else if (a == "--verbose") log::setMinLevel(log::Level::Debug);
        else {
            usage(argv[0]);
            return 2;
        }
    }
    if (config.device.empty() || out.empty()) {
        usage(argv[0]);
        return 2;
    }

    mem::VmmBackend backend(config);
    if (auto opened = backend.open(); !opened) {
        log::error("{}", opened.error());
        return 1;
    }
    const auto ranges = backend.physicalMemoryMap();
    if (ranges.empty()) {
        log::error("couldn't read the guest's physical memory map");
        return 1;
    }
    std::uint64_t total = 0, end = 0;
    for (const auto& r : ranges) {
        log::info("  range {:#014x} – {:#014x} ({} MiB)", r.base, r.base + r.size, r.size >> 20);
        total += r.size;
        end = std::max(end, r.base + r.size);
    }
    log::info("dumping {} MiB of physical memory in {} ranges to {}", total >> 20, ranges.size(), out);

    const int fd = ::open(out.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        log::error("can't open {}: {}", out, std::strerror(errno));
        return 1;
    }

    std::vector<std::byte> buf(chunk);
    std::uint64_t done = 0, failedBytes = 0;
    int lastPercent = -1;
    const auto start = std::chrono::steady_clock::now();
    for (const auto& r : ranges) {
        for (std::uint64_t off = 0; off < r.size; off += chunk) {
            const auto n = static_cast<std::size_t>(std::min<std::uint64_t>(chunk, r.size - off));
            const auto span = std::span(buf).first(n);
            // Unreadable pages come back zero-filled; count them but keep going.
            if (!backend.read(mem::VmmBackend::kPhysicalMemory, r.base + off, span, mem::Freshness::Fresh))
                failedBytes += n;
            const auto* p = reinterpret_cast<const char*>(span.data());
            std::size_t written = 0;
            while (written < n) {
                const ssize_t w = ::pwrite(fd, p + written, n - written, static_cast<off_t>(r.base + off + written));
                if (w < 0) {
                    log::error("write failed: {}", std::strerror(errno));
                    ::close(fd);
                    return 1;
                }
                written += static_cast<std::size_t>(w);
            }
            done += n;
            const int percent = static_cast<int>(done * 100 / total);
            if (percent / 5 != lastPercent / 5) {
                log::info("  {}%", percent);
                lastPercent = percent;
            }
        }
    }
    // Make the file cover the whole physical address range even if it ends in a hole.
    if (::ftruncate(fd, static_cast<off_t>(end)) != 0) log::warn("ftruncate failed: {}", std::strerror(errno));
    ::close(fd);
    backend.close();

    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    log::info("done: {} MiB in {:.1f} s{}", total >> 20, secs,
              failedBytes ? std::format(" ({} MiB unreadable, written as zeros)", failedBytes >> 20) : "");
    log::info("open it with: radar-backend --device {}", out);
    return 0;
}
