#pragma once

#include "core/sched/Published.hpp"
#include "game/eft/model/Players.hpp"
#include "game/eft/model/World.hpp"

namespace radar::eft {

// Everything the backend knows about the current raid, as immutable snapshots. Lives for the whole
// process; per-raid subsystems publish into it and reset their part when the raid ends. Readers
// (the server) take snapshots without locking.
struct WorldState {
    sched::Published<PlayersSnapshot> players;
    sched::Published<ExfilsSnapshot> exfils;
    sched::Published<ExplosivesSnapshot> explosives;
    sched::Published<LootSnapshot> loot;
    sched::Published<EquipmentSnapshot> equipment;
};

}  // namespace radar::eft
