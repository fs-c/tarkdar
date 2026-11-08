#include "game/eft/raid/RaidMonitor.hpp"

#include "game/eft/raid/RaidFinder.hpp"
#include "game/eft/raid/Roster.hpp"

namespace radar::eft {

std::optional<std::string> RaidMonitor::check(const Game& game, std::chrono::steady_clock::time_point now) {
    // Only trust the static once it has pointed at this raid's world: a raid found by the scene scan
    // may coexist with a stale _myPlayer from an earlier raid.
    const auto local = localPlayerWorld(game);
    if (local && local->world == localGameWorld_) ownerConfirmed_ = true;
    if (ownerConfirmed_ && local && local->world != localGameWorld_) {
        if (++movedChecks_ >= kMovedChecks) return "the local player is in a different GameWorld";
    } else {
        movedChecks_ = 0;
    }

    const auto header = readRosterHeader(game, localGameWorld_);
    if (!seenActive_ && (!header || header->count == 0) && now - startedAt_ >= kNeverActiveTimeout)
        return "roster never filled";
    if (!header) {
        emptyChecks_ = 0;
        if (!seenActive_) return std::nullopt;
        if (++invalidChecks_ >= kInvalidChecks) return "roster unreadable";
        return std::nullopt;
    }
    invalidChecks_ = 0;
    if (header->count > 0) {
        seenActive_ = true;
        emptyChecks_ = 0;
        return std::nullopt;
    }
    if (!seenActive_) return std::nullopt;
    if (++emptyChecks_ >= kEmptyChecks) return "roster empty";
    return std::nullopt;
}

}  // namespace radar::eft
