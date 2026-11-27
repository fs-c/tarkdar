#include "tools/diagnose/Diagnose.hpp"

#include "game/eft/model/PlayerText.hpp"
#include "game/eft/BuildCheck.hpp"
#include "game/eft/Game.hpp"
#include "game/eft/Read.hpp"
#include "game/eft/model/WorldState.hpp"
#include "game/eft/players/Players.hpp"
#include "game/eft/players/Skeleton.hpp"
#include "game/eft/raid/RaidFinder.hpp"
#include "game/eft/raid/Roster.hpp"
#include "game/eft/world/Exfils.hpp"
#include "game/eft/Layouts.hpp"
#include "game/eft/camera/CameraTracker.hpp"
#include "game/eft/items/ItemTree.hpp"
#include "game/eft/world/Explosives.hpp"
#include "game/eft/world/Loot.hpp"
#include "game/eft/world/Quests.hpp"
#include "game/eft/world/Stash.hpp"
#include "game/eft/world/Vehicles.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <format>
#include <map>
#include <string>
#include <thread>

namespace radar::diagnose {

namespace {

using mem::Address;
using sched::Clock;

class Report {
public:
    explicit Report(std::FILE* out) : out_(out) {}

    void section(std::string_view title) { std::fprintf(out_, "\n== %.*s ==\n", int(title.size()), title.data()); }
    void ok(std::string_view msg) { line("  OK  ", msg); }
    void fail(std::string_view msg, std::string_view hint = {}) {
        ++failures_;
        line("  FAIL", msg);
        if (!hint.empty()) line("      ", std::format("check: {}", hint));
    }
    void info(std::string_view msg) { line("      ", msg); }
    [[nodiscard]] int failures() const { return failures_; }

private:
    void line(std::string_view tag, std::string_view msg) {
        std::fprintf(out_, "%.*s %.*s\n", int(tag.size()), tag.data(), int(msg.size()), msg.data());
        std::fflush(out_);
    }
    std::FILE* out_;
    int failures_ = 0;
};

std::string hex(Address a) { return std::format("{:#x}", a); }

std::string classOf(const eft::Game& game, Address object) {
    const auto klass = game.managed.klassOf(object);
    const auto name = klass ? game.managed.fullClassName(*klass) : std::string{};
    return name.empty() ? "?" : name;
}

const char* statusName(eft::WorldCheck::Status s) {
    switch (s) {
    case eft::WorldCheck::Status::Ready: return "ready";
    case eft::WorldCheck::Status::Pending: return "pending";
    case eft::WorldCheck::Status::Rejected: return "rejected";
    }
    return "?";
}

std::size_t countNodes(const std::vector<eft::ItemNode>& nodes) {
    std::size_t n = nodes.size();
    for (const auto& c : nodes) n += countNodes(c.children);
    return n;
}

void checkIl2Cpp(Report& r, const eft::Game& game) {
    r.section("IL2CPP");
    const auto table = game.typeInfoTable();
    if (!table) {
        r.fail("type-info table not found at GameAssembly + " + hex(off::bootstrap::typeInfoTableRva),
               "bootstrap.typeInfoTableRva (regenerate with il2cpp-dump)");
        return;
    }
    r.ok("type-info table at " + hex(table->address()));
    const auto klass = table->klass(off::GamePlayerOwner::TypeIndex);
    if (!klass) {
        r.fail(std::format("type index {:#x} (GamePlayerOwner) has no class yet", off::GamePlayerOwner::TypeIndex),
               "GamePlayerOwner.TypeIndex; or the class isn't initialised yet (enter a raid)");
        return;
    }
    const auto name = game.managed.fullClassName(*klass);
    if (name == "EFT.GamePlayerOwner") r.ok("type index points at EFT.GamePlayerOwner");
    else r.fail("type index points at '" + name + "', expected EFT.GamePlayerOwner", "GamePlayerOwner.TypeIndex");
    const auto statics = table->staticFields(off::GamePlayerOwner::TypeIndex);
    if (!statics) {
        r.fail("GamePlayerOwner has no static fields block", "managedLayout.Il2CppClass.StaticFields");
        return;
    }
    const Address myPlayer = eft::readPointer(game, *statics + off::GamePlayerOwner::MyPlayer, mem::Freshness::Fresh);
    if (myPlayer) r.ok("GamePlayerOwner._myPlayer = " + hex(myPlayer) + " (" + classOf(game, myPlayer) + ")");
    else r.info("GamePlayerOwner._myPlayer is null (normal outside a raid)");
}

void checkUnity(Report& r, const eft::Game& game) {
    r.section("Unity");
    const auto gom = game.gameObjectManager();
    if (!gom) {
        r.fail("GameObjectManager pointer unreadable at UnityPlayer + " + hex(off::unity_rva::gameObjectManager),
               "unityRvas.gameObjectManager");
        return;
    }
    r.ok("GameObjectManager at " + hex(*gom));
    const auto walk = game.scene.activeObjects(*gom);
    const char* end = walk.end == unity::Scene::Walk::End::ReachedTail ? "reached tail"
                      : walk.end == unity::Scene::Walk::End::Cycle     ? "cycle"
                      : walk.end == unity::Scene::Walk::End::Cap       ? "hit the cap"
                      : walk.end == unity::Scene::Walk::End::BadHeader ? "bad list header"
                                                                       : "invalid next pointer";
    if (walk.objects.empty()) r.fail(std::format("active object list empty ({})", end), "unityLayout.GameObjectManager.*, ListNode.*");
    else r.ok(std::format("{} active objects ({})", walk.objects.size(), end));
    const auto named = game.scene.findByName(*gom, "GameWorld");
    r.info(std::format("{} object(s) named GameWorld (expected 1 in a raid)", named.size()));
}

std::optional<eft::RaidCandidate> checkRaid(Report& r, const eft::Game& game) {
    r.section("Raid discovery");
    eft::RaidFinder finder(game);
    std::optional<eft::RaidCandidate> found;
    auto describe = [&](std::string_view strategy, const std::optional<eft::WorldCheck>& wc) {
        if (!wc) {
            r.info(std::string(strategy) + ": no candidate world");
            return;
        }
        const auto& c = wc->candidate;
        const auto msg = std::format("{}: world {} → {} (location '{}', local player {}, {} registered){}{}", strategy,
                                     hex(c.localGameWorld), statusName(wc->status), c.locationId, hex(c.localPlayer),
                                     c.registeredCount, wc->reason.empty() ? "" : ": ", wc->reason);
        if (wc->status == eft::WorldCheck::Status::Ready) {
            r.ok(msg);
            if (!found) found = c;
        } else {
            r.info(msg);
        }
    };
    describe("GamePlayerOwner static", finder.viaGamePlayerOwner());
    describe("scene scan", finder.viaSceneScan());
    if (!found)
        r.fail("no raid found",
               "be in a raid; then GameWorld.Location, ClientLocalGameWorld.MainPlayer/RegisteredPlayers, "
               "and kRaidLocations in Maps.hpp for unknown locations");
    return found;
}

void checkPlayers(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Players");
    const auto& game = session->game;
    const auto roster = eft::readRoster(game, session->start.localGameWorld);
    if (!roster) {
        r.fail("roster unreadable", "ClientLocalGameWorld.RegisteredPlayers, managedLayout.List.*");
        return;
    }
    std::map<std::string, int> classes;
    for (Address p : roster->players) ++classes[classOf(game, p)];
    std::string classList;
    for (const auto& [name, n] : classes) classList += std::format("{}{} ×{}", classList.empty() ? "" : ", ", name, n);
    r.ok(std::format("{} registered players: {}", roster->players.size(), classList));
    if (roster->players.size() <= 1)
        r.info("only the local player is registered: normal right at raid start; if bots are already "
               "visible in game, ClientLocalGameWorld.RegisteredPlayers may point at the wrong list");

    eft::WorldState world;
    eft::Players players(session, world);
    const auto t = Clock::now();
    // Enough roster ticks to build every entry (kMaxBuildsPerTick each); then positions and equipment.
    for (std::size_t i = 0; i <= roster->players.size() / eft::Players::kMaxBuildsPerTick; ++i)
        players.rosterTick(t + std::chrono::milliseconds(20 * i));
    players.positionsTick(t);
    for (int i = 0; i < 1 + int(roster->players.size()); ++i) players.equipmentTick(t + std::chrono::seconds(i));
    const auto snap = world.players.get();
    std::map<std::string, int> kinds;
    for (const auto& p : snap->players) ++kinds[eft::kindName(p.kind)];
    std::string kindList;
    for (const auto& [name, n] : kinds) kindList += std::format("{}{} ×{}", kindList.empty() ? "" : ", ", name, n);
    if (snap->players.size() < roster->players.size())
        r.fail(std::format("only {} of {} players built ({})", snap->players.size(), roster->players.size(), kindList),
               "client/local players: Player.Profile → Profile.Info → PlayerInfo.Side, Player._playerBody, "
               "Player.MovementContext; observed players: ObservedPlayerView.*, ObservedPlayerController.*, "
               "ObservedMovementController.*; see the reasons below");
    else
        r.ok(std::format("{} players built ({})", snap->players.size(), kindList));
    for (const auto& f : players.buildFailures())
        r.info(std::format("not built: {} ({}): {}", hex(f.instance), f.className, f.error));

    int positioned = 0;
    for (const auto& p : snap->players) positioned += p.position ? 1 : 0;
    if (positioned == 0 && !snap->players.empty())
        r.fail("no player has a position",
               "literals PlayerBody.SkeletonRootJoint, Skeleton.Values; unityLayout.Transform*/TransformHierarchy.*");
    else
        r.ok(std::format("{} of {} players have a position", positioned, snap->players.size()));
    int withJoints = 0;
    for (const auto& p : snap->players) withJoints += p.joints ? 1 : 0;
    if (withJoints == 0 && positioned > 0)
        r.fail("no player has a full skeleton (joints)",
               "the joint bone indices in kJointSources (game/eft/players/Skeleton.hpp); see the Skeleton section");
    else
        r.ok(std::format("{} of {} players have a full skeleton", withJoints, snap->players.size()));
    for (const auto& p : snap->players) {
        if (!p.local && &p - snap->players.data() > 4) continue;  // the local player + a few others
        r.info(std::format("{}: pos {} yaw {:.1f} pitch {:.1f}", describePlayer(p),
                           p.position ? std::format("({:.1f}, {:.1f}, {:.1f})", p.position->x, p.position->y, p.position->z)
                                      : std::string("none"),
                           p.yaw, p.pitch));
    }
    // Identity of every player, for checking role/voice/group against what's actually in the raid
    // (the observed-player role source is unverified).
    int observedAi = 0, observedAiWithRole = 0;
    for (const auto& p : snap->players) {
        if (p.kind == eft::PlayerKind::Observed && p.ai) {
            ++observedAi;
            observedAiWithRole += p.role ? 1 : 0;
        }
        r.info(std::format("identity #{} {}{} side {} role {} voice '{}' nick '{}' group '{}'", p.id,
                           eft::kindName(p.kind), p.ai ? " ai" : "", static_cast<int>(p.side),
                           p.role ? std::to_string(*p.role) : "-", p.voice, p.nickname, p.groupId));
    }
    if (observedAi > 0)
        r.info(std::format("{} of {} observed AI players have a role (ObservedPlayerView.AIData → "
                           "StubAIData/AIData.BotHostilityData → BotHostilityData._role)",
                           observedAiWithRole, observedAi));
    if (!snap->local()) r.fail("no local player in the roster", "ClientLocalGameWorld.MainPlayer");

    const auto eq = world.equipment.get();
    if (eq->players.empty())
        r.fail("no equipment read for any player",
               "Player._inventoryController → InventoryController.Inventory → Inventory.Equipment → "
               "InventoryEquipment._cachedSlots; Slot.*; class CompoundItem");
    else
        r.ok(std::format("equipment for {} players (e.g. #{}: {} slots, {} items)", eq->players.size(),
                         eq->players[0].playerId, eq->players[0].slots.size(), countNodes(eq->players[0].slots)));
}

std::string signedVec(math::Vec3 v) { return std::format("({:+.2f}, {:+.2f}, {:+.2f})", v.x, v.y, v.z); }

// Checks one skeleton's joint bones by name; with `listAll`, also lists every bone (index, GameObject
// name, offset from Base), which is what the joint table in Skeleton.hpp is maintained from.
void checkSkeletonOf(Report& r, const eft::Game& game, std::string_view who, Address bodyField, bool listAll) {
    const auto bones = eft::readAllBones(game, bodyField);
    if (bones.empty()) {
        r.fail(std::format("{}: bone list unreadable", who), "literals PlayerBody.SkeletonRootJoint, Skeleton.Values");
        return;
    }
    r.ok(std::format("{}: {} bones", who, bones.size()));
    const std::optional<math::Vec3> base = bones[0].pose ? std::optional{bones[0].pose->position} : std::nullopt;
    auto offset = [&](const eft::BoneInfo& b) {
        return b.pose && base ? signedVec(b.pose->position - *base) : std::string("(unreadable)");
    };
    int matched = 0;
    for (std::size_t j = 0; j < eft::kJointCount; ++j) {
        const auto& src = eft::kJointSources[j];
        if (src.bone >= bones.size()) {
            r.fail(std::format("{}: joint {} wants bone {}, the list has {}", who, j, src.bone, bones.size()),
                   "kJointSources in game/eft/players/Skeleton.hpp");
            continue;
        }
        const auto& b = bones[src.bone];
        if (b.name.ends_with(src.nameSuffix)) {
            ++matched;
            continue;
        }
        // Where the expected name actually is, if anywhere.
        std::string found = "nowhere";
        for (const auto& o : bones)
            if (o.name.ends_with(src.nameSuffix)) found = std::format("at bone {}", o.index);
        r.fail(std::format("{}: joint {} expects *{} at bone {}, found '{}' (*{} is {})", who, j, src.nameSuffix,
                           src.bone, b.name, src.nameSuffix, found),
               "kJointSources in game/eft/players/Skeleton.hpp");
    }
    if (matched == int(eft::kJointCount)) r.ok(std::format("{}: all {} joint bones named as expected", who, matched));
    if (!listAll) return;
    for (const auto& b : bones)
        r.info(std::format("bone {:3} {:<28} {} (transform {:#x})", b.index, b.name.empty() ? "?" : "'" + b.name + "'", offset(b),
                           b.native));
}

void checkSkeleton(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Skeleton");
    const auto& game = session->game;
    const Address local = session->start.localPlayer;
    checkSkeletonOf(r, game, "local player", local + off::Player::_playerBody, true);

    // Every player's joints as the tracking reads them, with the reason for each one without.
    const auto roster = eft::readRoster(game, session->start.localGameWorld);
    bool client = false, observed = false;
    int full = 0, checked = 0;
    for (Address p : roster ? roster->players : std::vector<Address>{}) {
        const auto klass = classOf(game, p);
        const bool isObserved = klass.ends_with("ObservedPlayerView");
        if (!isObserved && !klass.ends_with("Player")) continue;  // not built either; see Players
        const Address bodyField = p + (isObserved ? off::ObservedPlayerView::PlayerBody : off::Player::_playerBody);
        // One other player of each kind by name: their bodies are built differently.
        if (p != local) {
            bool& seen = isObserved ? observed : client;
            if (!seen) {
                seen = true;
                checkSkeletonOf(r, game, std::format("{} player {}", isObserved ? "observed" : "client", hex(p)),
                                bodyField, false);
            }
        }
        ++checked;
        const auto bones = eft::resolveSkeletonBones(game, bodyField);
        std::string problem;
        if (!bones) problem = "position bones unresolved";
        else if (std::any_of(bones->transforms.begin(), bones->transforms.begin() + eft::kPositionJoints,
                             [](Address a) { return a == 0; }))
            problem = "some position bones unresolved (tracked by the others)";
        else if (!bones->full) problem = "joint bones unresolved";
        else problem = eft::jointProblem(game.transforms.worldPoses(bones->used(), mem::Freshness::Fresh));
        if (problem.empty()) ++full;
        else r.info(std::format("no joints for {} ({}): {}", hex(p), klass, problem));
    }
    r.ok(std::format("{} of {} players' skeletons give every joint", full, checked));
}

void checkExfils(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Exfils");
    eft::WorldState world;
    eft::Exfils exfils(session, world);
    exfils.discover();
    const auto snap = world.exfils.get();
    int regular = 0, secret = 0, positioned = 0;
    for (const auto& e : snap->exfils) {
        (e.kind == eft::Exfil::Kind::Secret ? secret : regular)++;
        positioned += e.position ? 1 : 0;
    }
    if (snap->exfils.empty())
        r.fail("no exfils", "ClientLocalGameWorld.ExfiltrationController, ExfiltrationController.*, ExitSettings.Name");
    else
        r.ok(std::format("{} regular + {} secret exfils, {} with position", regular, secret, positioned));
    if (regular == 0 && secret > 0)
        r.fail("no regular exfils: eligibility didn't match",
               "PlayerInfo.EntryPoint (PMC) / Profile.Id (scav), ExfiltrationPoint.EligibleEntryPoints / ScavExfiltrationPoint.EligibleIds");
    for (const auto& e : snap->exfils) r.info(std::format("'{}' status {}", e.name, e.status));
}

void checkExplosives(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Explosives");
    const auto& game = session->game;
    const Address grenades = eft::readPointer(game, session->start.localGameWorld + off::ClientLocalGameWorld::Grenades,
                                              mem::Freshness::Fresh);
    const auto grenadeList = grenades ? game.managed.readList<Address>(
                                            eft::readPointer(game, grenades + off::GrenadeCollection::List), 512)
                                      : std::nullopt;
    if (grenadeList) r.ok(std::format("grenade list readable ({} active)", grenadeList->size()));
    else r.fail("grenade list unreadable", "ClientLocalGameWorld.Grenades, literal GrenadeCollection.List");

    eft::WorldState world;
    eft::Explosives explosives(session, world);
    explosives.updateTripwires();
    const Address processor = eft::readPointer(
        game, session->start.localGameWorld + off::GameWorld::SynchronizableObjectLogicProcessor, mem::Freshness::Fresh);
    if (!processor) {
        r.fail("SynchronizableObjectLogicProcessor unreadable", "GameWorld.SynchronizableObjectLogicProcessor");
        return;
    }
    std::map<std::int32_t, int> types;
    for (auto field : {off::SynchronizableObjectLogicProcessor::_activeSynchronizableObjects,
                       off::SynchronizableObjectLogicProcessor::_staticSynchronizableObjects}) {
        const auto list = game.managed.readList<Address>(eft::readPointer(game, processor + field), 512);
        if (list)
            for (Address o : *list) ++types[game.mem.read<std::int32_t>(o + off::SynchronizableObject::Type)];
    }
    std::string hist;
    for (const auto& [type, n] : types) hist += std::format("{}type {} ×{}", hist.empty() ? "" : ", ", type, n);
    r.ok(std::format("synchronizable objects: {}; {} armed tripwire(s)", hist.empty() ? "none" : hist,
                     world.explosives.get()->tripwires.size()));
    r.info(std::format("tripwires are type {} (verify on a map with tripwires)", eft::Explosives::kTripwireType));
}

void checkCamera(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Camera");
    const auto& game = session->game;
    eft::WorldState world;
    eft::CameraTracker tracker(session, world);
    const auto found = tracker.resolve();
    if (found.cameras.empty()) {
        r.fail("camera list unreadable or empty", "unity_rva allCameras, unityLayout CameraList.*");
        return;
    }
    std::map<std::string, int> names;
    for (const auto& [camera, name] : found.cameras) ++names[name.empty() ? "(unnamed)" : name];
    std::string nameList;
    for (const auto& [name, n] : names) nameList += std::format("{}{}{}", nameList.empty() ? "" : ", ", name, n > 1 ? std::format(" ×{}", n) : "");
    r.ok(std::format("{} cameras: {}", found.cameras.size(), nameList));

    if (!found.fps) {
        r.fail("no readable camera named like 'FPS Camera'",
               "unityLayout Camera.ViewProjection, Camera.WorldToCamera (or the camera names changed)");
    } else {
        const auto sample = unity::Cameras(game.mem, eft::kCameraLayout).sample(found.fps);
        if (!sample) {
            r.fail(std::format("FPS camera {} doesn't read", hex(found.fps)), "unityLayout Camera.*");
        } else {
            const auto& v = *sample;
            r.ok(std::format("FPS camera {}: fov {:.1f}°, aspect {:.3f}{}", hex(found.fps), v.fieldOfView, v.aspect,
                             v.position ? std::format(", at ({:.1f}, {:.1f}, {:.1f})", v.position->x, v.position->y, v.position->z) : ", position unknown"));
            if (!v.fieldOfView || !v.aspect) r.info("fov or aspect implausible: check unityLayout Camera.FieldOfView / Camera.Aspect");
            // The camera should sit at the local player's eyes: compare with the skeleton's Base (feet).
            const auto bones = eft::resolveSkeletonBones(game, session->start.localPlayer + off::Player::_playerBody);
            const auto poses = bones ? game.transforms.worldPoses(bones->used(), mem::Freshness::Fresh)
                                     : std::vector<std::optional<unity::Pose>>{};
            if (v.position && !poses.empty() && poses[0]) {
                const auto d = *v.position - poses[0]->position;
                const float horizontal = std::sqrt(d.x * d.x + d.z * d.z);
                const auto msg = std::format("camera is {:.2f} m from the local player's feet, {:.2f} m above them", horizontal, d.y);
                if (horizontal < 1.0f && d.y > 0.2f && d.y < 2.2f) r.ok(msg);
                else r.fail(msg + " (expected: close, at eye height)", "unityLayout Camera.WorldToCamera, or the wrong camera");
            }
        }
    }
    r.info(std::format("optic camera: {}; OpticCameraManager: {}", found.optic ? hex(found.optic) : "not found",
                       found.opticManager ? hex(found.opticManager) : "not found"));

    const Address pwa = tracker.proceduralWeaponAnimation();
    const auto aiming = tracker.readAiming(pwa);
    if (!aiming) {
        r.fail("aiming state unreadable", "Player.ProceduralWeaponAnimation, ProceduralWeaponAnimation.IsAiming");
        return;
    }
    r.ok(std::format("aiming down sights: {} (aim through a scope while running radar-diagnose to check sights)",
                     *aiming ? "yes" : "no"));
    const auto sights = tracker.readSights(pwa, found.opticManager);
    if (sights.empty())
        r.info("no sights read: normal without optics; otherwise check ProceduralWeaponAnimation.Optics, SightNBone.*, "
               "SightComponent.*, SightModTemplate.Zooms");
    for (std::size_t i = 0; i < sights.size(); ++i) {
        const auto& s = sights[i];
        r.info(std::format("sight {}: scope {} mode {}, zoom {:.2f}× (range {:.1f}–{:.1f}){}{}", i, s.scope, s.mode, s.zoom,
                           s.minZoom, s.maxZoom, s.magnified ? ", magnified" : "", s.current ? ", looked through" : ""));
    }
}

void checkVehicles(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Vehicles");
    const auto& game = session->game;
    const Address controller = eft::readPointer(
        game, session->start.localGameWorld + off::ClientLocalGameWorld::btrController, mem::Freshness::Fresh);
    const Address view = controller ? eft::readPointer(game, controller + off::BtrController::BtrView, mem::Freshness::Fresh) : 0;
    if (!view) {
        r.info(controller ? "BTR not spawned (BtrController.BtrView is null)" : "no BtrController (normal on maps without a BTR)");
        return;
    }
    eft::WorldState world;
    eft::Players players(session, world);
    const auto t = Clock::now();
    for (int i = 0; i < 16; ++i) players.rosterTick(t + std::chrono::milliseconds(20 * i));
    eft::Vehicles vehicles(session, world, players);
    vehicles.update();
    const auto snap = world.vehicles.get();
    if (snap->vehicles.empty()) {
        r.fail("BTR view found but no vehicle read", "BtrView transform; BTRView.btrState");
        return;
    }
    const auto& v = snap->vehicles.front();
    r.ok(std::format("BTR at ({:.1f}, {:.1f}, {:.1f}) heading {:.0f}, state {} (0 stopped, 1 stopped/paid, 2 driving)",
                     v.position.x, v.position.y, v.position.z, v.yaw, v.state));
    const auto ps = world.players.get();
    for (const auto& o : v.occupants) {
        const auto p = std::find_if(ps->players.begin(), ps->players.end(), [&](const auto& x) { return x.id == o.playerId; });
        r.info(std::format("{} #{} {}", o.seat == eft::VehicleOccupant::Seat::Gunner ? "gunner" : "passenger", o.playerId,
                           p == ps->players.end() ? "?" : p->local ? "(local player)" : "voice '" + p->voice + "'"));
    }
    if (std::none_of(v.occupants.begin(), v.occupants.end(),
                     [](const auto& o) { return o.seat == eft::VehicleOccupant::Seat::Gunner; }))
        r.info("no gunner matched (BTRView.turret → BTRTurretView._bot)");
}

void checkLoot(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Loot");
    eft::WorldState world;
    eft::Loot loot(session, world);
    const auto t = Clock::now();
    loot.scan(t);
    for (int i = 1; i <= 50; ++i) loot.resolve(t + std::chrono::seconds(30 * i));  // past all back-offs
    const auto snap = world.loot.get();
    std::map<std::string, int> kinds;
    std::size_t withContents = 0, contentNodes = 0;
    for (const auto& l : snap->loot) {
        static constexpr const char* names[] = {"items", "quest items", "containers", "airdrops", "corpses"};
        ++kinds[names[static_cast<int>(l.kind)]];
        if (!l.contents.empty()) {
            ++withContents;
            contentNodes += countNodes(l.contents);
        }
    }
    std::string summary;
    for (const auto& [k, n] : kinds) summary += std::format("{}{} {}", summary.empty() ? "" : ", ", n, k);
    if (snap->loot.empty())
        r.fail("no loot resolved", "ClientLocalGameWorld.LootList; loot class names in Names.hpp; InteractiveLootItem.Item, "
                                   "Item.Template, ItemTemplate._id, literal MongoID.StringId");
    else
        r.ok(std::format("{} loot entries: {}", snap->loot.size(), summary));
    r.info(std::format("{} containers/corpses with contents ({} items){}", withContents, contentNodes,
                       off::CompoundItem::Grids ? "" : "; grid offsets unknown, so grid contents are skipped"));
    for (std::size_t i = 0; i < std::min<std::size_t>(5, snap->loot.size()); ++i) {
        const auto& l = snap->loot[i];
        r.info(std::format("tpl {} obj '{}' at ({:.1f}, {:.1f}, {:.1f})", l.templateId.empty() ? "-" : l.templateId,
                           l.objectName, l.position.x, l.position.y, l.position.z));
    }
}

void checkQuests(Report& r, const std::shared_ptr<const eft::RaidSession>& session) {
    r.section("Quests");
    eft::WorldState world;
    eft::Quests quests(session, world);
    quests.update();
    const auto snap = world.quests.get();
    if (!snap->known) {
        r.fail("local player's quest list not readable", "Player.Profile, Profile.QuestsData (List<QuestStatusData>)");
        return;
    }
    const auto unreadable = std::count_if(snap->quests.begin(), snap->quests.end(),
                                          [](const auto& q) { return !q.completedConditions; });
    if (snap->quests.empty())
        r.info("no quests in progress (or QuestsData.Status reads wrong; start a quest and check again)");
    else
        r.ok(std::format("{} quests in progress", snap->quests.size()));
    if (unreadable)
        r.fail(std::format("completed conditions unreadable for {} of them", unreadable),
               "QuestsData.CompletedConditions; managed HashSet.Slots / HashSet.LastIndex (unverified on SPT)");
    std::size_t withTemplate = 0, named = 0, objectives = 0, withProgress = 0;
    std::map<eft::QuestKind, int> kinds;
    for (const auto& q : snap->quests) {
        if (!q.objectives) continue;
        ++withTemplate;
        named += !q.name.empty();
        ++kinds[q.kind];
        objectives += q.objectives->size();
        for (const auto& o : *q.objectives) withProgress += o.progress.has_value();
    }
    if (!snap->quests.empty() && withTemplate == 0)
        r.fail("no quest template readable", "QuestsData.Template, QuestTemplate.Conditions, BindableList.List (literal)");
    else if (!snap->quests.empty())
        r.ok(std::format("{} with a template ({} named): {} story, {} side, {} daily, {} weekly; {} item objectives, {} with "
                         "hand-over progress",
                         withTemplate, named, kinds[eft::QuestKind::Story], kinds[eft::QuestKind::Side],
                         kinds[eft::QuestKind::Daily], kinds[eft::QuestKind::Weekly], objectives, withProgress));
    for (std::size_t i = 0; i < std::min<std::size_t>(5, snap->quests.size()); ++i) {
        const auto& q = snap->quests[i];
        std::string done = q.completedConditions ? std::to_string(q.completedConditions->size()) : "?";
        if (q.completedConditions && !q.completedConditions->empty()) done += " e.g. " + q.completedConditions->front();
        r.info(std::format("quest {} status {} (2 started, 3 ready to hand in), conditions done: {}", q.id, q.status, done));
    }
    // Quests not started yet (TODO.md, "future quests"): are they in the list, with readable templates?
    if (const auto survey = quests.surveyStatuses()) {
        for (const auto& s : *survey) {
            r.info(std::format("status {}: {} entries; of {} sampled, {} with a template, {} with item objectives",
                               s.status, s.entries, s.sampled, s.withTemplate, s.withItems));
            for (const auto& e : s.examples) r.info("  " + e);
        }
    } else {
        r.info("quest status survey: quest list not readable");
    }
}

// ---- Stash probe (owned items for quest/hideout needs; see TODO.md "quests tab") ----------------
//
// Answers, before building a stash reader:
//  - is the in-raid profile's stash (Player.Profile.Inventory.Stash) filled in, or stripped?
//  - can the menu-side profile be reached (TarkovApplication → MainMenuShowOperation → session/profile),
//    in a raid and outside one, and is it the same object as Player.Profile?
//  - how big is a stash read (items, templates, time), and does the FIR flag look right?
//  - hideout area levels (Profile.Hideout.Areas).

struct TreeStats {
    std::size_t top = 0, nodes = 0, fir = 0, attached = 0, units = 0;
    std::map<std::string, std::pair<std::int64_t, std::int64_t>> perTpl;  // tpl → (units, FIR units)
};

void tally(const std::vector<eft::ItemNode>& nodes, TreeStats& s) {
    for (const auto& n : nodes) {
        ++s.nodes;
        s.units += n.count;
        s.fir += n.fir;
        s.attached += !n.slot.empty();
        auto& t = s.perTpl[n.tpl];
        t.first += n.count;
        if (n.fir) t.second += n.count;
        tally(n.children, s);
    }
}

void reportTree(Report& r, std::string_view what, const std::vector<eft::ItemNode>& nodes, bool truncated,
                std::chrono::milliseconds took, bool details) {
    TreeStats s;
    s.top = nodes.size();
    tally(nodes, s);
    r.ok(std::format("{}: {} top-level, {} items ({} units), {} FIR, {} attached (in slots), {} templates, read in {} ms{}",
                     what, s.top, s.nodes, s.units, s.fir, s.attached, s.perTpl.size(), took.count(),
                     truncated ? " — TRUNCATED at the node cap" : ""));
    if (!details || s.perTpl.empty()) return;
    std::vector<std::pair<std::string, std::pair<std::int64_t, std::int64_t>>> top(s.perTpl.begin(), s.perTpl.end());
    std::sort(top.begin(), top.end(), [](const auto& a, const auto& b) { return a.second.first > b.second.first; });
    for (std::size_t i = 0; i < std::min<std::size_t>(8, top.size()); ++i)
        r.info(std::format("  tpl {} ×{} ({} FIR)", top[i].first, top[i].second.first, top[i].second.second));
    // A few FIR and non-FIR examples to check against the game's inventory screen.
    std::vector<std::string> firs, nonFirs;
    for (const auto& n : nodes) {
        if (n.fir && firs.size() < 4) firs.push_back(n.tpl);
        if (!n.fir && nonFirs.size() < 4) nonFirs.push_back(n.tpl);
    }
    auto join = [](const std::vector<std::string>& v) {
        std::string out;
        for (const auto& x : v) out += (out.empty() ? "" : ", ") + x;
        return out.empty() ? std::string("none") : out;
    };
    r.info("  top-level FIR e.g.: " + join(firs));
    r.info("  top-level not FIR e.g.: " + join(nonFirs));
}

constexpr eft::ItemTreeLimits kStashLimits{.maxDepth = 12, .maxNodes = 60000, .maxSlots = 64, .maxGridItems = 8192};

void probeContainer(Report& r, const eft::Game& game, std::string_view what, Address item, bool details) {
    if (!item) {
        r.info(std::format("{}: null", what));
        return;
    }
    eft::ItemTreeReader reader(game, kStashLimits);
    const auto t0 = std::chrono::steady_clock::now();
    const auto contents = reader.readContents(item);
    const auto took = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0);
    reportTree(r, std::format("{} ({}, {})", what, hex(item), classOf(game, item)), contents, reader.truncated(), took, details);
}

void probeProfile(Report& r, const eft::Game& game, std::string_view who, Address profile) {
    const auto id = game.managed.readStringField(profile + off::Profile::Id, 64).value_or("?");
    const Address info = eft::readPointer(game, profile + off::Profile::Info);
    const auto nick = info ? game.managed.readStringField(info + off::PlayerInfo::Nickname, 64).value_or("?") : "?";
    r.info(std::format("{} profile {} ({}): id {}, nickname '{}'", who, hex(profile), classOf(game, profile), id, nick));

    const Address inventory = eft::readPointer(game, profile + off::Profile::Inventory, mem::Freshness::Fresh);
    if (!inventory) {
        r.fail(std::format("{}: Profile.Inventory is null", who), "Profile.Inventory");
        return;
    }
    r.info(std::format("{}: inventory {} ({})", who, hex(inventory), classOf(game, inventory)));
    const auto field = [&](std::uint32_t offset) { return eft::readPointer(game, inventory + offset, mem::Freshness::Fresh); };

    if (const Address equipment = field(off::Inventory::Equipment)) {
        eft::ItemTreeReader reader(game, kStashLimits);
        const auto t0 = std::chrono::steady_clock::now();
        const auto slots = reader.readSlots(eft::readPointer(game, equipment + off::InventoryEquipment::_cachedSlots));
        const auto took = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0);
        reportTree(r, std::format("{}: equipment", who), slots, reader.truncated(), took, false);
    } else {
        r.info(std::format("{}: equipment null", who));
    }
    const Address stash = field(off::Inventory::Stash);
    if (!stash) r.info(std::format("{}: Inventory.Stash is null (stripped in this profile)", who));
    probeContainer(r, game, std::format("{}: stash", who), stash, true);
    probeContainer(r, game, std::format("{}: sorting table", who), field(off::Inventory::SortingTable), false);
    probeContainer(r, game, std::format("{}: quest raid items", who), field(off::Inventory::QuestRaidItems), true);
    probeContainer(r, game, std::format("{}: quest stash items", who), field(off::Inventory::QuestStashItems), false);
    probeContainer(r, game, std::format("{}: hideout customization stash", who),
                   field(off::Inventory::HideoutCustomizationStash), false);

    // Dictionary<?, stash>: the key is an enum (area type) or a string; either way the value sits at
    // the same entry offset, so it reads as <u64, Address>.
    if (const Address dict = field(off::Inventory::HideoutAreaStashes)) {
        const auto entries = game.managed.readDictionary<std::uint64_t, Address>(dict, 256, mem::Freshness::Fresh);
        if (!entries) {
            r.info(std::format("{}: hideout area stashes {} ({}) unreadable as a dictionary", who, hex(dict), classOf(game, dict)));
        } else {
            r.info(std::format("{}: {} hideout area stashes ({})", who, entries->size(), classOf(game, dict)));
            for (const auto& [key, value] : *entries)
                probeContainer(r, game, std::format("{}: area stash key {:#x}", who, key), value, false);
        }
    } else {
        r.info(std::format("{}: hideout area stashes null", who));
    }

    const Address hideout = eft::readPointer(game, profile + off::Profile::Hideout, mem::Freshness::Fresh);
    const Address areasArray = hideout ? eft::readPointer(game, hideout + off::HideoutInfo::Areas, mem::Freshness::Fresh) : 0;
    const auto areas = areasArray ? game.managed.readArray<Address>(areasArray, 128, mem::Freshness::Fresh) : std::nullopt;
    if (!areas) {
        r.info(std::format("{}: hideout areas unreadable (Hideout {}, Areas {})", who, hex(hideout), hex(areasArray)));
    } else {
        std::string list;
        for (Address a : *areas) {
            const auto type = game.mem.read<std::int32_t>(a + off::AreaInfo::Type);
            const auto level = game.mem.read<std::int32_t>(a + off::AreaInfo::Level);
            list += std::format("{}{}:{}", list.empty() ? "" : " ", type, level);
        }
        r.info(std::format("{}: {} hideout areas (type:level): {}", who, areas->size(), list));
    }
}

// Pointer fields of `root` (and of the objects they point at, up to `depth` levels) that hold an
// instance of `className`: "+0x18 (ClientBackEnd) → +0x40 (EFT.EftClientBackendSession)". For the
// session in a raid, where _menuOperation is gone and ClientApplication<T>'s own fields (generic, so
// without offsets in the dump) are the remaining way in.
struct PathHit {
    std::string path;
    Address object;
};

void searchFields(const eft::Game& game, Address root, std::string_view className, int depth, std::string path,
                  std::vector<Address>& seen, std::vector<PathHit>& hits) {
    static constexpr std::uint32_t kSpan = 0x300;
    std::vector<Address> fields(kSpan / 8);
    if (!game.mem.readBytes(root, std::as_writable_bytes(std::span{fields}), mem::Freshness::Fresh)) return;
    for (std::size_t i = 2; i < fields.size(); ++i) {  // skip klass and monitor
        const Address p = fields[i];
        if (!mem::MemoryView::isUserPointer(p) || std::find(seen.begin(), seen.end(), p) != seen.end()) continue;
        seen.push_back(p);
        const auto klass = game.managed.klassOf(p);
        if (!klass) continue;
        const auto name = game.managed.fullClassName(*klass);
        if (name.empty()) continue;
        const auto step = std::format("{}{}+{:#x} ({})", path, path.empty() ? "" : " → ", i * 8, name);
        if (game.managed.classIsA(*klass, className)) hits.push_back({step, p});
        else if (depth > 1 && hits.size() < 8) searchFields(game, p, className, depth - 1, step, seen, hits);
    }
}

void checkStash(Report& r, const eft::Game& game, Address localPlayer) {
    r.section("Stash (probe)");
    std::vector<std::pair<std::string, Address>> profiles;
    const auto addProfile = [&](std::string who, Address p) {
        if (!mem::MemoryView::isUserPointer(p)) return;
        for (const auto& [w, q] : profiles)
            if (q == p) {
                r.info(std::format("{} profile is the same object as the {} profile ({})", who, w, hex(p)));
                return;
            }
        profiles.emplace_back(std::move(who), p);
    };

    // The Stash subsystem's path in a raid: the local player's session.
    Address playerSession = 0;
    if (localPlayer) {
        const Address p = eft::readPointer(game, localPlayer + off::Player::Profile, mem::Freshness::Fresh);
        if (p) addProfile("in-raid (Player.Profile)", p);
        else r.fail("local player's profile unreadable", "Player.Profile");
        const Address session = eft::readPointer(game, localPlayer + off::ClientPlayer::Session, mem::Freshness::Fresh);
        playerSession = eft::Stash::playerSessionProfile(game, localPlayer);
        if (playerSession) {
            r.ok(std::format("ClientPlayer._session {} ({}) → profile {}", hex(session), classOf(game, session), hex(playerSession)));
            addProfile("session via ClientPlayer._session", playerSession);
        } else {
            r.fail(std::format("ClientPlayer._session {} ({}) has no ClientBackendSession profile", hex(session),
                               session ? classOf(game, session) : "-"),
                   "ClientPlayer.Session, ClientBackendSession.Profile");
        }
    } else {
        r.info("not in a raid: only the menu-side profile is probed");
    }

    const auto t0 = std::chrono::steady_clock::now();
    std::size_t checked = 0;
    const auto found = eft::Stash::findApplication(game, &checked);
    const auto took = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0);
    if (!found) {
        r.fail(std::format("TarkovApplication not found among the active objects ({} ms)", took.count()),
               "class name EFT.TarkovApplication; Scene components / Component.ManagedHandle, ManagedHandle.Object");
    } else {
        const Address application = *found;
        r.ok(std::format("TarkovApplication {} (found after {} objects, {} ms)", hex(application), checked, took.count()));
        const Address menu = eft::readPointer(game, application + off::TarkovApplication::MenuOperation, mem::Freshness::Fresh);
        if (!menu) {
            r.info("TarkovApplication._menuOperation is null");
        } else {
            r.info(std::format("_menuOperation {} ({})", hex(menu), classOf(game, menu)));
            const Address session = eft::readPointer(game, menu + off::MainMenuShowOperation::Session, mem::Freshness::Fresh);
            const Address menuProfile = eft::readPointer(game, menu + off::MainMenuShowOperation::Profile, mem::Freshness::Fresh);
            r.info(std::format("MainMenuShowOperation._session {} ({}), _profile {}", hex(session),
                               session ? classOf(game, session) : "-", hex(menuProfile)));
            if (session && game.managed.isInstanceOf(session, "EFT.ClientBackendSession")) {
                const Address sp = eft::readPointer(game, session + off::ClientBackendSession::Profile, mem::Freshness::Fresh);
                const auto all = game.managed.readArray<Address>(
                    eft::readPointer(game, session + off::ClientBackendSession::AllProfiles, mem::Freshness::Fresh), 16);
                r.info(std::format("ClientBackendSession._profile {}, AllProfiles: {}", hex(sp),
                                   all ? std::to_string(all->size()) : "unreadable"));
                addProfile("session (ClientBackendSession._profile)", sp);
                if (all)
                    for (std::size_t i = 0; i < all->size(); ++i) addProfile(std::format("session AllProfiles[{}]", i), (*all)[i]);
            } else if (session) {
                r.info("session isn't an EFT.ClientBackendSession: " + game.managed.describeAncestry(*game.managed.klassOf(session)));
            }
            addProfile("menu (MainMenuShowOperation._profile)", menuProfile);
        }
        // The direct path (literals; works in a raid and in the menu).
        const Address backEnd = eft::readPointer(game, application + off::ClientApplication::ClientBackEnd, mem::Freshness::Fresh);
        const Address direct = backEnd ? eft::readPointer(game, backEnd + off::ClientBackend::Session, mem::Freshness::Fresh) : 0;
        if (direct && game.managed.isInstanceOf(direct, "EFT.ClientBackendSession"))
            r.ok(std::format("TarkovApplication.ClientBackEnd ({}) → Session = {} ({})", classOf(game, backEnd), hex(direct),
                             classOf(game, direct)));
        else
            r.fail(std::format("TarkovApplication.ClientBackEnd {} → Session {} isn't a ClientBackendSession", hex(backEnd),
                               hex(direct)),
                   "literals ClientApplication.ClientBackEnd, ClientBackend.Session (see the field search below)");

        // Paths to the session that don't go through _menuOperation (gone in a raid), to re-find the
        // literals above after a game update.
        std::vector<Address> seen{application};
        std::vector<PathHit> hits;
        const auto s0 = std::chrono::steady_clock::now();
        searchFields(game, application, "EFT.ClientBackendSession", 3, "", seen, hits);
        const auto searchMs =
            std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - s0).count();
        if (hits.empty()) {
            r.fail(std::format("no ClientBackendSession within 3 pointer hops of TarkovApplication ({} objects, {} ms)",
                               seen.size(), searchMs));
        } else {
            r.ok(std::format("{} path(s) from TarkovApplication to a ClientBackendSession ({} objects, {} ms):", hits.size(),
                             seen.size(), searchMs));
            for (const auto& h : hits) r.info(std::format("  {} = {}", h.path, hex(h.object)));
            const Address session = hits.front().object;
            addProfile("session via field path", eft::readPointer(game, session + off::ClientBackendSession::Profile,
                                                                  mem::Freshness::Fresh));
        }
    }

    if (profiles.empty()) {
        r.fail("no profile to probe");
        return;
    }
    for (const auto& [who, p] : profiles) probeProfile(r, game, who, p);

    // What the backend's Stash subsystem publishes (the `stash` message): in a raid through the local
    // player's session; outside one (where the subsystem doesn't run) through the application.
    const Address sessionProfile = localPlayer ? playerSession : found ? eft::Stash::sessionProfile(game, *found) : 0;
    const auto contents = sessionProfile ? eft::Stash::readContents(game, sessionProfile) : std::nullopt;
    if (!contents) {
        r.fail("Stash subsystem: session profile or its stash unreadable",
               localPlayer ? "ClientPlayer.Session; ClientBackendSession.Profile; Inventory.Stash"
                           : "literals ClientApplication.ClientBackEnd, ClientBackend.Session; ClientBackendSession.Profile; Inventory.Stash");
    } else {
        std::int64_t units = 0, fir = 0;
        for (const auto& o : contents->stash) units += o.count, fir += o.fir;
        r.ok(std::format("Stash subsystem: profile {}: {} templates in the stash ({} units, {} FIR), {} in the equipment{}{}",
                         contents->profileId, contents->stash.size(), units, fir, contents->equipment.size(),
                         contents->truncated ? " — TRUNCATED" : "",
                         contents->unreadable ? std::format(" — {} failed reads", contents->unreadable) : ""));
    }
}

}  // namespace

int runDiagnose(mem::Target& target, int timeoutSeconds, std::FILE* out, const std::atomic<bool>* stop) {
    Report r(out);
    r.section("Attach");
    const auto start = Clock::now();
    while (target.poll() != mem::Target::State::Attached) {
        if (stop && stop->load()) {
            r.fail("interrupted while waiting for the game");
            return 1;
        }
        if (Clock::now() - start > std::chrono::seconds(timeoutSeconds)) {
            r.fail(std::format("not attached after {} s (state: {})", timeoutSeconds, mem::stateName(target.state())),
                   "is the game running? process/module names in game/eft/Names.hpp");
            return 1;
        }
        for (int i = 0; i < 5 && !(stop && stop->load()); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    r.ok(std::format("attached to {} (pid {})", target.processName(), target.pid().value_or(0)));
    for (const auto& [name, info] : target.modules()) r.info(std::format("{} at {} ({:#x} bytes)", name, hex(info.base), info.size));
    for (const auto& c : eft::checkBuild(target)) {
        using R = eft::ModuleBuildCheck::Result;
        const auto loaded = std::format("timestamp {:#x}, size {:#x}", c.loadedTimestamp, c.loadedSize);
        switch (c.result) {
        case R::Match: r.ok(c.module + " matches the offsets' build"); break;
        case R::Mismatch: r.info(c.module + " differs from the offsets' build (" + loaded + ")"); break;
        case R::NotRecorded: r.info(c.module + ": no fingerprint recorded; loaded " + loaded); break;
        case R::Unreadable: r.fail("can't read " + c.module + "'s PE header", "memory access / module base"); break;
        }
    }

    const auto game = eft::Game::fromTarget(target);
    checkIl2Cpp(r, game);
    checkUnity(r, game);
    const auto raid = checkRaid(r, game);
    if (raid) {
        auto session = std::make_shared<eft::RaidSession>(
            eft::RaidSession{.id = 1, .game = game, .start = *raid, .startedAt = Clock::now()});
        checkPlayers(r, session);
        checkSkeleton(r, session);
        checkExfils(r, session);
        checkExplosives(r, session);
        checkVehicles(r, session);
        checkLoot(r, session);
        checkQuests(r, session);
        checkCamera(r, session);
        checkStash(r, game, raid->localPlayer);
    } else {
        r.info("skipping players, exfils, explosives, vehicles, loot, quests and camera: they need a raid");
        checkStash(r, game, 0);
    }

    r.section("Summary");
    if (r.failures() == 0 && raid) r.ok("everything produced data");
    else r.info(std::format("{} failed check(s); see the 'check:' hints above", r.failures()));
    return r.failures() == 0 && raid ? 0 : 1;
}

}  // namespace radar::diagnose
