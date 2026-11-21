// radar-diagnose: one-shot check of the whole read chain against the running game (or a memory
// dump), best run while in a raid. Prints a report where every step says what it read and which
// offsets it depended on (see Diagnose.hpp).
//
// Exit code: 0 if a raid was found and every step produced data, 1 otherwise, 2 for usage errors.
//
//   sudo ./build/bin/radar-diagnose --device "qemu://hugepage-pid=$(pgrep -f 'qemu-system.*guest=<vm>')"
//   ./build/bin/radar-diagnose --device raid.raw

#include "core/log/Log.hpp"
#include "core/mem/Target.hpp"
#include "core/mem/VmmBackend.hpp"
#include "game/eft/Names.hpp"
#include "tools/diagnose/Diagnose.hpp"

#include <atomic>
#include <charconv>
#include <csignal>
#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

namespace {

std::atomic<bool> gStop{false};
void onSignal(int) { gStop.store(true); }

void usage(const char* argv0) {
    std::fprintf(stderr,
                 "usage: %s --device <leechcore-device> [options]\n"
                 "\n"
                 "  --device <str>     LeechCore device, e.g. \"qemu://hugepage-pid=<qemu pid>\" or a raw dump file\n"
                 "  --vmm-arg <arg>    extra argument passed to VMM (repeatable)\n"
                 "  --vmm-printf       show VMM's own output\n"
                 "  --timeout <sec>    give up if the game isn't attached within <sec> seconds (default 30)\n"
                 "  --verbose          debug logging\n",
                 argv0);
}

}  // namespace

int main(int argc, char** argv) {
    using namespace radar;
    mem::VmmConfig config;
    int timeoutSeconds = 30;
    for (int i = 1; i < argc; ++i) {
        const std::string_view a = argv[i];
        auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : nullptr; };
        if (a == "--help" || a == "-h") {
            usage(argv[0]);
            return 0;
        } else if (a == "--device" && i + 1 < argc) config.device = next();
        else if (a == "--vmm-arg" && i + 1 < argc) config.extraArgs.emplace_back(next());
        else if (a == "--vmm-printf") config.vmmPrintf = true;
        else if (a == "--timeout" && i + 1 < argc) {
            const std::string_view v = next();
            const auto r = std::from_chars(v.data(), v.data() + v.size(), timeoutSeconds);
            if (r.ec != std::errc{} || r.ptr != v.data() + v.size() || timeoutSeconds <= 0) {
                std::fprintf(stderr, "error: --timeout: expected a positive number of seconds\n\n");
                usage(argv[0]);
                return 2;
            }
        } else if (a == "--verbose") log::setMinLevel(log::Level::Debug);
        else {
            usage(argv[0]);
            return 2;
        }
    }
    if (config.device.empty()) {
        usage(argv[0]);
        return 2;
    }

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    mem::VmmBackend backend(config);
    log::info("opening memory source: {}", config.device);
    if (auto opened = backend.open(); !opened) {
        log::error("{}", opened.error());
        return 1;
    }
    const std::vector<std::string> modules(eft::kRequiredModules.begin(), eft::kRequiredModules.end());
    mem::Target target(backend, std::string(eft::kProcessName), modules);

    const int result = diagnose::runDiagnose(target, timeoutSeconds, stdout, &gStop);
    backend.close();
    return result;
}
