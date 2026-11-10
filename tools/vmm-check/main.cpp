// vmm-check: sanity-checks the VMM/LeechCore setup against a guest, without anything game-specific.
//
// For a qemu:// device it first checks that the QEMU process exists and that its guest RAM is a
// memfd or file (hugetlbfs) memory backend; plain anonymous RAM can't be mapped by the QEMU plugin.
//
// Opens the device, then checks, in order:
//   1. the guest's physical memory map,
//   2. the Windows version VMM detected,
//   3. the process list (printed),
//   4. a virtual read through the kernel's page tables: the "MZ" header of ntoskrnl.exe in System (pid 4),
//   5. with --process <name>: that process and its main module's "MZ" header (a user-mode read).
//
// Exit code: 0 if every check passed, 1 otherwise, 2 for usage errors.
//
//   sudo ./build/bin/vmm-check --device "qemu://hugepage-pid=$(pgrep -f 'qemu-system.*guest=<vm>')"
//   ./build/bin/vmm-check --device raid.raw

#include "core/log/Log.hpp"
#include "core/mem/VmmBackend.hpp"

#include <unistd.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <string_view>

namespace {

using namespace radar;

void usage(const char* argv0) {
    std::fprintf(stderr,
                 "usage: %s --device <leechcore-device> [options]\n"
                 "\n"
                 "  --device <str>     LeechCore device, e.g. \"qemu://hugepage-pid=<qemu pid>\" or a raw dump file\n"
                 "  --process <name>   also check this process (e.g. explorer.exe) and its main module\n"
                 "  --all              list terminated processes too\n"
                 "  --quiet            don't print the process list\n"
                 "  --vmm-arg <arg>    extra argument passed to VMM (repeatable)\n"
                 "  --vmm-printf       show VMM's own output\n"
                 "  --verbose          debug logging\n",
                 argv0);
}

int failures = 0;

void check(bool ok, std::string_view what, std::string_view detail = {}) {
    if (!ok) ++failures;
    std::printf("[%s] %.*s%s%.*s\n", ok ? " OK " : "FAIL", static_cast<int>(what.size()), what.data(),
                detail.empty() ? "" : ": ", static_cast<int>(detail.size()), detail.data());
}

// Reads the first two bytes of a module and checks for the PE "MZ" signature.
bool hasMzHeader(mem::VmmBackend& backend, mem::Pid pid, mem::Address base) {
    std::array<std::byte, 2> mz{};
    return backend.read(pid, base, mz, mem::Freshness::Fresh) && mz[0] == std::byte{'M'} &&
           mz[1] == std::byte{'Z'};
}

void checkModule(mem::VmmBackend& backend, mem::Pid pid, std::string_view module) {
    const auto mod = backend.findModule(pid, module);
    if (!mod) {
        check(false, std::format("module {} in pid {}", module, pid), "not found");
        return;
    }
    check(hasMzHeader(backend, pid, mod->base), std::format("read {} header in pid {}", module, pid),
          std::format("base {:#x}, size {:#x}", mod->base, mod->size));
}

// Checks QEMU's command line for the guest RAM backend. Returns false if the device can't work.
bool checkQemuRamBackend(std::string_view device) {
    constexpr std::string_view kKey = "hugepage-pid=";
    const auto at = device.find(kKey);
    if (at == std::string_view::npos) return true;  // some other qemu:// form; let VMM decide
    const auto pidText = device.substr(at + kKey.size(), device.find_first_of(",;&", at) - at - kKey.size());
    std::ifstream in(std::format("/proc/{}/cmdline", pidText), std::ios::binary);
    if (!in) {
        check(false, "qemu process", std::format("no process with pid '{}'", pidText));
        return false;
    }
    const std::string cmdline{std::istreambuf_iterator<char>(in), {}};
    if (cmdline.find("qemu") == std::string::npos) {
        check(false, "qemu process", std::format("pid {} isn't QEMU", pidText));
        return false;
    }
    if (cmdline.find("memory-backend-memfd") != std::string::npos)
        check(true, "guest RAM backend", "memfd");
    else if (cmdline.find("memory-backend-file") != std::string::npos)
        check(true, "guest RAM backend", "file (hugetlbfs?)");
    else if (cmdline.find("memory-backend-ram") != std::string::npos) {
        check(false, "guest RAM backend",
              "memory-backend-ram (anonymous memory, nothing to map); in the libvirt domain XML add\n"
              "       <memoryBacking><source type='memfd'/><access mode='shared'/></memoryBacking>\n"
              "       and restart the VM (see docs/verification-playbook.md 0.2)");
        return false;
    } else
        check(true, "guest RAM backend", "unknown, trying anyway");
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    mem::VmmConfig config;
    std::string process;
    bool all = false, quiet = false;
    for (int i = 1; i < argc; ++i) {
        const std::string_view a = argv[i];
        auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : nullptr; };
        if (a == "--device" && i + 1 < argc) config.device = next();
        else if (a == "--process" && i + 1 < argc) process = next();
        else if (a == "--all") all = true;
        else if (a == "--quiet") quiet = true;
        else if (a == "--vmm-arg" && i + 1 < argc) config.extraArgs.emplace_back(next());
        else if (a == "--vmm-printf") config.vmmPrintf = true;
        else if (a == "--verbose") log::setMinLevel(log::Level::Debug);
        else {
            usage(argv[0]);
            return 2;
        }
    }
    if (config.device.empty()) {
        usage(argv[0]);
        return 2;
    }

    if (config.device.starts_with("qemu://") && !checkQemuRamBackend(config.device)) return 1;

    mem::VmmBackend backend(config);
    const auto start = std::chrono::steady_clock::now();
    if (auto opened = backend.open(); !opened) {
        check(false, "open device", opened.error());
        if (config.device.starts_with("qemu://") && ::geteuid() != 0)
            std::printf("       not running as root; QEMU's guest memory usually isn't readable otherwise\n");
        std::printf("       rerun with --vmm-printf --vmm-arg -v for VMM's own diagnostics\n");
        return 1;
    }
    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    check(true, "open device", std::format("{} ({:.1f} s)", config.device, secs));

    // 1. Physical memory map.
    const auto ranges = backend.physicalMemoryMap();
    std::uint64_t total = 0;
    for (const auto& r : ranges) total += r.size;
    check(!ranges.empty(), "physical memory map", std::format("{} ranges, {} MiB", ranges.size(), total >> 20));

    // 2. OS detection.
    if (const auto v = backend.windowsVersion())
        check(true, "windows version", std::format("{}.{}.{}", v->major, v->minor, v->build));
    else
        check(false, "windows version", "VMM didn't identify a Windows kernel");

    // 3. Process list.
    auto procs = backend.processes();
    std::ranges::sort(procs, {}, &mem::VmmBackend::ProcessEntry::pid);
    const auto running = std::ranges::count_if(procs, &mem::VmmBackend::ProcessEntry::running);
    check(running > 0, "process list", std::format("{} running, {} total", running, procs.size()));
    if (!quiet && !procs.empty()) {
        std::printf("\n  %6s  %6s  %-5s  %s\n", "PID", "PPID", "", "NAME");
        for (const auto& p : procs) {
            if (!all && !p.running) continue;
            std::printf("  %6u  %6u  %-5s  %s%s\n", p.pid, p.parentPid, p.wow64 ? "32bit" : "",
                        p.name.c_str(), p.running ? "" : "  (terminated)");
        }
        std::printf("\n");
    }

    // 4. Kernel virtual read.
    checkModule(backend, 4, "ntoskrnl.exe");

    // 5. Optional user-mode process.
    if (!process.empty()) {
        if (const auto pid = backend.findProcess(process)) {
            check(true, std::format("find process {}", process), std::format("pid {}", *pid));
            checkModule(backend, *pid, process);
        } else {
            check(false, std::format("find process {}", process), "not running");
        }
    }

    backend.close();
    std::printf("\n%s\n", failures ? std::format("{} check(s) failed", failures).c_str() : "all checks passed");
    return failures ? 1 : 0;
}
