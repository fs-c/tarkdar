#pragma once

#include "core/sched/TaskRunner.hpp"
#include "game/eft/Game.hpp"

#include <optional>
#include <string>

namespace radar::eft {

// A raid that passed validation: a GameWorld on a raid location, with a local player and a
// non-empty roster.
struct RaidCandidate {
    Address localGameWorld = 0;   // the managed GameWorld (ClientLocalGameWorld) instance
    Address gameWorldObject = 0;  // native GameObject if found by scene scan, else == localGameWorld
    Address localPlayer = 0;
    std::string locationId;
    std::int32_t registeredCount = 0;
};

// Validation of one GameWorld candidate.
struct WorldCheck {
    enum class Status {
        Ready,     // a raid in progress
        Pending,   // a raid world that isn't ready yet (no local player or empty roster)
        Rejected,  // not a raid: unreadable, lobby/hideout, unknown location, implausible roster
    };
    Status status = Status::Rejected;
    RaidCandidate candidate;
    std::string reason;  // for Rejected/Pending
};

[[nodiscard]] WorldCheck checkWorld(const Game& game, Address localGameWorld, Address localPlayer,
                                    Address gameWorldObject);

// The local player per GamePlayerOwner._myPlayer (a static) and that player's GameWorld.
struct LocalPlayerWorld {
    Address player = 0;
    Address world = 0;
};
[[nodiscard]] std::optional<LocalPlayerWorld> localPlayerWorld(const Game& game);

// Searches for a running raid. Call poll() periodically (the lifecycle uses 2.5 s).
//
// Strategies, in order:
//  1. GamePlayerOwner._myPlayer (static, via the IL2CPP type-info table) → Player.GameWorld.
//  2. Scene scan: active GameObjects named "GameWorld" → their EFT.GameWorld component. Expensive,
//     so only after kSceneScanDelay of searching and then at most every kSceneScanInterval.
//
// A Pending world is retried for up to kMaxPendingAttempts polls before being dropped (it can be
// found and become pending again later). The world of the last ended raid is never accepted again
// until a different world has been seen, which keeps a lingering post-raid world from restarting the
// raid. As a safety net against a false raid end, the guard lifts once that world has looked ready
// continuously for kEndedWorldGrace.
class RaidFinder {
public:
    static constexpr int kMaxPendingAttempts = 6;
    static constexpr auto kSceneScanDelay = std::chrono::seconds(6);
    static constexpr auto kSceneScanInterval = std::chrono::seconds(20);
    static constexpr auto kEndedWorldGrace = std::chrono::seconds(30);

    struct Result {
        std::optional<RaidCandidate> raid;  // set when a raid is ready
        bool pending = false;               // a raid world exists but isn't ready yet
    };

    explicit RaidFinder(Game game) : game_(std::move(game)) {}

    // Starts a new search (resets timers and pending state, keeps the ended-world guard).
    void restart(sched::Clock::time_point now);
    Result poll(sched::Clock::time_point now);
    void markEnded(Address localGameWorld) {
        endedWorld_ = localGameWorld;
        endedReadySince_.reset();
    }

    // The individual strategies, without timing or pending logic (also used by diagnostics).
    // nullopt: the strategy found no candidate world at all.
    std::optional<WorldCheck> viaGamePlayerOwner();
    std::optional<WorldCheck> viaSceneScan();

private:
    WorldCheck check(Address localGameWorld, Address localPlayer, Address gameWorldObject);

    Game game_;
    sched::Clock::time_point searchStart_{};
    std::optional<sched::Clock::time_point> lastSceneScan_;
    std::optional<RaidCandidate> pending_;
    int pendingAttempts_ = 0;
    Address endedWorld_ = 0;
    std::optional<sched::Clock::time_point> endedReadySince_;
    sched::Clock::time_point now_{};
};

}  // namespace radar::eft
