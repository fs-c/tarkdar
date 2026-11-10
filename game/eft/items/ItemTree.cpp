#include "game/eft/items/ItemTree.hpp"

#include "game/eft/Names.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

namespace radar::eft {

std::optional<ItemNode> ItemTreeReader::read(Address item, std::string slot) { return readNode(item, std::move(slot), 0); }

std::vector<ItemNode> ItemTreeReader::readSlots(Address slotArray) {
    std::vector<ItemNode> out;
    readSlotArray(slotArray, 0, out);
    return out;
}

std::vector<ItemNode> ItemTreeReader::readContents(Address item) {
    std::vector<ItemNode> out;
    readChildren(item, 0, out);
    return out;
}

std::optional<ItemNode> ItemTreeReader::readNode(Address item, std::string slot, int depth) {
    if (!mem::MemoryView::isUserPointer(item)) return std::nullopt;
    if (nodes_ >= limits_.maxNodes) {
        truncated_ = true;
        return std::nullopt;
    }
    const Address tmpl = readPointer(game_, item + off::Item::Template);
    auto tpl = tmpl ? readMongoId(game_, tmpl + off::ItemTemplate::_id) : std::nullopt;
    if (!tpl) return std::nullopt;
    ++nodes_;
    ItemNode node;
    node.tpl = std::move(*tpl);
    node.slot = std::move(slot);
    const auto count = game_.mem.read<std::int32_t>(item + off::Item::StackObjectsCount);
    node.count = count > 0 ? count : 1;
    if (depth + 1 < limits_.maxDepth) readChildren(item, depth + 1, node.children);
    return node;
}

void ItemTreeReader::readChildren(Address item, int depth, std::vector<ItemNode>& out) {
    // Only compound items have slots and grids; reading those fields on anything else would read
    // unrelated memory.
    if (!game_.managed.isInstanceOf(item, kCompoundItemClass)) return;
    readSlotArray(readPointer(game_, item + off::LootItemMod::Slots), depth, out);

    if (!off::CompoundItem::Grids || !off::Grid::ItemCollection || !off::GridItemCollection::ItemsList) return;
    const auto grids = game_.managed.readArray<Address>(readPointer(game_, item + *off::CompoundItem::Grids), 32);
    if (!grids) return;
    for (Address grid : *grids) {
        const Address collection = readPointer(game_, grid + *off::Grid::ItemCollection);
        const auto items = collection ? game_.managed.readList<Address>(
                                            readPointer(game_, collection + *off::GridItemCollection::ItemsList),
                                            limits_.maxGridItems)
                                      : std::nullopt;
        if (!items) continue;
        for (Address child : *items)
            if (auto n = readNode(child, {}, depth)) out.push_back(std::move(*n));
    }
}

void ItemTreeReader::readSlotArray(Address slotArray, int depth, std::vector<ItemNode>& out) {
    const auto slots = game_.managed.readArray<Address>(slotArray, limits_.maxSlots);
    if (!slots) return;
    for (Address slot : *slots) {
        const Address contained = readPointer(game_, slot + off::Slot::ContainedItem);
        if (!contained) continue;
        auto id = game_.managed.readStringField(slot + off::Slot::ID, 64).value_or("");
        if (auto n = readNode(contained, std::move(id), depth)) out.push_back(std::move(*n));
    }
}

}  // namespace radar::eft
