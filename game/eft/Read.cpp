#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

namespace radar::eft {

std::optional<Address> findManagedComponent(const Game& game, Address gameObject, std::string_view className) {
    for (Address component : game.scene.components(gameObject)) {
        const auto object = game.scene.managedObject(component);
        if (object && game.managed.isInstanceOf(*object, className)) return object;
    }
    return std::nullopt;
}

std::optional<std::string> readMongoId(const Game& game, Address mongoId) {
    auto id = game.managed.readStringField(mongoId + off::MongoID::StringId, 64);
    if (!id || id->empty()) return std::nullopt;
    return id;
}

}  // namespace radar::eft
