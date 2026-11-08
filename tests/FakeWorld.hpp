#pragma once

#include "TestMemory.hpp"

#include "core/mem/Target.hpp"
#include <doctest/doctest.h>
#include "game/eft/Game.hpp"
#include "game/eft/Layouts.hpp"
#include "game/eft/Names.hpp"
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
        Address movement = 0;
        Address trs = 0;  // skeleton hierarchy TrsX array: slot 0 = Base, 1 = left foot, 2 = right foot
    };

    // A full EFT.Player (ClientPlayer) with profile, side, movement context and a skeleton whose Base
    // bone is at `position` and whose feet are 0.15 m to either side.
    Address newPlayer(int side = 4, std::optional<math::Vec3> position = std::nullopt) {
        const math::Vec3 pos = position.value_or(math::Vec3{100.0f + 3.0f * float(fakePlayers.size()), 5, 200});
        FakePlayer fp;
        fp.instance = heap.object(clientPlayerClass, 0x1000);
        const Address profile = heap.alloc(0x200), info = heap.alloc(0x100);
        heap.put<Address>(fp.instance + off::Player::Profile, profile);
        heap.put<Address>(profile + off::Profile::Info, info);
        heap.put<std::int32_t>(info + off::PlayerInfo::Side, side);
        fp.movement = heap.alloc(0x200);
        heap.put<Address>(fp.instance + off::Player::MovementContext, fp.movement);

        // Skeleton: body → root joint → List<Transform> (managed) → native transforms in one hierarchy.
        const Address body = heap.alloc(0x100), root = heap.alloc(0x100);
        heap.put<Address>(fp.instance + off::Player::_playerBody, body);
        heap.put<Address>(body + off::PlayerBody::SkeletonRootJoint, root);
        const Address hierarchy = heap.alloc(0x100);
        fp.trs = heap.alloc(3 * sizeof(unity::TrsX));
        const Address parents = heap.alloc(3 * 4);
        heap.put<Address>(hierarchy + kUnity.hierarchyLocalTransforms, fp.trs);
        heap.put<Address>(hierarchy + kUnity.hierarchyParentIndices, parents);
        const std::int32_t parentIdx[] = {-1, 0, 0};
        heap.putBytes(parents, parentIdx, sizeof(parentIdx));
        heap.put(fp.trs + 1 * sizeof(unity::TrsX), unity::TrsX{{-0.15f, 0, 0}, 0, {}, {1, 1, 1}, 0});
        heap.put(fp.trs + 2 * sizeof(unity::TrsX), unity::TrsX{{0.15f, 0, 0}, 0, {}, {1, 1, 1}, 0});
        std::vector<Address> bones(24, 0);
        const std::size_t boneIndex[] = {0, 18, 23};
        for (std::int32_t slot = 0; slot < 3; ++slot) {
            const Address native = heap.alloc(0x100), managedTransform = heap.alloc(0x40);
            heap.put<Address>(native + kUnity.transformHierarchy, hierarchy);
            heap.put<std::int32_t>(native + kUnity.transformIndex, slot);
            heap.put<Address>(managedTransform + kIl2Cpp.unityObjectCachedPtr, native);
            bones[boneIndex[slot]] = managedTransform;
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
        heap.putBytes(fakePlayers.at(player).movement + off::MovementContext::_rotation, v, sizeof(v));
    }
    void kill(Address player) { heap.put<Address>(player + off::Player::Corpse, heap.alloc(0x40)); }
    void setRosterList(const std::vector<Address>& list) {
        heap.put<Address>(world + off::ClientLocalGameWorld::RegisteredPlayers, heap.list(list, 64));
    }

    // Roster of `count` players; the first is the local player.
    void setRoster(int count) {
        std::vector<Address> players;
        for (int i = 0; i < count; ++i) players.push_back(i == 0 ? localPlayer : newPlayer());
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
    Address typeInfoTable = 0, ownerClass = 0, ownerStatics = 0;
    Address gom = 0, gameWorldObject = 0;
    Address world = 0, localPlayer = 0;
};

}  // namespace radar::test
