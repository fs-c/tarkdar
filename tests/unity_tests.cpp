#include "TestMemory.hpp"

#include "core/unity/Scene.hpp"
#include "core/unity/Transforms.hpp"

#include <doctest/doctest.h>

#include <cmath>
#include <numbers>

using namespace radar;
using radar::test::Heap;
using radar::test::kIl2Cpp;
using radar::test::kUnity;
using mem::Address;
using math::Quat;
using math::Vec3;

namespace {
constexpr mem::Pid kPid = 9;

Quat axisAngle(Vec3 axis, float degrees) {
    const float half = degrees * std::numbers::pi_v<float> / 360.0f;
    const float s = std::sin(half);
    return {axis.x * s, axis.y * s, axis.z * s, std::cos(half)};
}

bool near(Vec3 a, Vec3 b, float eps = 1e-4f) {
    return std::fabs(a.x - b.x) < eps && std::fabs(a.y - b.y) < eps && std::fabs(a.z - b.z) < eps;
}

unity::TrsX trs(Vec3 t, Quat q = {}, Vec3 s = {1, 1, 1}) { return {t, 0, q, s, 0}; }
}  // namespace

#define SETUP                         \
    mem::FakeBackend fake;            \
    REQUIRE(fake.open());             \
    Heap heap(fake, kPid);            \
    mem::MemoryView view(fake, kPid); \
    il2cpp::Managed managed(view, kIl2Cpp)

TEST_CASE("quaternion rotation matches the expected handedness") {
    // 90° about +Y maps +X to -Z (the standard rotation formula, as Unity uses).
    CHECK(near(math::rotate(axisAngle({0, 1, 0}, 90), {1, 0, 0}), {0, 0, -1}));
    // Composition: rotating by a then b equals rotating by (b * a).
    const Quat a = axisAngle({0, 1, 0}, 90), b = axisAngle({1, 0, 0}, 90);
    CHECK(near(math::rotate(b * a, {1, 0, 0}), math::rotate(b, math::rotate(a, {1, 0, 0}))));
}

TEST_CASE("Transforms::compose applies scale, rotation and translation of each ancestor") {
    // root (slot 0): at (10,0,0), rotated 90° about Y, scale 2
    // child (slot 1): local (1,0,0)
    const std::vector<unity::TrsX> local{trs({10, 0, 0}, axisAngle({0, 1, 0}, 90), {2, 2, 2}), trs({1, 0, 0})};
    const std::vector<std::int32_t> parents{-1, 0};
    const auto pose = unity::Transforms::compose(1, local, parents);
    REQUIRE(pose);
    CHECK(near(pose->position, {10, 0, -2}));  // (1,0,0) * 2 → rotate → (0,0,-2) → + (10,0,0)

    SUBCASE("a parent at a higher index is followed; cycles and out-of-range parents are rejected") {
        const std::vector<unity::TrsX> swapped{local[1], local[0]};  // child in slot 0, root in slot 1
        const auto p = unity::Transforms::compose(0, swapped, std::vector<std::int32_t>{1, -1});
        REQUIRE(p);
        CHECK(near(p->position, {10, 0, -2}));
        CHECK_FALSE(unity::Transforms::compose(0, local, std::vector<std::int32_t>{1, 0}));  // cycle
        CHECK_FALSE(unity::Transforms::compose(0, local, std::vector<std::int32_t>{5, -1}));  // out of range
    }
    SUBCASE("origin (zero-filled data) is rejected") {
        const std::vector<unity::TrsX> zeros(2, unity::TrsX{});
        CHECK_FALSE(unity::Transforms::compose(1, zeros, parents));
    }
}

namespace {
// Builds a native TransformHierarchy with the given slots; returns native transforms per slot.
std::vector<Address> makeHierarchy(Heap& heap, const std::vector<unity::TrsX>& local,
                                   const std::vector<std::int32_t>& parents) {
    const Address hierarchy = heap.alloc(0x100);
    const Address trsArray = heap.alloc(local.size() * sizeof(unity::TrsX));
    const Address parentArray = heap.alloc(parents.size() * 4);
    heap.putBytes(trsArray, local.data(), local.size() * sizeof(unity::TrsX));
    heap.putBytes(parentArray, parents.data(), parents.size() * 4);
    heap.put<Address>(hierarchy + kUnity.hierarchyLocalTransforms, trsArray);
    heap.put<Address>(hierarchy + kUnity.hierarchyParentIndices, parentArray);
    std::vector<Address> transforms;
    for (std::size_t i = 0; i < local.size(); ++i) {
        const Address t = heap.alloc(0x100);
        heap.put<Address>(t + kUnity.transformHierarchy, hierarchy);
        heap.put<std::int32_t>(t + kUnity.transformIndex, static_cast<std::int32_t>(i));
        transforms.push_back(t);
    }
    return transforms;
}
}  // namespace

TEST_CASE("Transforms::worldPoses reads hierarchies in bulk") {
    SETUP;
    unity::Transforms transforms(view, kUnity);
    const auto skeleton = makeHierarchy(
        heap, {trs({100, 5, 50}), trs({0, 1, 0}), trs({0, 0, 2}, axisAngle({0, 1, 0}, 180))}, {-1, 0, 1});
    const auto other = makeHierarchy(heap, {trs({-3, 0, 7})}, {-1});

    const std::vector<Address> query{skeleton[2], other[0], skeleton[1], 0x12345};
    const auto poses = transforms.worldPoses(query);
    REQUIRE(poses.size() == 4);
    REQUIRE(poses[0]);
    CHECK(near(poses[0]->position, {100, 6, 52}));
    CHECK(near(math::rotate(poses[0]->rotation, {0, 0, 1}), {0, 0, -1}));  // facing turned around
    REQUIRE(poses[1]);
    CHECK(near(poses[1]->position, {-3, 0, 7}));
    REQUIRE(poses[2]);
    CHECK(near(poses[2]->position, {100, 6, 50}));
    CHECK_FALSE(poses[3]);

    SUBCASE("resolveNative accepts managed or native transforms") {
        const Address managedTransform = heap.alloc(0x40);
        heap.put<Address>(managedTransform + kIl2Cpp.unityObjectCachedPtr, skeleton[1]);
        CHECK(transforms.resolveNative(managedTransform, managed) == skeleton[1]);
        CHECK(transforms.resolveNative(skeleton[1], managed) == skeleton[1]);
        CHECK_FALSE(transforms.resolveNative(heap.alloc(0x100), managed));
    }
}

TEST_CASE("Transforms::worldPoses falls back to the chain walk when a parent lies beyond the bulk prefix") {
    SETUP;
    unity::Transforms transforms(view, kUnity);
    // Slot 0's parent is slot 2: the bulk read of [0, 0] misses it, the chain walk finds it.
    const auto slots = makeHierarchy(heap, {trs({1, 0, 0}), trs({9, 9, 9}), trs({100, 0, 0})}, {2, -1, -1});
    const auto pose = transforms.worldPose(slots[0]);
    REQUIRE(pose);
    CHECK(near(pose->position, {101, 0, 0}));
}

TEST_CASE("Transforms::worldPoses walks the parent chain for large hierarchies") {
    SETUP;
    unity::Transforms transforms(view, kUnity);
    // Slots 0 → 3000 → 5000 (sparse; only the chain is populated).
    const Address hierarchy = heap.alloc(0x100);
    const Address trsArray = 0x2'0000'0000, parentArray = 0x3'0000'0000;
    heap.put<Address>(hierarchy + kUnity.hierarchyLocalTransforms, trsArray);
    heap.put<Address>(hierarchy + kUnity.hierarchyParentIndices, parentArray);
    heap.put(trsArray + 0 * sizeof(unity::TrsX), trs({1, 2, 3}));
    heap.put(trsArray + 3000 * sizeof(unity::TrsX), trs({10, 0, 0}));
    heap.put(trsArray + 5000 * sizeof(unity::TrsX), trs({0, 0, 100}));
    heap.put<std::int32_t>(parentArray + 0 * 4, -1);
    heap.put<std::int32_t>(parentArray + 3000 * 4, 0);
    heap.put<std::int32_t>(parentArray + 5000 * 4, 3000);
    const Address t = heap.alloc(0x100);
    heap.put<Address>(t + kUnity.transformHierarchy, hierarchy);
    heap.put<std::int32_t>(t + kUnity.transformIndex, 5000);

    const auto pose = transforms.worldPose(t);
    REQUIRE(pose);
    CHECK(near(pose->position, {11, 2, 103}));
}

namespace {
struct FakeGom {
    Address gom;
    std::vector<Address> nodes;
    std::vector<Address> objects;
};

// Builds a GOM with a linked list of named GameObjects.
FakeGom makeGom(Heap& heap, const std::vector<std::string>& names) {
    FakeGom g{heap.alloc(0x40), {}, {}};
    for (const auto& name : names) {
        const Address go = heap.alloc(0x100);
        heap.put<Address>(go + kUnity.gameObjectName, heap.cString(name));
        g.objects.push_back(go);
        const Address node = heap.alloc(0x18);
        heap.put<Address>(node + kUnity.listNodeObject, go);
        g.nodes.push_back(node);
    }
    for (std::size_t i = 0; i + 1 < g.nodes.size(); ++i) heap.put<Address>(g.nodes[i] + kUnity.listNodeNext, g.nodes[i + 1]);
    heap.put<Address>(g.gom + kUnity.gomActiveNodes, g.nodes.front());
    heap.put<Address>(g.gom + kUnity.gomLastActiveNode, g.nodes.back());
    return g;
}
}  // namespace

TEST_CASE("Scene walks the active object list") {
    SETUP;
    unity::Scene scene(view, kUnity);
    const auto g = makeGom(heap, {"Main Camera", "GameWorld", "Terrain", "gameworld"});

    const auto walk = scene.activeObjects(g.gom);
    CHECK(walk.end == unity::Scene::Walk::End::ReachedTail);
    CHECK(walk.objects == g.objects);

    const auto found = scene.findByName(g.gom, "GameWorld");
    REQUIRE(found.size() == 2);  // case-insensitive
    CHECK(found[0].native == g.objects[1]);
    CHECK(found[1].name == "gameworld");

    SUBCASE("cycle is detected") {
        heap.put<Address>(g.gom + kUnity.gomLastActiveNode, 0x9999'0000);  // tail never reached
        heap.put<Address>(g.nodes.back() + kUnity.listNodeNext, g.nodes[1]);
        const auto w = scene.activeObjects(g.gom);
        CHECK(w.end == unity::Scene::Walk::End::Cycle);
        CHECK(w.objects.size() == 4);
    }
    SUBCASE("cap is respected") {
        const auto w = scene.activeObjects(g.gom, 2);
        CHECK(w.end == unity::Scene::Walk::End::Cap);
        CHECK(w.objects.size() == 2);
    }
    SUBCASE("bad header") {
        CHECK(scene.activeObjects(heap.alloc(0x40)).end == unity::Scene::Walk::End::BadHeader);
    }
}

TEST_CASE("Scene components and managed component lookup") {
    SETUP;
    unity::Scene scene(view, kUnity);
    const Address behaviour = heap.klass("MonoBehaviour", "UnityEngine");
    const Address gameWorldClass = heap.klass("GameWorld", "EFT", behaviour);
    const Address clientWorldClass = heap.klass("ClientLocalGameWorld", "EFT", gameWorldClass);
    const Address otherClass = heap.klass("Something", "EFT", behaviour);

    const Address go = heap.alloc(0x100);
    const Address transform = heap.alloc(0x100);
    const Address otherComp = heap.alloc(0x100), worldComp = heap.alloc(0x100);
    const Address otherObj = heap.object(otherClass), worldObj = heap.object(clientWorldClass);
    heap.put<Address>(otherComp + kUnity.componentManagedObject, otherObj);
    heap.put<Address>(worldComp + kUnity.componentManagedObject, worldObj);
    heap.put<Address>(worldComp + kUnity.componentGameObject, go);

    // Component entries: {typeInfo, component}; Transform first, the GameWorld component third.
    const Address entries = heap.alloc(3 * kUnity.componentEntryStride);
    const Address comps[] = {transform, otherComp, worldComp};
    for (int i = 0; i < 3; ++i) heap.put<Address>(entries + i * kUnity.componentEntryStride + kUnity.componentEntryComponent, comps[i]);
    heap.put<Address>(go + kUnity.gameObjectComponents, entries);
    heap.put<std::uint64_t>(go + kUnity.gameObjectComponentCount, 3);

    CHECK(scene.components(go) == std::vector<Address>{transform, otherComp, worldComp});
    CHECK(scene.transform(go) == transform);
    CHECK(scene.gameObjectOf(worldComp) == go);
    // Found by base class, regardless of its index in the component array.
    CHECK(scene.findManagedComponent(go, "EFT.GameWorld", managed) == worldObj);
    CHECK_FALSE(scene.findManagedComponent(go, "Player", managed));

    heap.put<std::uint64_t>(go + kUnity.gameObjectComponentCount, 100000);
    CHECK(scene.components(go).empty());
}
