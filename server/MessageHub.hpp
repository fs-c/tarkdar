#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>

namespace radar::server {

// Fans messages out to connected clients. Keeps the latest message of each type, so a client that
// connects mid-raid immediately gets the current state (after "hello"). Thread-safe.
//
// Raid-scoped messages (raid != 0) are dropped from the replay once their raid ends, i.e. when a
// "status" for another raid (or for none) follows a status of that raid. Raid ids only increase.
class MessageHub {
public:
    using Sender = std::function<void(const std::string&)>;
    using ClientId = std::uint64_t;

    // Registers a client and sends it hello, the latest status, then the latest message of every
    // other type in the order they were broadcast.
    ClientId connect(Sender sender, const std::string& hello);
    void disconnect(ClientId id);

    // Sends to every client and remembers it as the latest of its type. `raid`: the raid the message
    // belongs to, 0 if none.
    void broadcast(const std::string& type, const std::string& message, std::uint64_t raid = 0);

    // Called for every broadcast message, under the hub's lock (tests use it to observe the stream). Set before use.
    void setTap(std::function<void(const std::string&)> tap);

private:
    struct Latest {
        std::string message;
        std::uint64_t raid = 0;
        std::uint64_t seq = 0;  // broadcast order
    };

    mutable std::mutex mutex_;
    std::map<ClientId, Sender> clients_;
    std::map<std::string, Latest> latest_;
    std::function<void(const std::string&)> tap_;
    ClientId nextId_ = 1;
    std::uint64_t nextSeq_ = 1;
    std::uint64_t statusRaid_ = 0;  // the raid of the latest status
    std::uint64_t endedRaid_ = 0;   // the newest raid that has ended: its messages (and older ones) aren't kept
};

}  // namespace radar::server
