#include "core/mem/FakeBackend.hpp"
#include "core/mem/MemoryView.hpp"
#include "core/mem/Pe.hpp"
#include "core/mem/Target.hpp"

#include <doctest/doctest.h>

#include <array>
#include <cstring>

using namespace radar::mem;

// doctest can't stringify enum classes by default; print them by name.
namespace doctest {
template <>
struct StringMaker<Target::State> {
    static String convert(Target::State s) { return stateName(s); }
};
}  // namespace doctest

namespace {
constexpr Pid kPid = 42;

// FakeBackend holds a mutex and isn't movable, so tests declare it and open it in place.
#define OPEN_FAKE(name) \
    FakeBackend name;   \
    REQUIRE(name.open())
}  // namespace

TEST_CASE("isUserPointer accepts only canonical user-mode addresses") {
    CHECK_FALSE(MemoryView::isUserPointer(0));
    CHECK_FALSE(MemoryView::isUserPointer(0xFFFF));
    CHECK(MemoryView::isUserPointer(0x10000));
    CHECK(MemoryView::isUserPointer(0x7FF6'1234'5678));
    CHECK_FALSE(MemoryView::isUserPointer(0x7FFF'FFFF'0000));
    CHECK_FALSE(MemoryView::isUserPointer(0xFFFF'8000'0000'0000));
}

TEST_CASE("typed reads zero-fill on failure") {
    OPEN_FAKE(fake);
    MemoryView mem(fake, kPid);
    fake.writeValue<std::uint32_t>(kPid, 0x20000, 0xDEADBEEF);

    std::uint32_t ok = 0;
    CHECK(mem.tryRead(0x20000, ok));
    CHECK(ok == 0xDEADBEEF);

    std::uint64_t partial = 0xFFFF'FFFF'FFFF'FFFF;
    CHECK_FALSE(mem.tryRead(0x20000, partial));  // only 4 of 8 bytes exist
    CHECK(partial == 0xDEADBEEF);                // present bytes kept, missing bytes zero

    CHECK(mem.read<std::uint64_t>(0x90000) == 0);
}

TEST_CASE("readChain follows pointers and validates intermediates") {
    OPEN_FAKE(fake);
    MemoryView mem(fake, kPid);
    // 0x100000 +0x10 -> 0x200000 ; 0x200000 +0x58 -> 0x300000 ; 0x300000 +0x8 -> 1234 (non-pointer)
    fake.writeValue<std::uint64_t>(kPid, 0x100010, 0x200000);
    fake.writeValue<std::uint64_t>(kPid, 0x200058, 0x300000);
    fake.writeValue<std::uint64_t>(kPid, 0x300008, 1234);

    constexpr std::array<std::uint32_t, 3> chain{0x10, 0x58, 0x8};
    auto result = mem.readChain(0x100000, chain);
    REQUIRE(result);
    CHECK(*result == 1234);  // final value is not pointer-validated

    SUBCASE("invalid intermediate pointer fails") {
        fake.writeValue<std::uint64_t>(kPid, 0x200058, 0x10);
        CHECK_FALSE(mem.readChain(0x100000, chain));
    }
    SUBCASE("failed read fails") {
        constexpr std::array<std::uint32_t, 2> bad{0x10, 0x60};
        CHECK_FALSE(mem.readChain(0x100000, bad));
    }
    SUBCASE("empty chain and null base fail") {
        CHECK_FALSE(mem.readChain(0x100000, std::span<const std::uint32_t>{}));
        CHECK_FALSE(mem.readChain(0, chain));
    }
}

TEST_CASE("readCString stops at NUL and caps length") {
    OPEN_FAKE(fake);
    MemoryView mem(fake, kPid);
    const char text[] = "GameWorld\0junk";
    fake.write(kPid, 0x40000, text, sizeof(text));
    CHECK(mem.readCString(0x40000) == "GameWorld");
    CHECK(mem.readCString(0x40000, 4) == "Game");
    CHECK(mem.readCString(0).empty());
}

TEST_CASE("readMany reports per-request bytesRead") {
    OPEN_FAKE(fake);
    fake.writeValue<std::uint64_t>(kPid, 0x50000, 7);
    std::uint64_t a = 1, b = 1;
    std::array<ReadRequest, 2> reqs{ReadRequest{0x50000, &a, 8, 0}, ReadRequest{0x60000, &b, 8, 0}};
    fake.readMany(kPid, reqs, Freshness::Fresh);
    CHECK(reqs[0].complete());
    CHECK(a == 7);
    CHECK_FALSE(reqs[1].complete());
    CHECK(b == 0);
}

namespace {
// Writes a minimal PE32+ header: DOS header with e_lfanew, NT signature, file header, optional
// header magic and SizeOfImage.
void writeFakePe(FakeBackend& fake, Address base, std::uint32_t timestamp, std::uint32_t size,
                 std::uint16_t optionalMagic = 0x20B) {
    constexpr std::uint32_t lfanew = 0x100;
    fake.writeValue<std::uint16_t>(kPid, base, 0x5A4D);
    fake.writeValue<std::uint32_t>(kPid, base + 0x3C, lfanew);
    fake.writeValue<std::uint32_t>(kPid, base + lfanew, 0x00004550);
    fake.writeValue<std::uint32_t>(kPid, base + lfanew + 4 + 4, timestamp);
    fake.writeValue<std::uint16_t>(kPid, base + lfanew + 24, optionalMagic);
    fake.writeValue<std::uint32_t>(kPid, base + lfanew + 24 + 56, size);
}
}  // namespace

TEST_CASE("readPeFingerprint") {
    OPEN_FAKE(fake);
    MemoryView mem(fake, kPid);
    writeFakePe(fake, 0x7FF600000000, 0x6543210F, 0x6000000);
    auto fp = readPeFingerprint(mem, 0x7FF600000000);
    REQUIRE(fp);
    CHECK(fp->timeDateStamp == 0x6543210F);
    CHECK(fp->sizeOfImage == 0x6000000);

    writeFakePe(fake, 0x7FF700000000, 1, 2, /*PE32, not PE32+*/ 0x10B);
    CHECK_FALSE(readPeFingerprint(mem, 0x7FF700000000));
    CHECK_FALSE(readPeFingerprint(mem, 0x7FF800000000));  // nothing there
}

TEST_CASE("Target attach state machine") {
    OPEN_FAKE(fake);
    Target target(fake, "Game.exe", {"A.dll", "B.dll"});

    CHECK(target.poll() == Target::State::WaitingForProcess);

    fake.addProcess("Game.exe", kPid);
    fake.addModule(kPid, "A.dll", {0x7FF600000000, 0x1000});
    CHECK(target.poll() == Target::State::WaitingForModules);  // B.dll not loaded yet
    CHECK(target.generation() == 0);

    fake.addModule(kPid, "B.dll", {0x7FF700000000, 0x2000});
    CHECK(target.poll() == Target::State::Attached);
    CHECK(target.generation() == 1);
    CHECK(target.pid().value_or(0) == kPid);
    CHECK(target.module("B.dll")->base == 0x7FF700000000);
    CHECK(target.view().pid() == kPid);

    CHECK(target.poll() == Target::State::Attached);  // stays attached
    CHECK(target.generation() == 1);

    SUBCASE("process exit and restart bumps generation") {
        fake.killProcess(kPid);
        CHECK(target.poll() == Target::State::WaitingForProcess);
        CHECK_FALSE(target.pid());
        CHECK(target.modules().empty());

        constexpr Pid newPid = 43;
        fake.addProcess("Game.exe", newPid);
        fake.addModule(newPid, "A.dll", {0x7FF600000000, 0x1000});
        fake.addModule(newPid, "B.dll", {0x7FF700000000, 0x2000});
        CHECK(target.poll() == Target::State::Attached);
        CHECK(target.generation() == 2);
        CHECK(target.pid().value_or(0) == newPid);
    }
}
