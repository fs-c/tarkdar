#pragma once

#include <chrono>
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
class TaskRunner {
public:
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

    // Called after each task with its duration; for diagnostics.
    std::function<void(const std::string& task, Clock::duration took)> onTaskDone;

private:
    struct Task {
        std::string name;
        Options options;
        std::function<void()> fn;
        Clock::time_point nextRun{};
    };

    void start(Clock::time_point now);

    std::string name_;
    std::vector<Task> tasks_;
    bool started_ = false;
};

}  // namespace radar::sched
