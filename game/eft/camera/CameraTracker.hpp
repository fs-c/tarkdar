#pragma once

#include "core/sched/Published.hpp"
#include "core/unity/Camera.hpp"
#include "game/eft/camera/Sights.hpp"
#include "game/eft/model/WorldState.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <atomic>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace radar::eft {

// The local player's view: the first-person camera, whether they aim down sights and through which
// sight at what zoom, and the scope's own camera while that's magnified. Publishes
// WorldState::camera. Nothing here draws anything: it's for clients that render the player's view.
//
// Cameras: Unity's list of all cameras (UnityPlayer global unity_rva::allCameras), told apart by
// their GameObject names ("FPS Camera", "BaseOpticCamera(Clone)", ...). The optic camera is taken from
// the OpticCameraManager when it can be found (a component on the optic camera's object, or
// EFT.CameraControl.CameraManager.OpticCameraManager on the FPS camera's) and its Camera reads; its
// CurrentOpticSight tells which of several sights is looked through.
//
// Aiming and sights: local player → Player.ProceduralWeaponAnimation → _isAiming, and _optics, a
// List<SightNBone> (Mod: the SightComponent; Bone: the sight's transform). Zoom: see resolveSight.
//
// Two tasks:
//  - live (kInterval): samples the FPS camera, and the optic camera while scoped; re-reads aiming
//    and sights every kSightInterval (batched; the sights' zoom tables are cached per template);
//  - background (kResolveCheck): looks up which camera is which every kResolveInterval, or sooner
//    when the live task asks (a camera stopped reading, or scoped without an optic camera), and
//    hands the result over through a published snapshot.
class CameraTracker final : public RaidSubsystem {
public:
    static constexpr auto kInterval = std::chrono::milliseconds(16);
    static constexpr auto kSightInterval = std::chrono::milliseconds(50);
    static constexpr auto kResolveCheck = std::chrono::milliseconds(250);
    static constexpr auto kResolveInterval = std::chrono::seconds(3);
    // Look-ups asked for by the live task are at least this far apart.
    static constexpr auto kRequestedResolveSpacing = std::chrono::milliseconds(500);
    // A camera that doesn't read for this long is dropped (and looked for again); until then the
    // last good view is kept.
    static constexpr auto kFailureGrace = std::chrono::milliseconds(750);
    static constexpr std::size_t kMaxSights = 16;
    static constexpr std::size_t kMaxScopes = 16;
    static constexpr std::size_t kMaxModes = 32;

    CameraTracker(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~CameraTracker() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    // Task bodies; public for tests, which drive them with synthetic times.
    void tick(sched::Clock::time_point now);     // live
    void refresh(sched::Clock::time_point now);  // background: look the cameras up if due

    // Which cameras were found.
    struct Found {
        std::vector<std::pair<Address, std::string>> cameras;  // the list, with GameObject names
        Address fps = 0;
        Address optic = 0;
        Address opticManager = 0;  // managed OpticCameraManager
    };
    // Looks the cameras up (doesn't change what the tracker uses; see refresh).
    [[nodiscard]] Found resolve() const;

    // The local player's ProceduralWeaponAnimation (0 if unreadable), whether they aim down sights
    // (nullopt if unreadable), and their sights as read now (empty if none or unreadable). The sights'
    // zoom tables are cached: call from one thread only.
    [[nodiscard]] Address proceduralWeaponAnimation() const;
    [[nodiscard]] std::optional<bool> readAiming(Address pwa) const;
    [[nodiscard]] std::vector<SightState> readSights(Address pwa, Address opticManager) const;

private:
    struct Tracked {
        Address camera = 0;
        std::optional<CameraView> view{};  // last good read
        sched::Clock::time_point failingSince{};
    };

    // Samples t.camera; false once it has failed for kFailureGrace.
    bool sample(Tracked& t, sched::Clock::time_point now) const;
    [[nodiscard]] const std::vector<std::vector<float>>& zooms(Address sightTemplate) const;
    void publish(CameraSnapshot next);

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    unity::Cameras cameras_;

    // Background → live.
    sched::Published<Found> found_;
    std::atomic<bool> resolveRequested_{false};
    // Background task only.
    sched::Clock::time_point lastResolve_{};

    // Live task only.
    std::shared_ptr<const Found> using_;
    Tracked fps_, optic_;
    Address opticManager_ = 0;
    sched::Clock::time_point nextSightRead_{};
    bool aiming_ = false;
    std::vector<SightState> sights_;
    mutable std::unordered_map<Address, std::vector<std::vector<float>>> zoomCache_;  // by SightModTemplate
    CameraSnapshot last_;
    std::uint64_t revision_ = 0;
};

}  // namespace radar::eft
