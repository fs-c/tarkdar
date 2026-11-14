#include "server/Feeds.hpp"

#include "core/sched/TaskRunner.hpp"
#include "server/Protocol.hpp"

#include <string>

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
            const auto message = encodeStatus(*status);
            hub_.broadcast("status", message);
            if (sources_.recorder) sources_.recorder->onStatus(*status, message);
            lastStatus_ = std::move(status);
            ++sent;
        }
    }
    if (sources_.world) {
        // Snapshots are immutable and replaced on every change, so pointer identity means "unchanged".
        auto* rec = sources_.recorder;
        const auto forward = [&](const auto& published, auto& last, const std::string& type, auto encode, auto record) {
            auto current = published.get();
            if (current == last) return;
            const auto message = encode(*current);
            hub_.broadcast(type, message);
            if (rec) record(*current, message);
            last = std::move(current);
            ++sent;
        };
        const auto other = [&](const std::string& type) {
            return [&rec, type](const auto& snap, const std::string& m) { rec->onMessage(type, snap.raidId, m); };
        };
        const auto& w = *sources_.world;
        // Skeletons come from the same snapshot, as their own message (the recorder keeps fewer of them
        // than of the players), sent first: a client redraws on players, with the matching skeletons.
        if (auto players = w.players.get(); players != lastSkeletonsFrom_) {
            if (auto message = encodeSkeletons(*players)) {
                hub_.broadcast("skeletons", *message);
                if (rec) rec->onSkeletons(players->raidId, *message);
                ++sent;
            }
            lastSkeletonsFrom_ = std::move(players);
        }
        forward(w.players, lastPlayers_, "players", [](const auto& s) { return encodePlayers(s); },
                [&](const auto& s, const std::string& m) { rec->onPlayers(s, m); });
        forward(w.exfils, lastExfils_, "exfils", [](const auto& s) { return encodeExfils(s); }, other("exfils"));
        forward(w.explosives, lastExplosives_, "explosives", [](const auto& s) { return encodeExplosives(s); },
                other("explosives"));
        forward(w.vehicles, lastVehicles_, "vehicles", [](const auto& s) { return encodeVehicles(s); },
                other("vehicles"));
        forward(w.loot, lastLoot_, "loot", [](const auto& s) { return encodeLoot(s); },
                [&](const auto& s, const std::string& m) { rec->onLoot(s, m); });
        forward(w.equipment, lastEquipment_, "equipment", [](const auto& s) { return encodeEquipment(s); },
                other("equipment"));
    }
    return sent;
}

void LiveFeed::run(std::stop_token stop) {
    while (!stop.stop_requested()) {
        poll();
        if (!sched::sleepFor(stop, period_)) break;
    }
}

}  // namespace radar::server
