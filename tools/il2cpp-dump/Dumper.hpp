#pragma once

#include "core/mem/MemoryView.hpp"
#include "core/mem/Pe.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <variant>
#include <vector>

// IL2CPP metadata dumper: finds the runtime's type-info table in GameAssembly, reads every class
// (names, parent, fields with offsets, static flags and type names) and locates Unity engine globals in
// UnityPlayer. The result feeds tools/update-offsets.py. Output format: docs/offset-tools.md.
namespace radar::tools {

using mem::Address;

// A constant's value: bool, signed or unsigned integer, floating point or string.
using LiteralValue = std::variant<bool, std::int64_t, std::uint64_t, double, std::string>;

struct FieldRecord {
    std::string name;            // verbatim, e.g. "<Profile>k__BackingField"
    std::string type;            // best-effort type name ("EFT.Player", "int32_t", "genericinst", ...)
    std::int32_t offset = 0;     // instance: from object start (incl. header); static: into static_fields; -1: thread-static
    bool isStatic = false;
    bool isLiteral = false;      // const: has no storage
    std::string declaringClass;  // full name of the class owning the FieldInfo (should equal the class)
    std::uint8_t typeKind = 0;   // Il2CppTypeEnum of the field's type (0: unread)
    std::int32_t metadataIndex = 0;     // position in the class's field array (fieldStart-relative)
    std::optional<LiteralValue> value;  // literals: the constant, if the metadata could be read
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
    Address typeDefinition = 0;      // byval_arg data: the Il2CppTypeDefinition in the loaded metadata
    std::uint16_t fieldCount = 0;    // Il2CppClass.field_count (set even before the fields are set up)
};

// Where the global metadata (global-metadata.dat as loaded) was found, and how much it resolved.
struct MetadataInfo {
    Address base = 0;               // session-specific
    std::int32_t version = 0;
    std::uint32_t typeDefinitionSize = 0;  // stride of the type-definition table
    std::uint32_t fieldStartOffset = 0;    // of Il2CppTypeDefinition.fieldStart
    std::size_t literalFields = 0;         // literal fields in the dump
    std::size_t literalValues = 0;         // ... with a value
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
    std::optional<MetadataInfo> metadata;  // nullopt: literal values not read (see notes)
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
    bool literals = true;  // read literal (const / enum member) values from the loaded metadata
    std::uint64_t metadataScanLimit = 1ull << 30;  // how far below the type definitions to look for the header
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
    // Fills FieldRecord::value for literals; nullopt (with a note) if the metadata can't be found or
    // its layout isn't recognised.
    [[nodiscard]] std::optional<MetadataInfo> readLiteralValues(std::vector<ClassRecord>& classes,
                                                                std::vector<std::string>& notes) const;

private:
    [[nodiscard]] bool validClass(Address klass) const;

    mem::MemoryView mem_;
    mem::ModuleInfo gameAssembly_;
    std::optional<mem::ModuleInfo> unityPlayer_;
    DumpOptions options_;
};

// Decodes a constant from the metadata's default-value blob at `at`: `kind` is the Il2CppTypeEnum of
// the value (an enum's underlying type), `version` the metadata version (29+ compresses 32-bit
// integers and string lengths). nullopt for unsupported kinds, null strings or data out of range.
[[nodiscard]] std::optional<LiteralValue> decodeConstant(std::span<const std::uint8_t> blob, std::size_t at,
                                                         std::uint8_t kind, std::int32_t version);

// Serialises the dump (after applying the output filters).
[[nodiscard]] std::string toJson(const Dump& dump, const DumpOptions& options);

}  // namespace radar::tools
