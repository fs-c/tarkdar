#include "core/sched/TaskRunner.hpp"

#include "core/log/Log.hpp"

#include <algorithm>
#include <condition_variable>
#include <exception>
#include <mutex>

namespace radar::sched {

bool sleepFor(std::stop_token stop, Clock::duration duration) {
    std::mutex m;
    std::condition_variable_any cv;
    std::unique_lock lock(m);
    cv.wait_for(lock, stop, duration, [] { return false; });
    return !stop.stop_requested();
}

void TaskRunner::add(std::string taskName, Options options, std::function<void()> fn) {
    tasks_.push_back(Task{std::move(taskName), options, std::move(fn)});
}

void TaskRunner::start(Clock::time_point now) {
    for (auto& t : tasks_)
        t.nextRun = now + t.options.phase + (t.options.runOnStart ? Clock::duration{} : t.options.interval);
    started_ = true;
}

Clock::time_point TaskRunner::step(Clock::time_point now) {
    if (!started_) start(now);

    // Due tasks in next-run order (stable: insertion order breaks ties).
    std::vector<Task*> due;
    for (auto& t : tasks_)
        if (t.options.interval > Clock::duration{} && t.nextRun <= now) due.push_back(&t);
    std::stable_sort(due.begin(), due.end(), [](const Task* a, const Task* b) { return a->nextRun < b->nextRun; });

    for (Task* t : due) {
        const auto begin = Clock::now();
        try {
            t->fn();
        } catch (const std::exception& e) {
            log::error("[{}] task {} threw: {}", name_, t->name, e.what());
        } catch (...) {
            log::error("[{}] task {} threw an unknown exception", name_, t->name);
        }
        const auto end = Clock::now();
        if (onTaskDone) onTaskDone(t->name, end - begin);

        // Keep the phase; skip missed cycles. Reference point: the later of `now` and the wall
        // clock, so tests driving step() with synthetic times behave deterministically.
        const auto reference = std::max(now, end);
        const auto interval = t->options.interval;
        if (t->nextRun <= reference) {
            const auto missed = (reference - t->nextRun) / interval + 1;
            t->nextRun += missed * interval;
        }
    }

    auto next = Clock::time_point::max();
    for (const auto& t : tasks_)
        if (t.options.interval > Clock::duration{}) next = std::min(next, t.nextRun);
    return next;
}

void TaskRunner::run(std::stop_token stop) {
    constexpr auto kMaxSleep = std::chrono::milliseconds(100);
    while (!stop.stop_requested()) {
        const auto now = Clock::now();
        const auto next = step(now);
        const auto wait = std::min<Clock::duration>(kMaxSleep, std::max<Clock::duration>(next - Clock::now(), {}));
        if (wait > Clock::duration{} && !sleepFor(stop, wait)) break;
    }
}

}  // namespace radar::sched
