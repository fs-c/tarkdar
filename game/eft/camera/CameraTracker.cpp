#include "game/eft/camera/CameraTracker.hpp"

#include "core/log/Log.hpp"
#include "game/eft/Layouts.hpp"
#include "game/eft/Read.hpp"
#include "core/mem/ReadBatch.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cctype>

namespace radar::eft {

using mem::Freshness;
using sched::Clock;

namespace {

constexpr auto kFresh = Freshness::Fresh;

bool containsIgnoreCase(std::string_view haystack, std::string_view needle) {
    return std::ranges::search(haystack, needle, [](char a, char b) {
               return std::tolower(static_cast<unsigned char>(a)) == std::tolower(static_cast<unsigned char>(b));
           }).begin() != haystack.end();
}

bool isFpsCamera(std::string_view name) { return containsIgnoreCase(name, "FPS") && containsIgnoreCase(name, "Camera"); }
bool isOpticCamera(std::string_view name) { return containsIgnoreCase(name, "Optic") && containsIgnoreCase(name, "Camera"); }

CameraView viewOf(const unity::CameraSample& s) { return {s.viewProjection, s.position, s.fieldOfView, s.aspect}; }

}  // namespace

CameraTracker::CameraTracker(std::shared_ptr<const RaidSession> session, WorldState& world)
    : session_(std::move(session)), game_(session_->game), world_(world), cameras_(game_.mem, kCameraLayout) {}

CameraTracker::~CameraTracker() { world_.camera.publish(CameraSnapshot{}); }

void CameraTracker::registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) {
    background.add("camera.resolve", {.interval = kResolveCheck, .runOnStart = true}, [this] { refresh(Clock::now()); });
    live.add("camera", {.interval = kInterval, .phase = std::chrono::milliseconds(7), .runOnStart = true},
             [this] { tick(Clock::now()); });
}

void CameraTracker::refresh(Clock::time_point now) {
    const bool requested = resolveRequested_.load() && now - lastResolve_ >= kRequestedResolveSpacing;
    if (lastResolve_ != Clock::time_point{} && now - lastResolve_ < kResolveInterval && !requested) return;
    resolveRequested_ = false;
    lastResolve_ = now;
    found_.publish(resolve());
}

CameraTracker::Found CameraTracker::resolve() const {
    Found f;
    Address firstOptic = 0;
    for (const Address camera : cameras_.list(game_.unityPlayer + off::unity_rva::allCameras)) {
        const auto object = game_.scene.gameObjectOf(camera);
        std::string name = object ? game_.scene.objectName(*object) : std::string{};
        if (!f.fps && isFpsCamera(name) && cameras_.sample(camera)) f.fps = camera;
        if (isOpticCamera(name)) {
            if (!firstOptic) firstOptic = camera;
            if (!f.optic && cameras_.sample(camera)) f.optic = camera;
        }
        f.cameras.emplace_back(camera, std::move(name));
    }
    if (!f.optic) f.optic = firstOptic;  // it only renders while scoped

    // The OpticCameraManager knows the optic camera for sure, and which sight is looked through.
    auto componentOf = [&](Address camera, std::string_view className) -> Address {
        const auto object = camera ? game_.scene.gameObjectOf(camera) : std::nullopt;
        return object ? game_.scene.findManagedComponent(*object, className, game_.managed).value_or(0) : 0;
    };
    f.opticManager = componentOf(f.optic, "OpticCameraManager");
    if (!f.opticManager)
        if (const Address manager = componentOf(f.fps, "EFT.CameraControl.CameraManager"))
            f.opticManager = readPointer(game_, manager + off::CameraManager::OpticCameraManager, kFresh);
    if (f.opticManager) {
        // Only a camera that reads: a wrong OpticCameraManager.Camera offset mustn't replace a good one.
        const Address managedCamera = readPointer(game_, f.opticManager + off::OpticCameraManager::Camera, kFresh);
        const auto native = managedCamera ? game_.managed.nativePointer(managedCamera, kFresh) : std::nullopt;
        if (native && mem::MemoryView::isUserPointer(*native) && *native != f.fps && cameras_.sample(*native))
            f.optic = *native;
    }
    return f;
}

Address CameraTracker::proceduralWeaponAnimation() const {
    const Address player =
        readPointer(game_, session_->start.localGameWorld + off::ClientLocalGameWorld::MainPlayer, kFresh);
    return player ? readPointer(game_, player + off::Player::ProceduralWeaponAnimation, kFresh) : 0;
}

std::optional<bool> CameraTracker::readAiming(Address pwa) const {
    std::uint8_t aiming = 0;
    if (!pwa || !game_.mem.tryRead(pwa + off::ProceduralWeaponAnimation::IsAiming, aiming, kFresh)) return std::nullopt;
    return aiming != 0;
}

const std::vector<std::vector<float>>& CameraTracker::zooms(Address sightTemplate) const {
    // Templates are static data: their zoom tables don't change during the raid.
    if (const auto it = zoomCache_.find(sightTemplate); it != zoomCache_.end()) return it->second;
    std::vector<std::vector<float>> table;
    const Address zooms = readPointer(game_, sightTemplate + off::SightModTemplate::Zooms, kFresh);
    if (const auto scopes = zooms ? game_.managed.readArray<Address>(zooms, kMaxScopes, kFresh) : std::nullopt)
        for (const Address scope : *scopes)
            table.push_back(game_.managed.readArray<float>(scope, kMaxModes, kFresh).value_or(std::vector<float>{}));
    if (table.empty()) {  // unreadable (yet): don't cache
        static const std::vector<std::vector<float>> none;
        return none;
    }
    return zoomCache_.emplace(sightTemplate, std::move(table)).first->second;
}

std::vector<SightState> CameraTracker::readSights(Address pwa, Address opticManager) const {
    const Address list = pwa ? readPointer(game_, pwa + off::ProceduralWeaponAnimation::Optics, kFresh) : 0;
    const auto sightBones = list ? game_.managed.readList<Address>(list, kMaxSights, kFresh) : std::nullopt;
    if (!sightBones || sightBones->empty()) return {};

    // The sight the optic camera renders: OpticSight → its scope transform (native).
    const Address current =
        opticManager ? readPointer(game_, opticManager + off::OpticCameraManager::CurrentOpticSight, kFresh) : 0;
    const Address scope = current ? readPointer(game_, current + off::OpticSight::ScopeTransform, kFresh) : 0;
    const Address scopeNative = scope ? game_.managed.nativePointer(scope, kFresh).value_or(0) : 0;

    // Per sight: SightNBone → Mod (SightComponent) and Bone (transform), then the component's fields
    // and the bone's native transform, two batches for all sights.
    struct Read {
        Address mod = 0, bone = 0, boneNative = 0, selectedModes = 0, tmpl = 0;
        std::int32_t scope = -1;
        float scopeZoomValue = 0;
    };
    std::vector<Read> reads(sightBones->size());
    mem::ReadBatch first(game_.mem);
    for (std::size_t i = 0; i < reads.size(); ++i) {
        first.add((*sightBones)[i] + off::SightNBone::Mod, reads[i].mod);
        first.add((*sightBones)[i] + off::SightNBone::Bone, reads[i].bone);
    }
    first.execute(kFresh);
    mem::ReadBatch second(game_.mem);
    for (auto& r : reads) {
        if (mem::MemoryView::isUserPointer(r.bone)) second.add(r.bone + kIl2CppLayout.unityObjectCachedPtr, r.boneNative);
        if (!mem::MemoryView::isUserPointer(r.mod)) continue;
        second.add(r.mod + off::SightComponent::SelectedScope, r.scope);
        second.add(r.mod + off::SightComponent::ScopeZoomValue, r.scopeZoomValue);
        second.add(r.mod + off::SightComponent::ScopesSelectedModes, r.selectedModes);
        second.add(r.mod + off::SightComponent::Template, r.tmpl);
    }
    second.execute(kFresh);

    std::vector<SightState> sights;
    for (const auto& r : reads) {
        if (!mem::MemoryView::isUserPointer(r.mod) || !mem::MemoryView::isUserPointer(r.tmpl)) continue;
        SightZoomData d{.selectedScope = r.scope, .selectedMode = 0, .zooms = zooms(r.tmpl), .scopeZoomValue = r.scopeZoomValue};
        if (mem::MemoryView::isUserPointer(r.selectedModes)) {
            const auto modes = game_.managed.readArray<std::int32_t>(r.selectedModes, kMaxScopes, kFresh);
            if (modes && r.scope >= 0 && static_cast<std::size_t>(r.scope) < modes->size())
                d.selectedMode = (*modes)[static_cast<std::size_t>(r.scope)];
        }
        auto s = resolveSight(d);
        if (!s) continue;
        s->current = scopeNative && r.boneNative == scopeNative;
        sights.push_back(*s);
    }
    return sights;
}

bool CameraTracker::sample(Tracked& t, Clock::time_point now) const {
    if (!t.camera) return false;
    if (const auto s = cameras_.sample(t.camera)) {
        t.view = viewOf(*s);
        t.failingSince = {};
        return true;
    }
    if (t.failingSince == Clock::time_point{}) t.failingSince = now;
    return now - t.failingSince < kFailureGrace;  // keeps the last good view meanwhile
}

void CameraTracker::tick(Clock::time_point now) {
    // Cameras found by the background task.
    if (auto found = found_.get(); found != using_ && (found->fps || found->optic || !found->cameras.empty())) {
        if (!using_ || found->fps != using_->fps || found->optic != using_->optic || found->opticManager != using_->opticManager)
            log::debug("camera: {} cameras; FPS {:#x}, optic {:#x}, OpticCameraManager {:#x}", found->cameras.size(),
                       found->fps, found->optic, found->opticManager);
        if (found->fps != fps_.camera) fps_ = {.camera = found->fps};
        if (found->optic != optic_.camera) optic_ = {.camera = found->optic};
        opticManager_ = found->opticManager;
        using_ = std::move(found);
    }
    if (now >= nextSightRead_) {
        nextSightRead_ = now + kSightInterval;
        const Address pwa = proceduralWeaponAnimation();
        aiming_ = readAiming(pwa).value_or(false);
        sights_ = aiming_ ? readSights(pwa, opticManager_) : std::vector<SightState>{};
    }

    CameraSnapshot next;
    if (fps_.camera && !sample(fps_, now)) {
        log::debug("camera: FPS camera {:#x} stopped reading", fps_.camera);
        fps_ = {};
        resolveRequested_ = true;
    }
    if (!fps_.camera) resolveRequested_ = true;
    next.fps = fps_.view;
    next.aiming = aiming_;
    next.sights = sights_;
    if (aiming_) next.activeSight = activeSight(sights_);
    if (next.activeSight) {
        const SightState& s = sights_[*next.activeSight];
        next.magnification = s.zoom;
        next.scoped = s.magnified;
    }
    if (next.scoped) {
        if (optic_.camera && !sample(optic_, now)) {
            log::debug("camera: optic camera {:#x} stopped reading", optic_.camera);
            optic_ = {};
        }
        if (!optic_.camera) resolveRequested_ = true;  // scoped without one: look for it now
        next.optic = optic_.view;
    } else {
        optic_.view.reset();
        optic_.failingSince = {};
    }
    if (!next.sameState(last_)) publish(std::move(next));
}

void CameraTracker::publish(CameraSnapshot next) {
    next.raidId = session_->id;
    next.revision = ++revision_;
    last_ = next;
    world_.camera.publish(std::move(next));
}

}  // namespace radar::eft
