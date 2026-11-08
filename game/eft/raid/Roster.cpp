#include "game/eft/raid/Roster.hpp"

#include "core/mem/ReadBatch.hpp"
#include "game/eft/Layouts.hpp"

#include <eft_offsets.hpp>

#include <unordered_set>

namespace radar::eft {

using mem::Freshness;
using mem::MemoryView;

std::optional<RosterHeader> readRosterHeader(const Game& game, Address localGameWorld) {
    if (!MemoryView::isUserPointer(localGameWorld)) return std::nullopt;
    RosterHeader h;
    if (!game.mem.tryRead(localGameWorld + off::ClientLocalGameWorld::RegisteredPlayers, h.list, Freshness::Fresh) ||
        !MemoryView::isUserPointer(h.list))
        return std::nullopt;
    mem::ReadBatch batch(game.mem);
    const auto hi = batch.add(h.list + kIl2CppLayout.listItems, h.items);
    const auto hc = batch.add(h.list + kIl2CppLayout.listSize, h.count);
    batch.execute(Freshness::Fresh);
    if (!batch.complete(hi) || !batch.complete(hc) || !MemoryView::isUserPointer(h.items) || h.count < 0 ||
        h.count > kMaxRegisteredPlayers)
        return std::nullopt;
    return h;
}

std::optional<Roster> readRoster(const Game& game, Address localGameWorld) {
    Roster roster;
    if (!MemoryView::isUserPointer(localGameWorld)) return std::nullopt;
    game.mem.tryRead(localGameWorld + off::ClientLocalGameWorld::MainPlayer, roster.localPlayer, Freshness::Fresh);
    if (!MemoryView::isUserPointer(roster.localPlayer)) roster.localPlayer = 0;

    const auto header = readRosterHeader(game, localGameWorld);
    if (!header) return std::nullopt;
    if (header->count == 0) return roster;

    std::vector<Address> raw(static_cast<std::size_t>(header->count));
    if (!game.mem.readBytes(header->items + kIl2CppLayout.arrayData, std::as_writable_bytes(std::span{raw}),
                            Freshness::Fresh))
        return std::nullopt;

    const auto again = readRosterHeader(game, localGameWorld);
    if (!again || again->list != header->list || again->items != header->items || again->count != header->count)
        return std::nullopt;

    std::unordered_set<Address> seen;
    for (Address p : raw)
        if (MemoryView::isUserPointer(p) && seen.insert(p).second) roster.players.push_back(p);
    return roster;
}

}  // namespace radar::eft
