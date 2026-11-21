#include "server/MessageHub.hpp"

#include <algorithm>
#include <map>
#include <vector>

namespace radar::server {

MessageHub::ClientId MessageHub::connect(Sender sender, const std::string& hello) {
    std::lock_guard lock(mutex_);
    const ClientId id = nextId_++;
    // Status first: a client reads the rest in its light (e.g. ignores raid data outside a raid).
    std::vector<const Latest*> replay;
    replay.reserve(latest_.size());
    for (const auto& [type, latest] : latest_)
        if (type != "status") replay.push_back(&latest);
    std::ranges::sort(replay, {}, &Latest::seq);
    // Senders run under the mutex: fine for the server's, which only queue the text on the connection.
    sender(hello);
    if (const auto it = latest_.find("status"); it != latest_.end()) sender(it->second.message);
    for (const Latest* latest : replay) sender(latest->message);
    clients_.emplace(id, std::move(sender));
    return id;
}

void MessageHub::disconnect(ClientId id) {
    std::lock_guard lock(mutex_);
    clients_.erase(id);
}

void MessageHub::broadcast(const std::string& type, const std::string& message, std::uint64_t raid) {
    std::lock_guard lock(mutex_);
    if (type == "status") {
        if (statusRaid_ != 0 && raid != statusRaid_) {
            endedRaid_ = std::max(endedRaid_, statusRaid_);
            std::erase_if(latest_, [&](const auto& e) { return e.second.raid != 0 && e.second.raid <= endedRaid_; });
        }
        statusRaid_ = raid;
    }
    // A late message of an ended raid (e.g. its last, empty snapshot) still goes out live, but isn't replayed.
    if (raid == 0 || raid > endedRaid_) latest_[type] = Latest{message, raid, nextSeq_++};
    else latest_.erase(type);
    if (tap_) tap_(message);
    for (const auto& [id, send] : clients_) send(message);
}

void MessageHub::setTap(std::function<void(const std::string&)> tap) {
    std::lock_guard lock(mutex_);
    tap_ = std::move(tap);
}

}  // namespace radar::server
