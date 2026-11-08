#pragma once

#include "game/eft/Lifecycle.hpp"
#include "game/eft/model/WorldState.hpp"
#include "server/MessageHub.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <mutex>
#include <stop_token>

// Sources and sinks of the message stream.
namespace radar::server {

// Turns live backend state into messages: polls the lifecycle status and the world snapshots at
// `rate` and broadcasts whatever changed.
class LiveFeed {
public:
    struct Sources {
        std::function<std::shared_ptr<const eft::Status>()> status;
        const eft::WorldState* world = nullptr;
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

// Appends every message to a file, one JSON message per line (JSON Lines).
class StreamRecorder {
public:
    explicit StreamRecorder(const std::filesystem::path& file);
    [[nodiscard]] bool ok() const { return out_.good(); }
    void write(const std::string& message);

private:
    std::mutex mutex_;
    std::ofstream out_;
    int unflushed_ = 0;
};

// Replays a recorded stream in real time (scaled by `speed`), using the messages' "t" fields for
// timing. Lines that aren't valid messages are skipped.
class StreamReplay {
public:
    StreamReplay(std::filesystem::path file, MessageHub& hub, double speed = 1.0, bool loop = true)
        : file_(std::move(file)), hub_(hub), speed_(speed), loop_(loop) {}

    // Returns false if the file can't be read or contains no messages.
    bool run(std::stop_token stop);

private:
    std::filesystem::path file_;
    MessageHub& hub_;
    double speed_;
    bool loop_;
};

}  // namespace radar::server
