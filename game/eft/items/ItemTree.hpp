#pragma once

#include "game/eft/Game.hpp"
#include "game/eft/model/Items.hpp"

#include <optional>
#include <vector>

// Reading item trees: an item's template id and stack count, then recursively its slots (for
// compound items: weapons, mods, armour, equipment) and grids (containers, backpacks, rigs).
namespace radar::eft {

struct ItemTreeLimits {
    int maxDepth = 8;
    std::size_t maxNodes = 512;   // per call; deeper/extra items are dropped
    std::size_t maxSlots = 64;    // per item
    std::size_t maxGridItems = 256;
};

class ItemTreeReader {
public:
    explicit ItemTreeReader(const Game& game, ItemTreeLimits limits = {}) : game_(game), limits_(limits) {}

    // One item and its contents. nullopt if the item or its template id can't be read.
    [[nodiscard]] std::optional<ItemNode> read(Address item, std::string slot = {});

    // The items in a Slot[] array (e.g. an equipment root's slots), one node per occupied slot.
    [[nodiscard]] std::vector<ItemNode> readSlots(Address slotArray);

    // Contents of a compound item: slot items, then grid items (e.g. a container's contents).
    [[nodiscard]] std::vector<ItemNode> readContents(Address item);

    // True if any call hit maxNodes since construction.
    [[nodiscard]] bool truncated() const noexcept { return truncated_; }

private:
    std::optional<ItemNode> readNode(Address item, std::string slot, int depth);
    void readChildren(Address item, int depth, std::vector<ItemNode>& out);
    void readSlotArray(Address slotArray, int depth, std::vector<ItemNode>& out);

    const Game& game_;
    ItemTreeLimits limits_;
    std::size_t nodes_ = 0;
    bool truncated_ = false;
};

}  // namespace radar::eft
