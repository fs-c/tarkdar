// mem-peek: interactive memory inspector for the running game (or a memory dump), for working out
// engine layouts by hand after a game/Unity update (docs/offset-tools.md, "Finding layouts by hand").
//
// Reads commands from stdin, one per line, so it can be driven by a script or a pipe:
//
//   q <addr> [len]         qwords, with hints: ptr, a C string it points to, the managed class of
//                          the object it points to (default len 0x40)
//   d <addr> [len]         dwords as hex / int / float (matrices, indices, counts)
//   s <addr>               C string at addr
//   c <addr>               managed class name of the object at addr
//   w <addr> <len> <file>  raw bytes to a file (unreadable pages are zeros), e.g. a module image to
//                          disassemble: w up+0 <imageSize> unityplayer.bin
//
// <addr> and <len> are hex (0x optional). An address can be relative to a module: up+<rva>
// (UnityPlayer.dll), ga+<rva> (GameAssembly.dll). '!' marks a qword that couldn't be read.
//
//   echo 'q up+2054CB0 8' | ./build/bin/mem-peek --device "qemu://hugepage-pid=$(pgrep -f 'guest=')"

#include "core/log/Log.hpp"
#include "core/mem/Target.hpp"
#include "core/mem/VmmBackend.hpp"
#include "game/eft/Game.hpp"
#include "game/eft/Names.hpp"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <optional>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

using radar::mem::Address;
using radar::mem::Freshness;
using radar::mem::MemoryView;

void usage(const char* argv0) {
    std::fprintf(stderr,
                 "usage: %s --device <leechcore-device> [options] < commands\n"
                 "\n"
                 "  --device <str>     LeechCore device, e.g. \"qemu://hugepage-pid=<qemu pid>\" or a raw dump file\n"
                 "  --vmm-arg <arg>    extra argument passed to VMM (repeatable)\n"
                 "  --verbose          debug logging\n"
                 "\n"
                 "commands (stdin, hex numbers; addresses may be up+<rva> / ga+<rva>):\n"
                 "  q <addr> [len]         qwords with pointer / string / class hints\n"
                 "  d <addr> [len]         dwords as hex, int and float\n"
                 "  s <addr>               C string\n"
                 "  c <addr>               managed class of the object at addr\n"
                 "  w <addr> <len> <file>  raw bytes to a file\n",
                 argv0);
}

std::optional<std::uint64_t> parseHex(std::string_view s) {
    if (s.starts_with("0x") || s.starts_with("0X")) s.remove_prefix(2);
    if (s.empty()) return std::nullopt;
    try {
        std::size_t used = 0;
        const auto v = std::stoull(std::string(s), &used, 16);
        if (used != s.size()) return std::nullopt;
        return v;
    } catch (...) {
        return std::nullopt;
    }
}

class Peek {
public:
    explicit Peek(const radar::eft::Game& game) : game_(game) {}

    void run(const std::string& line) {
        std::istringstream in(line);
        std::string cmd, addrText, lenText, file;
        in >> cmd >> addrText >> lenText >> file;
        if (cmd.empty() || cmd[0] == '#') return;
        const auto addr = address(addrText);
        if (!addr) {
            std::printf("? bad address '%s'\n", addrText.c_str());
            return;
        }
        const auto len = lenText.empty() ? std::optional<std::uint64_t>{0x40} : parseHex(lenText);
        if (!len || *len > kMaxLen) {
            std::printf("? bad length '%s' (at most %#llx)\n", lenText.c_str(), static_cast<unsigned long long>(kMaxLen));
            return;
        }
        std::printf("### %s = %#llx\n", line.c_str(), static_cast<unsigned long long>(*addr));
        if (cmd == "q") qwords(*addr, *len);
        else if (cmd == "d") dwords(*addr, *len);
        else if (cmd == "s") std::printf("  \"%s\"\n", string(*addr).value_or("").c_str());
        else if (cmd == "c") std::printf("  %s\n", className(*addr).value_or("(no class)").c_str());
        else if (cmd == "w" && !file.empty()) write(*addr, *len, file);
        else std::printf("? unknown command '%s'\n", cmd.c_str());
        std::fflush(stdout);
    }

private:
    static constexpr std::uint64_t kMaxLen = 0x1000'0000;  // 256 MiB: whole module images

    std::optional<Address> address(std::string_view text) const {
        Address base = 0;
        if (text.starts_with("up+")) base = game_.unityPlayer, text.remove_prefix(3);
        else if (text.starts_with("ga+")) base = game_.gameAssembly, text.remove_prefix(3);
        const auto v = parseHex(text);
        return v ? std::optional<Address>{base + *v} : std::nullopt;
    }

    // A printable C string of at least 3 characters at p.
    std::optional<std::string> string(Address p) const {
        std::array<char, 64> buf{};
        if (!game_.mem.readBytes(p, std::as_writable_bytes(std::span{buf}), Freshness::Fresh)) return std::nullopt;
        std::string s;
        for (const char c : buf) {
            if (c == '\0') break;
            if (c < 0x20 || c > 0x7E) return std::nullopt;
            s += c;
        }
        return s.size() >= 3 ? std::optional{s} : std::nullopt;
    }

    // The full class name of a managed object, if `object` looks like one.
    std::optional<std::string> className(Address object) const {
        Address klass = 0;
        if (!game_.mem.tryRead(object, klass, Freshness::Fresh) || !MemoryView::isUserPointer(klass)) return std::nullopt;
        const std::string name = game_.managed.fullClassName(klass);
        if (name.empty() || name.size() > 120) return std::nullopt;
        for (const char c : name)
            if (c < 0x20 || c > 0x7E) return std::nullopt;
        return name;
    }

    void qwords(Address addr, std::uint64_t len) const {
        for (std::uint64_t o = 0; o < len; o += 8) {
            std::uint64_t v = 0;
            const bool ok = game_.mem.tryRead(addr + o, v, Freshness::Fresh);
            std::string hint;
            if (ok && MemoryView::isUserPointer(v)) {
                hint = "ptr";
                if (const auto s = string(v)) hint += " \"" + *s + "\"";
                if (const auto c = className(v)) hint += " obj:" + *c;
            }
            std::printf("  +%03llx %s %016llx %s\n", static_cast<unsigned long long>(o), ok ? " " : "!",
                        static_cast<unsigned long long>(v), hint.c_str());
        }
    }

    void dwords(Address addr, std::uint64_t len) const {
        for (std::uint64_t o = 0; o < len; o += 4) {
            std::uint32_t v = 0;
            const bool ok = game_.mem.tryRead(addr + o, v, Freshness::Fresh);
            float f = 0;
            std::memcpy(&f, &v, sizeof f);
            std::printf("%s+%03llx%s%08x %11d %12.5g", o % 16 ? "   " : "\n  ", static_cast<unsigned long long>(o),
                        ok ? " " : "!", v, static_cast<int>(v), static_cast<double>(f));
        }
        std::printf("\n");
    }

    void write(Address addr, std::uint64_t len, const std::string& file) const {
        std::vector<std::byte> buf(len);
        std::size_t unreadable = 0;
        for (std::uint64_t o = 0; o < len; o += 0x1000) {
            const auto chunk = std::span{buf}.subspan(o, std::min<std::uint64_t>(0x1000, len - o));
            if (!game_.mem.readBytes(addr + o, chunk, Freshness::Fresh)) ++unreadable;
        }
        FILE* f = std::fopen(file.c_str(), "wb");
        if (!f || std::fwrite(buf.data(), 1, buf.size(), f) != buf.size()) {
            std::printf("? can't write %s\n", file.c_str());
            if (f) std::fclose(f);
            return;
        }
        std::fclose(f);
        std::printf("  wrote %llu bytes to %s (%zu unreadable page(s) zeroed)\n", static_cast<unsigned long long>(len),
                    file.c_str(), unreadable);
    }

    const radar::eft::Game& game_;
};

}  // namespace

int main(int argc, char** argv) {
    using namespace radar;
    mem::VmmConfig config;
    for (int i = 1; i < argc; ++i) {
        const std::string_view a = argv[i];
        if (a == "--help" || a == "-h") {
            usage(argv[0]);
            return 0;
        } else if (a == "--device" && i + 1 < argc) config.device = argv[++i];
        else if (a == "--vmm-arg" && i + 1 < argc) config.extraArgs.emplace_back(argv[++i]);
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

    mem::VmmBackend backend(config);
    if (auto opened = backend.open(); !opened) {
        log::error("{}", opened.error());
        return 1;
    }
    const std::vector<std::string> modules(eft::kRequiredModules.begin(), eft::kRequiredModules.end());
    mem::Target target(backend, std::string(eft::kProcessName), modules);
    for (int i = 0; i < 60 && target.poll() != mem::Target::State::Attached; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    if (target.state() != mem::Target::State::Attached) {
        log::error("game process not found");
        return 1;
    }
    const auto game = eft::Game::fromTarget(target);
    Peek peek(game);
    for (std::string line; std::getline(std::cin, line);) peek.run(line);
    backend.close();
    return 0;
}
