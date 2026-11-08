#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

namespace radar::eft {

std::optional<std::string> readMongoId(const Game& game, Address mongoId) {
    auto id = game.managed.readStringField(mongoId + off::MongoID::StringId, 64);
    if (!id || id->empty()) return std::nullopt;
    return id;
}

}  // namespace radar::eft
