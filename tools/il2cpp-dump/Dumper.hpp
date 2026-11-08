#pragma once

#include "core/mem/MemoryView.hpp"
#include "core/mem/Pe.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

// IL2CPP metadata dumper: finds the runtime's type-info table in GameAssembly, reads every class
// (names, parent, fields with offsets, static flags and type names) and locates Unity engine globals in
// UnityPlayer. The result feeds tools/update-offsets.py. Output format: docs/offset-tools.md.
namespace radar::tools {

using mem::Address;

struct FieldRecord {
    std::string name;            // verbatim, e.g. "<Profile>k__BackingField"
    std::string type;            // best-effort type name ("EFT.Player", "int32_t", "genericinst", ...)
    std::int32_t offset = 0;     // instance: from object start (incl. header); static: into static_fields; -1: thread-static
    bool isStatic = false;
    bool isLiteral = false;      // const: has no storage
    std::string declaringClass;  // full name of the class owning the FieldInfo (should equal the class)
};

struct ClassRecord {
    std::int32_t typeIndex = 0;
    Address klass = 0;  // session-specific
    std::string name;
    std::string ns;
    std::string fullName;  // "ns.name", or "name" for nested types (empty namespace)
    std::optional<std::string> declaringType;  // outer class for nested types
    std::optional<std::string> parent;         // base class full name
    std::optional<std::int32_t> parentTypeIndex;
    bool fieldsInitialised = false;  // false: IL2CPP hasn't set up this class's fields yet (lazy)
    std::vector<FieldRecord> fields; // own fields only, metadata order
};

struct TableLocation {
    std::uint64_t slotRva = 0;  // GameAssembly RVA of the global holding the table pointer
    Address table = 0;          // Il2CppClass*[] (session-specific)
    std::string method;         // "override", "signature:<n>", "broad", "compiled"
    bool validated = false;
};

struct UnityGlobal {
    std::string name;  // "gameObjectManager", "allCameras"
    std::optional<std::uint64_t> rva;  // UnityPlayer RVA of the global
    bool validated = false;            // checked against live objects
    std::vector<std::string> families; // signatures that pointed here
    std::optional<std::uint32_t> lastActiveNode, activeNodes;  // GameObjectManager list layout, if validated
    std::string note;
};

struct ModuleRecord {
    std::string name;
    mem::ModuleInfo info;
    std::optional<mem::PeFingerprint> fingerprint;
};

struct Dump {
    std::string process;
    std::vector<ModuleRecord> modules;
    std::optional<TableLocation> table;
    std::int32_t typeCount = 0;
    std::vector<ClassRecord> classes;  // sorted by typeIndex
    std::vector<UnityGlobal> unity;
    std::vector<std::string> notes;    // diagnostics worth keeping with the dump
};

struct DumpOptions {
    std::optional<std::uint64_t> typeInfoRvaOverride;
    std::uint64_t fallbackTypeInfoRva = 0;  // tried last (the compiled-in value)
    std::string namespaceFilter;  // output only: namespace starts with this
    std::string classFilter;      // output only: full name contains this
    bool broadScan = true;        // try every RIP-relative mov if the specific signatures fail
    int validateAttempts = 20;    // the table may still be filling up right after launch
    std::chrono::milliseconds validateDelay{250};
    bool unity = true;
};

class Il2CppDumper {
public:
    Il2CppDumper(const mem::MemoryView& mem, mem::ModuleInfo gameAssembly,
                 std::optional<mem::ModuleInfo> unityPlayer, DumpOptions options)
        : mem_(mem), gameAssembly_(gameAssembly), unityPlayer_(unityPlayer), options_(std::move(options)) {}

    // Runs every stage. Failures are recorded in Dump::notes; the table location is nullopt if no
    // valid table was found (then there are no classes).
    [[nodiscard]] Dump run();

    // Stages, public for tests.
    [[nodiscard]] std::optional<TableLocation> locateTypeInfoTable(std::vector<std::string>& notes) const;
    [[nodiscard]] bool validTable(Address table) const;
    [[nodiscard]] std::int32_t countTypes(Address table) const;
    [[nodiscard]] std::vector<ClassRecord> readClasses(Address table, std::int32_t typeCount) const;
    [[nodiscard]] std::vector<UnityGlobal> findUnityGlobals() const;

private:
    [[nodiscard]] bool validClass(Address klass) const;

    mem::MemoryView mem_;
    mem::ModuleInfo gameAssembly_;
    std::optional<mem::ModuleInfo> unityPlayer_;
    DumpOptions options_;
};

// Serialises the dump (after applying the output filters).
[[nodiscard]] std::string toJson(const Dump& dump, const DumpOptions& options);

}  // namespace radar::tools
