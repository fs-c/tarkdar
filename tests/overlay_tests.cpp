#include "FakeWorld.hpp"

#include "overlay/Frames.hpp"
#include "overlay/Scene.hpp"
#include "server/Protocol.hpp"

#include <doctest/doctest.h>

#include <algorithm>

using namespace radar;
using radar::test::FakeWorld;
using math::Vec3;
using overlay::DrawList;
using sched::Clock;
using std::chrono::milliseconds;

namespace {

// A camera at `eye` looking along +z.
eft::CameraView cameraAt(Vec3 eye, float fov = 90, float aspect = 16.f / 9.f) {
    return {FakeWorld::multiply(FakeWorld::perspective(fov, aspect), FakeWorld::viewAt(eye)), eye, fov, aspect};
}

eft::PlayersSnapshot players(std::uint64_t raid, std::vector<std::pair<std::uint32_t, Vec3>> others) {
    eft::PlayersSnapshot s;
    s.raidId = raid;
    s.players.push_back({.id = 1, .local = true, .position = Vec3{0, 0, 0}});
    for (auto [id, pos] : others) s.players.push_back({.id = id, .position = pos});
    return s;
}

// A person standing upright, facing +z: joints relative to the feet (Joint order).
eft::Joints standing() {
    return {{{0, 0, 0},         {-0.12f, 0.05f, 0}, {0.12f, 0.05f, 0}, {0, 0.95f, 0},       {0, 1.4f, 0},
             {0, 1.55f, 0},     {0, 1.65f, 0},      {-0.1f, 0.9f, 0},  {-0.11f, 0.5f, 0},   {0.1f, 0.9f, 0},
             {0.11f, 0.5f, 0},  {-0.2f, 1.45f, 0},  {-0.25f, 1.15f, 0}, {-0.27f, 0.9f, 0}, {0.2f, 1.45f, 0},
             {0.25f, 1.15f, 0}, {0.27f, 0.9f, 0}}};
}

template <class T>
std::vector<T> itemsOf(const DrawList& d) {
    std::vector<T> out;
    for (const auto& i : d.items)
        if (const auto* t = std::get_if<T>(&i)) out.push_back(*t);
    return out;
}

bool hasText(const DrawList& d, std::string_view text) {
    return std::ranges::any_of(itemsOf<DrawList::Text>(d), [&](const auto& t) { return t.text == text; });
}

struct Scene {
    overlay::Config config{.on = true, .raid = 7};
    eft::CameraSnapshot camera{};
    std::optional<eft::CameraView> fps = cameraAt({0, 1.7f, 0});
    std::optional<eft::CameraView> optic{};
    eft::PlayersSnapshot players = ::players(7, {});
    eft::LootSnapshot loot{};
    eft::ExfilsSnapshot exfils{};
    bool stretch = false;

    DrawList build() const {
        return overlay::buildScene({.config = config, .camera = camera, .fps = fps, .optic = optic, .players = players,
                                    .loot = loot, .exfils = exfils, .surfaceWidth = 1920, .surfaceHeight = 1080, .stretch = stretch});
    }
};

}  // namespace

TEST_CASE("overlay: projection and letterboxing") {
    const auto cam = cameraAt({0, 0, 0});
    const auto ahead = overlay::project(cam.viewProjection, {0, 0, 10});
    REQUIRE(ahead);
    CHECK(ahead->x == doctest::Approx(0));
    CHECK(ahead->y == doctest::Approx(0));
    CHECK(ahead->depth == doctest::Approx(10));
    CHECK_FALSE(overlay::project(cam.viewProjection, {0, 0, -10}));  // behind

    // A 16:9 picture on a 16:10 monitor: bars above and below.
    const auto vp = overlay::letterbox(1920, 1200, 16.f / 9.f);
    CHECK(vp.x == 0);
    CHECK(vp.width == 1920);
    CHECK(vp.height == doctest::Approx(1080));
    CHECK(vp.y == doctest::Approx(60));
}

TEST_CASE("overlay: a 4:3 picture letterboxed or stretched to 16:9") {
    Scene s;
    s.fps = cameraAt({0, 1.7f, 0}, 90, 4.f / 3.f);
    // Halfway to the right edge of the view: NDC x = 0.5 (tan 45° · 4/3 · 0.5 = 2/3 of the depth).
    s.players = players(7, {{2, {20.f / 3, 0, 10}}});
    s.config.marks.push_back({.kind = overlay::MarkKind::Player, .id = 2, .color = {255, 0, 0, 255}});
    auto lines = itemsOf<DrawList::Line>(s.build());
    REQUIRE(lines.size() == 1);
    CHECK(lines[0].a.x == doctest::Approx(240 + 0.75 * 1440));  // pillarboxed: 1440 wide, from x 240
    s.stretch = true;
    lines = itemsOf<DrawList::Line>(s.build());
    REQUIRE(lines.size() == 1);
    CHECK(lines[0].a.x == doctest::Approx(0.75 * 1920));  // the whole width
}

TEST_CASE("overlay: marked players, loot and exfils") {
    Scene s;
    s.players = players(7, {{2, {0, 0, 10}}, {3, {0, 0, -10}}, {4, {3, 0, 20}}});
    s.config.marks.push_back({.kind = overlay::MarkKind::Player, .id = 2, .color = {255, 0, 0, 255}, .label = "Killa"});
    s.config.marks.push_back({.kind = overlay::MarkKind::Player, .id = 3, .color = {255, 0, 0, 255}, .label = "Behind"});
    auto d = s.build();
    // Player 2: straight ahead, feet to head; labelled with the distance from the camera.
    const auto lines = itemsOf<DrawList::Line>(d);
    REQUIRE(lines.size() == 1);
    CHECK(lines[0].a.x == doctest::Approx(960));
    CHECK(lines[0].b.x == doctest::Approx(960));
    CHECK(lines[0].a.y > lines[0].b.y);  // feet below the head
    CHECK(hasText(d, "Killa 10 m"));
    CHECK_FALSE(hasText(d, "Behind 10 m"));  // behind the camera
    // Player 4 isn't marked and there's no colour for other players: not drawn.
    CHECK(itemsOf<DrawList::Circle>(d).size() == 1);

    // With a colour for the others, player 4 is drawn too.
    s.config.otherPlayers = overlay::Color{200, 200, 200, 255};
    d = s.build();
    CHECK(itemsOf<DrawList::Line>(d).size() == 2);

    // Marks made for another raid don't apply (ids restart every raid).
    s.config.raid = 6;
    d = s.build();
    CHECK_FALSE(hasText(d, "Killa 10 m"));
    CHECK(itemsOf<DrawList::Line>(d).size() == 2);  // the others still are (2 and 4 alike)

    // Loot within range, exfils.
    s.config.raid = 7;
    s.config.otherPlayers.reset();
    s.config.marks.clear();
    s.loot.raidId = 7;
    eft::LootEntry near{}, far{};
    near.id = 1, near.position = {1, 0, 5};
    far.id = 2, far.position = {0, 0, 400};
    s.loot.loot = {near, far};
    s.exfils.raidId = 7;
    s.exfils.exfils.push_back({.id = 5, .name = "Gate", .position = Vec3{0, 0, 100}});
    s.config.marks.push_back({.kind = overlay::MarkKind::Loot, .id = 1, .color = {255, 216, 77, 255}, .label = "LEDX"});
    s.config.marks.push_back({.kind = overlay::MarkKind::Loot, .id = 2, .color = {255, 216, 77, 255}, .label = "Far"});
    s.config.marks.push_back({.kind = overlay::MarkKind::Exfil, .id = 5, .color = {0, 255, 0, 255}, .label = "Gate"});
    d = s.build();
    CHECK(hasText(d, "LEDX 5 m"));
    CHECK_FALSE(hasText(d, "Far 400 m"));  // beyond lootRange
    CHECK(itemsOf<DrawList::Polygon>(d).size() == 1);
    CHECK(hasText(d, "Gate 100 m"));

    // Off, or no camera: nothing.
    s.config.on = false;
    CHECK(s.build().empty());
    s.config.on = true;
    s.fps.reset();
    CHECK(s.build().empty());
}

TEST_CASE("overlay: full skeletons") {
    Scene s;
    s.players = players(7, {{2, {0, 0, 10}}});
    s.players.players[1].joints = standing();
    s.config.marks.push_back({.kind = overlay::MarkKind::Player, .id = 2, .color = {255, 0, 0, 255}, .label = "Killa"});
    const auto d = s.build();
    CHECK(itemsOf<DrawList::Line>(d).size() == 13);  // every limb
    const auto heads = itemsOf<DrawList::Circle>(d);
    REQUIRE(heads.size() == 1);
    CHECK(heads[0].center.x == doctest::Approx(960));
    CHECK(heads[0].radius > 3);  // a real head's size at 10 m
    CHECK(heads[0].width > 0);
    CHECK(hasText(d, "Killa 10 m"));

    // Far away, too small to read: the plain line.
    s.players.players[1].position = Vec3{0, 0, 80};
    CHECK(itemsOf<DrawList::Line>(s.build()).size() == 1);

    // Through the scope, limbs crossing the scope's circle aren't drawn (their ends would be placed
    // through different views), the rest are.
    s.players.players[1].position = Vec3{0, 0, 3};
    s.camera.scoped = true;
    s.camera.magnification = 2;
    s.config.scopeRadius = 0.1f;
    const auto scoped = s.build();
    const auto limbs = itemsOf<DrawList::Line>(scoped).size();
    CHECK(limbs > 0);
    CHECK(limbs < 13);
}

TEST_CASE("overlay: through the scope inside its circle, the first-person view outside") {
    Scene s;
    // A target slightly right of the view's centre: near the centre in the first-person view, further
    // out through an 8× scope (whose camera covers an eighth of the field of view).
    s.players = players(7, {{2, {2, 0, 100}}, {3, {100, 0, 100}}});
    s.config.marks.push_back({.kind = overlay::MarkKind::Player, .id = 2, .color = {255, 0, 0, 255}, .label = "near"});
    s.config.marks.push_back({.kind = overlay::MarkKind::Player, .id = 3, .color = {255, 0, 0, 255}, .label = "wide"});
    const auto unscoped = itemsOf<DrawList::Line>(s.build());
    REQUIRE(unscoped.size() == 2);
    const float nearX = unscoped[0].a.x - 960;

    s.camera.scoped = true;
    s.camera.magnification = 8;
    s.optic = cameraAt({0, 1.7f, 0}, 90.f / 8, 1);
    const auto d = s.build();
    const auto lines = itemsOf<DrawList::Line>(d);
    REQUIRE(lines.size() == 2);
    CHECK(lines[0].a.x - 960 > nearX * 4);  // magnified
    CHECK(std::hypot(lines[0].b.x - 960, lines[0].b.y - 540) <= 0.36f * 1080);
    CHECK(lines[1].a.x == doctest::Approx(unscoped[1].a.x));  // outside the circle: unchanged
    // The circle itself.
    const auto circles = itemsOf<DrawList::Circle>(d);
    CHECK(std::ranges::any_of(circles, [](const auto& c) { return c.width > 0 && c.radius == doctest::Approx(0.36f * 1080); }));
}

TEST_CASE("overlay: camera history") {
    overlay::CameraHistory h;
    const auto t = Clock::now();
    CHECK_FALSE(h.at(t));
    h.add({.at = t, .fps = cameraAt({1, 0, 0})});
    h.add({.at = t + milliseconds(10), .fps = cameraAt({2, 0, 0})});
    h.add({.at = t + milliseconds(20), .fps = cameraAt({3, 0, 0})});
    CHECK(h.at(t + milliseconds(25))->fps->position->x == 3);
    CHECK(h.at(t + milliseconds(15))->fps->position->x == 2);
    CHECK(h.at(t - milliseconds(5))->fps->position->x == 1);  // older than all: the oldest
    h.add({.at = t + std::chrono::seconds(2), .fps = cameraAt({4, 0, 0})});
    CHECK(h.at(t)->fps->position->x == 4);  // the old ones were dropped
}

namespace {

class StubReader final : public eft::CameraReader {
public:
    mutable float x = 0;
    std::uint64_t raidId() const override { return 7; }
    std::optional<eft::CameraView> fps() const override { return cameraAt({x, 1.7f, 0}); }
    std::optional<eft::CameraView> optic() const override { return std::nullopt; }
};

}  // namespace

TEST_CASE("overlay: frames read the camera, and draw it as it was `delay` ago") {
    eft::WorldState world;
    sched::Published<overlay::Config> config;
    overlay::Frames frames(world, config);
    CHECK_FALSE(frames.active());
    world.players.publish(players(7, {{2, {0, 0, 10}}}));
    auto reader = std::make_shared<StubReader>();
    world.cameraReader.publish(eft::CameraReaderRef{reader});
    CHECK_FALSE(frames.active());  // not configured on
    overlay::Config c{.on = true, .raid = 7};
    c.marks.push_back({.kind = overlay::MarkKind::Player, .id = 2, .color = {255, 0, 0, 255}});
    c.delay = milliseconds(30);
    config.publish(c);
    CHECK(frames.active());

    const auto t = Clock::now();
    auto lineX = [](const DrawList& d) { return itemsOf<DrawList::Line>(d).at(0).a.x; };
    CHECK(lineX(frames.frame(1920, 1080, t)) == doctest::Approx(960));
    reader->x = 1;  // the camera moved right: the player is drawn left of centre, but only 30 ms later
    CHECK(lineX(frames.frame(1920, 1080, t + milliseconds(16))) == doctest::Approx(960));
    CHECK(lineX(frames.frame(1920, 1080, t + milliseconds(32))) == doctest::Approx(960));  // shows t + 2 ms
    CHECK(lineX(frames.frame(1920, 1080, t + milliseconds(46))) < 960);  // shows t + 16 ms
}

TEST_CASE("decodeOverlay") {
    const auto c = server::decodeOverlay(R"({"type":"overlay","data":{"on":true,"raid":4,"delayMs":20,"grid":true,
        "lootRange":80,"scopeRadius":0.3,"otherPlayers":"#c8c8c8",
        "marks":[{"kind":"player","id":3,"color":"#ff5a52","label":"Killa","emphasis":"loud"},
                 {"kind":"loot","id":9,"color":"#ffd84d80"},
                 {"kind":"exfil","id":1,"color":"red"},
                 {"kind":"vehicle","id":1,"color":"#ffffff"}]}})");
    REQUIRE(c);
    CHECK(c->on);
    CHECK(c->raid == 4);
    CHECK(c->delay == milliseconds(20));
    CHECK(c->grid);
    CHECK(c->lootRange == 80);
    CHECK(c->scopeRadius == doctest::Approx(0.3));
    CHECK(c->otherPlayers == overlay::Color{200, 200, 200, 255});
    REQUIRE(c->marks.size() == 2);  // a named colour and an unknown kind are dropped
    CHECK(c->marks[0].kind == overlay::MarkKind::Player);
    CHECK(c->marks[0].label == "Killa");
    CHECK(c->marks[0].emphasis == overlay::Emphasis::Loud);
    CHECK(c->marks[1].color == overlay::Color{255, 216, 77, 128});

    // As the frontend sends it (web/src/overlay/marks.ts), outside a raid and in one.
    const auto outside = server::decodeOverlay(R"({"type":"overlay","data":{"on":false,"raid":null,"delayMs":20,"grid":false,
        "lootRange":150,"scopeRadius":0.36,"otherPlayers":"#e0e0e0","marks":[]}})");
    REQUIRE(outside);
    CHECK_FALSE(outside->on);
    CHECK(outside->raid == 0);
    const auto inside = server::decodeOverlay(R"({"type":"overlay","data":{"on":true,"raid":1,"delayMs":20,"grid":false,
        "lootRange":150,"scopeRadius":0.36,"otherPlayers":"#e0e0e0","marks":[
        {"kind":"player","id":2,"color":"#f5c542","label":"Scav","emphasis":"faint"},
        {"kind":"player","id":3,"color":"#ff5a52","label":"BEAR","emphasis":"normal"},
        {"kind":"exfil","id":1,"color":"#4cd964","label":"ZB-1011","emphasis":"normal"}]}})");
    REQUIRE(inside);
    CHECK(inside->on);
    CHECK(inside->raid == 1);
    REQUIRE(inside->marks.size() == 3);
    CHECK(inside->marks[2].kind == overlay::MarkKind::Exfil);
    CHECK(inside->marks[2].color == overlay::Color{0x4c, 0xd9, 0x64, 255});

    CHECK_FALSE(server::decodeOverlay("not json"));
    CHECK_FALSE(server::decodeOverlay(R"({"type":"players","data":{}})"));
    const auto clamped = server::decodeOverlay(R"({"type":"overlay","data":{"delayMs":5000}})");
    REQUIRE(clamped);
    CHECK_FALSE(clamped->on);
    CHECK(clamped->delay == milliseconds(500));
}
