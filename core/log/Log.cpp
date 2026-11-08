#include "core/log/Log.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>

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
    const auto now = std::chrono::floor<std::chrono::milliseconds>(std::chrono::system_clock::now());
    const std::string line = std::format("{:%H:%M:%S} {} {}\n", now, tag(level), message);
    std::lock_guard lock(gMutex);
    std::fputs(line.c_str(), stderr);
}

}  // namespace radar::log
