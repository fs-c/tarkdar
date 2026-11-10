#pragma once

#include "game/eft/Lifecycle.hpp"
#include "game/eft/model/WorldState.hpp"
#include "server/MessageHub.hpp"
#include "server/Recorder.hpp"

#include <chrono>
#include <functional>
#include <memory>
#include <stop_token>

// Sources and sinks of the message stream.
namespace radar::server {

// Turns live backend state into messages: polls the lifecycle status and the world snapshots every
// `period` and broadcasts whatever changed (and hands it to the recorder, if there is one).
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

private:
    Sources sources_;
    MessageHub& hub_;
    std::chrono::milliseconds period_;
    std::shared_ptr<const eft::Status> lastStatus_;
    std::shared_ptr<const eft::PlayersSnapshot> lastPlayers_;
    std::shared_ptr<const eft::ExfilsSnapshot> lastExfils_;
    std::shared_ptr<const eft::ExplosivesSnapshot> lastExplosives_;
    std::shared_ptr<const eft::LootSnapshot> lastLoot_;
    std::shared_ptr<const eft::EquipmentSnapshot> lastEquipment_;
};

}  // namespace radar::server
