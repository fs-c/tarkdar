#include "core/sched/TaskRunner.hpp"

#include <doctest/doctest.h>

#include <chrono>
#include <stdexcept>

using namespace radar;
using sched::Clock;

TEST_CASE("TaskRunner keeps phase and skips missed cycles") {
    sched::TaskRunner runner("test");
    int fast = 0, slow = 0, startNow = 0;
    using std::chrono::milliseconds;
    runner.add("fast", {.interval = milliseconds(100)}, [&] { ++fast; });
    runner.add("slow", {.interval = milliseconds(1000), .phase = milliseconds(50)}, [&] { ++slow; });
    runner.add("start", {.interval = milliseconds(500), .runOnStart = true}, [&] { ++startNow; });

    const auto t0 = Clock::now();
    auto next = runner.step(t0);
    CHECK(startNow == 1);
    CHECK(fast == 0);
    CHECK(next == t0 + milliseconds(100));

    runner.step(t0 + milliseconds(100));
    CHECK(fast == 1);
    // A long stall: fast runs once (not 10 times), and stays on its 100 ms grid.
    next = runner.step(t0 + milliseconds(1105));
    CHECK(fast == 2);
    CHECK(slow == 1);
    CHECK(startNow == 2);
    CHECK(next == t0 + milliseconds(1200));
}

TEST_CASE("TaskRunner survives throwing tasks") {
    sched::TaskRunner runner("test");
    int ran = 0;
    runner.add("bad", {.interval = std::chrono::milliseconds(10), .runOnStart = true},
               [] { throw std::runtime_error("boom"); });
    runner.add("good", {.interval = std::chrono::milliseconds(10), .runOnStart = true}, [&] { ++ran; });
    runner.step(Clock::now());
    CHECK(ran == 1);
}

TEST_CASE("TaskRunner times its tasks") {
    using std::chrono::milliseconds;
    sched::TaskRunner runner("test");
    runner.add("a", {.interval = milliseconds(10), .runOnStart = true}, [] {});
    runner.add("idle", {.interval = milliseconds(1000)}, [] {});
    const auto t0 = Clock::now();
    runner.step(t0);
    runner.step(t0 + milliseconds(10));

    auto stats = runner.takeStats();
    REQUIRE(stats.size() == 2);
    CHECK(stats[0].name == "a");
    CHECK(stats[0].runs == 2);
    CHECK(stats[0].stalls == 0);
    CHECK(stats[0].longest <= stats[0].total);
    CHECK(stats[1].runs == 0);
    // Taking them resets the counters.
    CHECK(runner.takeStats()[0].runs == 0);

    CHECK(sched::TaskRunner::stallThreshold(milliseconds(10)) == milliseconds(100));
    CHECK(sched::TaskRunner::stallThreshold(milliseconds(250)) == milliseconds(750));
}
