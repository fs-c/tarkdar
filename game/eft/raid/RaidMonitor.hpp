#pragma once

#include "game/eft/Game.hpp"

#include <chrono>
#include <optional>
#include <string>

namespace radar::eft {

// Decides when a raid has ended, from the GameWorld's roster. Check every kInterval.
//
// The raid ends when, after the roster has been seen non-empty at least once:
//  - it reads as empty for kEmptyChecks consecutive checks, or
//  - its pointer chain is unreadable or implausible for kInvalidChecks consecutive checks.
// Before the roster was ever non-empty, neither counts (the raid may still be loading); but if it
// never fills within kNeverActiveTimeout, the raid ends anyway.
//
// Independently of the roster, the raid ends when the local player (GamePlayerOwner._myPlayer)
// belongs to a different GameWorld for kMovedChecks consecutive checks: the game doesn't
// necessarily clear a finished world's roster, so this catches a new raid (or the hideout) taking
// over. This check only starts once _myPlayer has been seen pointing at this raid's world.
//
// State lives in the monitor; create one per raid.
class RaidMonitor {
public:
    static constexpr auto kInterval = std::chrono::milliseconds(800);
    static constexpr int kEmptyChecks = 12;    // ~9.6 s
    static constexpr int kInvalidChecks = 10;  // ~8 s
    static constexpr int kMovedChecks = 3;     // ~2.4 s
    static constexpr auto kNeverActiveTimeout = std::chrono::minutes(2);

    RaidMonitor(Address localGameWorld, std::chrono::steady_clock::time_point startedAt)
        : localGameWorld_(localGameWorld), startedAt_(startedAt) {}

    // Returns the reason if the raid has ended.
    std::optional<std::string> check(const Game& game, std::chrono::steady_clock::time_point now);

private:
    Address localGameWorld_;
    std::chrono::steady_clock::time_point startedAt_;
    int movedChecks_ = 0;
    bool ownerConfirmed_ = false;
    bool seenActive_ = false;
    int emptyChecks_ = 0;
    int invalidChecks_ = 0;
};

}  // namespace radar::eft
