#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "core/mem/PatternScan.hpp"
#include "tests/TestMemory.hpp"
#include "tools/il2cpp-dump/Dumper.hpp"

#include <eft_offsets.hpp>

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>

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
    CHECK_FALSE(dump.metadata);  // type-definition handles here aren't one array

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

TEST_CASE("decodeConstant") {
    using tools::LiteralValue;
    auto decode = [](std::vector<std::uint8_t> b, std::uint8_t kind, std::int32_t version = 29) {
        return tools::decodeConstant(b, 0, kind, version);
    };
    // Compressed int32 (v29+): zigzag-style sign bit, 1/2/4/5-byte forms.
    CHECK(decode({0x00}, 0x08) == LiteralValue{std::int64_t{0}});
    CHECK(decode({0x40}, 0x08) == LiteralValue{std::int64_t{32}});
    CHECK(decode({0x09}, 0x08) == LiteralValue{std::int64_t{-5}});
    CHECK(decode({0x87, 0xD0}, 0x08) == LiteralValue{std::int64_t{1000}});
    CHECK(decode({0xC0, 0x01, 0x00, 0x00}, 0x08) == LiteralValue{std::int64_t{0x8000}});
    CHECK(decode({0xF0, 0x00, 0x00, 0x00, 0x80}, 0x09) == LiteralValue{std::uint64_t{0x80000000u}});
    CHECK(decode({0xFF}, 0x08) == LiteralValue{std::int64_t{std::numeric_limits<std::int32_t>::min()}});
    CHECK_FALSE(decode({0x87}, 0x08));  // truncated
    // Before v29: plain little-endian.
    CHECK(decode({0x20, 0x00, 0x00, 0x00}, 0x08, 24) == LiteralValue{std::int64_t{32}});
    // Fixed-size kinds.
    CHECK(decode({0x01}, 0x02) == LiteralValue{true});
    CHECK(decode({0xFE}, 0x04) == LiteralValue{std::int64_t{-2}});
    CHECK(decode({0x00, 0x00, 0xC0, 0x3F}, 0x0C) == LiteralValue{1.5});
    // Strings: compressed length, then UTF-8; -1 is null.
    CHECK(decode({0x08, 'B', 'o', 's', 's'}, 0x0E) == LiteralValue{std::string("Boss")});
    CHECK_FALSE(decode({0x01}, 0x0E));
    CHECK_FALSE(decode({0x10, 'x'}, 0x0E));  // longer than the blob
    CHECK_FALSE(decode({0x00}, 0x12));       // not a constant kind
}

namespace {
// A fake global metadata for FakeGame: every class in the type-info table gets its type definition at
// first + typeIndex * kStride (fieldStart at +kFieldStart), the header points back at that array, and
// `values` are the (class, field position, encoded bytes) default values.
constexpr std::uint32_t kStride = 0x58, kFieldStart = 0x20;
constexpr Address kMetadata = 0x4'0000'0000, kTypeDefs = kMetadata + 0x10000;
struct DefaultValue {
    Address klass;
    std::int32_t position;
    std::vector<std::uint8_t> bytes;
};
void writeMetadata(FakeGame& g, std::int32_t typeCount, const std::vector<DefaultValue>& values) {
    std::vector<std::uint8_t> defs(static_cast<std::size_t>(typeCount) * kStride, 0);
    std::map<Address, std::int32_t> fieldStartOf;
    std::int32_t running = 0;
    for (std::int32_t i = 0; i < typeCount; ++i) {
        const Address k = g.view.read<Address>(g.table + static_cast<Address>(i) * 8);
        std::uint16_t count = 0;
        if (k) {
            count = g.view.read<std::uint16_t>(k + off::managed::Il2CppClass::FieldCount);
            fieldStartOf[k] = running;
        }
        std::memcpy(defs.data() + static_cast<std::size_t>(i) * kStride + kFieldStart, &running, 4);
        const std::int32_t methodStart = i * 3;  // another "start" column that must not be mistaken for fieldStart
        std::memcpy(defs.data() + static_cast<std::size_t>(i) * kStride + kFieldStart + 4, &methodStart, 4);
        running += count;
    }
    g.heap.putBytes(kTypeDefs, defs.data(), defs.size());

    std::vector<std::uint8_t> table, data;
    for (const auto& v : values) {
        const std::int32_t entry[3] = {fieldStartOf.at(v.klass) + v.position, 0, static_cast<std::int32_t>(data.size())};
        const auto* p = reinterpret_cast<const std::uint8_t*>(entry);
        table.insert(table.end(), p, p + sizeof(entry));
        data.insert(data.end(), v.bytes.begin(), v.bytes.end());
    }
    constexpr std::uint32_t tableOffset = 0x1000, dataOffset = 0x2000;
    g.heap.putBytes(kMetadata + tableOffset, table.data(), table.size());
    g.heap.putBytes(kMetadata + dataOffset, data.data(), data.size());
    std::vector<std::uint32_t> header(0x100 / 4, 0);
    header[0] = 0xFAB11BAF;
    header[1] = 29;
    header[0x40 / 4] = tableOffset;
    header[0x44 / 4] = static_cast<std::uint32_t>(table.size());
    header[0x48 / 4] = dataOffset;
    header[0x4C / 4] = static_cast<std::uint32_t>(data.size());
    header[0xA0 / 4] = static_cast<std::uint32_t>(kTypeDefs - kMetadata);
    g.heap.putBytes(kMetadata, header.data(), header.size() * 4);
}
}  // namespace

TEST_CASE("Il2CppDumper reads literal values from the loaded metadata") {
    FakeGame g;
    constexpr std::uint16_t kConst = 0x10 | 0x40;  // static | literal
    const Address enumBase = g.klass("Enum", "System");
    const Address wild = g.klass("WildSpawnType", "EFT", enumBase);
    const Address consts = g.klass("WildSpawnTypeExtension", "");
    g.heap.put<Address>(g.table + 16 * 8, enumBase);
    g.heap.put<Address>(g.table + 106 * 8, wild);
    g.heap.put<Address>(g.table + 107 * 8, consts);
    // Type definitions as one array, indexed by type index.
    for (std::int32_t i = 0; i < 5008; ++i)
        if (const Address k = g.view.read<Address>(g.table + static_cast<Address>(i) * 8))
            g.heap.put<Address>(k + off::managed::Il2CppClass::ByvalArg + off::managed::Il2CppType::Data,
                                kTypeDefs + static_cast<Address>(i) * kStride);
    const Address wildHandle = kTypeDefs + 106 * kStride;
    g.fields(wild, {{"value__", 0x08, 0, 0x0, 0x10},
                    {"marksman", 0x11, wildHandle, kConst, 0},
                    {"assault", 0x11, wildHandle, kConst, 0},
                    {"bossBoar", 0x11, wildHandle, kConst, 0}});
    g.fields(consts, {{"SCAV_ROLE_BOSS", 0x0E, 0, kConst, 0},
                      {"Rate", 0x0C, 0, kConst, 0},
                      {"Offset", 0x08, 0, kConst, 0},
                      {"Missing", 0x08, 0, kConst, 0}});  // no default value recorded
    writeMetadata(g, 5008, {{wild, 1, {0x00}},
                            {wild, 2, {0x02}},
                            {wild, 3, {0x40}},
                            {consts, 0, {0x08, 'B', 'o', 's', 's'}},
                            {consts, 1, {0x00, 0x00, 0xC0, 0x3F}},
                            {consts, 2, {0x09}},
                            {g.player, 3, {0x83, 0x70}}});  // MaxHealth = 440

    const auto dump = g.dumper().run();
    REQUIRE(dump.metadata);
    CHECK(dump.metadata->base == kMetadata);
    CHECK(dump.metadata->version == 29);
    CHECK(dump.metadata->typeDefinitionSize == kStride);
    CHECK(dump.metadata->fieldStartOffset == kFieldStart);
    CHECK(dump.metadata->literalFields == 8);
    CHECK(dump.metadata->literalValues == 7);

    using tools::LiteralValue;
    const auto* e = find(dump, "EFT.WildSpawnType");
    REQUIRE(e);
    REQUIRE(e->fields.size() == 4);
    CHECK_FALSE(e->fields[0].value);  // value__ is the instance field
    CHECK(e->fields[1].value == LiteralValue{std::int64_t{0}});
    CHECK(e->fields[2].value == LiteralValue{std::int64_t{1}});
    CHECK(e->fields[3].value == LiteralValue{std::int64_t{32}});
    const auto* c = find(dump, "WildSpawnTypeExtension");
    REQUIRE(c);
    CHECK(c->fields[0].value == LiteralValue{std::string("Boss")});
    CHECK(c->fields[1].value == LiteralValue{1.5});
    CHECK(c->fields[2].value == LiteralValue{std::int64_t{-5}});
    CHECK_FALSE(c->fields[3].value);
    CHECK(find(dump, "EFT.Player")->fields[3].value == LiteralValue{std::int64_t{440}});

    const auto json = tools::toJson(dump, {});
    CHECK(json.find(R"("name": "bossBoar", "type": "EFT.WildSpawnType")") != std::string::npos);
    CHECK(json.find(R"("declaringClass": "EFT.WildSpawnType", "value": 32 })") != std::string::npos);
    CHECK(json.find(R"("value": "Boss" })") != std::string::npos);
    CHECK(json.find(R"("metadata": { "base": "0x400000000", "version": 29)") != std::string::npos);

    SUBCASE("without a header nothing is resolved, and the notes say why") {
        g.heap.put<std::uint32_t>(kMetadata, 0);
        tools::DumpOptions o;
        o.metadataScanLimit = 0x100000;
        const auto d = g.dumper(o).run();
        CHECK_FALSE(d.metadata);
        CHECK_FALSE(find(d, "EFT.WildSpawnType")->fields[3].value);
        CHECK(std::ranges::any_of(d.notes, [](const auto& n) { return n.starts_with("literal values: no metadata header"); }));
    }
}
