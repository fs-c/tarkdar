#include "server/Feeds.hpp"

#include "core/sched/TaskRunner.hpp"
#include "server/Protocol.hpp"

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

// A changed snapshot that the recorder keeps as it is: encode once, broadcast, record.
template <class Snapshot>
int forwardPlain(MessageHub& hub, RaidRecorder* recorder, const std::string& type,
                 const std::shared_ptr<const Snapshot>& snapshot, std::string (*encode)(const Snapshot&)) {
    if (!snapshot) return 0;
    const std::string message = encode(*snapshot);
    hub.broadcast(type, message);
    if (recorder) recorder->onMessage(type, snapshot->raidId, message);
    return 1;
}
}  // namespace

int LiveFeed::pollStatus() {
    if (!sources_.status) return 0;
    auto status = sources_.status();
    if (!status || (lastStatus_ && sameStatus(*status, *lastStatus_))) return 0;
    const auto message = encodeStatus(*status);
    hub_.broadcast("status", message);
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
            hub_.broadcast("skeletons", *message);
            if (recorder) recorder->onSkeletons(players->raidId, *message);
            ++sent;
        }
    }
    if (auto players = takeChange(w.players, lastPlayers_)) {
        const auto message = encodePlayers(*players);
        hub_.broadcast("players", message);
        if (recorder) recorder->onPlayers(std::move(players), message);
        ++sent;
    }
    sent += forwardPlain(hub_, recorder, "exfils", takeChange(w.exfils, lastExfils_), encodeExfils);
    sent += forwardPlain(hub_, recorder, "explosives", takeChange(w.explosives, lastExplosives_), encodeExplosives);
    sent += forwardPlain(hub_, recorder, "vehicles", takeChange(w.vehicles, lastVehicles_), encodeVehicles);
    if (auto loot = takeChange(w.loot, lastLoot_)) {
        const auto message = encodeLoot(*loot);
        hub_.broadcast("loot", message);
        if (recorder) recorder->onLoot(std::move(loot), message);
        ++sent;
    }
    sent += forwardPlain(hub_, recorder, "equipment", takeChange(w.equipment, lastEquipment_), encodeEquipment);
    sent += forwardPlain(hub_, recorder, "quests", takeChange(w.quests, lastQuests_), encodeQuests);
    if (const auto camera = takeChange(w.camera, lastCamera_)) {
        const auto message = encodeCamera(*camera);
        hub_.broadcast("camera", message);
        if (recorder) recorder->onCamera(camera->raidId, message);
        ++sent;
    }
    return sent;
}

int LiveFeed::poll() { return pollStatus() + (sources_.world ? pollWorld() : 0); }

void LiveFeed::run(std::stop_token stop) {
    while (!stop.stop_requested()) {
        poll();
        if (!sched::sleepFor(stop, period_)) break;
    }
}

}  // namespace radar::server
