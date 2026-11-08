#pragma once

#include "core/il2cpp/Managed.hpp"
#include "core/il2cpp/TypeInfoTable.hpp"
#include "core/mem/Target.hpp"
#include "core/unity/Scene.hpp"
#include "core/unity/Transforms.hpp"

#include <optional>

namespace radar::eft {

using mem::Address;

// Everything needed to read the game for one attach: memory access, the core readers configured
// with the game's layouts, and module bases. Rebuilt whenever Target::generation() changes.
// Cheap to copy; safe to use from several threads (the readers hold no mutable state).
struct Game {
    mem::MemoryView mem;
    il2cpp::Managed managed;
    unity::Scene scene;
    unity::Transforms transforms;
    Address gameAssembly = 0;
    Address unityPlayer = 0;
    std::uint64_t generation = 0;

    // Requires target.state() == Attached.
    [[nodiscard]] static Game fromTarget(const mem::Target& target);

    // GameObjectManager pointer, read from its UnityPlayer global.
    [[nodiscard]] std::optional<Address> gameObjectManager() const;
    // IL2CPP type-info table (used for static fields). nullopt until the runtime has set it up.
    [[nodiscard]] std::optional<il2cpp::TypeInfoTable> typeInfoTable() const;
};

}  // namespace radar::eft
