#pragma once

#include "TestMemory.hpp"

#include "core/mem/Target.hpp"
#include <doctest/doctest.h>
#include "game/eft/Game.hpp"
#include "game/eft/Layouts.hpp"
#include "game/eft/Names.hpp"
#include "game/eft/players/Skeleton.hpp"
#include "core/unity/Transforms.hpp"

#include <eft_offsets.hpp>

#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace radar::test {

// A fake EscapeFromTarkov process with just enough structure for raid discovery: the IL2CPP
// type-info table with GamePlayerOwner statics, a local player, a GameWorld with location and
// roster, and a GameObjectManager listing a "GameWorld" GameObject.
class FakeWorld {
public:
    static constexpr mem::Pid kPid = 1234;
    static constexpr Address kGameAssembly = 0x7FF8'0000'0000;
    static constexpr Address kUnityPlayer = 0x7FF9'0000'0000;

    FakeWorld() : heap(fake, kPid) {
        // The generic test heap lays out managed objects with test::kIl2Cpp; the game must agree.
        static_assert(sizeof(il2cpp::Layout) == sizeof(kIl2Cpp));
        REQUIRE(std::memcmp(&eft::kIl2CppLayout, &kIl2Cpp, sizeof(kIl2Cpp)) == 0);
        REQUIRE(std::memcmp(&eft::kUnityLayout, &kUnity, sizeof(kUnity)) == 0);
        REQUIRE(fake.open());
        fake.addProcess(std::string(eft::kProcessName), kPid);
        fake.addModule(kPid, std::string(eft::kGameAssembly), {kGameAssembly, 0x1000'0000});
        fake.addModule(kPid, std::string(eft::kUnityPlayer), {kUnityPlayer, 0x1000'0000});

        const Address monoBehaviour = heap.klass("MonoBehaviour", "UnityEngine");
        gameWorldClass = heap.klass("GameWorld", "EFT", monoBehaviour);
        clientWorldClass = heap.klass("ClientLocalGameWorld", "EFT", gameWorldClass);
        playerClass = heap.klass("Player", "EFT", monoBehaviour);
        clientPlayerClass = heap.klass("ClientPlayer", "EFT", playerClass);
        observedClass = heap.klass("ObservedPlayerView", "EFT.NextObservedPlayer", monoBehaviour);

        // GamePlayerOwner statics via the type-info table.
        typeInfoTable = heap.alloc(8 * (off::GamePlayerOwner::TypeIndex + 16));
        heap.put<Address>(kGameAssembly + off::bootstrap::typeInfoTableRva, typeInfoTable);
        ownerClass = heap.klass("GamePlayerOwner", "EFT");
        ownerStatics = heap.alloc(0x40);
        heap.put<Address>(ownerClass + kIl2Cpp.classStaticFields, ownerStatics);
        heap.put<Address>(typeInfoTable + static_cast<Address>(off::GamePlayerOwner::TypeIndex) * 8, ownerClass);

        // GameObjectManager with one "GameWorld" object. Its components: [Transform, GameWorld].
        gom = heap.alloc(0x40);
        heap.put<Address>(kUnityPlayer + off::unity_rva::gameObjectManager, gom);
        gameWorldObject = heap.alloc(0x100);
        heap.put<Address>(gameWorldObject + kUnity.gameObjectName, heap.cString("GameWorld"));
        const Address node = heap.alloc(0x18);
        heap.put<Address>(node + kUnity.listNodeObject, gameWorldObject);
        heap.put<Address>(gom + kUnity.gomActiveNodes, node);
        heap.put<Address>(gom + kUnity.gomLastActiveNode, node);
    }

    // Creates a new raid world (as each raid would) and makes it current everywhere.
    Address newWorld(std::u16string_view location, int players) {
        world = heap.object(clientWorldClass, 0x400);
        localPlayer = newPlayer(1);  // USEC
        heap.put<Address>(world + off::GameWorld::Location, heap.managedString(location));
        heap.put<Address>(world + off::ClientLocalGameWorld::MainPlayer, localPlayer);
        heap.put<Address>(localPlayer + off::Player::GameWorld, world);
        setMyPlayer(localPlayer);
        setRoster(players);

        const Address transform = heap.alloc(0x100), component = heap.alloc(0x100);
        heap.put<Address>(component + kUnity.componentManagedObject, world);
        const Address entries = heap.alloc(2 * kUnity.componentEntryStride);
        heap.put<Address>(entries + kUnity.componentEntryComponent, transform);
        heap.put<Address>(entries + kUnity.componentEntryStride + kUnity.componentEntryComponent, component);
        heap.put<Address>(gameWorldObject + kUnity.gameObjectComponents, entries);
        heap.put<std::uint64_t>(gameWorldObject + kUnity.gameObjectComponentCount, 2);
        return world;
    }

    struct FakePlayer {
        Address instance = 0;
        Address rotation = 0;     // Vector2 yaw/pitch
        Address corpseField = 0;  // non-null once dead
        Address trs = 0;  // skeleton hierarchy TrsX array, one slot per joint in Joint order (slot 0 = Base)
        // Per joint (Joint order): the bone's managed Transform and the native transform it points at.
        std::array<Address, eft::kJointCount> managed{}, native{};
    };

    // Joint offsets from Base in the fakes' skeletons (Joint order): a standing figure facing +z.
    static constexpr std::array<math::Vec3, eft::kJointCount> kFakeJointOffsets{{
        {0, 0, 0},         {-0.15f, 0, 0},    {0.15f, 0, 0},     {0, 0.95f, 0},     {0, 1.35f, 0},
        {0, 1.55f, 0},     {0, 1.7f, 0},      {-0.1f, 0.9f, 0},  {-0.12f, 0.5f, 0}, {0.1f, 0.9f, 0},
        {0.12f, 0.5f, 0},  {-0.2f, 1.45f, 0}, {-0.25f, 1.15f, 0}, {-0.27f, 0.9f, 0}, {0.2f, 1.45f, 0},
        {0.25f, 1.15f, 0}, {0.27f, 0.9f, 0},
    }};
    // Length of the bone list of skeletons created from now on; below the highest joint bone, only
    // the position bones resolve (if it's still above 23).
    std::size_t skeletonBones = 134;

    // A full EFT.Player (ClientPlayer) with profile, side, role (WildSpawnType; 1 = assault), movement
    // context and a skeleton whose Base bone is at `position` and whose feet are 0.15 m to either side.
    Address newPlayer(int side = 4, std::optional<math::Vec3> position = std::nullopt, int role = 1) {
        FakePlayer fp;
        fp.instance = heap.object(clientPlayerClass, 0x1000);
        const Address profile = heap.alloc(0x200), info = heap.alloc(0x100);
        heap.put<Address>(fp.instance + off::Player::Profile, profile);
        heap.put<Address>(profile + off::Profile::Info, info);
        heap.put<std::int32_t>(info + off::PlayerInfo::Side, side);
        const Address settings = heap.alloc(0x40);
        heap.put<Address>(info + off::PlayerInfo::Settings, settings);
        heap.put<std::int32_t>(settings + off::ProfileSettings::Role, role);
        const Address movement = heap.alloc(0x200);
        heap.put<Address>(fp.instance + off::Player::MovementContext, movement);
        fp.rotation = movement + off::MovementContext::_rotation;
        fp.corpseField = fp.instance + off::Player::Corpse;
        return addSkeleton(fp, fp.instance + off::Player::_playerBody, position);
    }

    // A network-replicated ObservedPlayerView: controller → health / movement → state context, side,
    // AI flag and voice on the view, and the same kind of skeleton as newPlayer.
    Address newObservedPlayer(int side = 4, bool ai = true, std::u16string_view voice = u"BossKilla",
                              std::optional<math::Vec3> position = std::nullopt) {
        FakePlayer fp;
        fp.instance = heap.object(observedClass, 0x200);
        const Address controller = heap.alloc(0x200), health = heap.alloc(0x100), movement = heap.alloc(0x100),
                      state = heap.alloc(0x200);
        heap.put<Address>(fp.instance + off::ObservedPlayerView::ObservedPlayerController, controller);
        heap.put<Address>(controller + off::ObservedPlayerController::HealthController, health);
        heap.put<Address>(controller + off::ObservedPlayerController::MovementController, movement);
        heap.put<Address>(movement + off::ObservedMovementController::ObservedPlayerStateContext, state);
        heap.put<std::uint8_t>(fp.instance + off::ObservedPlayerView::IsAI, ai ? 1 : 0);
        heap.put<std::int32_t>(fp.instance + off::ObservedPlayerView::Side, side);
        heap.put<Address>(fp.instance + off::ObservedPlayerView::Voice, heap.managedString(voice));
        fp.rotation = state + off::ObservedPlayerStateContext::Rotation;
        fp.corpseField = health + off::ObservedHealthController::PlayerCorpse;
        return addSkeleton(fp, fp.instance + off::ObservedPlayerView::PlayerBody, position);
    }

    // Nickname and group id of an observed player.
    void setObservedIdentity(Address instance, std::u16string_view nickname, std::u16string_view groupId) {
        heap.put<Address>(instance + off::ObservedPlayerView::NickName, heap.managedString(nickname));
        heap.put<Address>(instance + off::ObservedPlayerView::GroupId, heap.managedString(groupId));
    }

    // An observed player's AI data (class `aiClass`: StubAIData or AIData) → BotHostilityData._role.
    void setObservedRole(Address instance, int role, std::string_view aiClass = "StubAIData") {
        const bool stub = aiClass == "StubAIData";
        const Address aiData = heap.object(heap.klass(aiClass), 0x200);
        const Address hostility = heap.alloc(0x80);
        heap.put<Address>(aiData + (stub ? off::StubAIData::BotHostilityData : off::AIData::BotHostilityData), hostility);
        heap.put<std::int32_t>(hostility + off::BotHostilityData::Role, role);
        heap.put<Address>(instance + off::ObservedPlayerView::AIData, aiData);
    }

    Address addSkeleton(FakePlayer fp, Address bodyField, std::optional<math::Vec3> position) {
        const math::Vec3 pos = position.value_or(math::Vec3{100.0f + 3.0f * float(fakePlayers.size()), 5, 200});
        // Skeleton: body → root joint → List<Transform> (managed) → native transforms in one hierarchy.
        const Address body = heap.alloc(0x100), root = heap.alloc(0x100);
        heap.put<Address>(bodyField, body);
        heap.put<Address>(body + off::PlayerBody::SkeletonRootJoint, root);
        const Address hierarchy = heap.alloc(0x100);
        constexpr std::size_t n = eft::kJointCount;
        fp.trs = heap.alloc(n * sizeof(unity::TrsX));
        const Address parents = heap.alloc(n * 4);
        heap.put<Address>(hierarchy + kUnity.hierarchyLocalTransforms, fp.trs);
        heap.put<Address>(hierarchy + kUnity.hierarchyParentIndices, parents);
        std::vector<std::int32_t> parentIdx(n, 0);
        parentIdx[0] = -1;
        heap.putBytes(parents, parentIdx.data(), n * 4);
        for (std::size_t slot = 1; slot < n; ++slot)
            heap.put(fp.trs + slot * sizeof(unity::TrsX), unity::TrsX{kFakeJointOffsets[slot], 0, {}, {1, 1, 1}, 0});
        std::vector<Address> bones(skeletonBones, 0);
        for (std::size_t slot = 0; slot < n; ++slot) {
            const auto& src = eft::kJointSources[slot];
            if (src.bone >= bones.size()) continue;
            const Address native = heap.alloc(0x100), managedTransform = heap.alloc(0x40), object = heap.alloc(0x100);
            heap.put<Address>(native + kUnity.transformHierarchy, hierarchy);
            heap.put<std::int32_t>(native + kUnity.transformIndex, static_cast<std::int32_t>(slot));
            heap.put<Address>(native + kUnity.componentGameObject, object);
            heap.put<Address>(object + kUnity.gameObjectName, heap.cString(slot == 0 ? std::string(src.nameSuffix) : "Base Human" + std::string(src.nameSuffix)));
            heap.put<Address>(managedTransform + kIl2Cpp.unityObjectCachedPtr, native);
            bones[src.bone] = managedTransform;
            fp.managed[slot] = managedTransform;
            fp.native[slot] = native;
        }
        heap.put<Address>(root + off::Skeleton::Values, heap.list(bones));
        fakePlayers[fp.instance] = fp;
        movePlayer(fp.instance, pos);
        return fp.instance;
    }

    void movePlayer(Address player, math::Vec3 pos) {
        heap.put(fakePlayers.at(player).trs, unity::TrsX{pos, 0, {}, {1, 1, 1}, 0});
    }
    void setRotation(Address player, float yaw, float pitch) {
        const float v[2] = {yaw, pitch};
        heap.putBytes(fakePlayers.at(player).rotation, v, sizeof(v));
    }
    // ---- cameras ----
    // A camera at `position` looking along +z (Unity's world forward), with a perspective projection.
    struct FakeCamera {
        Address native = 0;
        Address gameObject = 0;
    };
    static math::Mat4 viewAt(math::Vec3 p) {
        // worldToCameraMatrix (OpenGL convention: the camera looks down its -z, so z is flipped).
        math::Mat4 v;
        auto set = [&](int r, int c, float x) { v.m[static_cast<std::size_t>(c * 4 + r)] = x; };
        set(0, 0, 1), set(1, 1, 1), set(2, 2, -1), set(3, 3, 1);
        set(0, 3, -p.x), set(1, 3, -p.y), set(2, 3, p.z);
        return v;
    }
    static math::Mat4 perspective(float fovDegrees, float aspect, float zNear = 0.05f, float zFar = 1000.0f) {
        math::Mat4 m;
        auto set = [&](int r, int c, float x) { m.m[static_cast<std::size_t>(c * 4 + r)] = x; };
        const float f = 1.0f / std::tan(fovDegrees * 3.14159265f / 360.0f);
        set(0, 0, f / aspect), set(1, 1, f), set(2, 2, (zFar + zNear) / (zNear - zFar));
        set(2, 3, 2 * zFar * zNear / (zNear - zFar)), set(3, 2, -1);
        return m;
    }
    static math::Mat4 multiply(const math::Mat4& a, const math::Mat4& b) {
        math::Mat4 out;
        for (int r = 0; r < 4; ++r)
            for (int c = 0; c < 4; ++c) {
                float sum = 0;
                for (int k = 0; k < 4; ++k) sum += a.at(r, k) * b.at(k, c);
                out.m[static_cast<std::size_t>(c * 4 + r)] = sum;
            }
        return out;
    }

    // Adds a camera to Unity's camera list: its GameObject (named `name`), matrices, fov and aspect.
    FakeCamera addCamera(std::string_view name, math::Vec3 position, float fov = 75.0f, float aspect = 16.0f / 9.0f) {
        FakeCamera c;
        c.native = heap.alloc(0x600);
        c.gameObject = heap.alloc(0x100);
        heap.put<Address>(c.gameObject + kUnity.gameObjectName, heap.cString(name));
        heap.put<Address>(c.native + kUnity.componentGameObject, c.gameObject);
        setCameraComponents(c, {});
        moveCamera(c.native, position, fov, aspect);
        cameras.push_back(c.native);
        const Address container = heap.alloc(0x20);
        const Address items = heap.alloc(8 * cameras.size());
        heap.putBytes(items, cameras.data(), 8 * cameras.size());
        heap.put<Address>(container + eft::kCameraLayout.listItems, items);
        heap.put<std::uint32_t>(container + eft::kCameraLayout.listCount, static_cast<std::uint32_t>(cameras.size()));
        heap.put<Address>(kUnityPlayer + off::unity_rva::allCameras, container);
        return c;
    }
    void moveCamera(Address camera, math::Vec3 position, float fov = 75.0f, float aspect = 16.0f / 9.0f) {
        const auto view = viewAt(position);
        heap.put(camera + eft::kCameraLayout.worldToCamera, view.m);
        heap.put(camera + eft::kCameraLayout.viewProjection, multiply(perspective(fov, aspect), view).m);
        heap.put(camera + eft::kCameraLayout.fieldOfView, fov);
        heap.put(camera + eft::kCameraLayout.aspect, aspect);
    }
    // The camera's GameObject components: [Transform, the camera, managed components...].
    void setCameraComponents(const FakeCamera& c, const std::vector<Address>& managed) {
        std::vector<Address> natives{heap.alloc(0x100), c.native};
        for (const Address m : managed) {
            const Address component = heap.alloc(0x100);
            heap.put<Address>(component + kUnity.componentManagedObject, m);
            natives.push_back(component);
        }
        const Address entries = heap.alloc(natives.size() * kUnity.componentEntryStride);
        for (std::size_t i = 0; i < natives.size(); ++i)
            heap.put<Address>(entries + i * kUnity.componentEntryStride + kUnity.componentEntryComponent, natives[i]);
        heap.put<Address>(c.gameObject + kUnity.gameObjectComponents, entries);
        heap.put<std::uint64_t>(c.gameObject + kUnity.gameObjectComponentCount, natives.size());
    }

    // The local player's weapon: ProceduralWeaponAnimation with aiming flag and sights. Each sight:
    // per-scope zoom modes, the selected scope and mode, and the live ScopeZoomValue.
    struct FakeSight {
        std::vector<std::vector<float>> zooms;
        int scope = 0;
        int mode = 0;
        float scopeZoomValue = 0;
    };
    struct FakeWeapon {
        Address pwa = 0;
        std::vector<Address> sightBones;  // SightNBone objects
        std::vector<Address> boneNatives; // their Bone transforms' native objects
    };
    FakeWeapon setWeapon(bool aiming, const std::vector<FakeSight>& sights) {
        FakeWeapon w;
        w.pwa = heap.alloc(0x400);
        heap.put<Address>(localPlayer + off::Player::ProceduralWeaponAnimation, w.pwa);
        heap.put<std::uint8_t>(w.pwa + off::ProceduralWeaponAnimation::IsAiming, aiming ? 1 : 0);
        for (const auto& s : sights) {
            const Address bone = heap.alloc(0x40), mod = heap.alloc(0x80), tmpl = heap.alloc(0x400);
            const Address transform = heap.alloc(0x40), native = heap.alloc(0x100);
            heap.put<Address>(transform + kIl2Cpp.unityObjectCachedPtr, native);
            heap.put<Address>(bone + off::SightNBone::Mod, mod);
            heap.put<Address>(bone + off::SightNBone::Bone, transform);
            heap.put<std::int32_t>(mod + off::SightComponent::SelectedScope, s.scope);
            heap.put<float>(mod + off::SightComponent::ScopeZoomValue, s.scopeZoomValue);
            std::vector<std::int32_t> modes(s.zooms.size(), 0);
            if (s.scope >= 0 && static_cast<std::size_t>(s.scope) < modes.size()) modes[static_cast<std::size_t>(s.scope)] = s.mode;
            heap.put<Address>(mod + off::SightComponent::ScopesSelectedModes, heap.array(modes));
            std::vector<Address> scopes;
            for (const auto& z : s.zooms) scopes.push_back(heap.array(z));
            heap.put<Address>(tmpl + off::SightModTemplate::Zooms, heap.array(scopes));
            heap.put<Address>(mod + off::SightComponent::Template, tmpl);
            w.sightBones.push_back(bone);
            w.boneNatives.push_back(native);
        }
        heap.put<Address>(w.pwa + off::ProceduralWeaponAnimation::Optics, heap.list(w.sightBones));
        return w;
    }
    void setAiming(const FakeWeapon& w, bool aiming) {
        heap.put<std::uint8_t>(w.pwa + off::ProceduralWeaponAnimation::IsAiming, aiming ? 1 : 0);
    }
    // An OpticCameraManager (component of `optic`'s GameObject) whose Camera is `optic` and whose
    // CurrentOpticSight looks through the sight with this index (-1: none).
    Address addOpticCameraManager(const FakeCamera& optic, const FakeWeapon& w, int currentSight) {
        const Address manager = heap.object(heap.klass("OpticCameraManager", "EFT.CameraControl"), 0x100);
        const Address managedCamera = heap.alloc(0x40);
        heap.put<Address>(managedCamera + kIl2Cpp.unityObjectCachedPtr, optic.native);
        heap.put<Address>(manager + off::OpticCameraManager::Camera, managedCamera);
        if (currentSight >= 0) {
            const Address sight = heap.alloc(0x80), scope = heap.alloc(0x40);
            heap.put<Address>(scope + kIl2Cpp.unityObjectCachedPtr, w.boneNatives.at(static_cast<std::size_t>(currentSight)));
            heap.put<Address>(sight + off::OpticSight::ScopeTransform, scope);
            heap.put<Address>(manager + off::OpticCameraManager::CurrentOpticSight, sight);
        }
        setCameraComponents(optic, {manager});
        return manager;
    }

    // Detaches (or re-attaches) a joint bone's managed Transform from its native transform, as for
    // a bone not set up yet.
    void setBoneAttached(Address player, eft::Joint joint, bool attached) {
        const auto& fp = fakePlayers.at(player);
        const auto j = static_cast<std::size_t>(joint);
        heap.put<Address>(fp.managed[j] + kIl2Cpp.unityObjectCachedPtr, attached ? fp.native[j] : 0);
    }
    void kill(Address player) { heap.put<Address>(fakePlayers.at(player).corpseField, heap.alloc(0x40)); }
    void setRosterList(const std::vector<Address>& list) {
        roster = list;
        heap.put<Address>(world + off::ClientLocalGameWorld::RegisteredPlayers, heap.list(list, 64));
    }
    [[nodiscard]] const std::vector<Address>& rosterPlayers() const { return roster; }

    // Roster of `count` players; the first is the local player.
    void setRoster(int count) {
        std::vector<Address> players;
        for (int i = 0; i < count; ++i) players.push_back(i == 0 ? localPlayer : newPlayer());
        roster = players;
        heap.put<Address>(world + off::ClientLocalGameWorld::RegisteredPlayers, heap.list(players, 8));
    }
    void setRosterCount(std::int32_t count) {
        const Address list = mem::MemoryView(fake, kPid).read<Address>(world + off::ClientLocalGameWorld::RegisteredPlayers);
        heap.put<std::int32_t>(list + kIl2Cpp.listSize, count);
    }
    void setMyPlayer(Address p) { heap.put<Address>(ownerStatics + off::GamePlayerOwner::MyPlayer, p); }
    void setLocation(std::u16string_view location) {
        heap.put<Address>(world + off::GameWorld::Location, heap.managedString(location));
    }

    eft::Game attachGame() {
        target = std::make_unique<mem::Target>(fake, std::string(eft::kProcessName),
                                               std::vector<std::string>{std::string(eft::kGameAssembly),
                                                                        std::string(eft::kUnityPlayer)});
        REQUIRE(target->poll() == mem::Target::State::Attached);
        return eft::Game::fromTarget(*target);
    }

    mem::FakeBackend fake;
    Heap heap;
    std::unique_ptr<mem::Target> target;
    Address gameWorldClass = 0, clientWorldClass = 0, playerClass = 0, clientPlayerClass = 0, observedClass = 0;
    std::map<Address, FakePlayer> fakePlayers;
    std::vector<Address> roster;   // as last set by setRoster / setRosterList
    std::vector<Address> cameras;  // Unity's camera list
    Address typeInfoTable = 0, ownerClass = 0, ownerStatics = 0;
    Address gom = 0, gameWorldObject = 0;
    Address world = 0, localPlayer = 0;
};

}  // namespace radar::test
