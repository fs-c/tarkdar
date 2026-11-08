#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "core/mem/PatternScan.hpp"
#include "tests/TestMemory.hpp"
#include "tools/il2cpp-dump/Dumper.hpp"

#include <eft_offsets.hpp>

#include <cstdlib>
#include <cstring>
#include <fstream>

using namespace radar;
using mem::Address;
using radar::test::Heap;

namespace {
constexpr mem::Pid kPid = 3;
constexpr Address kGameAssembly = 0x7FF6'0000'0000;
constexpr Address kUnityPlayer = 0x7FF7'0000'0000;
constexpr std::uint64_t kImageSize = 0x200000;
constexpr std::uint32_t kTextRva = 0x1000, kTextSize = 0x2000;

// Minimal PE32+ headers with one executable section at kTextRva.
void writePe(Heap& heap, Address base) {
    constexpr std::uint32_t lfanew = 0x80, optionalSize = 0xF0;
    heap.put<std::uint16_t>(base, 0x5A4D);
    heap.put<std::uint32_t>(base + 0x3C, lfanew);
    const Address nt = base + lfanew;
    heap.put<std::uint32_t>(nt, 0x00004550);
    heap.put<std::uint16_t>(nt + 4 + 2, 1);  // NumberOfSections
    heap.put<std::uint32_t>(nt + 4 + 4, 0x12345678);  // TimeDateStamp
    heap.put<std::uint16_t>(nt + 4 + 16, optionalSize);
    heap.put<std::uint16_t>(nt + 24, 0x20B);
    heap.put<std::uint32_t>(nt + 24 + 56, static_cast<std::uint32_t>(kImageSize));
    const Address section = nt + 24 + optionalSize;
    const std::uint8_t blank[40]{};
    heap.putBytes(section, blank, sizeof(blank));
    heap.putBytes(section, ".text\0\0\0", 8);
    heap.put<std::uint32_t>(section + 8, kTextSize);
    heap.put<std::uint32_t>(section + 12, kTextRva);
    heap.put<std::uint32_t>(section + 16, kTextSize);
    heap.put<std::uint32_t>(section + 36, 0x60000020);
    // Mark the code section as readable memory (zeros).
    const std::vector<std::uint8_t> zeros(kTextSize, 0);
    heap.putBytes(base + kTextRva, zeros.data(), zeros.size());
}

// Writes `bytes`, then a rel32 at insn+dispOffset pointing to `target` (insn length insnLength).
void writeRipInsn(Heap& heap, Address insn, std::vector<std::uint8_t> bytes, std::uint32_t dispOffset,
                  std::uint32_t insnLength, Address target) {
    heap.putBytes(insn, bytes.data(), bytes.size());
    const auto disp = static_cast<std::int32_t>(static_cast<std::int64_t>(target) - static_cast<std::int64_t>(insn + insnLength));
    heap.put<std::int32_t>(insn + dispOffset, disp);
}
}  // namespace

TEST_CASE("Pattern::parse") {
    const auto p = mem::Pattern::parse("48 8B 05 ? ?? C3");
    REQUIRE(p);
    CHECK(p->bytes == std::vector<std::int16_t>{0x48, 0x8B, 0x05, -1, -1, 0xC3});
    CHECK_FALSE(mem::Pattern::parse(""));
    CHECK_FALSE(mem::Pattern::parse("? ?"));
    CHECK_FALSE(mem::Pattern::parse("48 8"));
    CHECK_FALSE(mem::Pattern::parse("GG"));
}

TEST_CASE("scan finds matches across chunk boundaries, once each, up to the limit") {
    mem::FakeBackend fake;
    REQUIRE(fake.open());
    Heap heap(fake, kPid);
    mem::MemoryView view(fake, kPid);
    const Address base = 0x5000'0000;
    std::vector<std::uint8_t> data(1000, 0x90);
    const std::uint8_t sig[] = {0xAA, 0xBB, 0x11, 0xCC};
    for (std::size_t at : {10u, 61u, 128u, 500u, 996u}) std::memcpy(data.data() + at, sig, 4);  // 61 straddles 64; 128 starts a chunk
    heap.putBytes(base, data.data(), data.size());

    const auto pattern = *mem::Pattern::parse("AA BB ? CC");
    const mem::Region region{base, data.size()};
    const auto hits = mem::scan(view, std::span{&region, 1}, std::span{&pattern, 1}, 100, /*chunk*/ 64);
    CHECK(hits[0] == std::vector<Address>{base + 10, base + 61, base + 128, base + 500, base + 996});
    const auto limited = mem::scan(view, std::span{&region, 1}, std::span{&pattern, 1}, 2, 64);
    CHECK(limited[0].size() == 2);
}

TEST_CASE("codeRegions reads executable sections, or falls back to the whole image") {
    mem::FakeBackend fake;
    REQUIRE(fake.open());
    Heap heap(fake, kPid);
    mem::MemoryView view(fake, kPid);
    writePe(heap, kGameAssembly);
    const auto regions = mem::codeRegions(view, kGameAssembly, kImageSize);
    REQUIRE(regions.size() == 1);
    CHECK(regions[0].start == kGameAssembly + kTextRva);
    CHECK(regions[0].size == kTextSize);
    const auto fallback = mem::codeRegions(view, 0x6000'0000, 0x1000);
    REQUIRE(fallback.size() == 1);
    CHECK(fallback[0].size == 0x1000);
}

namespace {
struct FakeGame {
    mem::FakeBackend fake;
    Heap heap{fake, kPid};
    mem::MemoryView view{fake, kPid};
    Address table = 0, slot = 0;
    Address player = 0, localPlayer = 0, profile = 0, info = 0, monoBehaviour = 0;

    Address klass(const std::string& name, const std::string& ns, Address parent = 0) {
        const Address k = heap.klass(name, ns, parent);
        heap.put<Address>(k + off::managed::Il2CppClass::ByvalArg, k + 0x5000);  // unique type-definition handle
        return k;
    }

    // Field array: {name, type kind, type data, attrs, offset}.
    struct F {
        std::string name;
        std::uint8_t kind;
        Address data;
        std::uint16_t attrs;
        std::int32_t offset;
    };
    void fields(Address k, const std::vector<F>& fs) {
        const Address arr = heap.alloc(fs.size() * off::managed::FieldInfo::Size);
        for (std::size_t i = 0; i < fs.size(); ++i) {
            const Address fi = arr + i * off::managed::FieldInfo::Size;
            const Address type = heap.alloc(16);
            heap.put<Address>(type + off::managed::Il2CppType::Data, fs[i].data);
            heap.put<std::uint16_t>(type + off::managed::Il2CppType::Attrs, fs[i].attrs);
            heap.put<std::uint8_t>(type + off::managed::Il2CppType::Kind, fs[i].kind);
            heap.put<Address>(fi + off::managed::FieldInfo::Name, heap.cString(fs[i].name));
            heap.put<Address>(fi + off::managed::FieldInfo::Type, type);
            heap.put<Address>(fi + off::managed::FieldInfo::Parent, k);
            heap.put<std::int32_t>(fi + off::managed::FieldInfo::Offset, fs[i].offset);
        }
        heap.put<Address>(k + off::managed::Il2CppClass::Fields, arr);
        heap.put<std::uint16_t>(k + off::managed::Il2CppClass::FieldCount, static_cast<std::uint16_t>(fs.size()));
    }

    FakeGame() {
        REQUIRE(fake.open());
        writePe(heap, kGameAssembly);
        writePe(heap, kUnityPlayer);

        // Type-info table: core types at 0..15, real classes at 100.., more at 5000.. so the size probe passes.
        // Isolated from other allocations: what follows a real table is unrelated memory.
        table = 0x3'0000'0000;
        const std::vector<std::uint8_t> zeros(5010 * 8, 0);
        heap.putBytes(table, zeros.data(), zeros.size());
        const Address filler = klass("Object", "System");
        heap.put<Address>(table, filler);
        for (int i = 1; i < 16; ++i) heap.put<Address>(table + i * 8, klass("Core" + std::to_string(i), "System"));
        for (int i = 5000; i < 5008; ++i) heap.put<Address>(table + i * 8, klass("Late" + std::to_string(i), "System"));
        monoBehaviour = klass("MonoBehaviour", "UnityEngine", filler);
        player = klass("Player", "EFT", monoBehaviour);
        localPlayer = klass("LocalPlayer", "EFT", player);
        profile = klass("Profile", "EFT");
        info = klass("Info", "");  // nested in Profile
        heap.put<Address>(info + off::managed::Il2CppClass::DeclaringType, profile);
        // A generic instance base class (not in the table).
        const Address genericBase = klass("List`1", "System.Collections.Generic");
        const Address derived = klass("PlayerList", "EFT", genericBase);
        const std::pair<int, Address> placed[] = {{100, monoBehaviour}, {101, player}, {102, localPlayer},
                                                  {103, profile},       {104, info},   {105, derived}};
        for (auto [i, k] : placed) heap.put<Address>(table + static_cast<Address>(i) * 8, k);

        fields(player, {{"<Profile>k__BackingField", 0x12, profile + 0x5000, 0x0, 0x9C0},
                        {"_corpse", 0x12, 0xDEAD0000, 0x0, 0x728},  // unknown class handle
                        {"Instances", 0x1D, 0, 0x10, 0x8},          // static array (element type unresolved)
                        {"MaxHealth", 0x08, 0, 0x50, 0x0}});        // literal int
        fields(localPlayer, {});
        heap.put<Address>(localPlayer + off::managed::Il2CppClass::Fields, 0);  // fields not set up yet
        heap.put<std::uint16_t>(localPlayer + off::managed::Il2CppClass::FieldCount, 3);

        // Code: "initStore" signature referencing the table slot in GameAssembly's data.
        slot = kGameAssembly + 0x100000;
        heap.put<Address>(slot, table);
        writeRipInsn(heap, kGameAssembly + kTextRva + 0x100,
                     {0x48, 0x89, 0x05, 0, 0, 0, 0, 0x48, 0x8B, 0x05, 1, 2, 3, 4, 0x8B, 0x48}, 3, 7, slot);
    }

    void addGom() {
        const Address gomSlot = kUnityPlayer + 0x180000;
        const Address mgr = heap.alloc(0x40), node = heap.alloc(0x20), object = heap.alloc(0x40);
        heap.put<Address>(node + 0x10, object);
        heap.put<Address>(mgr + 0x20, node);
        heap.put<Address>(mgr + 0x28, node);
        heap.put<Address>(gomSlot, mgr);
        writeRipInsn(heap, kUnityPlayer + kTextRva + 0x40, {0x48, 0x89, 0x05, 0, 0, 0, 0, 0x48, 0x83, 0xC4, 0x28, 0xC3, 0x33, 0xC9},
                     3, 7, gomSlot);
    }

    tools::Il2CppDumper dumper(tools::DumpOptions o = {}) {
        o.validateAttempts = 1;
        return tools::Il2CppDumper(view, {kGameAssembly, kImageSize}, mem::ModuleInfo{kUnityPlayer, kImageSize}, o);
    }
};

const tools::ClassRecord* find(const tools::Dump& d, std::string_view fullName) {
    for (const auto& c : d.classes)
        if (c.fullName == fullName) return &c;
    return nullptr;
}
}  // namespace

TEST_CASE("Il2CppDumper locates the type-info table by signature") {
    FakeGame g;
    std::vector<std::string> notes;
    const auto loc = g.dumper().locateTypeInfoTable(notes);
    REQUIRE(loc);
    CHECK(loc->slotRva == 0x100000);
    CHECK(loc->table == g.table);
    CHECK(loc->method == "signature:initStore");
    CHECK(loc->validated);

    SUBCASE("falls back to the compiled-in RVA") {
        g.heap.put<std::uint8_t>(kGameAssembly + kTextRva + 0x100, 0x00);  // break the signature
        tools::DumpOptions o;
        o.broadScan = false;
        o.fallbackTypeInfoRva = 0x100000;
        const auto fb = g.dumper(o).locateTypeInfoTable(notes);
        REQUIRE(fb);
        CHECK(fb->method == "compiled");
    }
    SUBCASE("a table without classes at 5000+ doesn't validate") {
        for (int i = 5000; i < 5008; ++i) g.heap.put<Address>(g.table + i * 8, 0);
        CHECK_FALSE(g.dumper().validTable(g.table));
    }
}

TEST_CASE("Il2CppDumper reads classes, parents and fields") {
    FakeGame g;
    g.addGom();
    const auto dump = g.dumper().run();
    REQUIRE(dump.table);
    CHECK(dump.typeCount == 5008);

    const auto* player = find(dump, "EFT.Player");
    REQUIRE(player);
    CHECK(player->typeIndex == 101);
    CHECK(player->parent == "UnityEngine.MonoBehaviour");
    CHECK(player->parentTypeIndex == 100);
    CHECK(player->fieldsInitialised);
    REQUIRE(player->fields.size() == 4);
    CHECK(player->fields[0].name == "<Profile>k__BackingField");
    CHECK(player->fields[0].offset == 0x9C0);
    CHECK(player->fields[0].type == "EFT.Profile");
    CHECK(player->fields[0].declaringClass == "EFT.Player");
    CHECK_FALSE(player->fields[0].isStatic);
    CHECK(player->fields[1].type == "class");  // unresolvable handle
    CHECK(player->fields[2].isStatic);
    CHECK(player->fields[2].type == "?[]");
    CHECK(player->fields[3].isLiteral);
    CHECK(player->fields[3].type == "int32_t");

    const auto* local = find(dump, "EFT.LocalPlayer");
    REQUIRE(local);
    CHECK(local->parent == "EFT.Player");
    CHECK_FALSE(local->fieldsInitialised);

    const auto* info = find(dump, "Info");
    REQUIRE(info);
    CHECK(info->declaringType == "EFT.Profile");

    const auto* list = find(dump, "EFT.PlayerList");
    REQUIRE(list);
    CHECK(list->parent == "System.Collections.Generic.List`1");  // generic base read directly
    CHECK_FALSE(list->parentTypeIndex);

    REQUIRE(dump.unity.size() == 2);
    CHECK(dump.unity[0].name == "gameObjectManager");
    CHECK(dump.unity[0].validated);
    CHECK(dump.unity[0].rva == 0x180000);
    CHECK(dump.unity[0].lastActiveNode == 0x20u);
    CHECK_FALSE(dump.unity[1].validated);  // no camera signature in the fake

    // For checking the JSON end to end with tools/update-offsets.py (set RADAR_DUMP_JSON_OUT).
    if (const char* outPath = std::getenv("RADAR_DUMP_JSON_OUT")) {
        std::ofstream(outPath) << tools::toJson(dump, {});
    }

    SUBCASE("JSON output applies filters") {
        tools::DumpOptions o;
        o.namespaceFilter = "EFT";
        o.classFilter = "Player";
        const auto json = tools::toJson(dump, o);
        CHECK(json.find("\"fullName\": \"EFT.Player\"") != std::string::npos);
        CHECK(json.find("\"fullName\": \"EFT.LocalPlayer\"") != std::string::npos);
        CHECK(json.find("\"fullName\": \"EFT.Profile\"") == std::string::npos);
        CHECK(json.find("\"typeInfoTable\": { \"rva\": \"0x100000\"") != std::string::npos);
        CHECK(json.find("\"gameObjectManager\": { \"rva\": \"0x180000\", \"validated\": true") != std::string::npos);
    }
}
