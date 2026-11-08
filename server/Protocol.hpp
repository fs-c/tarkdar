#pragma once

#include "game/eft/Status.hpp"
#include "game/eft/model/Players.hpp"
#include "game/eft/model/World.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

// Server → client messages (JSON text frames). Format documented in docs/protocol.md.
namespace radar::server {

inline constexpr int kProtocolVersion = 1;

[[nodiscard]] std::string encodeHello();
[[nodiscard]] std::string encodeStatus(const eft::Status& status);
[[nodiscard]] std::string encodePlayers(const eft::PlayersSnapshot& players);
[[nodiscard]] std::string encodeExfils(const eft::ExfilsSnapshot& exfils);
[[nodiscard]] std::string encodeExplosives(const eft::ExplosivesSnapshot& explosives);
[[nodiscard]] std::string encodeLoot(const eft::LootSnapshot& loot);
[[nodiscard]] std::string encodeEquipment(const eft::EquipmentSnapshot& equipment);

// The "type" field of an encoded message; nullopt if it isn't a valid message.
[[nodiscard]] std::optional<std::string> messageType(std::string_view message);
// The "t" field (ms since the Unix epoch); nullopt if missing.
[[nodiscard]] std::optional<std::int64_t> messageTime(std::string_view message);

}  // namespace radar::server
