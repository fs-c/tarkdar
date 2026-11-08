#include "app/Options.hpp"

#include <charconv>
#include <cstdio>
#include <string_view>

namespace radar::app {

void printUsage(const char* argv0) {
    std::fprintf(stderr,
                 "usage: %s --device <leechcore-device> [options]\n"
                 "       %s --replay <stream.jsonl> [options]\n"
                 "\n"
                 "Memory source:\n"
                 "  --device <str>        LeechCore device, e.g. \"qemu://hugepage-pid=<qemu pid>\",\n"
                 "                        or a raw memory dump file path\n"
                 "  --vmm-arg <arg>       extra argument passed to VMM (repeatable)\n"
                 "  --vmm-printf          show VMM's own output\n"
                 "  --once                attach, print module info and exit (connectivity check)\n"
                 "  --diagnose            check the whole read chain once (best in a raid), print a report, exit\n"
                 "  --timeout <sec>       give up if not attached within <sec> seconds\n"
                 "\n"
                 "Server:\n"
                 "  --listen <addr:port>  HTTP/WebSocket listen address (default 127.0.0.1:8080)\n"
                 "  --web-root <dir>      built frontend (default web/dist)\n"
                 "  --maps-root <dir>     map folders (default maps)\n"
                 "  --data-root <dir>     item/quest data (default data)\n"
                 "  --no-server           don't start the server\n"
                 "  --record <file>       append every streamed message to <file> (JSON Lines)\n"
                 "  --replay <file>       serve a recorded stream; no memory source needed\n"
                 "  --replay-speed <x>    replay speed factor (default 1)\n"
                 "  --replay-once         stop at the end of the recording instead of looping\n"
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
        } else if (arg == "--record") {
            VALUE_OR_FAIL(v);
            opt.record = *v;
        } else if (arg == "--replay") {
            VALUE_OR_FAIL(v);
            opt.replay = *v;
        } else if (arg == "--replay-speed") {
            VALUE_OR_FAIL(v);
            try {
                opt.replaySpeed = std::stod(*v);
            } catch (...) {
                opt.replaySpeed = 0;
            }
            if (!(opt.replaySpeed > 0)) {
                error = "--replay-speed: expected a positive number";
                return std::nullopt;
            }
        } else if (arg == "--replay-once") {
            opt.replayLoop = false;
        } else {
            error = "unknown option: " + std::string(arg);
            return std::nullopt;
        }
#undef VALUE_OR_FAIL
    }
    if (opt.replay && !opt.vmm.device.empty()) {
        error = "--replay and --device are mutually exclusive";
        return std::nullopt;
    }
    if (!opt.replay && opt.vmm.device.empty()) {
        error = "--device (or --replay) is required";
        return std::nullopt;
    }
    if (opt.replay && opt.diagnose) {
        error = "--diagnose needs --device, not --replay";
        return std::nullopt;
    }
    if (opt.replay && opt.noServer) {
        error = "--replay needs the server";
        return std::nullopt;
    }
    return opt;
}

}  // namespace radar::app
