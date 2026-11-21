#include "core/log/Log.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <format>
#include <mutex>
#include <string>

namespace radar::log {

namespace {
std::atomic<Level> gMinLevel{Level::Info};
std::mutex gMutex;

const char* tag(Level level) {
    switch (level) {
    case Level::Debug: return "DBG";
    case Level::Info: return "INF";
    case Level::Warn: return "WRN";
    case Level::Error: return "ERR";
    case Level::Off: break;
    }
    return "???";
}
}  // namespace

void setMinLevel(Level level) noexcept { gMinLevel.store(level, std::memory_order_relaxed); }

void write(Level level, std::string_view message) {
    if (level < gMinLevel.load(std::memory_order_relaxed)) return;
    // Local wall-clock time. localtime_r rather than std::chrono::current_zone: the tz database may
    // be missing (e.g. in containers).
    const auto now = std::chrono::system_clock::now();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()) %
                    std::chrono::seconds(1);
    const std::time_t seconds = std::chrono::system_clock::to_time_t(now);
    std::tm local{};
    localtime_r(&seconds, &local);
    char clock[16];
    std::strftime(clock, sizeof clock, "%H:%M:%S", &local);
    const std::string line = std::format("{}.{:03} {} {}\n", clock, ms.count(), tag(level), message);
    std::lock_guard lock(gMutex);
    std::fputs(line.c_str(), stderr);
}

}  // namespace radar::log
