#include "core/sched/TaskRunner.hpp"

#include "core/log/Log.hpp"

#include <algorithm>
#include <condition_variable>
#include <exception>
#include <format>
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
    Task task{taskName, options, std::move(fn)};
    task.stats.name = std::move(taskName);
    tasks_.push_back(std::move(task));
}

Clock::duration TaskRunner::stallThreshold(Clock::duration interval) {
    return std::max<Clock::duration>(interval * 3, std::chrono::milliseconds(100));
}

std::vector<TaskRunner::TaskStats> TaskRunner::takeStats() {
    std::vector<TaskStats> out;
    out.reserve(tasks_.size());
    for (auto& t : tasks_) {
        out.push_back(t.stats);
        t.stats = TaskStats{.name = t.name};
    }
    return out;
}

void TaskRunner::report(Clock::time_point now) {
    const auto window = now - lastReport_;
    lastReport_ = now;
    if (window <= Clock::duration{}) return;
    using ms = std::chrono::duration<double, std::milli>;
    Clock::duration busy{};
    std::string lines;
    for (const auto& s : takeStats()) {
        if (s.runs == 0) continue;
        busy += s.total;
        lines += std::format("\n  {}: {} runs, avg {:.2f} ms, max {:.1f} ms, {:.1f}% of the thread{}", s.name, s.runs,
                             ms(s.total).count() / static_cast<double>(s.runs), ms(s.longest).count(),
                             100.0 * ms(s.total).count() / ms(window).count(),
                             s.stalls ? std::format(", {} stalls", s.stalls) : "");
    }
    if (lines.empty()) return;
    log::debug("[{}] busy {:.1f}% over {:.0f} s:{}", name_, 100.0 * ms(busy).count() / ms(window).count(),
               std::chrono::duration<double>(window).count(), lines);
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

        const auto took = end - begin;
        auto& stats = t->stats;
        ++stats.runs;
        stats.total += took;
        stats.longest = std::max(stats.longest, took);
        if (took > stallThreshold(t->options.interval) && stats.stalls++ == 0)
            log::warn("[{}] task {} took {:.0f} ms (interval {:.0f} ms): the thread's other tasks waited", name_,
                      t->name, std::chrono::duration<double, std::milli>(took).count(),
                      std::chrono::duration<double, std::milli>(t->options.interval).count());

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
    lastReport_ = Clock::now();
    while (!stop.stop_requested()) {
        const auto now = Clock::now();
        if (now - lastReport_ >= kReportInterval) report(now);
        const auto next = step(now);
        const auto wait = std::min<Clock::duration>(kMaxSleep, std::max<Clock::duration>(next - Clock::now(), {}));
        if (wait > Clock::duration{} && !sleepFor(stop, wait)) break;
    }
}

}  // namespace radar::sched
