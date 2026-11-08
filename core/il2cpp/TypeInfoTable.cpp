#include "core/il2cpp/TypeInfoTable.hpp"

namespace radar::il2cpp {

using mem::Address;
using mem::Freshness;
using mem::MemoryView;

namespace {
// Sanity cap on type indices; real tables hold tens of thousands of types.
constexpr std::int32_t kMaxTypeIndex = 1'000'000;
}  // namespace

std::optional<TypeInfoTable> TypeInfoTable::locate(const MemoryView& mem, const Layout& layout,
                                                   Address gameAssemblyBase, std::uint64_t tableRva) {
    if (!MemoryView::isUserPointer(gameAssemblyBase) || tableRva == 0) return std::nullopt;
    Address table = 0;
    if (!mem.tryRead(gameAssemblyBase + tableRva, table, Freshness::Fresh) || !MemoryView::isUserPointer(table))
        return std::nullopt;
    return TypeInfoTable(mem, layout, table);
}

std::optional<Address> TypeInfoTable::klass(std::int32_t typeIndex) const {
    if (typeIndex < 0 || typeIndex >= kMaxTypeIndex) return std::nullopt;
    Address k = 0;
    // Fresh: slots start out null and get filled when the class is first used.
    if (!mem_.tryRead(table_ + static_cast<Address>(typeIndex) * sizeof(Address), k, Freshness::Fresh) ||
        !MemoryView::isUserPointer(k))
        return std::nullopt;
    return k;
}

std::optional<Address> TypeInfoTable::staticFields(std::int32_t typeIndex) const {
    const auto k = klass(typeIndex);
    if (!k) return std::nullopt;
    Address statics = 0;
    if (!mem_.tryRead(*k + layout_.classStaticFields, statics, Freshness::Fresh) ||
        !MemoryView::isUserPointer(statics))
        return std::nullopt;
    return statics;
}

}  // namespace radar::il2cpp
