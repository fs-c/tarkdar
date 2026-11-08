#include "server/Feeds.hpp"

#include "core/log/Log.hpp"
#include "core/sched/TaskRunner.hpp"
#include "server/Protocol.hpp"

#include <string>
#include <vector>

namespace radar::server {

namespace {
bool sameStatus(const eft::Status& a, const eft::Status& b) {
    return a.state == b.state && a.raidPending == b.raidPending && a.locationId == b.locationId &&
           a.raidId == b.raidId && a.attachGeneration == b.attachGeneration && a.offsetsMismatch == b.offsetsMismatch;
}
}  // namespace

int LiveFeed::poll() {
    int sent = 0;
    if (sources_.status) {
        auto status = sources_.status();
        if (status && (!lastStatus_ || !sameStatus(*status, *lastStatus_))) {
            hub_.broadcast("status", encodeStatus(*status));
            lastStatus_ = std::move(status);
            ++sent;
        }
    }
    if (sources_.world) {
        // Snapshots are immutable and replaced on every change, so pointer identity means "unchanged".
        const auto forward = [&](const auto& published, auto& last, const char* type, auto encode) {
            auto current = published.get();
            if (current == last) return;
            hub_.broadcast(type, encode(*current));
            last = std::move(current);
            ++sent;
        };
        const auto& w = *sources_.world;
        forward(w.players, lastPlayers_, "players", [](const auto& s) { return encodePlayers(s); });
        forward(w.exfils, lastExfils_, "exfils", [](const auto& s) { return encodeExfils(s); });
        forward(w.explosives, lastExplosives_, "explosives", [](const auto& s) { return encodeExplosives(s); });
        forward(w.loot, lastLoot_, "loot", [](const auto& s) { return encodeLoot(s); });
        forward(w.equipment, lastEquipment_, "equipment", [](const auto& s) { return encodeEquipment(s); });
    }
    return sent;
}

void LiveFeed::run(std::stop_token stop) {
    while (!stop.stop_requested()) {
        poll();
        if (!sched::sleepFor(stop, period_)) break;
    }
}

StreamRecorder::StreamRecorder(const std::filesystem::path& file) : out_(file, std::ios::app) {}

void StreamRecorder::write(const std::string& message) {
    std::lock_guard lock(mutex_);
    out_ << message << '\n';
    // Flush now and then rather than per message: this runs under the hub's lock.
    if (++unflushed_ >= 64) {
        out_.flush();
        unflushed_ = 0;
    }
}

bool StreamReplay::run(std::stop_token stop) {
    struct Entry {
        std::string type;
        std::string message;
        std::int64_t t;
    };
    std::vector<Entry> entries;
    {
        std::ifstream in(file_);
        if (!in) {
            log::error("replay: can't open {}", file_.string());
            return false;
        }
        std::string line;
        while (std::getline(in, line)) {
            auto type = messageType(line);
            auto t = messageTime(line);
            if (type && t && *type != "hello") entries.push_back({std::move(*type), std::move(line), *t});
        }
    }
    if (entries.empty()) {
        log::error("replay: no messages in {}", file_.string());
        return false;
    }
    log::info("replay: {} messages, {:.1f} s", entries.size(),
              static_cast<double>(entries.back().t - entries.front().t) / 1000.0);

    do {
        const auto start = sched::Clock::now();
        const std::int64_t t0 = entries.front().t;
        for (const auto& e : entries) {
            const auto due = start + std::chrono::duration_cast<sched::Clock::duration>(
                                         std::chrono::duration<double, std::milli>(static_cast<double>(e.t - t0) / speed_));
            const auto wait = due - sched::Clock::now();
            if (wait > sched::Clock::duration{} && !sched::sleepFor(stop, wait)) return true;
            hub_.broadcast(e.type, e.message);
        }
        if (loop_) log::info("replay: looping");
    } while (loop_ && !stop.stop_requested());
    return true;
}

}  // namespace radar::server
