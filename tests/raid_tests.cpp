#include "FakeWorld.hpp"

#include "core/sched/TaskRunner.hpp"
#include "game/eft/Lifecycle.hpp"
#include "game/eft/Maps.hpp"
#include "game/eft/raid/RaidFinder.hpp"
#include "game/eft/raid/RaidMonitor.hpp"
#include "game/eft/raid/Roster.hpp"

#include <doctest/doctest.h>

#include <atomic>
#include <thread>

using namespace radar;
using radar::test::FakeWorld;
using sched::Clock;
using Status = eft::WorldCheck::Status;
using mem::Address;

namespace doctest {
template <>
struct StringMaker<Status> {
    static String convert(Status s) {
        switch (s) {
        case Status::Ready: return "Ready";
        case Status::Pending: return "Pending";
        case Status::Rejected: return "Rejected";
        }
        return "?";
    }
};
}  // namespace doctest

TEST_CASE("location ids") {
    CHECK(eft::isLobbyLocation(""));
    CHECK(eft::isLobbyLocation("Hideout"));
    CHECK(eft::isRaidLocation("bigmap"));
    CHECK(eft::isRaidLocation("RezervBase"));
    CHECK(eft::isRaidLocation("factory_event"));
    CHECK_FALSE(eft::isRaidLocation("hideout"));
    CHECK_FALSE(eft::isRaidLocation("custom_mod_map"));
}

TEST_CASE("checkWorld") {
    FakeWorld w;
    const Address world = w.newWorld(u"Woods", 5);
    const auto game = w.attachGame();

    auto wc = eft::checkWorld(game, world, 0, 0);
    CHECK(wc.status == Status::Ready);
    CHECK(wc.candidate.locationId == "Woods");
    CHECK(wc.candidate.localPlayer == w.localPlayer);  // from MainPlayer
    CHECK(wc.candidate.registeredCount == 5);
    CHECK(wc.candidate.gameWorldObject == world);

    SUBCASE("empty roster is pending") {
        w.setRoster(0);
        CHECK(eft::checkWorld(game, world, 0, 0).status == Status::Pending);
    }
    SUBCASE("hideout and unknown locations are rejected") {
        w.setLocation(u"hideout");
        CHECK(eft::checkWorld(game, world, 0, 0).status == Status::Rejected);
        w.setLocation(u"somewhere");
        CHECK(eft::checkWorld(game, world, 0, 0).status == Status::Rejected);
    }
    SUBCASE("location falls back to the local player's") {
        w.heap.put<Address>(world + off::GameWorld::Location, 0);
        w.heap.put<Address>(w.localPlayer + off::Player::Location, w.heap.managedString(u"Shoreline"));
        CHECK(eft::checkWorld(game, world, 0, 0).candidate.locationId == "Shoreline");
    }
    SUBCASE("implausible roster count is rejected") {
        w.setRosterCount(100000);
        CHECK(eft::checkWorld(game, world, 0, 0).status == Status::Rejected);
    }
}

TEST_CASE("readRoster filters invalid and duplicate entries") {
    FakeWorld w;
    const Address world = w.newWorld(u"bigmap", 0);
    const Address other = w.newPlayer();
    w.heap.put<Address>(world + off::ClientLocalGameWorld::RegisteredPlayers,
                        w.heap.list(std::vector<Address>{w.localPlayer, 0, other, w.localPlayer, 0x10}));
    const auto game = w.attachGame();
    const auto roster = eft::readRoster(game, world);
    REQUIRE(roster);
    CHECK(roster->localPlayer == w.localPlayer);
    CHECK(roster->players == std::vector<Address>{w.localPlayer, other});
}

TEST_CASE("RaidFinder") {
    FakeWorld w;
    const auto t0 = Clock::now();
    using std::chrono::seconds;

    SUBCASE("finds a raid through GamePlayerOwner") {
        const Address world = w.newWorld(u"Interchange", 3);
        eft::RaidFinder finder(w.attachGame());
        finder.restart();
        const auto r = finder.poll(t0);
        REQUIRE(r.raid);
        CHECK(r.raid->localGameWorld == world);
        CHECK(r.raid->localPlayer == w.localPlayer);
    }

    SUBCASE("a world the local player isn't in yet isn't found (no scene scan)") {
        w.newWorld(u"Interchange", 3);
        w.setMyPlayer(0);
        eft::RaidFinder finder(w.attachGame());
        finder.restart();
        CHECK_FALSE(finder.poll(t0 + seconds(60)).raid);
        CHECK_FALSE(finder.poll(t0 + seconds(60)).pending);
    }

    SUBCASE("pending world is promoted when it becomes ready, or dropped") {
        w.newWorld(u"Woods", 0);
        eft::RaidFinder finder(w.attachGame());
        finder.restart();
        auto r = finder.poll(t0);
        CHECK_FALSE(r.raid);
        CHECK(r.pending);
        w.setRoster(4);
        CHECK(finder.poll(t0 + seconds(3)).raid);
    }

    SUBCASE("the ended raid's world is not accepted again while it lingers") {
        const Address world = w.newWorld(u"Woods", 4);
        eft::RaidFinder finder(w.attachGame());
        finder.restart();
        REQUIRE(finder.poll(t0).raid);
        finder.markEnded(world);
        finder.restart();
        CHECK_FALSE(finder.poll(t0).raid);  // still looks like a raid: lingering

        SUBCASE("a new world is accepted") {
            const Address next = w.newWorld(u"Woods", 4);
            const auto r = finder.poll(t0);
            REQUIRE(r.raid);
            CHECK(r.raid->localGameWorld == next);
        }
        SUBCASE("the same address is accepted once it was seen torn down") {
            w.setRoster(0);
            CHECK_FALSE(finder.poll(t0).raid);
            w.setRoster(4);
            CHECK(finder.poll(t0).raid);
        }
    }
}

TEST_CASE("RaidMonitor") {
    FakeWorld w;
    const Address world = w.newWorld(u"Woods", 0);
    const auto game = w.attachGame();
    const auto t0 = Clock::now();
    eft::RaidMonitor monitor(world, t0);

    // Empty from the start: not "seen active", never ends.
    for (int i = 0; i < 50; ++i) CHECK_FALSE(monitor.check(game, t0));

    w.setRoster(3);
    CHECK_FALSE(monitor.check(game, t0));

    SUBCASE("ends after the roster stays empty") {
        w.setRosterCount(0);
        for (int i = 1; i < eft::RaidMonitor::kEmptyChecks; ++i) CHECK_FALSE(monitor.check(game, t0));
        CHECK(monitor.check(game, t0) == "roster empty");
    }
    SUBCASE("a refill resets the count") {
        w.setRosterCount(0);
        for (int i = 1; i < eft::RaidMonitor::kEmptyChecks; ++i) CHECK_FALSE(monitor.check(game, t0));
        w.setRosterCount(3);
        CHECK_FALSE(monitor.check(game, t0));
        w.setRosterCount(0);
        CHECK_FALSE(monitor.check(game, t0));
    }
    SUBCASE("ends after the roster stays unreadable") {
        w.heap.put<Address>(world + off::ClientLocalGameWorld::RegisteredPlayers, 0);
        for (int i = 1; i < eft::RaidMonitor::kInvalidChecks; ++i) CHECK_FALSE(monitor.check(game, t0));
        CHECK(monitor.check(game, t0) == "roster unreadable");
    }
}

TEST_CASE("RaidMonitor: the local player moving to another world, and a roster that never fills") {
    FakeWorld w;
    const Address first = w.newWorld(u"Woods", 3);
    const auto game = w.attachGame();
    const auto t0 = Clock::now();

    SUBCASE("ends once _myPlayer belongs to another world") {
        eft::RaidMonitor monitor(first, t0);
        CHECK_FALSE(monitor.check(game, t0));  // confirms the static matches this raid
        w.newWorld(u"Shoreline", 3);           // the old world keeps its roster
        CHECK_FALSE(monitor.check(game, t0));
        CHECK_FALSE(monitor.check(game, t0));
        CHECK(monitor.check(game, t0) == "the local player is in a different GameWorld");
    }
    SUBCASE("a stale static that never matched this raid is ignored") {
        const Address second = w.newWorld(u"Shoreline", 3);
        w.setMyPlayer(0);
        w.heap.put<Address>(w.localPlayer + off::Player::GameWorld, first);
        w.setMyPlayer(w.localPlayer);  // _myPlayer → a player of the first world
        eft::RaidMonitor monitor(second, t0);
        for (int i = 0; i < 10; ++i) CHECK_FALSE(monitor.check(game, t0));
    }
    SUBCASE("a roster that never fills ends the raid after the timeout") {
        w.setRoster(0);
        eft::RaidMonitor monitor(first, t0);
        CHECK_FALSE(monitor.check(game, t0 + std::chrono::seconds(60)));
        CHECK(monitor.check(game, t0 + eft::RaidMonitor::kNeverActiveTimeout) == "roster never filled");
    }
}

TEST_CASE("RaidFinder: the ended-world guard lifts after the grace period") {
    FakeWorld w;
    const Address world = w.newWorld(u"Woods", 4);
    eft::RaidFinder finder(w.attachGame());
    const auto t0 = Clock::now();
    finder.restart();
    REQUIRE(finder.poll(t0).raid);
    finder.markEnded(world);
    CHECK_FALSE(finder.poll(t0 + std::chrono::seconds(1)).raid);
    CHECK_FALSE(finder.poll(t0 + std::chrono::seconds(20)).raid);
    CHECK(finder.poll(t0 + std::chrono::seconds(32)).raid);  // still ready 30 s later: accepted
}

namespace {
class CountingSubsystem final : public eft::RaidSubsystem {
public:
    explicit CountingSubsystem(std::atomic<int>& ticks) : ticks_(ticks) {}
    void registerTasks(sched::TaskRunner& live, sched::TaskRunner&) override {
        live.add("count", {.interval = std::chrono::milliseconds(10), .runOnStart = true}, [this] { ++ticks_; });
    }

private:
    std::atomic<int>& ticks_;
};

template <class Pred>
bool waitFor(Pred pred, std::chrono::milliseconds timeout = std::chrono::milliseconds(5000)) {
    const auto end = Clock::now() + timeout;
    while (Clock::now() < end) {
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
}
}  // namespace

TEST_CASE("Lifecycle runs a raid and ends it when the game process goes away") {
    FakeWorld w;
    w.newWorld(u"Shoreline", 6);
    auto target = w.makeTarget();

    std::atomic<int> ticks{0};
    std::atomic<int> sessionsCreated{0};
    eft::Lifecycle lifecycle(target, [&](std::shared_ptr<const eft::RaidSession> session) {
        ++sessionsCreated;
        CHECK(session->start.locationId == "Shoreline");
        std::vector<std::unique_ptr<eft::RaidSubsystem>> out;
        out.push_back(std::make_unique<CountingSubsystem>(ticks));
        return out;
    });

    std::jthread thread([&](std::stop_token stop) { lifecycle.run(stop); });
    REQUIRE(waitFor([&] { return lifecycle.status()->state == eft::Status::State::InRaid; }));
    CHECK(lifecycle.status()->locationId == "Shoreline");
    CHECK(lifecycle.session());
    CHECK(waitFor([&] { return ticks.load() > 3; }));  // subsystem tasks run on the live worker
    CHECK(sessionsCreated == 1);

    w.fake.killProcess(test::FakeWorld::kPid);
    REQUIRE(waitFor([&] { return lifecycle.status()->state == eft::Status::State::WaitingForProcess; }));
    CHECK_FALSE(lifecycle.session());
    const int ticksAfterEnd = ticks.load();
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    CHECK(ticks.load() == ticksAfterEnd);  // workers stopped

    thread.request_stop();
}
