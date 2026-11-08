#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>

namespace radar::server {

// Fans messages out to connected clients. Keeps the latest message of each type, so a client that
// connects mid-raid immediately gets the current state (after "hello"). Thread-safe.
class MessageHub {
public:
    using Sender = std::function<void(const std::string&)>;
    using ClientId = std::uint64_t;

    // Registers a client and sends it hello + the latest message of every type.
    ClientId connect(Sender sender, const std::string& hello);
    void disconnect(ClientId id);

    // Sends to every client and remembers it as the latest of its type.
    void broadcast(const std::string& type, const std::string& message);

    // Called for every broadcast message (e.g. stream recording). Set before use.
    void setTap(std::function<void(const std::string&)> tap);

    [[nodiscard]] std::size_t clientCount() const;

private:
    mutable std::mutex mutex_;
    std::map<ClientId, Sender> clients_;
    std::map<std::string, std::string> latest_;
    std::function<void(const std::string&)> tap_;
    ClientId nextId_ = 1;
};

}  // namespace radar::server
