// il2cpp-dump: dumps the game's IL2CPP class metadata (classes, parents, fields with offsets) and the
// Unity globals to a JSON file, for tools/update-offsets.py. Usage: docs/offset-tools.md.

#include "core/log/Log.hpp"
#include "core/mem/Pe.hpp"
#include "core/mem/Target.hpp"
#include "core/mem/VmmBackend.hpp"
#include "game/eft/Names.hpp"
#include "tools/il2cpp-dump/Dumper.hpp"

#include <eft_offsets.hpp>

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>

namespace {

void usage(const char* argv0) {
    std::fprintf(stderr,
                 "usage: %s --device <leechcore-device> [options]\n"
                 "\n"
                 "  --device <str>         LeechCore device (QEMU guest or raw memory dump file)\n"
                 "  --vmm-arg <arg>        extra argument passed to VMM (repeatable)\n"
                 "  --vmm-printf           show VMM's own output\n"
                 "  --out <file>           output file (default il2cpp-dump.json)\n"
                 "  --namespace <prefix>   only write classes whose namespace starts with <prefix>\n"
                 "  --class <text>         only write classes whose full name contains <text>\n"
                 "  --type-info-rva <hex>  use this GameAssembly RVA for the type-info table global\n"
                 "  --no-broad             don't fall back to scanning every RIP-relative mov\n"
                 "  --no-unity             skip the UnityPlayer globals\n"
                 "  --timeout <sec>        wait at most this long for the game (default 60)\n"
                 "  --verbose              debug logging\n",
                 argv0);
}

}  // namespace

int main(int argc, char** argv) {
    using namespace radar;

    mem::VmmConfig vmm;
    tools::DumpOptions options;
    options.fallbackTypeInfoRva = off::bootstrap::typeInfoTableRva;
    std::filesystem::path out = "il2cpp-dump.json";
    int timeoutSeconds = 60;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto value = [&]() -> std::string {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "error: %s needs a value\n", arg.c_str());
                std::exit(2);
            }
            return argv[++i];
        };
        try {
            if (arg == "--device") vmm.device = value();
            else if (arg == "--vmm-arg") vmm.extraArgs.push_back(value());
            else if (arg == "--vmm-printf") vmm.vmmPrintf = true;
            else if (arg == "--out") out = value();
            else if (arg == "--namespace") options.namespaceFilter = value();
            else if (arg == "--class") options.classFilter = value();
            else if (arg == "--type-info-rva") options.typeInfoRvaOverride = std::stoull(value(), nullptr, 16);
            else if (arg == "--no-broad") options.broadScan = false;
            else if (arg == "--no-unity") options.unity = false;
            else if (arg == "--timeout") timeoutSeconds = std::stoi(value());
            else if (arg == "--verbose") log::setMinLevel(log::Level::Debug);
            else if (arg == "--help" || arg == "-h") {
                usage(argv[0]);
                return 0;
            } else {
                std::fprintf(stderr, "error: unknown option %s\n\n", arg.c_str());
                usage(argv[0]);
                return 2;
            }
        } catch (const std::exception&) {
            std::fprintf(stderr, "error: invalid value for %s\n", arg.c_str());
            return 2;
        }
    }
    if (vmm.device.empty()) {
        usage(argv[0]);
        return 2;
    }

    mem::VmmBackend backend(vmm);
    if (auto opened = backend.open(); !opened) {
        log::error("{}", opened.error());
        return 1;
    }
    std::vector<std::string> modules(eft::kRequiredModules.begin(), eft::kRequiredModules.end());
    mem::Target target(backend, std::string(eft::kProcessName), modules);
    const auto start = std::chrono::steady_clock::now();
    while (target.poll() != mem::Target::State::Attached) {
        if (std::chrono::steady_clock::now() - start > std::chrono::seconds(timeoutSeconds)) {
            log::error("{} not attached within {} s ({})", eft::kProcessName, timeoutSeconds,
                       mem::stateName(target.state()));
            return 1;
        }
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    const auto view = target.view();
    const auto gameAssembly = *target.module(std::string(eft::kGameAssembly));
    const auto unityPlayer = target.module(std::string(eft::kUnityPlayer));
    log::info("attached to {} (pid {}); dumping...", target.processName(), target.pid().value_or(0));

    tools::Il2CppDumper dumper(view, gameAssembly, unityPlayer, options);
    tools::Dump dump = dumper.run();
    dump.process = target.processName();
    for (const auto& [name, info] : target.modules())
        dump.modules.push_back({name, info, mem::readPeFingerprint(view, info.base)});

    for (const auto& note : dump.notes) log::info("{}", note);
    for (const auto& g : dump.unity)
        log::info("unity {}: {} ({}){}", g.name, g.rva ? std::format("{:#x}", *g.rva) : "-",
                  g.validated ? "validated" : "not validated", g.note.empty() ? "" : " - " + g.note);

    // Write atomically: a crash mid-write leaves the previous file intact.
    const auto tmp = std::filesystem::path(out.string() + ".tmp");
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        f << tools::toJson(dump, options);
        if (!f) {
            log::error("can't write {}", tmp.string());
            return 1;
        }
    }
    std::filesystem::rename(tmp, out);
    log::info("wrote {}", out.string());
    backend.close();
    return dump.table ? 0 : 1;
}
