#include "tools/il2cpp-dump/Dumper.hpp"

#include "core/mem/PatternScan.hpp"
#include "core/mem/ReadBatch.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <format>
#include <functional>
#include <limits>
#include <map>
#include <set>
#include <thread>
#include <unordered_map>

namespace radar::tools {

using mem::Freshness;
using mem::MemoryView;
using mem::Pattern;

namespace {

// IL2CPP runtime layouts (x64, metadata v29-era). They come from the game's offsets file because they
// can change with the IL2CPP version.
namespace L {
constexpr std::uint32_t ClassName = off::managed::Il2CppClass::Name;
constexpr std::uint32_t ClassNamespace = off::managed::Il2CppClass::Namespace;
constexpr std::uint32_t ClassByvalArg = off::managed::Il2CppClass::ByvalArg;
constexpr std::uint32_t ClassDeclaringType = off::managed::Il2CppClass::DeclaringType;
constexpr std::uint32_t ClassParent = off::managed::Il2CppClass::Parent;
constexpr std::uint32_t ClassFields = off::managed::Il2CppClass::Fields;
constexpr std::uint32_t ClassFieldCount = off::managed::Il2CppClass::FieldCount;  // u16
constexpr std::uint32_t FieldName = off::managed::FieldInfo::Name;
constexpr std::uint32_t FieldType = off::managed::FieldInfo::Type;
constexpr std::uint32_t FieldParent = off::managed::FieldInfo::Parent;
constexpr std::uint32_t FieldOffset = off::managed::FieldInfo::Offset;
constexpr std::uint32_t FieldSize = off::managed::FieldInfo::Size;
constexpr std::uint32_t TypeData = off::managed::Il2CppType::Data;
constexpr std::uint32_t TypeAttrs = off::managed::Il2CppType::Attrs;  // u16
constexpr std::uint32_t TypeKind = off::managed::Il2CppType::Kind;    // u8
// Bytes of the class header read in one go: everything up to and including field_count.
constexpr std::uint32_t ClassHeaderSize = std::max({ClassName, ClassNamespace, ClassByvalArg, ClassDeclaringType,
                                                    ClassParent, ClassFields}) + 8 > ClassFieldCount + 2
                                              ? std::max({ClassName, ClassNamespace, ClassByvalArg, ClassDeclaringType,
                                                          ClassParent, ClassFields}) + 8
                                              : ClassFieldCount + 2;
}  // namespace L

constexpr std::uint16_t kFieldAttrStatic = 0x10;
constexpr std::uint16_t kFieldAttrLiteral = 0x40;
constexpr std::int32_t kMaxTypes = 200'000;
constexpr std::size_t kSlotChunk = 2048;
constexpr std::uint16_t kMaxFields = 4096;
constexpr std::size_t kShortName = 64;
constexpr std::size_t kLongName = 256;

struct RipSignature {
    const char* name;
    const char* pattern;
    std::uint32_t dispOffset;
    std::uint32_t insnLength;
};

// Instructions that load or store the type-info table global.
constexpr RipSignature kTableSignatures[] = {
    {"tableLookup",
     "48 8B 05 ? ? ? ? ? ? ? ? ? ? ? 90 48 85 DB 75 ? 48 8D 2D ? ? ? ? 48 89 6C 24 ? 48 8B CD E8 ? ? ? ? 90 ? ? ? "
     "48 85 DB 75 ? 8B CF",
     3, 7},
    {"rcxLoad", "48 8B 0D ? ? ? ? 48 63 D0 ? ? ? ? 48 85 C9 74", 3, 7},
    {"initStoreLong",
     "48 89 05 ? ? ? ? 4C 8B 05 ? ? ? ? 48 8B 05 ? ? ? ? 48 63 48 ? BA ? ? ? ? 41 FF D0 48 89 05 ? ? ? ?", 3, 7},
    {"initStore", "48 89 05 ? ? ? ? 48 8B 05 ? ? ? ? 8B 48", 3, 7},
    // calloc(count, 8) followed by the store of the result into the global.
    {"allocStore", "48 C1 E9 04 BA 08 00 00 00 ? ? ? 48 89 05 ? ? ? ? 48 8B 05 ? ? ? ?", 15, 19},
};

// Any RIP-relative 64-bit mov to or from a global; last resort.
constexpr const char* kBroadMovs[] = {"48 8B 05 ? ? ? ?", "48 8B 0D ? ? ? ?", "48 8B 15 ? ? ? ?", "4C 8B 05 ? ? ? ?",
                                      "4C 8B 0D ? ? ? ?", "48 89 05 ? ? ? ?", "48 89 0D ? ? ? ?", "4C 89 05 ? ? ? ?"};

// UnityPlayer: the GameObjectManager global.
constexpr RipSignature kGomDirect[] = {
    {"gomInitStore", "48 89 05 ? ? ? ? 48 83 C4 ? C3 33 C9", 3, 7},
    {"gomRbpStore", "48 89 2D ? ? ? ? 48 8B 6C 24 ? 48 83 C4 ? 5E C3 33 ED", 3, 7},
    {"gomRsiRead", "48 8B 35 ? ? ? ? 48 85 F6 0F 84 ? ? ? ? 8B 46", 3, 7},
    {"gomRdxRead", "48 8B 15 ? ? ? ? 48 83 C2 ? 48 3B DA", 3, 7},
    {"gomRcxRead", "48 8B 0D ? ? ? ? 4C 8D 4C 24 ? 4C 8D 44 24 ? 89 44 24", 3, 7},
};
// Calls to a getter that starts with "mov rax, [rip+global]".
constexpr RipSignature kGomCalls[] = {
    {"gomGetterCall1", "E8 ? ? ? ? 4C 8D 45 ? 89 5D ? 48 8D 55", 1, 5},
    {"gomGetterCall2", "E8 ? ? ? ? 8B 48 ? ? ? ? ? ? ? ? 48 8D 77", 1, 5},
    {"gomGetterCall3", "E8 ? ? ? ? 48 8B 58 ? 48 8D 78 ? 48 3B DF 74 ? ? ? ? 48 8B 53", 1, 5},
};
// UnityPlayer: the "all cameras" array global.
constexpr RipSignature kAllCameras[] = {
    {"camIterator", "4C 8B 05 ? ? ? ? 33 D2 49 8B 48 10 48 85 C9 74 ? 4D 8B 08", 3, 7},
    {"camIndexed", "48 8B 05 ? ? ? ? 48 8B 38 48 8B 3C 3E 8B 87 74 03 00 00", 3, 7},
    {"camCount", "48 8B 05 ? ? ? ? 49 C7 C6 FF FF FF FF 8B 48 10 85 C9 0F 84 ? ? ? ?", 3, 7},
    {"camRbxIterator", "48 8B 1D ? ? ? ? 48 8B 73 ? 48 8B 43 ? 48 FF C6", 3, 7},
};

template <std::size_t N>
std::vector<Pattern> parsePatterns(const RipSignature (&sigs)[N]) {
    std::vector<Pattern> out;
    for (const auto& s : sigs) out.push_back(*Pattern::parse(s.pattern));
    return out;
}

bool inModule(Address a, const mem::ModuleInfo& m) { return a >= m.base && a < m.base + m.size; }

// Valid UTF-8 without control characters, non-empty.
bool plausibleName(std::string_view s) {
    if (s.empty()) return false;
    for (std::size_t i = 0; i < s.size();) {
        const auto c = static_cast<unsigned char>(s[i]);
        if (c < 0x20 || c == 0x7F) return false;
        std::size_t n = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
        if (n == 0 || i + n > s.size()) return false;
        for (std::size_t k = 1; k < n; ++k)
            if ((static_cast<unsigned char>(s[i + k]) >> 6) != 0x2) return false;
        i += n;
    }
    return true;
}

std::optional<std::string> cstr(std::span<const char> buf) {
    const auto end = std::find(buf.begin(), buf.end(), '\0');
    if (end == buf.end()) return std::nullopt;  // no terminator within the buffer
    return std::string(buf.begin(), end);
}

// Reads many C strings: first kShortName bytes each, then kLongName for those not terminated.
std::vector<std::optional<std::string>> readNames(const MemoryView& mem, const std::vector<Address>& ptrs) {
    std::vector<std::optional<std::string>> out(ptrs.size());
    std::vector<std::array<char, kShortName>> shortBuf(ptrs.size());
    {
        mem::ReadBatch batch(mem);
        for (std::size_t i = 0; i < ptrs.size(); ++i)
            if (MemoryView::isUserPointer(ptrs[i])) batch.add(ptrs[i], shortBuf[i]);
        batch.execute();
    }
    std::vector<std::size_t> retry;
    for (std::size_t i = 0; i < ptrs.size(); ++i) {
        if (!MemoryView::isUserPointer(ptrs[i])) continue;
        if (auto s = cstr(shortBuf[i])) out[i] = std::move(s);
        else retry.push_back(i);
    }
    if (!retry.empty()) {
        std::vector<std::array<char, kLongName>> longBuf(retry.size());
        mem::ReadBatch batch(mem);
        for (std::size_t k = 0; k < retry.size(); ++k) batch.add(ptrs[retry[k]], longBuf[k]);
        batch.execute();
        for (std::size_t k = 0; k < retry.size(); ++k) out[retry[k]] = cstr(longBuf[k]);
    }
    for (auto& s : out)
        if (s && !plausibleName(*s)) s.reset();
    return out;
}

std::string fullNameOf(const std::string& ns, const std::string& name) { return ns.empty() ? name : ns + "." + name; }

template <class T>
T fromBytes(const std::uint8_t* p) {
    T v;
    std::memcpy(&v, p, sizeof(T));
    return v;
}

const char* typeKindName(std::uint8_t kind) {
    switch (kind) {
    case 0x01: return "void";
    case 0x02: return "bool";
    case 0x03: return "char";
    case 0x04: return "int8_t";
    case 0x05: return "uint8_t";
    case 0x06: return "int16_t";
    case 0x07: return "uint16_t";
    case 0x08: return "int32_t";
    case 0x09: return "uint32_t";
    case 0x0A: return "int64_t";
    case 0x0B: return "uint64_t";
    case 0x0C: return "float";
    case 0x0D: return "double";
    case 0x0E: return "string";
    case 0x11: return "valuetype";
    case 0x12: return "class";
    case 0x13: return "var";
    case 0x14: return "array";
    case 0x15: return "genericinst";
    case 0x16: return "typedbyref";
    case 0x18: return "intptr";
    case 0x19: return "uintptr";
    case 0x1B: return "fnptr";
    case 0x1C: return "object";
    case 0x1E: return "mvar";
    case 0x55: return "enum";
    default: return nullptr;
    }
}

}  // namespace

// ---- type-info table ----------------------------------------------------------------------------

bool Il2CppDumper::validClass(Address klass) const {
    if (!MemoryView::isUserPointer(klass)) return false;
    const Address namePtr = mem_.read<Address>(klass + L::ClassName, Freshness::Fresh);
    if (!MemoryView::isUserPointer(namePtr)) return false;
    std::array<char, 160> buf{};
    mem_.readBytes(namePtr, std::as_writable_bytes(std::span{buf}), Freshness::Fresh);
    const auto name = cstr(buf);
    return name && !name->empty() &&
           std::all_of(name->begin(), name->end(), [](char c) { return c >= 0x20 && c <= 0x7E; });
}

bool Il2CppDumper::validTable(Address table) const {
    if (!MemoryView::isUserPointer(table)) return false;
    auto probe = [&](std::size_t first, std::size_t count, std::size_t needed) {
        std::vector<Address> slots(count);
        mem_.readBytes(table + first * sizeof(Address), std::as_writable_bytes(std::span{slots}), Freshness::Fresh);
        std::size_t valid = 0;
        for (Address k : slots) valid += validClass(k) ? 1 : 0;
        return valid >= needed;
    };
    // Low indices are core types that are always set up; index 5000+ checks the table is really large.
    return probe(0, 16, 8) && probe(5000, 8, 3);
}

std::optional<TableLocation> Il2CppDumper::locateTypeInfoTable(std::vector<std::string>& notes) const {
    auto tableAt = [&](std::uint64_t rva) -> Address {
        if (rva == 0 || rva >= gameAssembly_.size) return 0;
        return mem_.read<Address>(gameAssembly_.base + rva, Freshness::Fresh);
    };

    if (options_.typeInfoRvaOverride) {
        const Address table = tableAt(*options_.typeInfoRvaOverride);
        const bool ok = validTable(table);
        notes.push_back(std::format("type-info table: using --type-info-rva {:#x} ({})", *options_.typeInfoRvaOverride,
                                    ok ? "validated" : "NOT validated"));
        return TableLocation{*options_.typeInfoRvaOverride, table, "override", ok};
    }

    const auto regions = mem::codeRegions(mem_, gameAssembly_.base, gameAssembly_.size);

    // Specific signatures, validated with retries (the table fills up during startup).
    std::vector<std::pair<std::uint64_t, std::string>> candidates;
    {
        const auto patterns = parsePatterns(kTableSignatures);
        const auto matches = mem::scan(mem_, regions, patterns, 64);
        std::set<std::uint64_t> seen;
        for (std::size_t i = 0; i < matches.size(); ++i) {
            for (Address m : matches[i]) {
                const auto target =
                    mem::ripTarget(mem_, m, kTableSignatures[i].dispOffset, kTableSignatures[i].insnLength);
                if (!target || !inModule(*target, gameAssembly_)) continue;
                const std::uint64_t rva = *target - gameAssembly_.base;
                if (seen.insert(rva).second) candidates.emplace_back(rva, kTableSignatures[i].name);
            }
            notes.push_back(std::format("type-info table: signature {} matched {} time(s)", kTableSignatures[i].name,
                                        matches[i].size()));
        }
    }
    for (int attempt = 0; attempt < std::max(1, options_.validateAttempts); ++attempt) {
        for (const auto& [rva, name] : candidates) {
            const Address table = tableAt(rva);
            if (validTable(table)) {
                notes.push_back(std::format("type-info table: {:#x} via signature {}", rva, name));
                return TableLocation{rva, table, "signature:" + name, true};
            }
        }
        if (candidates.empty()) break;
        if (attempt + 1 < options_.validateAttempts) std::this_thread::sleep_for(options_.validateDelay);
    }
    notes.push_back(std::format("type-info table: none of {} signature candidate(s) validated", candidates.size()));

    if (options_.broadScan) {
        std::vector<Pattern> patterns;
        for (const char* p : kBroadMovs) patterns.push_back(*Pattern::parse(p));
        const auto matches = mem::scan(mem_, regions, patterns, 20'000);
        std::set<std::uint64_t> seen;
        for (const auto& list : matches) {
            for (Address m : list) {
                const auto target = mem::ripTarget(mem_, m, 3, 7);
                if (!target || !inModule(*target, gameAssembly_)) continue;
                const std::uint64_t rva = *target - gameAssembly_.base;
                if (!seen.insert(rva).second) continue;
                const Address table = tableAt(rva);
                if (MemoryView::isUserPointer(table) && validTable(table)) {
                    notes.push_back(std::format("type-info table: {:#x} via broad scan ({} globals tried)", rva,
                                                seen.size()));
                    return TableLocation{rva, table, "broad", true};
                }
            }
        }
        notes.push_back(std::format("type-info table: broad scan found nothing ({} globals tried)", seen.size()));
    }

    if (options_.fallbackTypeInfoRva) {
        const Address table = tableAt(options_.fallbackTypeInfoRva);
        if (validTable(table)) {
            notes.push_back(std::format("type-info table: compiled-in RVA {:#x} validated", options_.fallbackTypeInfoRva));
            return TableLocation{options_.fallbackTypeInfoRva, table, "compiled", true};
        }
        notes.push_back(std::format("type-info table: compiled-in RVA {:#x} did not validate", options_.fallbackTypeInfoRva));
    }
    return std::nullopt;
}

std::int32_t Il2CppDumper::countTypes(Address table) const {
    // The table's size isn't stored anywhere reliable. Scan chunks until two consecutive chunks hold no
    // classes, and report the highest slot holding one. Single null slots are normal (entries are filled
    // lazily). Only plausible classes seen for the first time count: memory after the table can hold
    // stray pointers, including pointers to real classes.
    std::int32_t highest = -1;
    int emptyChunks = 0;
    std::set<Address> seen;
    std::vector<Address> slots(kSlotChunk);
    for (std::int32_t first = 0; first < kMaxTypes && emptyChunks < 2; first += static_cast<std::int32_t>(kSlotChunk)) {
        std::fill(slots.begin(), slots.end(), 0);
        mem_.readBytes(table + static_cast<Address>(first) * sizeof(Address), std::as_writable_bytes(std::span{slots}),
                       Freshness::Fresh);
        std::vector<std::size_t> candidates;
        std::vector<Address> namePtrs;
        for (std::size_t i = 0; i < slots.size(); ++i)
            if (MemoryView::isUserPointer(slots[i]) && !seen.contains(slots[i])) candidates.push_back(i);
        namePtrs.resize(candidates.size());
        {
            mem::ReadBatch batch(mem_);
            for (std::size_t k = 0; k < candidates.size(); ++k)
                batch.add(slots[candidates[k]] + L::ClassName, namePtrs[k]);
            batch.execute(Freshness::Fresh);
        }
        const auto names = readNames(mem_, namePtrs);
        bool any = false;
        for (std::size_t k = 0; k < candidates.size(); ++k) {
            if (!names[k] || !seen.insert(slots[candidates[k]]).second) continue;
            any = true;
            highest = first + static_cast<std::int32_t>(candidates[k]);
        }
        emptyChunks = any ? 0 : emptyChunks + 1;
    }
    return highest + 1;
}

// ---- classes and fields -------------------------------------------------------------------------

std::vector<ClassRecord> Il2CppDumper::readClasses(Address table, std::int32_t typeCount) const {
    if (typeCount <= 0) return {};
    std::vector<Address> slots(static_cast<std::size_t>(typeCount));
    mem_.readBytes(table, std::as_writable_bytes(std::span{slots}), Freshness::Fresh);

    struct Raw {
        std::int32_t index;
        Address klass;
        std::array<std::uint8_t, L::ClassHeaderSize> header{};
    };
    std::vector<Raw> raws;
    std::set<Address> seenKlass;  // a class appears once; repeats are stray pointers
    for (std::int32_t i = 0; i < typeCount; ++i) {
        const Address k = slots[static_cast<std::size_t>(i)];
        if (MemoryView::isUserPointer(k) && seenKlass.insert(k).second) raws.push_back({i, k});
    }
    {
        mem::ReadBatch batch(mem_);
        for (auto& r : raws) batch.addBytes(r.klass, r.header.data(), r.header.size());
        batch.execute(Freshness::Fresh);
    }
    auto ptrAt = [](const Raw& r, std::uint32_t off) { return fromBytes<Address>(r.header.data() + off); };

    // Names and namespaces.
    std::vector<Address> namePtrs, nsPtrs;
    for (const auto& r : raws) {
        namePtrs.push_back(ptrAt(r, L::ClassName));
        nsPtrs.push_back(ptrAt(r, L::ClassNamespace));
    }
    const auto names = readNames(mem_, namePtrs);
    const auto namespaces = readNames(mem_, nsPtrs);

    std::vector<ClassRecord> classes;
    std::vector<const Raw*> rawOf;
    std::unordered_map<Address, std::size_t> byKlass;
    std::unordered_map<Address, std::size_t> byByvalData;  // type-definition handle → class (for field types)
    for (std::size_t i = 0; i < raws.size(); ++i) {
        if (!names[i]) continue;
        ClassRecord c;
        c.typeIndex = raws[i].index;
        c.klass = raws[i].klass;
        c.name = *names[i];
        c.ns = namespaces[i].value_or("");
        c.fullName = fullNameOf(c.ns, c.name);
        byKlass.emplace(c.klass, classes.size());
        const Address byval = ptrAt(raws[i], L::ClassByvalArg + L::TypeData);
        if (byval) byByvalData.emplace(byval, classes.size());
        c.typeDefinition = byval;
        c.fieldCount = fromBytes<std::uint16_t>(raws[i].header.data() + L::ClassFieldCount);
        classes.push_back(std::move(c));
        rawOf.push_back(&raws[i]);
    }

    // Parent and declaring classes: from the table when possible, otherwise (generic instances, which
    // aren't in the table) read their names directly.
    std::vector<Address> foreign;
    for (const Raw* r : rawOf) {
        for (std::uint32_t off : {L::ClassParent, L::ClassDeclaringType}) {
            const Address k = ptrAt(*r, off);
            if (MemoryView::isUserPointer(k) && !byKlass.contains(k)) foreign.push_back(k);
        }
    }
    std::sort(foreign.begin(), foreign.end());
    foreign.erase(std::unique(foreign.begin(), foreign.end()), foreign.end());
    std::unordered_map<Address, std::string> foreignNames;
    {
        std::vector<std::array<Address, 2>> ptrs(foreign.size());
        mem::ReadBatch batch(mem_);
        for (std::size_t i = 0; i < foreign.size(); ++i) {
            batch.add(foreign[i] + L::ClassName, ptrs[i][0]);
            batch.add(foreign[i] + L::ClassNamespace, ptrs[i][1]);
        }
        batch.execute();
        std::vector<Address> n, s;
        for (const auto& p : ptrs) {
            n.push_back(p[0]);
            s.push_back(p[1]);
        }
        const auto fn = readNames(mem_, n);
        const auto fs = readNames(mem_, s);
        for (std::size_t i = 0; i < foreign.size(); ++i)
            if (fn[i]) foreignNames.emplace(foreign[i], fullNameOf(fs[i].value_or(""), *fn[i]));
    }
    auto nameOfClass = [&](Address k) -> std::optional<std::string> {
        if (auto it = byKlass.find(k); it != byKlass.end()) return classes[it->second].fullName;
        if (auto it = foreignNames.find(k); it != foreignNames.end()) return it->second;
        return std::nullopt;
    };
    for (std::size_t i = 0; i < classes.size(); ++i) {
        const Address parent = ptrAt(*rawOf[i], L::ClassParent);
        if (MemoryView::isUserPointer(parent)) {
            classes[i].parent = nameOfClass(parent);
            if (auto it = byKlass.find(parent); it != byKlass.end()) classes[i].parentTypeIndex = classes[it->second].typeIndex;
        }
        const Address outer = ptrAt(*rawOf[i], L::ClassDeclaringType);
        if (MemoryView::isUserPointer(outer)) classes[i].declaringType = nameOfClass(outer);
    }

    // Fields: raw FieldInfo arrays, then names, then types.
    struct RawFields {
        std::size_t cls;
        std::vector<std::uint8_t> bytes;
    };
    std::vector<RawFields> rawFields;
    for (std::size_t i = 0; i < classes.size(); ++i) {
        const Address arr = ptrAt(*rawOf[i], L::ClassFields);
        const auto count = fromBytes<std::uint16_t>(rawOf[i]->header.data() + L::ClassFieldCount);
        if (count == 0) {
            classes[i].fieldsInitialised = true;  // a class without fields
            continue;
        }
        if (!MemoryView::isUserPointer(arr) || count > kMaxFields) continue;  // not set up yet
        rawFields.push_back({i, std::vector<std::uint8_t>(static_cast<std::size_t>(count) * L::FieldSize)});
    }
    {
        mem::ReadBatch batch(mem_);
        for (auto& rf : rawFields)
            batch.addBytes(ptrAt(*rawOf[rf.cls], L::ClassFields), rf.bytes.data(), rf.bytes.size());
        batch.execute(Freshness::Fresh);
    }

    std::vector<Address> fieldNamePtrs;
    std::vector<Address> fieldTypePtrs;
    for (const auto& rf : rawFields) {
        for (std::size_t off = 0; off < rf.bytes.size(); off += L::FieldSize) {
            fieldNamePtrs.push_back(fromBytes<Address>(rf.bytes.data() + off + L::FieldName));
            fieldTypePtrs.push_back(fromBytes<Address>(rf.bytes.data() + off + L::FieldType));
        }
    }
    const auto fieldNames = readNames(mem_, fieldNamePtrs);

    // Il2CppType records (deduplicated), resolved to names with a small cache.
    struct TypeInfo {
        Address data = 0;
        std::uint16_t attrs = 0;
        std::uint8_t kind = 0;
        bool ok = false;
    };
    std::unordered_map<Address, TypeInfo> types;
    auto readTypes = [&](const std::vector<Address>& ptrs) {
        std::vector<Address> todo;
        for (Address p : ptrs)
            if (MemoryView::isUserPointer(p) && !types.contains(p)) {
                types.emplace(p, TypeInfo{});
                todo.push_back(p);
            }
        std::vector<std::array<std::uint8_t, 16>> buf(todo.size());
        mem::ReadBatch batch(mem_);
        std::vector<mem::ReadBatch::Handle> handles;
        for (std::size_t i = 0; i < todo.size(); ++i) handles.push_back(batch.add(todo[i], buf[i]));
        batch.execute();
        for (std::size_t i = 0; i < todo.size(); ++i) {
            auto& t = types[todo[i]];
            t.ok = batch.complete(handles[i]);
            t.data = fromBytes<Address>(buf[i].data() + L::TypeData);
            t.attrs = fromBytes<std::uint16_t>(buf[i].data() + L::TypeAttrs);
            t.kind = buf[i][L::TypeKind];
        }
    };
    readTypes(fieldTypePtrs);

    std::function<std::string(Address, int)> typeName = [&](Address p, int depth) -> std::string {
        if (depth > 8) return "?";
        if (!types.contains(p)) readTypes({p});
        const auto it = types.find(p);
        if (it == types.end() || !it->second.ok) return "?";
        const TypeInfo t = it->second;
        switch (t.kind) {
        case 0x0F: return typeName(t.data, depth + 1) + "*";   // PTR
        case 0x10: return typeName(t.data, depth + 1) + "&";   // BYREF
        case 0x1D: return typeName(t.data, depth + 1) + "[]";  // SZARRAY
        case 0x11:
        case 0x12:
        case 0x55: {  // VALUETYPE, CLASS, ENUM: data = type-definition handle (or a class pointer)
            if (auto c = byByvalData.find(t.data); c != byByvalData.end()) return classes[c->second].fullName;
            if (auto c = byKlass.find(t.data); c != byKlass.end()) return classes[c->second].fullName;
            return typeKindName(t.kind);
        }
        default:
            if (const char* n = typeKindName(t.kind)) return n;
            return std::format("type_0x{:02X}", t.kind);
        }
    };

    std::size_t f = 0;
    for (const auto& rf : rawFields) {
        ClassRecord& c = classes[rf.cls];
        c.fieldsInitialised = true;
        for (std::size_t off = 0; off < rf.bytes.size(); off += L::FieldSize, ++f) {
            if (!fieldNames[f]) continue;
            FieldRecord fr;
            fr.name = *fieldNames[f];
            fr.offset = fromBytes<std::int32_t>(rf.bytes.data() + off + L::FieldOffset);
            fr.metadataIndex = static_cast<std::int32_t>(off / L::FieldSize);
            const Address typePtr = fieldTypePtrs[f];
            if (auto t = types.find(typePtr); t != types.end() && t->second.ok) {
                fr.isStatic = (t->second.attrs & kFieldAttrStatic) != 0;
                fr.isLiteral = (t->second.attrs & kFieldAttrLiteral) != 0;
                fr.typeKind = t->second.kind;
            }
            fr.type = typeName(typePtr, 0);
            const Address owner = fromBytes<Address>(rf.bytes.data() + off + L::FieldParent);
            fr.declaringClass = nameOfClass(owner).value_or("?");
            c.fields.push_back(std::move(fr));
        }
    }
    return classes;
}

// ---- Literal values (global metadata) -----------------------------------------------------------
//
// Constants (enum members, const fields) have no storage: their values live only in the global
// metadata (global-metadata.dat, loaded into memory by the runtime). It's found through the classes:
// each class's byval_arg points at its Il2CppTypeDefinition, an array indexed by type index inside
// the metadata. From there:
//  1. the stride of that array is the common difference between consecutive classes' pointers;
//  2. the metadata header is page-aligned below it: sanity 0xFAB11BAF, then (offset, size) pairs whose
//     typeDefinitions entry (0xA0) must point back at the array;
//  3. Il2CppTypeDefinition.fieldStart is the int32 that grows by each class's field_count from one
//     type to the next (found by trying every offset, so the struct layout needn't be known);
//  4. fieldDefaultValues (0x40) maps global field indices (fieldStart + position) to offsets into
//     fieldAndParameterDefaultValueData (0x48), where the value is encoded by type.

namespace {
constexpr std::uint32_t kMetadataSanity = 0xFAB11BAF;
constexpr std::uint32_t kHeaderFieldDefaultValues = 0x40;
constexpr std::uint32_t kHeaderDefaultValueData = 0x48;
constexpr std::uint32_t kHeaderTypeDefinitions = 0xA0;
constexpr std::uint32_t kHeaderSize = 0x100;
constexpr std::uint64_t kPage = 0x1000;
constexpr std::size_t kChunk = 1 << 20;
constexpr std::uint32_t kMaxSection = 256u << 20;

// Reads [va, va + size) in chunks; false if any byte is missing.
bool readRange(const MemoryView& mem, Address va, std::vector<std::uint8_t>& out, std::size_t size) {
    out.assign(size, 0);
    mem::ReadBatch batch(mem);
    std::vector<mem::ReadBatch::Handle> handles;
    for (std::size_t at = 0; at < size; at += kChunk)
        handles.push_back(batch.addBytes(va + at, out.data() + at, std::min(kChunk, size - at)));
    batch.execute(Freshness::Fresh);
    return std::ranges::all_of(handles, [&](auto h) { return batch.complete(h); });
}

// libil2cpp's compressed integers (utils/MemoryRead.h).
std::optional<std::uint32_t> readCompressedU32(std::span<const std::uint8_t> b, std::size_t& at) {
    auto byte = [&]() -> std::optional<std::uint32_t> {
        if (at >= b.size()) return std::nullopt;
        return b[at++];
    };
    const auto first = byte();
    if (!first) return std::nullopt;
    const std::uint32_t r = *first;
    if ((r & 0x80) == 0) return r;
    if ((r & 0xC0) == 0x80) {
        const auto b1 = byte();
        if (!b1) return std::nullopt;
        return ((r & ~0x80u) << 8) | *b1;
    }
    if ((r & 0xE0) == 0xC0) {
        const auto b1 = byte(), b2 = byte(), b3 = byte();
        if (!b1 || !b2 || !b3) return std::nullopt;
        return ((r & ~0xC0u) << 24) | (*b1 << 16) | (*b2 << 8) | *b3;
    }
    if (r == 0xF0) {
        if (at + 4 > b.size()) return std::nullopt;
        const auto v = fromBytes<std::uint32_t>(b.data() + at);
        at += 4;
        return v;
    }
    if (r == 0xFE) return 0xFFFFFFFEu;
    if (r == 0xFF) return 0xFFFFFFFFu;
    return std::nullopt;
}

std::optional<std::int32_t> readCompressedI32(std::span<const std::uint8_t> b, std::size_t& at) {
    const auto u = readCompressedU32(b, at);
    if (!u) return std::nullopt;
    if (*u == 0xFFFFFFFFu) return std::numeric_limits<std::int32_t>::min();
    const std::uint32_t magnitude = *u >> 1;
    return (*u & 1) ? -static_cast<std::int32_t>(magnitude) - 1 : static_cast<std::int32_t>(magnitude);
}
}  // namespace

std::optional<LiteralValue> decodeConstant(std::span<const std::uint8_t> blob, std::size_t at, std::uint8_t kind,
                                           std::int32_t version) {
    auto fixed = [&]<class T>(T) -> std::optional<T> {
        if (at > blob.size() || blob.size() - at < sizeof(T)) return std::nullopt;
        return fromBytes<T>(blob.data() + at);
    };
    const bool compressed = version >= 29;
    switch (kind) {
    case 0x02: if (auto v = fixed(std::uint8_t{})) return LiteralValue{*v != 0}; break;
    case 0x03: if (auto v = fixed(std::uint16_t{})) return LiteralValue{std::uint64_t{*v}}; break;  // char
    case 0x04: if (auto v = fixed(std::int8_t{})) return LiteralValue{std::int64_t{*v}}; break;
    case 0x05: if (auto v = fixed(std::uint8_t{})) return LiteralValue{std::uint64_t{*v}}; break;
    case 0x06: if (auto v = fixed(std::int16_t{})) return LiteralValue{std::int64_t{*v}}; break;
    case 0x07: if (auto v = fixed(std::uint16_t{})) return LiteralValue{std::uint64_t{*v}}; break;
    case 0x08:
        if (compressed) {
            if (auto v = readCompressedI32(blob, at)) return LiteralValue{std::int64_t{*v}};
        } else if (auto v = fixed(std::int32_t{})) return LiteralValue{std::int64_t{*v}};
        break;
    case 0x09:
        if (compressed) {
            if (auto v = readCompressedU32(blob, at)) return LiteralValue{std::uint64_t{*v}};
        } else if (auto v = fixed(std::uint32_t{})) return LiteralValue{std::uint64_t{*v}};
        break;
    case 0x0A: if (auto v = fixed(std::int64_t{})) return LiteralValue{*v}; break;
    case 0x0B: if (auto v = fixed(std::uint64_t{})) return LiteralValue{*v}; break;
    case 0x0C: if (auto v = fixed(float{})) return LiteralValue{double{*v}}; break;
    case 0x0D: if (auto v = fixed(double{})) return LiteralValue{*v}; break;
    case 0x0E: {
        std::optional<std::int32_t> length;
        if (compressed) length = readCompressedI32(blob, at);
        else if (auto v = fixed(std::int32_t{})) {
            length = *v;
            at += 4;
        }
        if (!length || *length < 0 || static_cast<std::size_t>(*length) > blob.size() - std::min(at, blob.size()))
            return std::nullopt;  // null string or out of range
        std::string s(reinterpret_cast<const char*>(blob.data() + at), static_cast<std::size_t>(*length));
        if (!s.empty() && !plausibleName(s)) return std::nullopt;
        return LiteralValue{std::move(s)};
    }
    default: break;
    }
    return std::nullopt;
}

std::optional<MetadataInfo> Il2CppDumper::readLiteralValues(std::vector<ClassRecord>& classes,
                                                            std::vector<std::string>& notes) const {
    auto fail = [&](std::string why) -> std::optional<MetadataInfo> {
        notes.push_back("literal values: " + why);
        return std::nullopt;
    };

    // 1. Type-definition array: stride and start.
    std::vector<const ClassRecord*> defs;
    for (const auto& c : classes)
        if (MemoryView::isUserPointer(c.typeDefinition) && c.typeIndex >= 0) defs.push_back(&c);
    std::sort(defs.begin(), defs.end(), [](auto* a, auto* b) { return a->typeIndex < b->typeIndex; });
    if (defs.size() < 2) return fail("too few classes with a type definition");
    std::map<std::uint64_t, std::size_t> strides;
    for (std::size_t i = 1; i < defs.size(); ++i) {
        const auto di = static_cast<std::uint64_t>(defs[i]->typeIndex - defs[i - 1]->typeIndex);
        if (di == 0 || defs[i]->typeDefinition <= defs[i - 1]->typeDefinition) continue;
        const std::uint64_t delta = defs[i]->typeDefinition - defs[i - 1]->typeDefinition;
        if (delta % di == 0) ++strides[delta / di];
    }
    const auto best = std::max_element(strides.begin(), strides.end(),
                                       [](const auto& a, const auto& b) { return a.second < b.second; });
    if (best == strides.end() || best->second * 10 < (defs.size() - 1) * 9 || best->first < 0x20 || best->first > 0x200)
        return fail("class type definitions aren't one evenly spaced array");
    const auto stride = static_cast<std::uint32_t>(best->first);
    const Address first = defs[0]->typeDefinition - static_cast<Address>(defs[0]->typeIndex) * stride;

    // 2. Header: page-aligned at or below the array.
    std::optional<Address> base;
    std::array<std::uint8_t, kHeaderSize> header{};
    std::int32_t version = 0;
    const std::uint64_t pages = options_.metadataScanLimit / kPage;
    constexpr std::uint64_t kPagesPerBatch = 4096;
    for (std::uint64_t done = 0; done < pages && !base; done += kPagesPerBatch) {
        const std::uint64_t n = std::min(kPagesPerBatch, pages - done);
        std::vector<std::array<std::uint32_t, 2>> heads(n);
        std::vector<Address> at(n);
        mem::ReadBatch batch(mem_);
        for (std::uint64_t k = 0; k < n; ++k) {
            const Address top = (first & ~(kPage - 1));
            if (top < (done + k) * kPage) break;
            at[k] = top - (done + k) * kPage;
            batch.add(at[k], heads[k]);
        }
        batch.execute(Freshness::Fresh);
        for (std::uint64_t k = 0; k < n && !base; ++k) {
            if (!at[k] || heads[k][0] != kMetadataSanity) continue;
            const auto v = static_cast<std::int32_t>(heads[k][1]);
            if (v < 24 || v > 40) continue;
            if (!mem_.readBytes(at[k], std::as_writable_bytes(std::span{header}), Freshness::Fresh)) continue;
            if (fromBytes<std::uint32_t>(header.data() + kHeaderTypeDefinitions) != first - at[k]) continue;
            base = at[k];
            version = v;
        }
    }
    if (!base)
        return fail(std::format("no metadata header (sanity {:#X}, typeDefinitions at +{:#X}) within {:#X} bytes below the "
                                "type definitions at {:#X} (stride {:#X})",
                                kMetadataSanity, kHeaderTypeDefinitions, options_.metadataScanLimit, first, stride));

    // 3. fieldStart: the int32 that advances by field_count from one type to the next.
    const auto typeCount = static_cast<std::size_t>(defs.back()->typeIndex) + 1;
    std::vector<std::uint8_t> typeDefs;
    if (!readRange(mem_, first, typeDefs, typeCount * stride)) return fail("type definitions unreadable");
    std::vector<std::int32_t> fieldCounts(typeCount, -1);
    for (const auto* c : defs)
        if (c->typeDefinition == first + static_cast<Address>(c->typeIndex) * stride) fieldCounts[c->typeIndex] = c->fieldCount;
    std::optional<std::uint32_t> fieldStartOffset;
    std::size_t bestHits = 0, pairs = 0, ties = 0;
    for (std::uint32_t o = 0; o + 4 <= stride; o += 4) {
        std::size_t hits = 0, n = 0;
        for (std::size_t i = 0; i + 1 < typeCount; ++i) {
            if (fieldCounts[i] <= 0 || fieldCounts[i + 1] <= 0) continue;
            ++n;
            const auto a = fromBytes<std::int32_t>(typeDefs.data() + i * stride + o);
            const auto b = fromBytes<std::int32_t>(typeDefs.data() + (i + 1) * stride + o);
            hits += (static_cast<std::int64_t>(b) - a == fieldCounts[i]) ? 1 : 0;
        }
        pairs = n;
        if (hits > bestHits) {
            bestHits = hits;
            fieldStartOffset = o;
            ties = 0;
        } else if (hits == bestHits && hits > 0) {
            ++ties;
        }
    }
    if (!fieldStartOffset || ties > 0 || pairs < 2 || bestHits * 10 < pairs * 9)
        return fail(std::format("no unambiguous Il2CppTypeDefinition.fieldStart ({} of {} type pairs at best)", bestHits, pairs));

    // 4. Default values.
    const auto section = [&](std::uint32_t at) {
        return std::pair{fromBytes<std::uint32_t>(header.data() + at), fromBytes<std::uint32_t>(header.data() + at + 4)};
    };
    const auto [valuesOffset, valuesSize] = section(kHeaderFieldDefaultValues);
    const auto [dataOffset, dataSize] = section(kHeaderDefaultValueData);
    if (valuesSize % 12 != 0 || valuesSize > kMaxSection || dataSize > kMaxSection)
        return fail(std::format("implausible default-value sections ({:#X} bytes, {:#X} bytes)", valuesSize, dataSize));
    std::vector<std::uint8_t> valueTable, data;
    if (!readRange(mem_, *base + valuesOffset, valueTable, valuesSize) || !readRange(mem_, *base + dataOffset, data, dataSize))
        return fail("default-value sections unreadable");
    std::unordered_map<std::int32_t, std::int32_t> dataIndexOf;  // global field index → data index
    for (std::size_t at = 0; at + 12 <= valueTable.size(); at += 12)
        dataIndexOf.emplace(fromBytes<std::int32_t>(valueTable.data() + at), fromBytes<std::int32_t>(valueTable.data() + at + 8));

    // Enums are stored as their underlying type (the value__ field).
    std::unordered_map<std::string, std::uint8_t> enumKinds;
    for (const auto& c : classes)
        if (c.parent == "System.Enum")
            for (const auto& f : c.fields)
                if (f.name == "value__" && !f.isStatic) enumKinds[c.fullName] = f.typeKind;

    MetadataInfo info{*base, version, stride, *fieldStartOffset, 0, 0};
    for (auto& c : classes) {
        if (c.typeIndex < 0 || static_cast<std::size_t>(c.typeIndex) >= typeCount || fieldCounts[c.typeIndex] < 0) continue;
        const auto fieldStart = fromBytes<std::int32_t>(typeDefs.data() + static_cast<std::size_t>(c.typeIndex) * stride + *fieldStartOffset);
        for (auto& f : c.fields) {
            if (!f.isLiteral) continue;
            ++info.literalFields;
            const auto it = dataIndexOf.find(fieldStart + f.metadataIndex);
            if (it == dataIndexOf.end() || it->second < 0) continue;
            std::uint8_t kind = f.typeKind;
            if (kind == 0x11 || kind == 0x55) {
                const auto e = enumKinds.find(f.type);
                if (e == enumKinds.end()) continue;
                kind = e->second;
            }
            if ((f.value = decodeConstant(data, static_cast<std::size_t>(it->second), kind, version))) ++info.literalValues;
        }
    }
    notes.push_back(std::format("literal values: {} of {} literal fields (metadata v{} at {:#X}, type definitions "
                                "{:#X} bytes each, fieldStart at +{:#X})",
                                info.literalValues, info.literalFields, version, info.base, stride, *fieldStartOffset));
    return info;
}

// ---- Unity globals ------------------------------------------------------------------------------

std::vector<UnityGlobal> Il2CppDumper::findUnityGlobals() const {
    std::vector<UnityGlobal> out;
    if (!unityPlayer_) return out;
    const mem::ModuleInfo up = *unityPlayer_;
    const auto regions = mem::codeRegions(mem_, up.base, up.size);

    // Candidate slot → signature families that point at it.
    using Candidates = std::map<Address, std::set<std::string>>;
    auto collect = [&](std::span<const RipSignature> sigs, Candidates& cands, bool viaGetter) {
        std::vector<Pattern> patterns;
        for (const auto& s : sigs) patterns.push_back(*Pattern::parse(s.pattern));
        const auto matches = mem::scan(mem_, regions, patterns, 64);
        for (std::size_t i = 0; i < matches.size(); ++i) {
            for (Address m : matches[i]) {
                auto target = mem::ripTarget(mem_, m, sigs[i].dispOffset, sigs[i].insnLength);
                if (!target) continue;
                if (viaGetter) {
                    std::array<std::uint8_t, 3> head{};
                    mem_.readBytes(*target, std::as_writable_bytes(std::span{head}));
                    if (head != std::array<std::uint8_t, 3>{0x48, 0x8B, 0x05}) continue;
                    target = mem::ripTarget(mem_, *target, 3, 7);
                    if (!target) continue;
                }
                if (inModule(*target, up)) cands[*target].insert(sigs[i].name);
            }
        }
    };

    // Picks the validated candidate with the most distinct families (a tie at the top is ambiguous).
    auto choose = [&](const std::string& name, const Candidates& cands, auto&& validate) {
        UnityGlobal g;
        g.name = name;
        std::vector<std::pair<Address, std::size_t>> valid;
        for (const auto& [slot, fams] : cands)
            if (validate(slot, g)) valid.emplace_back(slot, fams.size());
        std::sort(valid.begin(), valid.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
        auto pick = [&](Address slot) {
            g.rva = slot - up.base;
            const auto& fams = cands.at(slot);
            g.families.assign(fams.begin(), fams.end());
        };
        if (!valid.empty() && (valid.size() == 1 || valid[0].second > valid[1].second)) {
            pick(valid[0].first);
            g.validated = true;
            validate(valid[0].first, g);  // re-run to record the layout of the winner
        } else if (!valid.empty()) {
            g.note = std::format("ambiguous: {} validated candidates tie", valid.size());
        } else if (!cands.empty()) {
            // Nothing validates (e.g. no scene loaded). Report the best-supported candidate anyway.
            const auto best = std::max_element(cands.begin(), cands.end(),
                                               [](const auto& a, const auto& b) { return a.second.size() < b.second.size(); });
            pick(best->first);
            g.lastActiveNode.reset();
            g.activeNodes.reset();
            g.note = "not validated (no live objects behind any candidate; dump again while in a raid)";
        } else {
            g.note = "no signature matched";
        }
        return g;
    };

    Candidates gom;
    collect(kGomDirect, gom, false);
    collect(kGomCalls, gom, true);
    out.push_back(choose("gameObjectManager", gom, [&](Address slot, UnityGlobal& g) {
        const Address mgr = mem_.read<Address>(slot, Freshness::Fresh);
        if (!MemoryView::isUserPointer(mgr)) return false;
        for (const auto& [last, active] : {std::pair<std::uint32_t, std::uint32_t>{0x20, 0x28}, {0x28, 0x30}}) {
            const Address a = mem_.read<Address>(mgr + last, Freshness::Fresh);
            const Address b = mem_.read<Address>(mgr + active, Freshness::Fresh);
            if (MemoryView::isUserPointer(a) && MemoryView::isUserPointer(b) &&
                MemoryView::isUserPointer(mem_.read<Address>(a + 0x10, Freshness::Fresh)) &&
                MemoryView::isUserPointer(mem_.read<Address>(b + 0x10, Freshness::Fresh))) {
                g.lastActiveNode = last;
                g.activeNodes = active;
                return true;
            }
        }
        return false;
    }));

    Candidates cams;
    collect(kAllCameras, cams, false);
    out.push_back(choose("allCameras", cams, [&](Address slot, UnityGlobal&) {
        const Address container = mem_.read<Address>(slot, Freshness::Fresh);
        if (!MemoryView::isUserPointer(container)) return false;
        const Address items = mem_.read<Address>(container, Freshness::Fresh);
        if (!MemoryView::isUserPointer(items) || !MemoryView::isUserPointer(mem_.read<Address>(items, Freshness::Fresh)))
            return false;
        const auto count32 = mem_.read<std::uint32_t>(container + 8, Freshness::Fresh);
        const auto count64 = mem_.read<std::uint64_t>(container + 0x10, Freshness::Fresh);
        const auto capacity = mem_.read<std::uint64_t>(container + 0x18, Freshness::Fresh);
        return (count32 >= 1 && count32 <= 4096) ||
               (count64 >= 1 && count64 <= 4096 && count64 <= capacity && capacity <= 65536);
    }));
    return out;
}

// ---- run ----------------------------------------------------------------------------------------

Dump Il2CppDumper::run() {
    Dump dump;
    dump.table = locateTypeInfoTable(dump.notes);
    if (dump.table && MemoryView::isUserPointer(dump.table->table)) {
        dump.typeCount = countTypes(dump.table->table);
        dump.classes = readClasses(dump.table->table, dump.typeCount);
        std::size_t uninitialised = 0;
        for (const auto& c : dump.classes) uninitialised += c.fieldsInitialised ? 0 : 1;
        dump.notes.push_back(std::format("{} types, {} classes read, {} with fields not set up yet", dump.typeCount,
                                         dump.classes.size(), uninitialised));
    } else {
        dump.notes.push_back("no type-info table: no classes dumped");
    }
    if (options_.literals && !dump.classes.empty()) dump.metadata = readLiteralValues(dump.classes, dump.notes);
    if (options_.unity) dump.unity = findUnityGlobals();
    return dump;
}

// ---- JSON ---------------------------------------------------------------------------------------

namespace {
std::string quote(std::string_view s) {
    std::string out = "\"";
    for (const char ch : s) {
        const auto c = static_cast<unsigned char>(ch);
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) out += std::format("\\u{:04x}", c);
            else out += ch;
        }
    }
    return out + "\"";
}
std::string hex(std::uint64_t v) { return quote(std::format("0x{:X}", v)); }
std::string literalJson(const LiteralValue& v) {
    return std::visit(
        [](const auto& x) -> std::string {
            using T = std::decay_t<decltype(x)>;
            if constexpr (std::is_same_v<T, bool>) return x ? "true" : "false";
            else if constexpr (std::is_same_v<T, std::string>) return quote(x);
            else if constexpr (std::is_same_v<T, double>) return std::isfinite(x) ? std::format("{}", x) : quote(std::format("{}", x));
            else return std::to_string(x);
        },
        v);
}
template <class T>
std::string optional(const std::optional<T>& v, auto&& fmt) {
    return v ? fmt(*v) : "null";
}
bool passes(const ClassRecord& c, const DumpOptions& o) {
    if (!o.namespaceFilter.empty() && !c.ns.starts_with(o.namespaceFilter)) return false;
    if (!o.classFilter.empty() && c.fullName.find(o.classFilter) == std::string::npos) return false;
    return true;
}
}  // namespace

std::string toJson(const Dump& d, const DumpOptions& options) {
    std::string out;
    out += "{\n";
    out += "  \"dumpedBy\": \"radar il2cpp-dump\",\n";
    out += "  \"schema\": 1,\n";
    out += "  \"backend\": \"IL2CPP\",\n";
    out += "  \"process\": " + quote(d.process) + ",\n";
    out += "  \"modules\": {";
    for (std::size_t i = 0; i < d.modules.size(); ++i) {
        const auto& m = d.modules[i];
        out += std::format("{}\n    {}: {{ \"base\": {}, \"imageSize\": {}, \"peTimestamp\": {}, \"sizeOfImage\": {} }}",
                           i ? "," : "", quote(m.name), hex(m.info.base), hex(m.info.size),
                           optional(m.fingerprint, [](const auto& f) { return hex(f.timeDateStamp); }),
                           optional(m.fingerprint, [](const auto& f) { return hex(f.sizeOfImage); }));
    }
    out += d.modules.empty() ? "},\n" : "\n  },\n";
    if (d.table)
        out += std::format("  \"typeInfoTable\": {{ \"rva\": {}, \"pointer\": {}, \"method\": {}, \"validated\": {} }},\n",
                           hex(d.table->slotRva), hex(d.table->table), quote(d.table->method),
                           d.table->validated ? "true" : "false");
    else
        out += "  \"typeInfoTable\": null,\n";
    out += std::format("  \"staticFieldsOffset\": {},\n", hex(off::managed::Il2CppClass::StaticFields));
    if (d.metadata)
        out += std::format("  \"metadata\": {{ \"base\": {}, \"version\": {}, \"typeDefinitionSize\": {}, "
                           "\"fieldStartOffset\": {}, \"literalFields\": {}, \"literalValues\": {} }},\n",
                           hex(d.metadata->base), d.metadata->version, hex(d.metadata->typeDefinitionSize),
                           hex(d.metadata->fieldStartOffset), d.metadata->literalFields, d.metadata->literalValues);
    else
        out += "  \"metadata\": null,\n";
    out += std::format("  \"typeCount\": {},\n", d.typeCount);

    out += "  \"unity\": {";
    for (std::size_t i = 0; i < d.unity.size(); ++i) {
        const auto& g = d.unity[i];
        std::string families;
        for (std::size_t k = 0; k < g.families.size(); ++k) families += (k ? ", " : "") + quote(g.families[k]);
        out += std::format("{}\n    {}: {{ \"rva\": {}, \"validated\": {}, \"families\": [{}]", i ? "," : "",
                           quote(g.name), optional(g.rva, hex), g.validated ? "true" : "false", families);
        if (g.lastActiveNode && g.activeNodes)
            out += std::format(", \"layout\": {{ \"lastActiveNode\": {}, \"activeNodes\": {} }}", hex(*g.lastActiveNode),
                               hex(*g.activeNodes));
        if (!g.note.empty()) out += ", \"note\": " + quote(g.note);
        out += " }";
    }
    out += d.unity.empty() ? "},\n" : "\n  },\n";

    out += "  \"notes\": [";
    for (std::size_t i = 0; i < d.notes.size(); ++i) out += std::format("{}\n    {}", i ? "," : "", quote(d.notes[i]));
    out += d.notes.empty() ? "],\n" : "\n  ],\n";

    std::size_t written = 0;
    out += "  \"classes\": [";
    for (const auto& c : d.classes) {
        if (!passes(c, options)) continue;
        out += std::format("{}\n    {{ \"typeIndex\": {}, \"name\": {}, \"namespace\": {}, \"fullName\": {}, "
                           "\"declaringType\": {}, \"parent\": {}, \"parentTypeIndex\": {}, \"classPtr\": {}, "
                           "\"fieldsInitialised\": {}, \"fields\": [",
                           written++ ? "," : "", c.typeIndex, quote(c.name), quote(c.ns), quote(c.fullName),
                           optional(c.declaringType, quote), optional(c.parent, quote),
                           optional(c.parentTypeIndex, [](std::int32_t v) { return std::to_string(v); }), hex(c.klass),
                           c.fieldsInitialised ? "true" : "false");
        for (std::size_t k = 0; k < c.fields.size(); ++k) {
            const auto& f = c.fields[k];
            out += std::format("{}\n      {{ \"name\": {}, \"type\": {}, \"offset\": {}, \"offsetHex\": {}, "
                               "\"isStatic\": {}, \"isLiteral\": {}, \"declaringClass\": {}{} }}",
                               k ? "," : "", quote(f.name), quote(f.type), f.offset,
                               hex(static_cast<std::uint32_t>(f.offset)), f.isStatic ? "true" : "false",
                               f.isLiteral ? "true" : "false", quote(f.declaringClass),
                               f.value ? ", \"value\": " + literalJson(*f.value) : std::string());
        }
        out += c.fields.empty() ? "] }" : "\n    ] }";
    }
    out += written ? "\n  ]\n}\n" : "]\n}\n";
    return out;
}

}  // namespace radar::tools
