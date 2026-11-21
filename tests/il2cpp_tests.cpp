#include "TestMemory.hpp"

#include "core/il2cpp/Managed.hpp"
#include "core/il2cpp/TypeInfoTable.hpp"
#include "core/mem/ReadBatch.hpp"
#include "core/text/Ascii.hpp"
#include "core/text/Utf16.hpp"

#include <doctest/doctest.h>

using namespace radar;
using radar::test::Heap;
using radar::test::kIl2Cpp;
using mem::Address;

namespace {
constexpr mem::Pid kPid = 7;
}

#define SETUP                                \
    mem::FakeBackend fake;                   \
    REQUIRE(fake.open());                    \
    Heap heap(fake, kPid);                   \
    mem::MemoryView view(fake, kPid);        \
    il2cpp::Managed managed(view, kIl2Cpp)

TEST_CASE("utf16ToUtf8") {
    using text::utf16ToUtf8;
    CHECK(utf16ToUtf8(std::u16string_view(u"bigmap")) == "bigmap");
    CHECK(utf16ToUtf8(std::u16string_view(u"Привет")) == "Привет");
    CHECK(utf16ToUtf8(std::u16string_view(u"a\U0001F600b")) == "a\xF0\x9F\x98\x80" "b");  // surrogate pair
    const char16_t lone[] = {u'a', 0xD800, u'b'};
    CHECK(utf16ToUtf8(lone) == "a\xEF\xBF\xBD" "b");  // unpaired surrogate → U+FFFD
    const char16_t nul[] = {u'a', 0, u'b'};
    CHECK(utf16ToUtf8(nul) == "a");
}

TEST_CASE("ASCII case-insensitive helpers") {
    using namespace text;
    CHECK(lowerAscii("Item_BARTER_Info") == "item_barter_info");
    CHECK(lowerAscii("\xD0\x9F") == "\xD0\x9F");  // non-ASCII bytes are left alone
    CHECK(equalsIgnoreCase("BigMap", "bigmap"));
    CHECK_FALSE(equalsIgnoreCase("bigmap", "bigmaps"));
    CHECK(startsWithIgnoreCase("Item_barter_info_x", "item_barter_info_"));
    CHECK_FALSE(startsWithIgnoreCase("item_barter", "item_barter_info_"));
    CHECK(containsIgnoreCase("Optic Camera", "CAMERA"));
    CHECK(containsIgnoreCase("anything", ""));
    CHECK_FALSE(containsIgnoreCase("FPS", "Camera"));
}

TEST_CASE("sanitizeUtf8 replaces invalid sequences") {
    using text::sanitizeUtf8;
    CHECK(sanitizeUtf8("plain") == "plain");
    CHECK(sanitizeUtf8("Привет \xF0\x9F\x98\x80") == "Привет \xF0\x9F\x98\x80");
    CHECK(sanitizeUtf8("a\xFF" "b") == "a\xEF\xBF\xBD" "b");          // stray byte
    CHECK(sanitizeUtf8("cut \xE2\x82") == "cut \xEF\xBF\xBD\xEF\xBF\xBD");  // truncated sequence
    CHECK(sanitizeUtf8("\xC0\xAF") == "\xEF\xBF\xBD\xEF\xBF\xBD");    // overlong
    CHECK(sanitizeUtf8("\xED\xA0\x80") == "\xEF\xBF\xBD\xEF\xBF\xBD\xEF\xBF\xBD");  // surrogate
}

TEST_CASE("readCString output is valid UTF-8") {
    mem::FakeBackend fake;
    REQUIRE(fake.open());
    const char bytes[] = "name\xC3";  // a 2-byte sequence cut off
    fake.write(kPid, 0x20000, bytes, sizeof(bytes));
    mem::MemoryView view(fake, kPid);
    CHECK(view.readCString(0x20000) == "name\xEF\xBF\xBD");
}

TEST_CASE("ReadBatch splits large requests and reports partial reads") {
    mem::FakeBackend fake;
    REQUIRE(fake.open());
    fake.setLimits({.maxRequestsPerBatch = 2, .maxBytesPerRequest = 4});
    mem::MemoryView view(fake, kPid);
    const std::uint64_t v1 = 0x1122334455667788, v2 = 0xAABBCCDD;
    fake.writeValue(kPid, 0x20000, v1);
    fake.writeValue<std::uint32_t>(kPid, 0x30000, static_cast<std::uint32_t>(v2));

    std::uint64_t a = 0, b = 0, c = 0;
    mem::ReadBatch batch(view);
    const auto ha = batch.add(0x20000, a);  // 2 pieces
    const auto hb = batch.add(0x30000, b);  // first piece ok, second missing
    const auto hc = batch.add(0x40000, c);  // nothing there
    batch.execute();
    CHECK(batch.complete(ha));
    CHECK(a == v1);
    CHECK_FALSE(batch.complete(hb));
    CHECK(batch.bytesRead(hb) == 4);
    CHECK(b == v2);
    CHECK(batch.bytesRead(hc) == 0);
    CHECK(fake.readCalls() >= 3);  // 5 pieces, at most 2 per backend call
}

TEST_CASE("readString") {
    SETUP;
    const Address s = heap.managedString(u"factory4_day");
    CHECK(managed.readString(s) == "factory4_day");
    CHECK(managed.readString(s, 7) == std::nullopt);  // rejected, not truncated
    CHECK(managed.readString(s, 7, il2cpp::Managed::Overflow::Truncate) == "factory");
    CHECK(managed.readString(heap.managedString(u"")) == "");
    CHECK(managed.readString(0) == std::nullopt);

    const Address bad = heap.alloc(0x20);
    heap.put<std::int32_t>(bad + kIl2Cpp.stringLength, -5);
    CHECK(managed.readString(bad) == std::nullopt);

    const Address field = heap.alloc(8);
    heap.put<Address>(field, heap.managedString(u"Reserve  \r\n"));
    CHECK(managed.readStringField(field) == "Reserve");
    heap.put<Address>(field, 0);
    CHECK(managed.readStringField(field) == std::nullopt);
}

TEST_CASE("readArray and readList") {
    SETUP;
    const std::vector<std::uint64_t> values{0x10000, 0x20000, 0x30000};
    const Address arr = heap.array(values);
    CHECK(managed.readArray<std::uint64_t>(arr) == values);
    CHECK(managed.readArray<std::uint64_t>(arr, 2) == std::nullopt);  // over cap
    CHECK(managed.readArray<std::uint64_t>(heap.array(std::vector<std::uint64_t>{}))->empty());

    const Address list = heap.list(values, /*capacity*/ 8);
    CHECK(managed.readList<std::uint64_t>(list) == values);
    CHECK(managed.readList<std::uint64_t>(heap.list(std::vector<std::uint64_t>{}))->empty());

    SUBCASE("size larger than backing array is rejected") {
        const Address l = heap.alloc(0x20);
        heap.put<Address>(l + kIl2Cpp.listItems, heap.array(values));
        heap.put<std::int32_t>(l + kIl2Cpp.listSize, 5);
        CHECK(managed.readList<std::uint64_t>(l) == std::nullopt);
    }
    SUBCASE("negative size is rejected") {
        const Address l = heap.alloc(0x20);
        heap.put<std::int32_t>(l + kIl2Cpp.listSize, -1);
        CHECK(managed.readList<std::uint64_t>(l) == std::nullopt);
    }
}

TEST_CASE("batched readers match the single ones, element for element") {
    SETUP;
    const std::vector<std::uint64_t> values{0x10000, 0x20000, 0x30000};
    const Address field = heap.alloc(8), nullField = heap.alloc(8), longField = heap.alloc(8), emptyField = heap.alloc(8);
    heap.put<Address>(field, heap.managedString(u"Reserve  \r\n"));
    heap.put<Address>(longField, heap.managedString(u"much too long"));
    heap.put<Address>(emptyField, heap.managedString(u""));
    const std::vector<Address> fields{field, nullField, longField, emptyField, 0};
    const auto strings = managed.readStringFields(fields, 12);
    REQUIRE(strings.size() == fields.size());
    for (std::size_t i = 0; i < fields.size(); ++i) CHECK(strings[i] == managed.readStringField(fields[i], 12));
    CHECK(strings[2] == std::nullopt);  // over the cap
    CHECK(strings[0] == "Reserve");

    const Address tooBig = heap.list(values, 8);
    const Address oversized = heap.alloc(0x20);  // _size larger than the backing array
    heap.put<Address>(oversized + kIl2Cpp.listItems, heap.array(values));
    heap.put<std::int32_t>(oversized + kIl2Cpp.listSize, 5);
    const std::vector<Address> lists{heap.list(values, 8), heap.list(std::vector<std::uint64_t>{}), oversized, 0, tooBig};
    const auto readLists = managed.readLists<std::uint64_t>(lists, 4);
    for (std::size_t i = 0; i < lists.size(); ++i) CHECK(readLists[i] == managed.readList<std::uint64_t>(lists[i], 4));
    CHECK(readLists[0] == values);

    const std::vector<Address> arrays{heap.array(values), heap.array(std::vector<std::uint64_t>{}), 0};
    const auto readArrays = managed.readArrays<std::uint64_t>(arrays, 3);
    for (std::size_t i = 0; i < arrays.size(); ++i) CHECK(readArrays[i] == managed.readArray<std::uint64_t>(arrays[i], 3));
    CHECK(managed.readArrays<std::uint64_t>(arrays, 2)[0] == std::nullopt);  // over cap
}

TEST_CASE("readDictionary skips freed slots") {
    SETUP;
    struct Entry {
        std::int32_t hashCode, next;
        std::uint64_t key;
        std::int32_t value;
    };
    const std::vector<Entry> entries{{1, -1, 0xAA, 10}, {-1, -1, 0xBB, 20}, {3, 0, 0xCC, 30}};
    const Address dict = heap.alloc(0x40);
    heap.put<Address>(dict + kIl2Cpp.dictEntries, heap.array(entries));
    heap.put<std::int32_t>(dict + kIl2Cpp.dictCount, 3);

    const auto pairs = managed.readDictionary<std::uint64_t, std::int32_t>(dict);
    REQUIRE(pairs);
    REQUIRE(pairs->size() == 2);
    CHECK((*pairs)[0] == std::pair<std::uint64_t, std::int32_t>{0xAA, 10});
    CHECK((*pairs)[1] == std::pair<std::uint64_t, std::int32_t>{0xCC, 30});
    CHECK(managed.readDictionary<std::uint64_t, std::int32_t>(dict, 2) == std::nullopt);
}

TEST_CASE("readHashSet skips freed slots and checks the slot count") {
    SETUP;
    struct Slot {
        std::int32_t hashCode, next;
        std::uint64_t value;
    };
    const std::vector<Slot> slots{{1, -1, 0xAA}, {-1, -1, 0xBB}, {3, 0, 0xCC}, {0, 0, 0}};
    const Address set = heap.alloc(0x40);
    heap.put<Address>(set + kIl2Cpp.hashSetSlots, heap.array(slots));
    heap.put<std::int32_t>(set + kIl2Cpp.hashSetLastIndex, 3);  // the 4th slot was never used

    CHECK(managed.readHashSet<std::uint64_t>(set) == std::vector<std::uint64_t>{0xAA, 0xCC});
    CHECK(managed.readHashSet<std::uint64_t>(set, 2) == std::nullopt);

    SUBCASE("more slots used than the array holds is rejected") {
        heap.put<std::int32_t>(set + kIl2Cpp.hashSetLastIndex, 5);
        CHECK(managed.readHashSet<std::uint64_t>(set) == std::nullopt);
    }
    SUBCASE("empty") {
        heap.put<std::int32_t>(set + kIl2Cpp.hashSetLastIndex, 0);
        CHECK(managed.readHashSet<std::uint64_t>(set)->empty());
    }
}

TEST_CASE("class identity and inheritance") {
    SETUP;
    const Address objectClass = heap.klass("Object", "System");
    const Address playerClass = heap.klass("Player", "EFT", objectClass);
    const Address localClass = heap.klass("LocalPlayer", "EFT", playerClass);
    const Address nested = heap.klass("Inner", "", objectClass);
    const Address obj = heap.object(localClass);

    CHECK(managed.classNameOf(obj) == "LocalPlayer");
    CHECK(managed.fullClassName(localClass) == "EFT.LocalPlayer");
    CHECK(managed.fullClassName(nested) == "Inner");
    CHECK(managed.isInstanceOf(obj, "LocalPlayer"));
    CHECK(managed.isInstanceOf(obj, "Player"));
    CHECK(managed.isInstanceOf(obj, "EFT.Player"));
    CHECK(managed.isInstanceOf(obj, "System.Object"));
    CHECK_FALSE(managed.isInstanceOf(obj, "Other.Player"));
    CHECK_FALSE(managed.isInstanceOf(obj, "ObservedPlayerView"));

    SUBCASE("self-parent doesn't loop") {
        heap.put<Address>(objectClass + kIl2Cpp.classParent, objectClass);
        CHECK_FALSE(managed.isInstanceOf(obj, "Nope"));
    }
}

TEST_CASE("inheritance walks past an unnamed class") {
    SETUP;
    const Address objectClass = heap.klass("Object", "System");
    const Address compound = heap.klass("CompoundItem", "EFT.InventoryLogic", objectClass);
    const Address unnamed = heap.klass("", "", compound);
    const Address vest = heap.klass("Vest", "EFT.InventoryLogic", unnamed);
    const Address obj = heap.object(vest);
    CHECK(managed.isInstanceOf(obj, "Vest"));
    CHECK(managed.isInstanceOf(obj, "CompoundItem"));
    CHECK(managed.isInstanceOf(obj, "System.Object"));
}

TEST_CASE("an ancestry cut short by an unreadable parent is no \"no\", and isn't cached") {
    SETUP;
    const Address objectClass = heap.klass("Object", "System");
    const Address lootItem = heap.klass("LootItem", "EFT.Interactive", objectClass);
    const Address observed = heap.klass("ObservedLootItem", "EFT.Interactive");  // parent reads as 0

    CHECK(managed.classIsAKnown(observed, "ObservedLootItem") == true);
    CHECK(managed.classIsAKnown(observed, "LootItem") == std::nullopt);
    CHECK_FALSE(managed.classIsA(observed, "LootItem"));
    CHECK(managed.describeAncestry(observed) == "EFT.Interactive.ObservedLootItem (incomplete)");

    heap.put<Address>(observed + kIl2Cpp.classParent, lootItem);  // readable now
    CHECK(managed.classIsAKnown(observed, "LootItem") == true);
    CHECK(managed.classIsAKnown(observed, "Door") == false);  // complete: a real "no"
    CHECK(managed.describeAncestry(observed) ==
          "EFT.Interactive.ObservedLootItem < EFT.Interactive.LootItem < System.Object");
}

TEST_CASE("TypeInfoTable static fields") {
    SETUP;
    const Address gameAssembly = 0x7FF6'0000'0000;
    constexpr std::uint64_t rva = 0x5000;
    const Address table = heap.alloc(8 * 16);
    heap.put<Address>(gameAssembly + rva, table);

    const Address klass = heap.klass("GamePlayerOwner", "EFT");
    const Address statics = heap.alloc(0x20);
    heap.put<Address>(klass + kIl2Cpp.classStaticFields, statics);
    heap.put<Address>(table + 5 * 8, klass);

    const auto tit = il2cpp::TypeInfoTable::locate(view, kIl2Cpp, gameAssembly, rva);
    REQUIRE(tit);
    CHECK(tit->klass(5) == klass);
    CHECK(tit->staticFields(5) == statics);
    CHECK(tit->klass(6) == std::nullopt);  // slot not filled yet
    CHECK(tit->klass(-1) == std::nullopt);
    CHECK_FALSE(il2cpp::TypeInfoTable::locate(view, kIl2Cpp, gameAssembly, rva + 8));
}

#undef SETUP
