#pragma once

#include "core/math/Math.hpp"
#include "game/eft/model/Items.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

// Snapshots of non-player raid state: exfils, explosives, loot.
namespace radar::eft {

struct Exfil {
    enum class Kind { Regular, Secret };
    std::uint32_t id = 0;
    Kind kind = Kind::Regular;
    std::string name;        // the game's internal exit name (display names are a frontend concern)
    std::int32_t status = 0; // EExfiltrationStatus: 1 NotPresent, 2 UncompleteRequirements, 3 Countdown,
                             // 4 RegularMode (open), 5 Pending, 6 AwaitsManualActivation
    std::optional<math::Vec3> position;
};

struct ExfilsSnapshot {
    std::uint64_t raidId = 0;
    std::uint64_t revision = 0;
    std::vector<Exfil> exfils{};
};

struct Grenade {
    std::uint32_t id = 0;
    math::Vec3 position;
};

struct Tripwire {
    std::uint32_t id = 0;
    math::Vec3 from, to;
};

struct ExplosivesSnapshot {
    std::uint64_t raidId = 0;
    std::uint64_t revision = 0;
    std::vector<Grenade> grenades;
    std::vector<Tripwire> tripwires;
};

struct LootEntry {
    enum class Kind { Item, QuestItem, Container, Airdrop, Corpse };
    std::uint32_t id = 0;
    Kind kind = Kind::Item;
    std::string templateId;  // item/container template id; empty for airdrops and corpses
    std::string objectName{};  // GameObject name (for debugging; not meant for display)
    math::Vec3 position;
    // Containers: their contents. Corpses: their equipment (one node per occupied slot).
    std::vector<ItemNode> contents{};
};

struct LootSnapshot {
    std::uint64_t raidId = 0;
    std::uint64_t revision = 0;
    std::vector<LootEntry> loot;
};

struct PlayerEquipment {
    std::uint32_t playerId = 0;  // PlayerState::id
    std::vector<ItemNode> slots; // one node per occupied equipment slot, with contents
};

struct EquipmentSnapshot {
    std::uint64_t raidId = 0;
    std::uint64_t revision = 0;
    std::vector<PlayerEquipment> players;  // ordered by player id
};

}  // namespace radar::eft
