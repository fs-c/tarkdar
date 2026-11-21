#include "FakeWorld.hpp"

#include "core/unity/Camera.hpp"
#include "game/eft/camera/CameraTracker.hpp"
#include "game/eft/camera/Sights.hpp"
#include "server/Protocol.hpp"

#include <doctest/doctest.h>

using namespace radar;
using radar::test::FakeWorld;
using radar::test::near;
using math::Mat4;
using math::Vec3;
using mem::Address;
using sched::Clock;
using std::chrono::milliseconds;

namespace {


eft::SightZoomData zoomData(std::vector<std::vector<float>> zooms, int scope, int mode, float scopeZoomValue = 0) {
    return {.selectedScope = scope, .selectedMode = mode, .zooms = std::move(zooms), .scopeZoomValue = scopeZoomValue};
}

}  // namespace

TEST_CASE("camera matrices: validation and position") {
    const Mat4 view = FakeWorld::viewAt({10, 2, -5});
    const Mat4 vp = FakeWorld::multiply(FakeWorld::perspective(60, 1.5f), view);
    CHECK(unity::matrixLooksValid(view));
    CHECK(unity::viewProjectionLooksValid(vp));
    CHECK(unity::viewProjectionMatchesView(vp, view));
    REQUIRE(unity::cameraPosition(view));
    CHECK(near(*unity::cameraPosition(view), {10, 2, -5}));

    CHECK_FALSE(unity::matrixLooksValid(Mat4{}));  // zeroed memory
    Mat4 identity;
    for (int i = 0; i < 4; ++i) identity.m[static_cast<std::size_t>(i * 5)] = 1;
    CHECK(unity::matrixLooksValid(identity));
    CHECK_FALSE(unity::viewProjectionLooksValid(identity));  // affine: no perspective
    Mat4 garbage = vp;
    garbage.m[3] = 1e9f;
    CHECK_FALSE(unity::matrixLooksValid(garbage));
    // A view-projection from another camera orientation doesn't match this view.
    Mat4 turned = view;
    std::swap(turned.m[2], turned.m[0]), std::swap(turned.m[6], turned.m[4]), std::swap(turned.m[10], turned.m[8]);
    CHECK_FALSE(unity::viewProjectionMatchesView(FakeWorld::multiply(FakeWorld::perspective(60, 1.5f), turned), view));
}

TEST_CASE("Cameras lists and samples cameras") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    const auto fps = w.addCamera("FPS Camera", {1, 2, 3}, 70, 1.6f);
    const auto broken = w.addCamera("Broken", {0, 0, 0});
    w.heap.put(broken.native + eft::kCameraLayout.viewProjection, Mat4{}.m);

    const auto game = w.attachGame();
    const unity::Cameras cameras(game.mem, eft::kCameraLayout);
    const auto list = cameras.list(FakeWorld::kUnityPlayer + off::unity_rva::allCameras);
    REQUIRE(list.size() == 2);
    CHECK(list[0] == fps.native);
    const auto s = cameras.sample(fps.native);
    REQUIRE(s);
    CHECK(s->fieldOfView == doctest::Approx(70));
    CHECK(s->aspect == doctest::Approx(1.6f));
    REQUIRE(s->position);
    CHECK(near(*s->position, {1, 2, 3}));
    CHECK_FALSE(cameras.sample(broken.native));
    CHECK(cameras.list(0x1234).empty());
}

TEST_CASE("Cameras: the 64-bit count wins, and clip w is made positive in front") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    const auto a = w.addCamera("A", {0, 0, 0});
    w.addCamera("B", {0, 0, 0});
    const auto game = w.attachGame();
    const unity::Cameras cameras(game.mem, eft::kCameraLayout);
    const Address global = FakeWorld::kUnityPlayer + off::unity_rva::allCameras;
    const Address container = game.mem.read<Address>(global);
    // A u32 field that isn't the count (e.g. a memory label) next to a valid u64 count.
    w.heap.put<std::uint32_t>(container + eft::kCameraLayout.listCount, 7);
    w.heap.put<std::uint64_t>(container + eft::kCameraLayout.listCount64, 1);
    CHECK(cameras.list(global) == std::vector<Address>{a.native});

    // A view-projection stored negated: same picture, normalised back.
    const auto before = cameras.sample(a.native);
    REQUIRE(before);
    auto negated = before->viewProjection;
    for (float& e : negated.m) e = -e;
    w.heap.put(a.native + eft::kCameraLayout.viewProjection, negated.m);
    const auto after = cameras.sample(a.native);
    REQUIRE(after);
    CHECK(after->viewProjection == before->viewProjection);
}

TEST_CASE("resolveSight: fixed and variable scopes") {
    // Fixed 4× scope.
    auto s = eft::resolveSight(zoomData({{4}}, 0, 0));
    REQUIRE(s);
    CHECK(s->zoom == doctest::Approx(4));
    CHECK(s->magnified);
    // A 1×/4× switchable scope in its 1× mode: not magnified.
    s = eft::resolveSight(zoomData({{1, 4}}, 0, 0));
    REQUIRE(s);
    CHECK(s->zoom == doctest::Approx(1));
    CHECK_FALSE(s->magnified);
    CHECK(s->minZoom == doctest::Approx(1));
    CHECK(s->maxZoom == doctest::Approx(4));
    // A 1–8× variable scope: the live zoom from ScopeZoomValue (30° / 7.5° = 4×), clamped to the range.
    s = eft::resolveSight(zoomData({{1, 8}}, 0, 1, 7.5f));
    REQUIRE(s);
    CHECK(s->zoom == doctest::Approx(4));
    s = eft::resolveSight(zoomData({{1, 8}}, 0, 1, 3.5f));  // 8.6×: slightly past the range
    CHECK(s->zoom == doctest::Approx(8));
    // At its minimum setting, a live value a little above 1× counts as 1× (unmagnified).
    s = eft::resolveSight(zoomData({{1, 8}}, 0, 0, 24.5f));  // 30 / 24.5 = 1.22
    CHECK(s->zoom == doctest::Approx(1));
    CHECK_FALSE(s->magnified);
    // An implausible live value: the template mode's zoom.
    s = eft::resolveSight(zoomData({{1, 8}}, 0, 1, 0.5f));  // 60×
    CHECK(s->zoom == doctest::Approx(8));
    // A reflex on top of a scope (two scopes): the range spans both.
    s = eft::resolveSight(zoomData({{4}, {1}}, 1, 0));
    REQUIRE(s);
    CHECK(s->zoom == doctest::Approx(1));
    CHECK(s->maxZoom == doctest::Approx(4));
    // Out-of-range mode falls back to mode 0; unknown scope or no zooms: nullopt.
    CHECK(eft::resolveSight(zoomData({{2, 3}}, 0, 9))->zoom == doctest::Approx(2));
    CHECK_FALSE(eft::resolveSight(zoomData({{4}}, 1, 0)));
    CHECK_FALSE(eft::resolveSight(zoomData({}, 0, 0)));
    CHECK_FALSE(eft::resolveSight(zoomData({{}}, 0, 0)));

    std::vector<eft::SightState> sights(2);
    CHECK(eft::activeSight(sights) == 0u);
    sights[1].current = true;
    CHECK(eft::activeSight(sights) == 1u);
    CHECK_FALSE(eft::activeSight({}));
}

TEST_CASE("CameraTracker follows the FPS camera, aiming and the scope") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    w.addCamera("Main Camera", {0, 50, 0});
    const auto fps = w.addCamera("FPS Camera", {5, 1.6f, 5});
    const auto optic = w.addCamera("BaseOpticCamera(Clone)", {5, 1.6f, 5.2f}, 7.0f, 1.0f);
    // A reflex sight and a variable 1–6× scope (at 3×), looked through the scope.
    const auto weapon = w.setWeapon(false, {{.zooms = {{1}}}, {.zooms = {{1, 6}}, .mode = 1, .scopeZoomValue = 10}});
    w.addOpticCameraManager(optic, weapon, 1);

    eft::WorldState world;
    {
        eft::CameraTracker tracker(w.makeSession(3), world);
        const auto found = tracker.resolve();
        CHECK(found.cameras.size() == 3);
        CHECK(found.fps == fps.native);
        CHECK(found.optic == optic.native);
        CHECK(found.opticManager != 0);

        auto t = Clock::now();
        tracker.tick(t);  // nothing found yet: nothing published
        CHECK_FALSE(world.camera.get()->fps);
        tracker.refresh(t);
        tracker.tick(t);
        auto snap = world.camera.get();
        CHECK(snap->raidId == 3);
        REQUIRE(snap->fps);
        REQUIRE(snap->fps->position);
        CHECK(near(*snap->fps->position, {5, 1.6f, 5}));
        CHECK(snap->fps->fieldOfView == doctest::Approx(75));
        // The reader reads the same camera on demand.
        auto reader = world.cameraReader.get()->reader;
        REQUIRE(reader);
        CHECK(reader->raidId() == 3);
        REQUIRE(reader->fps());
        CHECK(near(*reader->fps()->position, {5, 1.6f, 5}));
        CHECK_FALSE(snap->aiming);
        CHECK(snap->sights.empty());
        CHECK_FALSE(snap->optic);

        // Unchanged: nothing new published.
        const auto revision = snap->revision;
        tracker.tick(t + milliseconds(16));
        CHECK(world.camera.get()->revision == revision);

        // Aiming through the scope: sights, magnification and the optic camera.
        w.setAiming(weapon, true);
        tracker.tick(t + eft::CameraTracker::kSightInterval);
        snap = world.camera.get();
        CHECK(snap->aiming);
        REQUIRE(snap->sights.size() == 2);
        CHECK_FALSE(snap->sights[0].current);
        CHECK(snap->sights[1].current);
        CHECK(snap->activeSight == 1u);
        CHECK(snap->magnification == doctest::Approx(3));
        CHECK(snap->scoped);
        REQUIRE(snap->optic);
        CHECK(snap->optic->fieldOfView == doctest::Approx(7));

        // The camera moves: a new snapshot.
        w.moveCamera(fps.native, {6, 1.6f, 5});
        tracker.tick(t + eft::CameraTracker::kSightInterval + milliseconds(16));
        REQUIRE(world.camera.get()->fps->position);
        CHECK(near(*world.camera.get()->fps->position, {6, 1.6f, 5}));

        // The FPS camera stops reading: the last view is kept for kFailureGrace, then dropped.
        w.heap.put(fps.native + eft::kCameraLayout.viewProjection, Mat4{}.m);
        auto later = t + milliseconds(200);
        tracker.tick(later);
        CHECK(world.camera.get()->fps);
        tracker.tick(later + eft::CameraTracker::kFailureGrace);
        CHECK_FALSE(world.camera.get()->fps);
        CHECK_FALSE(world.cameraReader.get()->reader);  // nothing to read: no reader

        // Its replacement is picked up at once: the live task asks for a look-up.
        w.addCamera("FPS Camera", {7, 1.6f, 7});
        tracker.refresh(later + eft::CameraTracker::kFailureGrace + milliseconds(8));
        tracker.tick(later + eft::CameraTracker::kFailureGrace + milliseconds(16));
        REQUIRE(world.camera.get()->fps);
        CHECK(near(*world.camera.get()->fps->position, {7, 1.6f, 7}));
        reader = world.cameraReader.get()->reader;
        REQUIRE(reader);
        CHECK(near(*reader->fps()->position, {7, 1.6f, 7}));
    }
    CHECK_FALSE(world.camera.get()->fps);  // cleared at raid end
    CHECK_FALSE(world.cameraReader.get()->reader);
}

TEST_CASE("encodeCamera") {
    eft::CameraSnapshot snap;
    snap.raidId = 4;
    snap.revision = 9;
    snap.fps = eft::CameraView{.viewProjection = FakeWorld::multiply(FakeWorld::perspective(60, 1.5f), FakeWorld::viewAt({1, 2, 3})),
                               .position = Vec3{1, 2, 3}, .fieldOfView = 60, .aspect = 1.5f};
    snap.aiming = true;
    snap.sights = {eft::SightState{.scope = 0, .mode = 1, .zoom = 4, .minZoom = 1, .maxZoom = 4, .magnified = true, .current = true}};
    snap.activeSight = 0;
    snap.magnification = 4;
    snap.scoped = true;
    const auto json = server::encodeCamera(snap);
    auto has = [&](std::string_view part) { return json.find(part) != std::string::npos; };
    CHECK(has(R"("type":"camera")"));
    CHECK(has(R"("raid":4)"));
    CHECK(has(R"("pos":[1,2,3])"));
    CHECK(has(R"("fov":60)"));
    CHECK(has(R"("aspect":1.5)"));
    CHECK(has(R"("aiming":true)"));
    CHECK(has(R"("scoped":true)"));
    CHECK(has(R"("magnification":4)"));
    CHECK(has(R"("active":0)"));
    CHECK(has(R"("min":1)"));
    CHECK(has(R"("max":4)"));
    CHECK(has(R"("current":true)"));
    CHECK(has(R"("optic":null)"));
    CHECK(has(R"("vp":[)"));
}

TEST_CASE("CameraTracker ignores an OpticCameraManager camera that doesn't read") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    w.addCamera("FPS Camera", {5, 1.6f, 5});
    const auto optic = w.addCamera("BaseOpticCamera(Clone)", {5, 1.6f, 5.2f}, 7.0f, 1.0f);
    const auto weapon = w.setWeapon(true, {{.zooms = {{4}}}});
    const Address manager = w.addOpticCameraManager(optic, weapon, 0);
    // The manager's Camera points at something that isn't a camera.
    const Address bogus = w.heap.alloc(0x40);
    w.heap.put<Address>(bogus + radar::test::kIl2Cpp.unityObjectCachedPtr, w.heap.alloc(0x600));
    w.heap.put<Address>(manager + off::OpticCameraManager::Camera, bogus);

    eft::WorldState world;
    eft::CameraTracker tracker(w.makeSession(3), world);
    const auto found = tracker.resolve();
    CHECK(found.optic == optic.native);  // the one found by name stays
    CHECK(found.opticManager == manager);
}
