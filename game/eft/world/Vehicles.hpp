#pragma once

#include "game/eft/model/WorldState.hpp"
#include "game/eft/players/Players.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <memory>
#include <optional>

namespace radar::eft {

// Vehicles (so far only the BTR). Publishes WorldState::vehicles.
//
// BTR: GameWorld.BtrController → BtrView (BTRView, a MonoBehaviour). Null on maps without a BTR and
// until it spawns. Position and heading come from the view's transform (its +z axis is the hull's
// forward). Occupants:
//  - the gunner: BTRView.turret → BTRTurretView._bot, a (ObservedPlayerView, bool) tuple whose first
//    field is the gunner's player object;
//  - passengers: players whose own BTR state (Player._btrState / ObservedPlayerView.BtrState, an
//    EPlayerBtrState) is GoIn, Inside or GoOut. (BTRView._btrSides lists them too, but that array
//    was unreadable in one of the test raids; the players' own state always read.)
// Players are matched by object address against Players::refs().
class Vehicles final : public RaidSubsystem {
public:
    static constexpr auto kInterval = std::chrono::milliseconds(100);
    // Republished when the vehicle moves or turns at least this much, or anything else changes.
    static constexpr float kMinMove = 0.1f;
    static constexpr float kMinTurn = 1.0f;
    // EPlayerBtrState values that count as aboard (Outside 0, Approach 1, GoIn 2, Inside 3, GoOut 4).
    static constexpr std::int32_t kGoIn = 2;
    static constexpr std::int32_t kGoOut = 4;

    Vehicles(std::shared_ptr<const RaidSession> session, WorldState& world, const Players& players);
    ~Vehicles() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void update();

private:
    [[nodiscard]] std::optional<Vehicle> readBtr();

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    const Players& players_;
    Address btrTransform_ = 0;  // native transform of the current BTRView
    Address btrView_ = 0;
    std::optional<Vehicle> last_;
    std::uint64_t revision_ = 0;
};

}  // namespace radar::eft
