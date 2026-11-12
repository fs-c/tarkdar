#pragma once

#include "game/eft/Status.hpp"
#include "game/eft/model/Players.hpp"
#include "game/eft/model/World.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// Server → client messages (JSON text frames). Format documented in docs/protocol.md.
namespace radar::server {

inline constexpr int kProtocolVersion = 1;
// Version of the raid recording format (docs/protocol.md, "Raid recordings").
inline constexpr int kRecordingFormat = 1;

// `live`: false when the backend serves recordings only (--offline).
[[nodiscard]] std::string encodeHello(bool live = true);
[[nodiscard]] std::string encodeStatus(const eft::Status& status);
[[nodiscard]] std::string encodePlayers(const eft::PlayersSnapshot& players);
// The joints of every alive, present player that has them; nullopt if no player has any. Shares the
// players snapshot's revision.
[[nodiscard]] std::optional<std::string> encodeSkeletons(const eft::PlayersSnapshot& players);
[[nodiscard]] std::string encodeExfils(const eft::ExfilsSnapshot& exfils);
[[nodiscard]] std::string encodeExplosives(const eft::ExplosivesSnapshot& explosives);
[[nodiscard]] std::string encodeLoot(const eft::LootSnapshot& loot);
// Recordings only: the first line of a raid recording.
[[nodiscard]] std::string encodeRecordingHeader(const eft::Status& status);
// Recordings only: the loot changes since the previous loot (or lootDiff) line. `revision` is the
// loot snapshot's revision.
[[nodiscard]] std::string encodeLootDiff(std::uint64_t raidId, std::uint64_t revision,
                                         const std::vector<const eft::LootEntry*>& added,
                                         const std::vector<std::uint32_t>& removed,
                                         const std::vector<const eft::LootEntry*>& changed);
[[nodiscard]] std::string encodeEquipment(const eft::EquipmentSnapshot& equipment);

// The "type" field of an encoded message; nullopt if it isn't a valid message.
[[nodiscard]] std::optional<std::string> messageType(std::string_view message);
// The "t" field (ms since the Unix epoch); nullopt if missing.
[[nodiscard]] std::optional<std::int64_t> messageTime(std::string_view message);

}  // namespace radar::server
