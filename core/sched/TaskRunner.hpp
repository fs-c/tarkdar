#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <stop_token>
#include <string>
#include <vector>

namespace radar::sched {

using Clock = std::chrono::steady_clock;

// Waits up to `duration`; returns early (false) if a stop is requested.
bool sleepFor(std::stop_token stop, Clock::duration duration);

// Runs periodic tasks on the calling thread. Tasks never overlap within one runner.
//
// Scheduling: each task has an interval and a phase offset. When a task finishes, its next run is
// advanced by whole intervals until it lies in the future. That keeps the phase and skips missed
// cycles instead of running a burst to catch up. Exceptions from tasks are logged and swallowed.
//
// Timing: every run is timed. A run longer than stallThreshold() is logged as a warning right away
// (at most once per task per report); every kReportInterval, run() logs a summary of each task
// (runs, average and longest run, share of the thread) at debug level.
class TaskRunner {
public:
    static constexpr auto kReportInterval = std::chrono::seconds(10);

    struct TaskStats {
        std::string name;
        std::uint64_t runs = 0;
        std::uint64_t stalls = 0;  // runs longer than stallThreshold()
        Clock::duration total{}, longest{};
    };

    struct Options {
        Clock::duration interval{};
        Clock::duration phase{};  // offset of the first run (spreads tasks with equal intervals)
        bool runOnStart = false;  // first run at start + phase instead of start + interval + phase
    };

    explicit TaskRunner(std::string name) : name_(std::move(name)) {}

    void add(std::string taskName, Options options, std::function<void()> fn);

    // Runs until stop is requested.
    void run(std::stop_token stop);

    // Runs every task that is due at `now` (in next-run order) and returns the time the next task
    // is due. Exposed for tests; run() is a loop around it. The first call schedules all tasks
    // relative to `now`.
    Clock::time_point step(Clock::time_point now);

    // Per-task timing since the last call (or the start), in insertion order; resets the counters.
    std::vector<TaskStats> takeStats();

    // A run this long holds up every other task on the thread: 3 intervals, at least 100 ms.
    [[nodiscard]] static Clock::duration stallThreshold(Clock::duration interval);

private:
    struct Task {
        std::string name;
        Options options;
        std::function<void()> fn;
        Clock::time_point nextRun{};
        TaskStats stats;
    };

    void report(Clock::time_point now);

    void start(Clock::time_point now);

    std::string name_;
    std::vector<Task> tasks_;
    bool started_ = false;
    Clock::time_point lastReport_{};
};

}  // namespace radar::sched
