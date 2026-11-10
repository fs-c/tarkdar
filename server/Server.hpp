#pragma once

#include "server/MessageHub.hpp"
#include "server/Recorder.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace radar::server {

struct ServerConfig {
    std::string bindAddress = "127.0.0.1";  // LAN access is opt-in
    std::uint16_t port = 8080;
    std::filesystem::path webRoot = "web/dist";  // built frontend
    std::filesystem::path mapsRoot = "maps";     // one folder per map, each with map.json
    std::filesystem::path dataRoot = "data";     // item/quest data files
    std::filesystem::path recordingsRoot = "recordings";  // raid recordings
    bool live = true;  // false: serving recordings only (--offline); sent in "hello"
};

// HTTP + WebSocket server:
//   GET /ws               WebSocket: the message stream (docs/protocol.md)
//   GET /maps/index.json  generated list of map folders and their configs
//   GET /maps/<path>      files under mapsRoot
//   GET /data/<path>      files under dataRoot
//   GET /api/recordings   list of raid recordings (JSON)
//   GET /api/recordings/<name>  one recording file (the active one flushed first)
//   GET /, /<path>        the frontend (files under webRoot; index.html for /)
class Server {
public:
    // `recorder` (optional) is asked for the active recording, which it flushes before it's served.
    Server(ServerConfig config, MessageHub& hub, RaidRecorder* recorder = nullptr);
    ~Server();

    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    // Starts serving on background threads. Returns false if the port can't be bound.
    bool start();
    void stop();

    [[nodiscard]] std::uint16_t port() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Resolves a request path under root. nullopt unless the result is an existing regular file inside
// root (after resolving symlinks and ".."), so requests can't escape the served directory.
[[nodiscard]] std::optional<std::filesystem::path> resolveUnder(const std::filesystem::path& root,
                                                                std::string_view requestPath);

// Whether a WebSocket upgrade with this Origin header may connect to a server reached as `host` (the
// Host header): the origin's host[:port] must equal it. A missing Origin (non-browser client) is
// allowed.
[[nodiscard]] bool originAllowed(std::string_view origin, std::string_view host);

// JSON array of {"folder": name, "config": <contents of map.json>} for every subfolder of mapsRoot
// with a valid map.json, sorted by folder name.
[[nodiscard]] std::string buildMapsIndex(const std::filesystem::path& mapsRoot);

}  // namespace radar::server
