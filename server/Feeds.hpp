#pragma once

#include "game/eft/Lifecycle.hpp"
#include "game/eft/model/WorldState.hpp"
#include "server/MessageHub.hpp"
#include "server/Recorder.hpp"

#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <stop_token>
#include <string>

// Sources and sinks of the message stream.
namespace radar::server {

// Turns live backend state into messages: polls the lifecycle status and the world snapshots every
// `period` and broadcasts whatever changed (and hands it to the recorder, if there is one).
// Every kReportInterval, run() logs (debug) the messages and bytes sent per type and the slowest poll.
class LiveFeed {
public:
    struct Sources {
        std::function<std::shared_ptr<const eft::Status>()> status;
        const eft::WorldState* world = nullptr;
        RaidRecorder* recorder = nullptr;
    };

    LiveFeed(Sources sources, MessageHub& hub, std::chrono::milliseconds period = std::chrono::milliseconds(33))
        : sources_(std::move(sources)), hub_(hub), period_(period) {}

    void run(std::stop_token stop);
    // One poll; returns the number of messages sent. Exposed for tests.
    int poll();

    static constexpr auto kReportInterval = std::chrono::seconds(10);

private:
    int pollStatus();
    int pollWorld();
    // Broadcasts and counts the message for the report.
    void send(const std::string& type, const std::string& message);
    // A changed snapshot that the recorder keeps as it is: encode once, send, record.
    template <class Snapshot>
    int forwardPlain(const std::string& type, const std::shared_ptr<const Snapshot>& snapshot,
                     std::string (*encode)(const Snapshot&));
    void report(std::chrono::steady_clock::duration window);

    struct TypeStats {
        std::uint64_t messages = 0, bytes = 0, largest = 0;
    };
    std::map<std::string, TypeStats> typeStats_;
    std::chrono::steady_clock::duration longestPoll_{};

    Sources sources_;
    MessageHub& hub_;
    std::chrono::milliseconds period_;
    std::shared_ptr<const eft::Status> lastStatus_;
    std::shared_ptr<const eft::PlayersSnapshot> lastPlayers_;
    std::shared_ptr<const eft::PlayersSnapshot> lastSkeletonsFrom_;  // the snapshot skeletons were last sent for
    std::shared_ptr<const eft::ExfilsSnapshot> lastExfils_;
    std::shared_ptr<const eft::ExplosivesSnapshot> lastExplosives_;
    std::shared_ptr<const eft::VehiclesSnapshot> lastVehicles_;
    std::shared_ptr<const eft::LootSnapshot> lastLoot_;
    std::shared_ptr<const eft::EquipmentSnapshot> lastEquipment_;
    std::shared_ptr<const eft::QuestsSnapshot> lastQuests_;
    std::shared_ptr<const eft::CameraSnapshot> lastCamera_;
};

}  // namespace radar::server
