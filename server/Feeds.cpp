#include "server/Feeds.hpp"

#include "core/sched/TaskRunner.hpp"
#include "server/Protocol.hpp"

#include "core/log/Log.hpp"

#include <algorithm>
#include <format>
#include <memory>
#include <string>

namespace radar::server {

namespace {
bool sameStatus(const eft::Status& a, const eft::Status& b) {
    return a.state == b.state && a.raidPending == b.raidPending && a.locationId == b.locationId &&
           a.raidId == b.raidId && a.attachGeneration == b.attachGeneration && a.offsetsMismatch == b.offsetsMismatch;
}

// The source's snapshot if it changed since `last` (which is then updated to it), else null.
// Snapshots are immutable and replaced on every change, so pointer identity means "unchanged".
template <class Snapshot>
std::shared_ptr<const Snapshot> takeChange(const sched::Published<Snapshot>& source,
                                           std::shared_ptr<const Snapshot>& last) {
    auto current = source.get();
    if (current == last) return nullptr;
    last = current;
    return current;
}

}  // namespace

void LiveFeed::send(const std::string& type, std::uint64_t raid, const std::string& message) {
    hub_.broadcast(type, message, raid);
    auto& s = typeStats_[type];
    ++s.messages;
    s.bytes += message.size();
    s.largest = std::max<std::uint64_t>(s.largest, message.size());
}

template <class Snapshot>
int LiveFeed::forwardPlain(const std::string& type, const std::shared_ptr<const Snapshot>& snapshot,
                           std::string (*encode)(const Snapshot&)) {
    if (!snapshot) return 0;
    const std::string message = encode(*snapshot);
    send(type, snapshot->raidId, message);
    if (sources_.recorder) sources_.recorder->onMessage(type, snapshot->raidId, message);
    return 1;
}

int LiveFeed::pollStatus() {
    if (!sources_.status) return 0;
    auto status = sources_.status();
    if (!status || (lastStatus_ && sameStatus(*status, *lastStatus_))) return 0;
    const auto message = encodeStatus(*status);
    send("status", status->raidId, message);
    if (sources_.recorder) sources_.recorder->onStatus(*status, message);
    lastStatus_ = std::move(status);
    return 1;
}

int LiveFeed::pollWorld() {
    const auto& w = *sources_.world;
    auto* recorder = sources_.recorder;
    int sent = 0;

    // Skeletons come from the players snapshot, as their own message (the recorder keeps fewer of
    // them than of the players), sent first: a client redraws on players, with the matching skeletons.
    if (const auto players = takeChange(w.players, lastSkeletonsFrom_)) {
        if (const auto message = encodeSkeletons(*players)) {
            send("skeletons", players->raidId, *message);
            if (recorder) recorder->onSkeletons(players->raidId, *message);
            ++sent;
        }
    }
    if (auto players = takeChange(w.players, lastPlayers_)) {
        const auto message = encodePlayers(*players);
        send("players", players->raidId, message);
        if (recorder) recorder->onPlayers(std::move(players), message);
        ++sent;
    }
    sent += forwardPlain("exfils", takeChange(w.exfils, lastExfils_), encodeExfils);
    sent += forwardPlain("explosives", takeChange(w.explosives, lastExplosives_), encodeExplosives);
    sent += forwardPlain("vehicles", takeChange(w.vehicles, lastVehicles_), encodeVehicles);
    if (auto loot = takeChange(w.loot, lastLoot_)) {
        const auto message = encodeLoot(*loot);
        send("loot", loot->raidId, message);
        if (recorder) recorder->onLoot(std::move(loot), message);
        ++sent;
    }
    sent += forwardPlain("equipment", takeChange(w.equipment, lastEquipment_), encodeEquipment);
    sent += forwardPlain("quests", takeChange(w.quests, lastQuests_), encodeQuests);
    sent += forwardPlain("stash", takeChange(w.stash, lastStash_), encodeStash);
    if (const auto camera = takeChange(w.camera, lastCamera_)) {
        const auto message = encodeCamera(*camera);
        send("camera", camera->raidId, message);
        if (recorder) recorder->onCamera(camera->raidId, message);
        ++sent;
    }
    return sent;
}

int LiveFeed::poll() { return pollStatus() + (sources_.world ? pollWorld() : 0); }

void LiveFeed::report(std::chrono::steady_clock::duration window) {
    using ms = std::chrono::duration<double, std::milli>;
    const double seconds = std::chrono::duration<double>(window).count();
    std::string lines;
    for (const auto& [type, s] : typeStats_)
        lines += std::format("\n  {}: {:.1f}/s, {:.1f} KiB/s, largest {:.1f} KiB", type,
                             static_cast<double>(s.messages) / seconds, static_cast<double>(s.bytes) / 1024.0 / seconds,
                             static_cast<double>(s.largest) / 1024.0);
    if (!lines.empty())
        log::debug("feed: slowest poll {:.1f} ms over {:.0f} s:{}", ms(longestPoll_).count(), seconds, lines);
    typeStats_.clear();
    longestPoll_ = {};
}

void LiveFeed::run(std::stop_token stop) {
    using Clock = std::chrono::steady_clock;
    auto lastReport = Clock::now();
    while (!stop.stop_requested()) {
        const auto begin = Clock::now();
        poll();
        const auto end = Clock::now();
        longestPoll_ = std::max(longestPoll_, end - begin);
        if (end - lastReport >= kReportInterval) {
            report(end - lastReport);
            lastReport = end;
        }
        if (!sched::sleepFor(stop, period_)) break;
    }
}

}  // namespace radar::server
