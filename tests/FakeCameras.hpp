#pragma once

// Cameras and the local player's weapon on top of FakeWorld: entries in Unity's camera list with
// matrices / fov / components, a ProceduralWeaponAnimation with sights, and an OpticCameraManager.
// Assumes FakeWorld::newWorld has run (setWeapon hangs the weapon on the local player).

#include "FakeWorld.hpp"
#include "TestMath.hpp"

namespace radar::test {

// A camera in Unity's camera list.
struct FakeCamera {
    Address native = 0;
    Address gameObject = 0;
};

// Writes the camera's matrices (looking along +z from `position`), fov and aspect.
inline void moveCamera(FakeWorld& world, Address camera, math::Vec3 position, float fov = 75.0f, float aspect = 16.0f / 9.0f) {
    const auto view = viewAt(position);
    world.heap.put(camera + eft::kCameraLayout.worldToCamera, view.m);
    world.heap.put(camera + eft::kCameraLayout.viewProjection, multiply(perspective(fov, aspect), view).m);
    world.heap.put(camera + eft::kCameraLayout.fieldOfView, fov);
    world.heap.put(camera + eft::kCameraLayout.aspect, aspect);
}

// The camera's GameObject components: [Transform, the camera, managed components...].
inline void setCameraComponents(FakeWorld& world, const FakeCamera& c, const std::vector<Address>& managed) {
    std::vector<Address> natives{world.heap.alloc(0x100), c.native};
    for (const Address m : managed) {
        const Address component = world.heap.alloc(0x100);
        world.heap.setManaged(component, m);
        natives.push_back(component);
    }
    const Address entries = world.heap.alloc(natives.size() * kUnity.componentEntryStride);
    for (std::size_t i = 0; i < natives.size(); ++i)
        world.heap.put<Address>(entries + i * kUnity.componentEntryStride + kUnity.componentEntryComponent, natives[i]);
    world.heap.put<Address>(c.gameObject + kUnity.gameObjectComponents, entries);
    world.heap.put<std::uint64_t>(c.gameObject + kUnity.gameObjectComponentCount, natives.size());
}

// Adds a camera to Unity's camera list: its GameObject (named `name`), matrices, fov and aspect.
inline FakeCamera addCamera(FakeWorld& world, std::string_view name, math::Vec3 position, float fov = 75.0f, float aspect = 16.0f / 9.0f) {
    FakeCamera c;
    c.native = world.heap.alloc(0x600);
    c.gameObject = world.heap.alloc(0x100);
    world.heap.put<Address>(c.gameObject + kUnity.gameObjectName, world.heap.cString(name));
    world.heap.put<Address>(c.native + kUnity.componentGameObject, c.gameObject);
    setCameraComponents(world, c, {});
    moveCamera(world, c.native, position, fov, aspect);
    world.cameras.push_back(c.native);
    const Address container = world.heap.alloc(0x20);
    const Address items = world.heap.alloc(8 * world.cameras.size());
    world.heap.putBytes(items, world.cameras.data(), 8 * world.cameras.size());
    world.heap.put<Address>(container + eft::kCameraLayout.listItems, items);
    world.heap.put<std::uint32_t>(container + eft::kCameraLayout.listCount, static_cast<std::uint32_t>(world.cameras.size()));
    world.heap.put<Address>(FakeWorld::kUnityPlayer + off::unity_rva::allCameras, container);
    return c;
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

inline FakeWeapon setWeapon(FakeWorld& world, bool aiming, const std::vector<FakeSight>& sights) {
    FakeWeapon w;
    w.pwa = world.heap.alloc(0x400);
    world.heap.put<Address>(world.localPlayer + off::Player::ProceduralWeaponAnimation, w.pwa);
    world.heap.put<std::uint8_t>(w.pwa + off::ProceduralWeaponAnimation::IsAiming, aiming ? 1 : 0);
    for (const auto& s : sights) {
        const Address bone = world.heap.alloc(0x40), mod = world.heap.alloc(0x80), tmpl = world.heap.alloc(0x400);
        const Address transform = world.heap.alloc(0x40), native = world.heap.alloc(0x100);
        world.heap.put<Address>(transform + kIl2Cpp.unityObjectCachedPtr, native);
        world.heap.put<Address>(bone + off::SightNBone::Mod, mod);
        world.heap.put<Address>(bone + off::SightNBone::Bone, transform);
        world.heap.put<std::int32_t>(mod + off::SightComponent::SelectedScope, s.scope);
        world.heap.put<float>(mod + off::SightComponent::ScopeZoomValue, s.scopeZoomValue);
        std::vector<std::int32_t> modes(s.zooms.size(), 0);
        if (s.scope >= 0 && static_cast<std::size_t>(s.scope) < modes.size()) modes[static_cast<std::size_t>(s.scope)] = s.mode;
        world.heap.put<Address>(mod + off::SightComponent::ScopesSelectedModes, world.heap.array(modes));
        std::vector<Address> scopes;
        for (const auto& z : s.zooms) scopes.push_back(world.heap.array(z));
        world.heap.put<Address>(tmpl + off::SightModTemplate::Zooms, world.heap.array(scopes));
        world.heap.put<Address>(mod + off::SightComponent::Template, tmpl);
        w.sightBones.push_back(bone);
        w.boneNatives.push_back(native);
    }
    world.heap.put<Address>(w.pwa + off::ProceduralWeaponAnimation::Optics, world.heap.list(w.sightBones));
    return w;
}
inline void setAiming(FakeWorld& world, const FakeWeapon& w, bool aiming) {
    world.heap.put<std::uint8_t>(w.pwa + off::ProceduralWeaponAnimation::IsAiming, aiming ? 1 : 0);
}
// An OpticCameraManagerRs, reached through the CameraManager._instance singleton (a CameraManagerRs),
// whose Camera is `optic` and whose CurrentOpticSight looks through the sight with this index (-1: none).
inline Address addOpticCameraManager(FakeWorld& world, const FakeCamera& optic, const FakeWeapon& w, int currentSight) {
    const Address manager = world.heap.object(world.heap.klass("OpticCameraManagerRs", "EFT.CameraControl"), 0x100);
    const Address cameraManager = world.heap.object(world.heap.klass("CameraManagerRs", "EFT.CameraControl"), 0x100);
    world.heap.put<Address>(cameraManager + off::CameraManagerRs::OpticCameraManager, manager);
    const Address statics = world.addStatics(off::CameraManager::TypeIndex, "CameraManager", "EFT.CameraControl");
    world.heap.put<Address>(statics + off::CameraManager::Instance, cameraManager);
    const Address managedCamera = world.heap.alloc(0x40);
    world.heap.put<Address>(managedCamera + kIl2Cpp.unityObjectCachedPtr, optic.native);
    world.heap.put<Address>(manager + off::OpticCameraManager::Camera, managedCamera);
    if (currentSight >= 0) {
        const Address sight = world.heap.alloc(0x80), scope = world.heap.alloc(0x40);
        world.heap.put<Address>(scope + kIl2Cpp.unityObjectCachedPtr, w.boneNatives.at(static_cast<std::size_t>(currentSight)));
        world.heap.put<Address>(sight + off::OpticSight::ScopeTransform, scope);
        world.heap.put<Address>(manager + off::OpticCameraManager::CurrentOpticSight, sight);
    }
    return manager;
}

}  // namespace radar::test
