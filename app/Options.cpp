#include "app/Options.hpp"

#include <charconv>
#include <cstdio>
#include <string_view>

namespace radar::app {

void printUsage(const char* argv0) {
    std::fprintf(stderr,
                 "usage: %s --device <leechcore-device> [options]\n"
                 "       %s --offline [options]\n"
                 "\n"
                 "Memory source:\n"
                 "  --device <str>        LeechCore device, e.g. \"qemu://hugepage-pid=<qemu pid>\",\n"
                 "                        or a raw memory dump file path\n"
                 "  --vmm-arg <arg>       extra argument passed to VMM (repeatable)\n"
                 "  --vmm-printf          show VMM's own output\n"
                 "  --once                attach, print module info and exit (connectivity check)\n"
                 "  --diagnose            check the whole read chain once (best in a raid), print a report, exit\n"
                 "  --quest-probe <file>  with --diagnose: also dump the quests' templates and progress as JSON\n"
                 "  --locale-probe <file> with --diagnose: also look the exfils up in the game's text table, as JSON\n"
                 "  --timeout <sec>       give up if not attached within <sec> seconds\n"
                 "\n"
                 "Server:\n"
                 "  --listen <addr:port>  HTTP/WebSocket listen address (default 127.0.0.1:8080)\n"
                 "  --web-root <dir>      built frontend (default web/dist)\n"
                 "  --maps-root <dir>     map folders (default maps)\n"
                 "  --data-root <dir>     item/quest data (default data)\n"
                 "  --no-server           don't start the server\n"
                 "  --offline             no memory source: serve the frontend and past recordings only\n"
                 "\n"
                 "Raid recordings (one file per raid, browsed and replayed in the frontend):\n"
                 "  --recordings <dir>    where recordings go (default recordings)\n"
                 "  --no-record           don't record raids\n"
                 "  --keep-recordings <n> keep only the newest <n> recordings\n"
                 "\n"
                 "Overlay (Wayland; configured in the frontend: Settings, Overlay):\n"
                 "  --overlay             draw the player's view in a transparent window over the game's picture\n"
                 "  --overlay-output <n>  the monitor to cover (Wayland output name, e.g. DP-1)\n"
                 "  --overlay-font <file> TrueType font for its labels\n"
                 "  --overlay-stretch     the game's picture is stretched to fill the monitor (e.g. 4:3 stretched),\n"
                 "                        not letterboxed to its aspect\n"
                 "  --overlay-immediate   draw as soon as the compositor asks, not just in time for the vblank\n"
                 "                        (to compare)\n"
                 "  --overlay-test        draw a test pattern and why nothing else shows (implies --overlay)\n"
                 "\n"
                 "  --verbose             debug logging\n",
                 argv0, argv0);
}

std::optional<Options> parseOptions(int argc, char** argv, std::string& error) {
    Options opt;
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        auto value = [&]() -> std::optional<std::string> {
            if (i + 1 >= argc) {
                error = std::string(arg) + " needs a value";
                return std::nullopt;
            }
            return std::string(argv[++i]);
        };
#define VALUE_OR_FAIL(name) \
    auto name = value();    \
    if (!name) return std::nullopt

        if (arg == "--help" || arg == "-h") {
            error.clear();
            return std::nullopt;
        } else if (arg == "--device") {
            VALUE_OR_FAIL(v);
            opt.vmm.device = *v;
        } else if (arg == "--vmm-arg") {
            VALUE_OR_FAIL(v);
            opt.vmm.extraArgs.push_back(*v);
        } else if (arg == "--vmm-printf") {
            opt.vmm.vmmPrintf = true;
        } else if (arg == "--once") {
            opt.once = true;
        } else if (arg == "--diagnose") {
            opt.diagnose = true;
        } else if (arg == "--quest-probe") {
            VALUE_OR_FAIL(v);
            opt.questProbe = *v;
            opt.diagnose = true;
        } else if (arg == "--locale-probe") {
            VALUE_OR_FAIL(v);
            opt.localeProbe = *v;
            opt.diagnose = true;
        } else if (arg == "--timeout") {
            VALUE_OR_FAIL(v);
            int seconds = 0;
            const auto r = std::from_chars(v->data(), v->data() + v->size(), seconds);
            if (r.ec != std::errc{} || r.ptr != v->data() + v->size() || seconds <= 0) {
                error = "--timeout: expected a positive number of seconds";
                return std::nullopt;
            }
            opt.timeoutSeconds = seconds;
        } else if (arg == "--verbose") {
            opt.verbose = true;
        } else if (arg == "--listen") {
            VALUE_OR_FAIL(v);
            // <host>:<port>, with IPv6 hosts in brackets: [::1]:8080
            const auto colon = v->rfind(':');
            unsigned port = 0;
            const char* first = colon == std::string::npos ? nullptr : v->data() + colon + 1;
            const char* last = v->data() + v->size();
            const auto parsed = first ? std::from_chars(first, last, port) : std::from_chars_result{nullptr, std::errc::invalid_argument};
            if (!first || parsed.ec != std::errc{} || parsed.ptr != last || port == 0 || port > 65535 || colon == 0) {
                error = "--listen: expected <address>:<port>, e.g. 127.0.0.1:8080 or [::1]:8080";
                return std::nullopt;
            }
            std::string host = v->substr(0, colon);
            if (host.size() >= 2 && host.front() == '[' && host.back() == ']') host = host.substr(1, host.size() - 2);
            opt.server.bindAddress = host;
            opt.server.port = static_cast<std::uint16_t>(port);
        } else if (arg == "--web-root") {
            VALUE_OR_FAIL(v);
            opt.server.webRoot = *v;
        } else if (arg == "--maps-root") {
            VALUE_OR_FAIL(v);
            opt.server.mapsRoot = *v;
        } else if (arg == "--data-root") {
            VALUE_OR_FAIL(v);
            opt.server.dataRoot = *v;
        } else if (arg == "--no-server") {
            opt.noServer = true;
        } else if (arg == "--offline") {
            opt.offline = true;
        } else if (arg == "--recordings") {
            VALUE_OR_FAIL(v);
            opt.server.recordingsRoot = *v;
        } else if (arg == "--no-record") {
            opt.noRecord = true;
        } else if (arg == "--keep-recordings") {
            VALUE_OR_FAIL(v);
            int n = 0;
            const auto r = std::from_chars(v->data(), v->data() + v->size(), n);
            if (r.ec != std::errc{} || r.ptr != v->data() + v->size() || n <= 0) {
                error = "--keep-recordings: expected a positive number";
                return std::nullopt;
            }
            opt.keepRecordings = n;
        } else if (arg == "--overlay") {
            opt.overlay = true;
        } else if (arg == "--overlay-stretch") {
            opt.overlayStretch = true;
        } else if (arg == "--overlay-immediate") {
            opt.overlayImmediate = true;
        } else if (arg == "--overlay-test") {
            opt.overlay = true;
            opt.overlayTest = true;
        } else if (arg == "--overlay-output") {
            VALUE_OR_FAIL(v);
            opt.overlayOutput = *v;
        } else if (arg == "--overlay-font") {
            VALUE_OR_FAIL(v);
            opt.overlayFont = *v;
        } else if (arg == "--record" || arg == "--replay") {
            error = std::string(arg) + " is gone: raids are recorded automatically (--recordings, --no-record), "
                                        "and replayed in the frontend (--offline without a game)";
            return std::nullopt;
        } else {
            error = "unknown option: " + std::string(arg);
            return std::nullopt;
        }
#undef VALUE_OR_FAIL
    }
    if (opt.overlay && (opt.offline || opt.noServer)) {
        error = "--overlay needs the live mode with the server (it's configured from the frontend)";
        return std::nullopt;
    }
#ifndef RADAR_HAVE_OVERLAY_WINDOW
    if (opt.overlay) {
        error = "--overlay: this build has no overlay window (configure with the Wayland, EGL and OpenGL ES "
                "development files installed; see overlay/CMakeLists.txt)";
        return std::nullopt;
    }
#endif
    if (opt.offline && !opt.vmm.device.empty()) {
        error = "--offline and --device are mutually exclusive";
        return std::nullopt;
    }
    if (!opt.offline && opt.vmm.device.empty()) {
        error = "--device (or --offline) is required";
        return std::nullopt;
    }
    if (opt.offline && (opt.diagnose || opt.once)) {
        error = "--diagnose and --once need --device, not --offline";
        return std::nullopt;
    }
    if (opt.offline && opt.noServer) {
        error = "--offline needs the server";
        return std::nullopt;
    }
    opt.server.live = !opt.offline;
    return opt;
}

}  // namespace radar::app
