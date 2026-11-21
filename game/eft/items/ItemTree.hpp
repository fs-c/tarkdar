#pragma once

#include "game/eft/Game.hpp"
#include "game/eft/model/Items.hpp"

#include <span>
#include <vector>

// Reading item trees: an item's template id, stack count and found-in-raid flag, then recursively its slots (for
// compound items: weapons, mods, armour, equipment) and grids (containers, backpacks, rigs).
namespace radar::eft {

struct ItemTreeLimits {
    int maxDepth = 8;
    std::size_t maxNodes = 512;   // per reader (all its calls together); extra items are dropped
    std::size_t maxSlots = 64;    // per item
    std::size_t maxGridItems = 256;
};

// Where a tree starts: a Slot[] array (e.g. an equipment root's slots; one node per occupied slot), or a compound
// item whose contents (slot items, then grid items) are wanted (e.g. a container).
struct ItemRoot {
    enum class Kind { Slots, Contents };
    Kind kind = Kind::Contents;
    Address address = 0;
};

// Trees are read breadth first, all roots of a call together: each depth level costs a fixed number of batched
// reads, whatever the number of items. So when maxNodes cuts, it cuts the deepest items.
class ItemTreeReader {
public:
    explicit ItemTreeReader(const Game& game, ItemTreeLimits limits = {}) : game_(game), limits_(limits) {}

    // One result per root, in order.
    [[nodiscard]] std::vector<std::vector<ItemNode>> read(std::span<const ItemRoot> roots);

    [[nodiscard]] std::vector<ItemNode> readSlots(Address slotArray);
    [[nodiscard]] std::vector<ItemNode> readContents(Address item);

    // True if any call hit maxNodes since construction.
    [[nodiscard]] bool truncated() const noexcept { return truncated_; }

private:
    const Game& game_;
    ItemTreeLimits limits_;
    std::size_t nodes_ = 0;
    bool truncated_ = false;
};

}  // namespace radar::eft
