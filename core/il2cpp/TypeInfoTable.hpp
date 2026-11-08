#pragma once

#include "core/il2cpp/Layout.hpp"
#include "core/mem/MemoryView.hpp"

#include <cstdint>
#include <optional>

namespace radar::il2cpp {

// The IL2CPP runtime's type-info table: an array of Il2CppClass* indexed by type definition index,
// pointed to by a global in GameAssembly. Entries are filled lazily (a class's slot stays null until
// the class is first used), so lookups can fail early in the game's lifetime.
//
// Used to reach static fields: klass = table[typeIndex]; statics = klass->static_fields.
class TypeInfoTable {
public:
    // Reads the table pointer from GameAssembly + tableRva.
    [[nodiscard]] static std::optional<TypeInfoTable> locate(const mem::MemoryView& mem, const Layout& layout,
                                                             mem::Address gameAssemblyBase,
                                                             std::uint64_t tableRva);

    [[nodiscard]] mem::Address address() const noexcept { return table_; }

    [[nodiscard]] std::optional<mem::Address> klass(std::int32_t typeIndex) const;
    // Static field block of the class; null until the class's static constructor has run.
    [[nodiscard]] std::optional<mem::Address> staticFields(std::int32_t typeIndex) const;

private:
    TypeInfoTable(const mem::MemoryView& mem, const Layout& layout, mem::Address table)
        : mem_(mem), layout_(layout), table_(table) {}

    mem::MemoryView mem_;
    Layout layout_;
    mem::Address table_;
};

}  // namespace radar::il2cpp
