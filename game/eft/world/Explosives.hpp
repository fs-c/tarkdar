#pragma once

#include "game/eft/model/WorldState.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <memory>
#include <unordered_map>
#include <unordered_set>

namespace radar::eft {

// Thrown grenades and tripwires. Publishes WorldState::explosives.
//
// Grenades: the GameWorld's grenade collection holds a List<Throwable>. A grenade lives from when it
// appears in the list until it's destroyed (Throwable._isDestroyed) or leaves the list. Positions
// come from its transform; the last good one is kept on a bad read. Smokes, flashes and frags aren't
// told apart.
//
// Tripwires: synchronizable objects (both the active and static lists of the GameWorld's
// SynchronizableObjectLogicProcessor) whose Type is kTripwireType. Shown while their state is Wait
// or Active; the endpoints are raised by kTripwireYOffset (the game stores them slightly below the
// visible wire).
class Explosives final : public RaidSubsystem {
public:
    static constexpr auto kGrenadeInterval = std::chrono::milliseconds(100);
    static constexpr auto kTripwireInterval = std::chrono::milliseconds(20);
    static constexpr std::size_t kMaxObjects = 512;
    // SynchronizableObjectType value of tripwires, and ETripwireState values that mean "armed".
    static constexpr std::int32_t kTripwireType = 2;
    static constexpr std::int32_t kTripwireWait = 1;
    static constexpr std::int32_t kTripwireActive = 2;
    static constexpr float kTripwireYOffset = 0.175f;

    Explosives(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Explosives() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void updateGrenades();
    void updateTripwires();

private:
    struct GrenadeEntry {
        std::uint32_t id = 0;
        Address transform = 0;
        std::optional<math::Vec3> position;
    };
    void publish();

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    std::unordered_map<Address, GrenadeEntry> grenades_;
    std::unordered_set<Address> destroyed_;  // destroyed but still in the game's list: don't re-add
    std::unordered_map<Address, Tripwire> tripwires_;
    std::uint32_t nextId_ = 1;
    std::uint64_t revision_ = 0;
};

}  // namespace radar::eft
