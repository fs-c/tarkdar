#include "game/eft/world/Vehicles.hpp"

#include "core/mem/ReadBatch.hpp"
#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cmath>
#include <numbers>

namespace radar::eft {

using mem::Freshness;
using math::Vec3;

namespace {

// Heading of a rotation's +z axis, in degrees: 0 = +z, 90 = +x.
float yawOf(math::Quat q) {
    const Vec3 forward = math::rotate(q, Vec3{0, 0, 1});
    return std::atan2(forward.x, forward.z) * 180.0f / std::numbers::pi_v<float>;
}

// Smallest absolute difference between two headings, in degrees.
float turnBetween(float a, float b) {
    const float d = std::fmod(std::fabs(a - b), 360.0f);
    return d > 180.0f ? 360.0f - d : d;
}

bool sameVehicle(const Vehicle& a, const Vehicle& b) {
    return a.kind == b.kind && a.state == b.state && a.occupants == b.occupants &&
           math::length(a.position - b.position) < Vehicles::kMinMove && turnBetween(a.yaw, b.yaw) < Vehicles::kMinTurn;
}

}  // namespace

Vehicles::Vehicles(std::shared_ptr<const RaidSession> session, WorldState& world, const Players& players)
    : session_(std::move(session)), game_(session_->game), world_(world), players_(players) {}

Vehicles::~Vehicles() { world_.vehicles.publish(VehiclesSnapshot{}); }

void Vehicles::registerTasks(sched::TaskRunner& live, sched::TaskRunner&) {
    live.add("vehicles", {.interval = kInterval, .phase = std::chrono::milliseconds(11)}, [this] { update(); });
}

void Vehicles::update() {
    auto btr = readBtr();
    if (btr.has_value() == last_.has_value() && (!btr || sameVehicle(*btr, *last_))) return;
    last_ = std::move(btr);
    VehiclesSnapshot snap;
    snap.raidId = session_->id;
    snap.revision = ++revision_;
    if (last_) snap.vehicles.push_back(*last_);
    world_.vehicles.publish(std::move(snap));
}

std::optional<Vehicle> Vehicles::readBtr() {
    const Address controller =
        readPointer(game_, session_->start.localGameWorld + off::ClientLocalGameWorld::btrController, Freshness::Fresh);
    const Address view = controller ? readPointer(game_, controller + off::BtrController::BtrView, Freshness::Fresh) : 0;
    if (!view) return std::nullopt;
    if (view != btrView_) {
        btrView_ = view;
        btrTransform_ = transformOfComponent(game_, view).value_or(0);
    }
    if (!btrTransform_) {
        btrView_ = 0;  // retry next tick
        return std::nullopt;
    }
    const auto pose = game_.transforms.worldPose(btrTransform_, Freshness::Fresh);
    if (!pose || !math::isSane(pose->position, 100000.0f)) return last_;  // keep the last good one

    Vehicle btr{.id = 1, .kind = Vehicle::Kind::Btr, .state = 0, .position = pose->position, .yaw = yawOf(pose->rotation)};
    std::uint8_t state = 0;
    if (game_.mem.tryRead(view + off::BTRView::btrState, state, Freshness::Fresh)) btr.state = state;

    const Address turret = readPointer(game_, view + off::BTRView::turret, Freshness::Fresh);
    const Address gunner = turret ? readPointer(game_, turret + off::BTRTurretView::attachedBot, Freshness::Fresh) : 0;

    const auto refs = players_.refs();
    std::vector<std::int32_t> states(refs->size(), 0);
    mem::ReadBatch batch(game_.mem);
    for (std::size_t i = 0; i < refs->size(); ++i) {
        const auto& r = (*refs)[i];
        batch.add(r.instance + (r.kind == PlayerKind::Observed ? off::ObservedPlayerView::BtrState : off::Player::_btrState),
                  states[i]);
    }
    batch.execute(Freshness::Fresh);
    for (std::size_t i = 0; i < refs->size(); ++i) {
        const auto& r = (*refs)[i];
        if (r.dead) continue;
        if (gunner && r.instance == gunner) btr.occupants.push_back({r.id, VehicleOccupant::Seat::Gunner});
        else if (batch.complete(i) && states[i] >= kGoIn && states[i] <= kGoOut)
            btr.occupants.push_back({r.id, VehicleOccupant::Seat::Passenger});
    }
    // refs are ordered by id, so occupants are too.
    return btr;
}

}  // namespace radar::eft
