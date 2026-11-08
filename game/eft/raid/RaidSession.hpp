#pragma once

#include "core/sched/TaskRunner.hpp"
#include "game/eft/Game.hpp"
#include "game/eft/raid/RaidFinder.hpp"

#include <cstdint>
#include <memory>

namespace radar::eft {

// Immutable identity of one raid. Created when the raid is found, shared with every per-raid
// subsystem, and dropped when the raid ends, so nothing from a previous raid can leak into the next.
struct RaidSession {
    std::uint64_t id = 0;  // increments per raid, for the lifetime of the process
    Game game;
    RaidCandidate start;   // world, local player and location at raid start
    sched::Clock::time_point startedAt{};
};

// A per-raid component (players, loot, exfils, ...). Created at raid start with the session and
// destroyed after its tasks have stopped, so it needs no "clear cache" logic.
class RaidSubsystem {
public:
    virtual ~RaidSubsystem() = default;
    // Registers periodic tasks. `live` is for high-rate work (positions), `background` for the rest.
    virtual void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) = 0;
};

}  // namespace radar::eft
