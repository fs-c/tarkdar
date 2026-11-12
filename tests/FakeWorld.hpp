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
    std::vector<Address> roster;  // as last set by setRoster / setRosterList
    Address typeInfoTable = 0, ownerClass = 0, ownerStatics = 0;
    Address gom = 0, gameWorldObject = 0;
    Address world = 0, localPlayer = 0;
};

}  // namespace radar::test
