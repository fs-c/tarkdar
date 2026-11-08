#pragma once

#include "game/eft/Game.hpp"

#include <cstdint>
#include <optional>
#include <vector>

// The GameWorld's RegisteredPlayers list (List<Player>).
namespace radar::eft {

// Sanity cap on the registered-player count; anything above means we're reading garbage.
inline constexpr std::int32_t kMaxRegisteredPlayers = 512;

struct RosterHeader {
    Address list = 0;   // List<Player>
    Address items = 0;  // backing Player[]
    std::int32_t count = 0;
};

// Reads the list header. nullopt if the chain is unreadable or the count is implausible.
[[nodiscard]] std::optional<RosterHeader> readRosterHeader(const Game& game, Address localGameWorld);

struct Roster {
    Address localPlayer = 0;       // GameWorld.MainPlayer (0 if not set)
    std::vector<Address> players;  // distinct, valid pointers, in list order
};

// Reads the full roster. The header is re-read after the elements and the read fails if it changed,
// which guards against reading while the list is being resized.
[[nodiscard]] std::optional<Roster> readRoster(const Game& game, Address localGameWorld);

}  // namespace radar::eft
