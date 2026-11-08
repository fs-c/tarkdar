#pragma once

#include "game/eft/Game.hpp"

#include <optional>
#include <string>

// Small read helpers shared by the game subsystems.
namespace radar::eft {

// Pointer stored at `at`, or 0 if unreadable or not a user pointer.
[[nodiscard]] inline Address readPointer(const Game& game, Address at, mem::Freshness freshness = mem::Freshness::Cached) {
    Address p = 0;
    if (!mem::MemoryView::isUserPointer(at) || !game.mem.tryRead(at, p, freshness) || !mem::MemoryView::isUserPointer(p))
        return 0;
    return p;
}

// Native Transform of the GameObject a managed component (MonoBehaviour) belongs to:
// managed → native component → GameObject → component 0 (always the Transform).
[[nodiscard]] inline std::optional<Address> transformOfComponent(const Game& game, Address managedComponent) {
    const auto native = game.managed.nativePointer(managedComponent);
    const auto gameObject = native ? game.scene.gameObjectOf(*native) : std::nullopt;
    return gameObject ? game.scene.transform(*gameObject) : std::nullopt;
}

// EFT's MongoID struct (inline in templates and profiles) → its string form.
[[nodiscard]] std::optional<std::string> readMongoId(const Game& game, Address mongoId);

}  // namespace radar::eft
