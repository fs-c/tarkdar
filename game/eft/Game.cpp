#include "game/eft/Game.hpp"

#include "game/eft/Layouts.hpp"
#include "game/eft/Names.hpp"

#include <eft_offsets.hpp>

namespace radar::eft {

Game Game::fromTarget(const mem::Target& target) {
    const auto view = target.view();
    Game game{
        .mem = view,
        .managed = il2cpp::Managed(view, kIl2CppLayout),
        .scene = unity::Scene(view, kUnityLayout),
        .transforms = unity::Transforms(view, kUnityLayout),
        .gameAssembly = target.module(std::string(kGameAssembly)).value_or(mem::ModuleInfo{}).base,
        .unityPlayer = target.module(std::string(kUnityPlayer)).value_or(mem::ModuleInfo{}).base,
        .generation = target.generation(),
    };
    return game;
}

std::optional<Address> Game::gameObjectManager() const {
    if (!mem::MemoryView::isUserPointer(unityPlayer)) return std::nullopt;
    Address gom = 0;
    if (!mem.tryRead(unityPlayer + off::unity_rva::gameObjectManager, gom, mem::Freshness::Fresh) ||
        !mem::MemoryView::isUserPointer(gom))
        return std::nullopt;
    return gom;
}

std::optional<il2cpp::TypeInfoTable> Game::typeInfoTable() const {
    return il2cpp::TypeInfoTable::locate(mem, kIl2CppLayout, gameAssembly, off::bootstrap::typeInfoTableRva);
}

}  // namespace radar::eft
