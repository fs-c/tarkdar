#include "FakeWorld.hpp"

#include "game/eft/players/Players.hpp"
#include "game/eft/players/Skeleton.hpp"

#include <doctest/doctest.h>

using namespace radar;
using radar::test::FakeWorld;
using mem::Address;
using math::Vec3;
using sched::Clock;
using std::chrono::milliseconds;

namespace {
bool near(Vec3 a, Vec3 b, float eps = 1e-3f) {
    return std::fabs(a.x - b.x) < eps && std::fabs(a.y - b.y) < eps && std::fabs(a.z - b.z) < eps;
}

std::shared_ptr<const eft::RaidSession> makeSession(FakeWorld& w) {
    return std::make_shared<eft::RaidSession>(eft::RaidSession{
        .id = 7,
        .game = w.attachGame(),
        .start = eft::RaidCandidate{.localGameWorld = w.world, .gameWorldObject = w.world,
                                    .localPlayer = w.localPlayer, .locationId = "bigmap", .registeredCount = 1},
        .startedAt = Clock::now(),
    });
}

const eft::PlayerState* byPosition(const eft::PlayersSnapshot& s, Vec3 pos) {
    for (const auto& p : s.players)
        if (p.position && near(*p.position, pos)) return &p;
    return nullptr;
}

std::optional<unity::Pose> pose(Vec3 p) { return unity::Pose{p, {}}; }
}  // namespace

TEST_CASE("pickPosition and plausibleSkeleton") {
    const Vec3 base{10, 1, 20}, left{9.85f, 1, 20}, right{10.15f, 1, 20};
    CHECK(eft::pickPosition({pose(base), pose(left), pose(right)}) == base);
    CHECK(near(*eft::pickPosition({std::nullopt, pose(left), pose(right)}), {10, 1, 20}));
    CHECK(eft::pickPosition({std::nullopt, pose(left), std::nullopt}) == left);
    CHECK(eft::pickPosition({std::nullopt, pose(left), pose({30, 1, 20})}) == left);  // feet too far apart
    CHECK_FALSE(eft::pickPosition({std::nullopt, std::nullopt, std::nullopt}));

    CHECK(eft::plausibleSkeleton({pose(base), pose(left), pose(right)}));
    CHECK_FALSE(eft::plausibleSkeleton({pose(base), pose(left), std::nullopt}));
    CHECK_FALSE(eft::plausibleSkeleton({pose(base), pose(left), pose({20, 1, 20})}));  // foot 10 m away
    CHECK_FALSE(eft::plausibleSkeleton({pose({0.5f, 0.5f, 0.5f}), pose(left), pose(right)}));  // near origin
}

TEST_CASE("Players tracks the roster, positions, rotation and death") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    const Address bot1 = w.newPlayer(4, Vec3{50, 2, 60});
    const Address bot2 = w.newPlayer(2, Vec3{-40, 3, 10});
    w.setRosterList({w.localPlayer, bot1, bot2});
    w.movePlayer(w.localPlayer, {1, 1, 1});
    w.setRotation(bot1, 123.0f, -5.0f);

    eft::WorldState world;
    auto session = makeSession(w);
    eft::Players players(session, world);
    auto t = Clock::now();

    players.rosterTick(t);
    auto snap = world.players.get();
    CHECK(snap->raidId == 7);
    REQUIRE(snap->players.size() == 3);
    const auto* local = snap->local();
    REQUIRE(local);
    CHECK(local->side == eft::Side::Usec);
    CHECK_FALSE(local->ai);
    CHECK_FALSE(local->position);  // positions come from the positions task

    players.positionsTick(t);
    snap = world.players.get();
    const auto* p1 = byPosition(*snap, {50, 2, 60});
    const auto* p2 = byPosition(*snap, {-40, 3, 10});
    REQUIRE(p1);
    REQUIRE(p2);
    CHECK(p1->ai);
    CHECK(p1->side == eft::Side::Savage);
    CHECK(p1->yaw == 123.0f);
    CHECK(p1->pitch == -5.0f);
    CHECK(p2->side == eft::Side::Bear);
    CHECK(near(*snap->local()->position, {1, 1, 1}));
    const auto id1 = p1->id;

    SUBCASE("movement is picked up") {
        w.movePlayer(bot1, {55, 2, 61});
        players.positionsTick(t + milliseconds(10));
        const auto* moved = byPosition(*world.players.get(), {55, 2, 61});
        REQUIRE(moved);
        CHECK(moved->id == id1);  // same id
    }

    SUBCASE("death is detected via the corpse field and is permanent") {
        w.kill(bot1);
        players.rosterTick(t + milliseconds(200));
        snap = world.players.get();
        const auto* dead = byPosition(*snap, {50, 2, 60});
        REQUIRE(dead);
        CHECK(dead->dead);
        // Dead players keep their last position.
        w.movePlayer(bot1, {0, 0, 0});
        players.positionsTick(t + milliseconds(210));
        CHECK(byPosition(*world.players.get(), {50, 2, 60}));
    }

    SUBCASE("players leaving the list become absent after misses and time") {
        w.setRosterList({w.localPlayer, bot2});
        players.rosterTick(t + milliseconds(20));
        players.rosterTick(t + milliseconds(40));
        players.rosterTick(t + milliseconds(60));
        CHECK_FALSE(byPosition(*world.players.get(), {50, 2, 60})->absent);  // 3 misses, but < 2 s
        players.rosterTick(t + milliseconds(2100));
        CHECK(byPosition(*world.players.get(), {50, 2, 60})->absent);
        // Back in the list: no longer absent.
        w.setRosterList({w.localPlayer, bot1, bot2});
        players.rosterTick(t + milliseconds(2120));
        CHECK_FALSE(byPosition(*world.players.get(), {50, 2, 60})->absent);
    }

    SUBCASE("stale bones are re-resolved") {
        // A foot suddenly far from Base looks like stale bone pointers: they're dropped and resolved again.
        const auto& fp = w.fakePlayers.at(bot1);
        w.heap.put(fp.trs + sizeof(unity::TrsX), unity::TrsX{{30, 0, 0}, 0, {}, {1, 1, 1}, 0});  // foot 30 m away
        players.positionsTick(t + milliseconds(10));                                       // invalidates
        w.heap.put(fp.trs + sizeof(unity::TrsX), unity::TrsX{{-0.15f, 0, 0}, 0, {}, {1, 1, 1}, 0});
        w.movePlayer(bot1, {52, 2, 60});
        players.positionsTick(t + milliseconds(20));  // resolves again, reads the new position
        CHECK(byPosition(*world.players.get(), {52, 2, 60}));
    }
}

TEST_CASE("Players builds observed players through their own layout") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    const Address client = w.newPlayer(4, Vec3{50, 2, 60});
    const Address boss = w.newObservedPlayer(4, true, u"BossKilla", Vec3{-20, 1, 30});
    const Address pmc = w.newObservedPlayer(2, false, u"Bear_1", Vec3{10, 4, -10});
    w.setRosterList({w.localPlayer, client, boss, pmc});
    w.setRotation(boss, 45.0f, 2.0f);

    eft::WorldState world;
    eft::Players players(makeSession(w), world);
    const auto t = Clock::now();
    players.rosterTick(t);
    players.positionsTick(t);
    auto snap = world.players.get();
    REQUIRE(snap->players.size() == 4);
    CHECK(snap->local()->kind == eft::PlayerKind::Local);

    const auto* c = byPosition(*snap, {50, 2, 60});
    const auto* b = byPosition(*snap, {-20, 1, 30});
    const auto* p = byPosition(*snap, {10, 4, -10});
    REQUIRE(c);
    REQUIRE(b);
    REQUIRE(p);
    CHECK(c->kind == eft::PlayerKind::Client);
    CHECK(c->ai);
    CHECK(b->kind == eft::PlayerKind::Observed);
    CHECK(b->ai);
    CHECK(b->side == eft::Side::Savage);
    CHECK(b->voice == "BossKilla");
    CHECK(b->yaw == doctest::Approx(45.0f));
    CHECK(p->kind == eft::PlayerKind::Observed);
    CHECK_FALSE(p->ai);  // a human player on another machine
    CHECK(p->side == eft::Side::Bear);

    const auto bossId = b->id;
    w.kill(boss);
    w.movePlayer(pmc, {11, 4, -10});
    players.rosterTick(t + eft::Players::kCorpseInterval);
    players.positionsTick(t + eft::Players::kCorpseInterval);
    snap = world.players.get();
    for (const auto& q : snap->players)
        if (q.id == bossId) CHECK(q.dead);
    CHECK(byPosition(*snap, {11, 4, -10}));
}

TEST_CASE("Players backs off on build failures and reports why") {
    FakeWorld w;
    w.newWorld(u"bigmap", 0);
    const Address observed = w.heap.object(w.observedClass);  // an observed view with nothing filled in
    const Address broken = w.newPlayer();
    w.heap.put<Address>(broken + off::Player::Profile, 0);  // can't build
    w.setRosterList({w.localPlayer, observed, broken});

    eft::WorldState world;
    {
        eft::Players players(makeSession(w), world);
        auto t = Clock::now();
        // Free retries are spaced kMinBuildSpacing apart: 5 attempts at 0, 250, …, 1000 ms.
        for (int i = 0; i < 10; ++i) players.rosterTick(t + milliseconds(250 * i));
        CHECK(world.players.get()->players.size() == 1);  // only the local player
        const auto failures = players.buildFailures();
        REQUIRE(failures.size() == 2);
        for (const auto& f : failures) {
            CHECK(f.attempts == eft::Players::kMaxFreeBuildAttempts);
            if (f.instance == broken) {
                CHECK(f.className == "ClientPlayer");
                CHECK(f.error == "Player.Profile is null");
            } else {
                CHECK(f.className == "ObservedPlayerView");
                CHECK(f.error == "ObservedPlayerView.ObservedPlayerController is null");
            }
        }

        // The broken player becomes buildable: picked up after the back-off.
        w.heap.put<Address>(broken + off::Player::Profile, w.heap.alloc(0x200));
        const Address profile = mem::MemoryView(w.fake, FakeWorld::kPid).read<Address>(broken + off::Player::Profile);
        w.heap.put<Address>(profile + off::Profile::Info, w.heap.alloc(0x100));
        players.rosterTick(t + milliseconds(2500));
        CHECK(world.players.get()->players.size() == 1);  // still backing off (last attempt at 1000 ms)
        players.rosterTick(t + milliseconds(3100));
        CHECK(world.players.get()->players.size() == 2);
    }
    CHECK(world.players.get()->players.empty());  // cleared at raid end
}
