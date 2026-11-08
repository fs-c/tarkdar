#include "server/MessageHub.hpp"

namespace radar::server {

MessageHub::ClientId MessageHub::connect(Sender sender, const std::string& hello) {
    std::lock_guard lock(mutex_);
    const ClientId id = nextId_++;
    sender(hello);
    for (const auto& [type, message] : latest_) sender(message);
    clients_.emplace(id, std::move(sender));
    return id;
}

void MessageHub::disconnect(ClientId id) {
    std::lock_guard lock(mutex_);
    clients_.erase(id);
}

void MessageHub::broadcast(const std::string& type, const std::string& message) {
    std::lock_guard lock(mutex_);
    latest_[type] = message;
    if (tap_) tap_(message);
    for (const auto& [id, send] : clients_) send(message);
}

void MessageHub::setTap(std::function<void(const std::string&)> tap) {
    std::lock_guard lock(mutex_);
    tap_ = std::move(tap);
}

std::size_t MessageHub::clientCount() const {
    std::lock_guard lock(mutex_);
    return clients_.size();
}

}  // namespace radar::server
