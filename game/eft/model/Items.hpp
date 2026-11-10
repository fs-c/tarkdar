#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace radar::eft {

// An item and everything inside it: attachments and slot contents (e.g. a weapon's mods, armour
// plates), and grid contents (backpack, rig, container) where the grid offsets are known.
struct ItemNode {
    std::string tpl;         // template id
    std::string slot{};      // slot id when the item sits in a slot (e.g. "FirstPrimaryWeapon"); empty in grids
    std::int32_t count = 1;  // stack size
    std::vector<ItemNode> children{};

    friend bool operator==(const ItemNode&, const ItemNode&) = default;
};

}  // namespace radar::eft
