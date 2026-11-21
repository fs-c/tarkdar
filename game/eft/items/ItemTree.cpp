#include "game/eft/items/ItemTree.hpp"

#include "core/log/Log.hpp"
#include "core/mem/ReadBatch.hpp"
#include "game/eft/Names.hpp"

#include <eft_offsets.hpp>

namespace radar::eft {

using mem::MemoryView;

namespace {

// The pointer at each address, 0 where unreadable or not a user pointer (as readPointer).
std::vector<Address> pointersAt(const Game& game, std::span<const Address> at) {
    std::vector<Address> fields(at.size());
    for (std::size_t i = 0; i < at.size(); ++i) fields[i] = MemoryView::isUserPointer(at[i]) ? at[i] : 0;
    const auto read = mem::readEach<Address>(game.mem, fields);
    std::vector<Address> out(at.size(), 0);
    for (std::size_t i = 0; i < at.size(); ++i)
        if (read[i] && MemoryView::isUserPointer(*read[i])) out[i] = *read[i];
    return out;
}

// Something whose children are read in the current level: a slot array, or a (maybe) compound item.
struct Expansion {
    ItemRoot root;
    std::vector<ItemNode>* out;
    int depth;  // of the nodes it produces
};

// A child found by an expansion, to be read as a node.
struct Candidate {
    std::size_t expansion;
    Address item;
    std::string slot;
};

}  // namespace

std::vector<ItemNode> ItemTreeReader::readSlots(Address slotArray) {
    const ItemRoot root{ItemRoot::Kind::Slots, slotArray};
    return std::move(read({&root, 1})[0]);
}

std::vector<ItemNode> ItemTreeReader::readContents(Address item) {
    const ItemRoot root{ItemRoot::Kind::Contents, item};
    return std::move(read({&root, 1})[0]);
}

std::vector<std::vector<ItemNode>> ItemTreeReader::read(std::span<const ItemRoot> roots) {
    std::vector<std::vector<ItemNode>> results(roots.size());
    std::vector<Expansion> level;
    for (std::size_t i = 0; i < roots.size(); ++i) level.push_back({roots[i], &results[i], 0});

    const bool gridsKnown = off::CompoundItem::Grids && off::Grid::ItemCollection && off::GridItemCollection::ItemsList;
    while (!level.empty()) {
        const std::size_t n = level.size();

        // Items: class, Slots and Grids. Only compound items have slots and grids; those fields of anything else
        // are unrelated memory, read but not followed.
        std::vector<Address> klassAt(n, 0), slotsAt(n, 0), gridsAt(n, 0);
        for (std::size_t i = 0; i < n; ++i) {
            const Address a = level[i].root.address;
            if (level[i].root.kind != ItemRoot::Kind::Contents || !MemoryView::isUserPointer(a)) continue;
            klassAt[i] = a + game_.managed.layout().objectKlass;
            slotsAt[i] = a + off::LootItemMod::Slots;
            if (gridsKnown) gridsAt[i] = a + *off::CompoundItem::Grids;
        }
        const auto klasses = pointersAt(game_, klassAt);
        const auto slotPtrs = pointersAt(game_, slotsAt);
        const auto gridPtrs = pointersAt(game_, gridsAt);
        std::vector<Address> slotArrays(n, 0), gridArrays(n, 0);
        for (std::size_t i = 0; i < n; ++i) {
            if (level[i].root.kind == ItemRoot::Kind::Slots) {
                slotArrays[i] = level[i].root.address;
                continue;
            }
            if (!klassAt[i]) continue;
            if (!klasses[i]) {
                log::debug("items: {:#x}: class unreadable; no slots/grids read", level[i].root.address);
                continue;
            }
            if (!game_.managed.classIsA(klasses[i], kCompoundItemClass)) continue;  // plain item: nothing inside
            slotArrays[i] = slotPtrs[i];
            gridArrays[i] = gridPtrs[i];
            if (gridsKnown && !gridArrays[i])
                log::debug("items: {:#x}: Grids array unreadable (null or bad pointer)", level[i].root.address);
        }

        // Slots: the contained item and the slot id of each.
        const auto slotLists = game_.managed.readArrays<Address>(slotArrays, limits_.maxSlots);
        std::vector<std::pair<std::size_t, Address>> slots;  // (expansion, slot)
        for (std::size_t i = 0; i < n; ++i)
            if (slotLists[i])
                for (Address slot : *slotLists[i]) slots.emplace_back(i, slot);
        std::vector<Address> containedAt(slots.size()), idAt(slots.size());
        for (std::size_t k = 0; k < slots.size(); ++k) containedAt[k] = slots[k].second + off::Slot::ContainedItem;
        const auto contained = pointersAt(game_, containedAt);
        for (std::size_t k = 0; k < slots.size(); ++k) idAt[k] = contained[k] ? slots[k].second + off::Slot::ID : 0;
        const auto slotIds = game_.managed.readStringFields(idAt, 64);

        // Grids: each one's item list.
        std::vector<std::pair<std::size_t, Address>> grids;  // (expansion, grid)
        if (gridsKnown) {
            const auto gridLists = game_.managed.readArrays<Address>(gridArrays, 32);
            for (std::size_t i = 0; i < n; ++i) {
                if (!gridArrays[i]) continue;
                if (!gridLists[i]) {
                    log::debug("items: {:#x}: Grids array at {:#x} unreadable (bad pointer or over cap)",
                               level[i].root.address, gridArrays[i]);
                    continue;
                }
                for (Address grid : *gridLists[i]) grids.emplace_back(i, grid);
            }
        }
        std::vector<Address> at(grids.size());
        for (std::size_t k = 0; k < grids.size(); ++k) at[k] = grids[k].second + (gridsKnown ? *off::Grid::ItemCollection : 0);
        const auto collections = pointersAt(game_, at);
        for (std::size_t k = 0; k < grids.size(); ++k)
            at[k] = collections[k] ? collections[k] + *off::GridItemCollection::ItemsList : 0;
        const auto gridItems = game_.managed.readLists<Address>(pointersAt(game_, at), limits_.maxGridItems);

        // Children in order: per expansion, slot items, then grid items grid by grid.
        std::vector<std::vector<Candidate>> byExpansion(n);
        for (std::size_t k = 0; k < slots.size(); ++k)
            if (contained[k])
                byExpansion[slots[k].first].push_back({slots[k].first, contained[k], slotIds[k].value_or("")});
        for (std::size_t k = 0; k < grids.size(); ++k) {
            if (!gridItems[k]) {
                log::debug("items: {:#x}: grid {:#x} collection {:#x} ItemsList unreadable",
                           level[grids[k].first].root.address, grids[k].second, collections[k]);
                continue;
            }
            for (Address item : *gridItems[k])
                if (MemoryView::isUserPointer(item)) byExpansion[grids[k].first].push_back({grids[k].first, item, {}});
        }
        std::vector<Candidate> candidates;
        for (auto& list : byExpansion)
            for (auto& c : list) candidates.push_back(std::move(c));

        // Nodes: template id, stack count, found in raid.
        const std::size_t m = candidates.size();
        std::vector<Address> templateAt(m);
        for (std::size_t k = 0; k < m; ++k) templateAt[k] = candidates[k].item + off::Item::Template;
        const auto templates = pointersAt(game_, templateAt);
        std::vector<std::int32_t> counts(m, 0);
        std::vector<std::uint8_t> fir(m, 0);
        {
            mem::ReadBatch batch(game_.mem);
            for (std::size_t k = 0; k < m; ++k) {
                batch.add(candidates[k].item + off::Item::StackObjectsCount, counts[k]);
                batch.add(candidates[k].item + off::Item::SpawnedInSession, fir[k]);
            }
            batch.execute();  // failed reads stay 0: count 1, not found in raid
        }
        std::vector<Address> idFieldAt(m);
        for (std::size_t k = 0; k < m; ++k)
            idFieldAt[k] = templates[k] ? templates[k] + off::ItemTemplate::_id + off::MongoID::StringId : 0;
        auto ids = game_.managed.readStringFields(idFieldAt, 64);

        // Pushed first, pointed to after: a children vector stops growing once its level is done.
        struct Placed {
            std::vector<ItemNode>* out;
            std::size_t index;
            Address item;
            int depth;
        };
        std::vector<Placed> placed;
        for (std::size_t k = 0; k < m; ++k) {
            const Expansion& e = level[candidates[k].expansion];
            if (!ids[k] || ids[k]->empty()) {
                log::debug("items: {:#x}: template id unreadable (Template={:#x}, depth {})", candidates[k].item,
                           templates[k], e.depth);
                continue;
            }
            if (nodes_ >= limits_.maxNodes) {
                truncated_ = true;
                break;
            }
            ++nodes_;
            ItemNode node;
            node.tpl = std::move(*ids[k]);
            node.slot = std::move(candidates[k].slot);
            node.count = counts[k] > 0 ? counts[k] : 1;
            node.fir = fir[k] != 0;
            e.out->push_back(std::move(node));
            if (e.depth + 1 < limits_.maxDepth) placed.push_back({e.out, e.out->size() - 1, candidates[k].item, e.depth + 1});
        }

        std::vector<Expansion> next;
        next.reserve(placed.size());
        for (const Placed& p : placed)
            next.push_back({{ItemRoot::Kind::Contents, p.item}, &(*p.out)[p.index].children, p.depth});
        level = std::move(next);
    }
    return results;
}

}  // namespace radar::eft
