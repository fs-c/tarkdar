#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace radar::eft {

// How many of an item the player owns: stack units (a stack of 30 rounds counts 30), all of them and
// those found in raid.
struct OwnedItem {
    std::string tpl;
    std::int64_t count = 0;
    std::int64_t fir = 0;
    friend bool operator==(const OwnedItem&, const OwnedItem&) = default;
};

// The PMC's items, from the menu-side profile (Stash): what's in the stash, and what the character
// had on at the last menu state (in a raid: what they took in; their current gear is the equipment
// snapshot).
struct StashSnapshot {
    std::uint64_t raidId = 0;
    std::uint64_t revision = 0;
    // False until read once.
    bool known = false;
    std::string profileId{};
    // Stash, sorting table, quest stash items and hideout area stashes; ordered by tpl.
    std::vector<OwnedItem> stash{};
    // The profile's equipment (not the in-raid player's); ordered by tpl.
    std::vector<OwnedItem> equipment{};
};

}  // namespace radar::eft
